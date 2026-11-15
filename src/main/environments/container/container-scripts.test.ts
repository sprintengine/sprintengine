import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import {
  buildImageScript,
  cloneAddress,
  cloneFolderName,
  cloneScript,
  dockerCommand,
  dockerStatusScript,
  EXEC_READY_MARKER,
  execSessionScript,
  parseDockerStatus,
  parseUnpushed,
  removalOutcome,
  removeContainerScript,
  runContainerScript,
  unpushedScript,
} from './container-scripts'
import {
  dockerSearchPath,
  holdStdinUntil,
  localHostRunner,
  runOnHost,
  shellQuote,
  sshScriptBody,
  type HostProcess,
} from './docker-host'

const scratch = mkdtempSync(join(tmpdir(), 'se-container-scripts-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * The few system tools the scripts use, and nothing else: a host's real
 * `docker` (a CI runner has one in /usr/bin) must never answer for a stand-in.
 */
const BASE = join(scratch, 'base')
mkdirSync(BASE, { recursive: true })
for (const tool of ['sed', 'cat', 'mktemp', 'rm', 'tr', 'printf']) {
  const found = ['/usr/bin', '/bin']
    .map((dir) => join(dir, tool))
    .find((path) => {
      try {
        execFileSync('test', ['-x', path])
        return true
      } catch {
        return false
      }
    })
  if (found) symlinkSync(found, join(BASE, tool))
}

/** A directory holding stand-ins for `docker`, `colima` or `git`, each a script answering as told. */
function fakeBin(name: string, tools: Record<string, string>): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  for (const [tool, body] of Object.entries(tools)) {
    const path = join(dir, tool)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  return dir
}

/** This computer's runner, seeing only the stand-ins in `dir` and the base tools. */
const runnerFor = (dir: string) =>
  localHostRunner({ env: { PATH: `${dir}:${BASE}`, HOME: scratch }, searchPath: false })

const IMAGE = 'sprintengine-studio-agent:0123456789ab'
const NAME = 'sprintengine-0123456789abcdef'

async function statusWith(dir: string) {
  const result = await runOnHost(runnerFor(dir), dockerStatusScript(IMAGE), { timeoutMs: 10_000 })
  return parseDockerStatus(result.stdout, 'this Mac')
}

test('a word survives the shell, whatever it holds', () => {
  for (const word of ["it's", 'a b', '$(touch x)', '`id`', '"q"', 'back\\slash', '', 'line\nbreak'])
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(word)}`], { encoding: 'utf8' }), word)
  assert.throws(() => shellQuote('nul\0'))
})

test("an SSH machine's `sh -s` gets the whole script before it runs, and the payload only after the marker", async () => {
  // A script read from stdin, as `ssh … sh -s` gives it: one compound command.
  assert.equal(
    execFileSync('/bin/sh', ['-s'], { input: sshScriptBody('a=1\necho "$a" two'), encoding: 'utf8' }).trim(),
    '1 two',
  )
  // The payload written at once is held until the script says it has become the command reading it.
  const child = spawn('/bin/sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as HostProcess
  child.stdin.write(sshScriptBody(`echo ${EXEC_READY_MARKER}\nexec cat`))
  const held = holdStdinUntil(child, EXEC_READY_MARKER)
  held.stdin.end('the relay starts here\n')
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
  await new Promise((resolve) => child.once('close', resolve))
  assert.equal(out, `${EXEC_READY_MARKER}\nthe relay starts here\n`)
})

test('Docker on a host, in words: running, Colima stopped, not running, missing', async () => {
  const ready = await statusWith(
    fakeBin('ready', {
      docker: [
        'case "$1" in',
        '  version) echo 29.2.1 ;;',
        '  context) echo colima ;;',
        '  image) exit 0 ;;',
        'esac',
      ].join('\n'),
    }),
  )
  assert.deepEqual(ready, {
    state: 'ready',
    words: 'Docker 29.2.1 is running on this Mac (Colima).',
    imageReady: true,
    canStart: null,
    context: 'colima',
  })
  const stopped = await statusWith(fakeBin('stopped', { docker: 'exit 1', colima: 'exit 1' }))
  assert.deepEqual(stopped, {
    state: 'stopped',
    words: 'Colima is installed on this Mac, but it is stopped.',
    imageReady: false,
    canStart: 'colima',
  })
  const down = await statusWith(fakeBin('down', { docker: 'exit 1' }))
  assert.equal(down.state, 'not-running')
  assert.equal(down.words, 'Docker is installed on this Mac, but it is not running.')
  const missing = await statusWith(fakeBin('missing', {}))
  assert.equal(missing.state, 'missing')
  assert.equal(missing.words, 'Docker was not found on this Mac.')
  const noImage = await statusWith(
    fakeBin('no-image', {
      docker: 'case "$1" in version) echo 28.0.0 ;; context) echo default ;; image) exit 1 ;; esac',
    }),
  )
  assert.equal(noImage.imageReady, false)
  assert.equal(noImage.words, 'Docker 28.0.0 is running on this Mac.')
  assert.equal(noImage.context, 'default')
  // A login profile's greeting before the answer is not the answer.
  assert.equal(parseDockerStatus('Welcome to build-box\n@@docker missing\n', 'build-box').state, 'missing')
  assert.equal(parseDockerStatus('', 'build-box').state, 'unreachable')
})

test('only names Studio minted are spelled bare in a script', () => {
  assert.throws(() => execSessionScript('sprintengine-x; rm -rf /'))
  assert.throws(() => removeContainerScript('postgres'))
  assert.throws(() => runContainerScript({ name: NAME, image: 'x; id', machineId: '0123456789abcdef' }))
  assert.throws(() => dockerCommand('colima; id'))
  assert.throws(() => cloneScript({ name: NAME, address: 'x', folder: '../etc' }))
  assert.throws(() => unpushedScript('sprintengine-x; id'))
  // A repository's address is a quoted word, whatever it holds.
  const script = cloneScript({ name: NAME, address: "https://example.com/it's $(here).git", folder: 'x' })
  assert.ok(script.includes(`'https://example.com/it'\\''s $(here).git'`))
})

test('a container is made without capabilities, with only its own home as a volume, on the context it was asked under', () => {
  const run = runContainerScript({ name: NAME, image: IMAGE, machineId: '0123456789abcdef', context: 'colima' })
  assert.match(
    run,
    /^docker --context colima volume create --label sprintengine\.studio\.container=1 --label sprintengine\.studio\.machine=0123456789abcdef sprintengine-0123456789abcdef-home /u,
  )
  assert.match(run, /\ndocker --context colima run -d /u)
  assert.match(run, / --cap-drop ALL --security-opt no-new-privileges /u)
  assert.match(run, /--label sprintengine\.studio\.container=1 /u)
  // The one volume is Studio's own; nothing of the host's folders is mounted.
  assert.deepEqual(run.match(/-v \S+/gu), ['-v sprintengine-0123456789abcdef-home:/home/node'])
  assert.doesNotMatch(run, /--mount|--privileged|--cap-add|-v \//u)
  // The host's default context is not named, so DOCKER_HOST still decides it.
  assert.equal(dockerCommand(null), 'docker')
  assert.equal(dockerCommand('default'), 'docker')
  for (const script of [
    execSessionScript(NAME, { context: 'colima' }),
    removeContainerScript(NAME, 'colima'),
    cloneScript({ name: NAME, address: 'https://github.com/acme/app.git', folder: 'app', context: 'colima' }),
    unpushedScript(NAME, 'colima'),
  ])
    assert.doesNotMatch(script.replace(/docker --context colima /gu, ''), /\bdocker /u, script)
})

test('the image is built from the Dockerfile carried in the script, so a host is sent nothing else', async () => {
  const dir = fakeBin('build', { docker: 'cat > "$HOME/received-dockerfile"; echo "args: $*"' })
  const dockerfile = 'FROM node:22\nRUN echo "it\'s $HOME"\n'
  const result = await runOnHost(runnerFor(dir), buildImageScript(IMAGE, dockerfile))
  assert.match(
    result.stdout,
    /args: build -q -t sprintengine-studio-agent:0123456789ab --label sprintengine\.studio\.image=agent -/u,
  )
  assert.equal(execFileSync('cat', [join(scratch, 'received-dockerfile')], { encoding: 'utf8' }), dockerfile)
  assert.throws(() => buildImageScript(IMAGE, 'FROM x\nSPRINTENGINE_DOCKERFILE_END_7f3a\n'))
})

test("a container is removed only when it carries Studio's label, and called gone only when Docker says so", async () => {
  const docker = (inspect: string, version = 'echo 29') =>
    fakeBin(`rm-${Math.random().toString(36).slice(2)}`, {
      docker: [
        'case "$1" in',
        `  version) ${version} ;;`,
        `  inspect) ${inspect} ;;`,
        '  rm) echo "removed $3" >&2 ;;',
        `  volume) case "$2" in inspect) ${inspect} ;; rm) echo "volume removed $3" >&2 ;; esac ;;`,
        'esac',
      ].join('\n'),
    })
  const remove = async (dir: string) => {
    const result = await runOnHost(runnerFor(dir), removeContainerScript(NAME))
    return {
      said: /@@removed (\S+)/u.exec(result.stdout)?.[1],
      outcome: removalOutcome(result, NAME, 'this Mac'),
      result,
    }
  }
  const absent = await remove(docker(`echo "Error: No such object: ${NAME}" >&2; exit 1`))
  assert.equal(absent.said, 'absent')
  assert.deepEqual(absent.outcome, { ok: true })
  const ours = await remove(docker('echo 1'))
  assert.equal(ours.said, 'yes')
  // Its home volume goes with it, by its own name.
  assert.match(ours.result.stderr, /volume removed sprintengine-0123456789abcdef-home/u)
  const theirs = await remove(docker('echo ""'))
  assert.equal(theirs.said, 'not-ours')
  assert.doesNotMatch(theirs.result.stderr, /removed/u)
  // Docker not running: the container is not called gone, and the words say it stays.
  const stopped = await remove(docker('echo 1', 'exit 1'))
  assert.equal(stopped.said, 'no-docker')
  assert.equal(stopped.outcome.ok, false)
  assert.match(
    stopped.outcome.ok ? '' : stopped.outcome.message,
    /Docker is not running on this Mac, so .* is still there/u,
  )
  // Any other answer from inspect is a failure, not an absence.
  const odd = await remove(docker('echo "permission denied while trying to connect" >&2; exit 1'))
  assert.equal(odd.said, 'failed')
  assert.match(odd.outcome.ok ? '' : odd.outcome.message, /permission denied/u)
})

test('a repository to clone, as a person types it, and the folder it lands in', () => {
  assert.equal(cloneAddress('acme/app'), 'https://github.com/acme/app.git')
  assert.equal(cloneAddress(' acme/app.git '), 'https://github.com/acme/app.git')
  assert.equal(cloneAddress('https://github.com/acme/app'), 'https://github.com/acme/app')
  assert.equal(cloneAddress('git@github.com:acme/app.git'), 'git@github.com:acme/app.git')
  assert.equal(cloneAddress('ssh://git@example.com/acme/app.git'), 'ssh://git@example.com/acme/app.git')
  for (const bad of ['', 'app', '--upload-pack=id', 'file:///etc', 'https://x y/z', '/Users/dev/app'])
    assert.equal(cloneAddress(bad), null, bad)
  assert.equal(cloneFolderName('https://github.com/acme/demo-app.git'), 'demo-app')
  assert.equal(cloneFolderName('git@github.com:acme/app.git'), 'app')
  assert.equal(cloneFolderName('https://example.com/a/..'), 'repo')
})

test('a clone runs inside as the agent, with no password prompt, and never over a folder already there', async () => {
  const dir = fakeBin('clone', {
    docker: ['case "$1" in', '  start) exit 0 ;;', '  exec) echo "args: $*" ;;', 'esac'].join('\n'),
  })
  const result = await runOnHost(
    runnerFor(dir),
    cloneScript({ name: NAME, address: 'https://github.com/acme/app.git', folder: 'app' }),
  )
  assert.match(
    result.stdout,
    /args: exec -u node -e HOME=\/home\/node -w \/home\/node sprintengine-0123456789abcdef sh -c /u,
  )
  assert.match(result.stdout, /GIT_TERMINAL_PROMPT=0 git clone -q -- "\$1" \/home\/node\/work\/app/u)
  assert.match(result.stdout, /if \[ -e \/home\/node\/work\/app \]; then echo "@@clone exists/u)
  assert.match(result.stdout, / sh https:\/\/github\.com\/acme\/app\.git$/mu)
})

test('what deleting a container would lose: unpushed branches, uncommitted changes, detached commits and stashes', async () => {
  const work = realpathSync(mkdtempSync(join(scratch, 'unpushed-')))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], {
      cwd,
      encoding: 'utf8',
    })
  const origin = join(work, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin])
  const repo = join(work, 'home', 'work', 'app')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'one')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  // A branch with no upstream and two commits of its own.
  git(repo, 'checkout', '-q', '-b', 'agent/fix')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'two')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'three')
  git(repo, 'checkout', '-q', 'main')
  // A stash.
  writeFileSync(join(repo, 'stashed.txt'), 'x\n')
  git(repo, 'stash', 'push', '-q', '-u')
  // A worktree with an untracked file and an uncommitted change.
  const dirty = join(work, 'home', 'work', '.sprintengine-worktrees', 'app', 'dirty')
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/dirty', dirty, 'main')
  writeFileSync(join(dirty, 'new.txt'), 'x\n')
  // A detached worktree with a commit on no branch.
  const detached = join(work, 'home', 'work', '.sprintengine-worktrees', 'app', 'detached')
  git(repo, 'worktree', 'add', '-q', '--detach', detached, 'main')
  git(detached, 'commit', '-q', '--allow-empty', '-m', 'adrift')
  // A stand-in docker that runs the inside script here, with this scratch home as the container's.
  const inside = join(work, 'home')
  const dir = fakeBin('unpushed', {
    docker: [
      'case "$1" in',
      '  start) exit 0 ;;',
      `  exec) shift 6; script="$3"; script="$(printf '%s' "$script" | sed 's#/home/node#${inside}#g')"; exec /bin/sh -c "$script" ;;`,
      'esac',
    ].join('\n'),
  })
  const result = await runOnHost(
    localHostRunner({ env: { PATH: `${dir}:${BASE}:/usr/bin:/bin`, HOME: scratch }, searchPath: false }),
    unpushedScript(NAME),
  )
  assert.deepEqual(parseUnpushed(result.stdout), {
    branches: [{ repo, branch: 'agent/fix', commits: 2 }],
    dirty: [{ worktree: dirty, files: 1 }],
    detached: [{ worktree: detached, commits: 1 }],
    stashes: [{ repo, count: 1 }],
  })
  assert.equal(parseUnpushed('@@branch 1\t/x\tb\n'), null, 'an answer that did not finish is not "nothing"')
})

test("Docker's usual homes join the PATH an app opened from the Dock has", () => {
  const path = dockerSearchPath('/usr/bin:/bin', {
    platform: 'darwin',
    home: '/Users/dev',
    loginPath: '/opt/homebrew/bin:/usr/bin',
  })
  assert.deepEqual(path.split(':'), [
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/local/bin',
    '/Users/dev/.docker/bin',
    '/Applications/Docker.app/Contents/Resources/bin',
  ])
})

test("a container's session is a shell inside it, as the agent's user, once Docker has started it", async () => {
  const dir = fakeBin('exec', {
    docker: ['case "$1" in', '  start) echo started >&2 ;;', '  exec) echo "args: $*" ;;', 'esac'].join('\n'),
  })
  const result = await runOnHost(runnerFor(dir), execSessionScript(NAME))
  assert.match(result.stderr, /started/u)
  assert.match(
    result.stdout,
    /args: exec -i -u node -w \/home\/node -e HOME=\/home\/node sprintengine-0123456789abcdef sh -s/u,
  )
})
