import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import {
  buildImageScript,
  copyRepoInScript,
  dockerCommand,
  dockerStatusScript,
  EXEC_READY_MARKER,
  execSessionScript,
  listContainersScript,
  parseContainerList,
  parseDockerStatus,
  pushOutScript,
  removalOutcome,
  removeContainerScript,
  runContainerScript,
  workFolderName,
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
  assert.throws(() => copyRepoInScript({ source: '/x', name: NAME, path: '/etc/passwd', branch: 'b' }))
  assert.throws(() =>
    pushOutScript({ source: '/x', name: NAME, path: '/home/node/work/x', branch: 'b', ref: 'refs/heads/main' }),
  )
  // A folder's path is a quoted word, whatever it holds.
  const script = copyRepoInScript({
    source: "/Users/dev/it's $(here)",
    name: NAME,
    path: '/home/node/work/x',
    branch: 'studio/container-01234567',
  })
  assert.ok(script.includes(`src='/Users/dev/it'\\''s $(here)'`))
})

test('a container is made with only the capabilities its server needs to run agents as another user, never with a mount, on the context it was asked under', () => {
  const run = runContainerScript({ name: NAME, image: IMAGE, machineId: '0123456789abcdef', context: 'colima' })
  assert.match(run, /^docker --context colima run -d /u)
  // SETUID and SETGID to start each program as the agent's user, KILL to stop
  // it; held by the server (root) alone, and none gained through a setuid file.
  assert.match(
    run,
    / --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges /u,
  )
  assert.equal(run.match(/--cap-add/gu)?.length, 3)
  assert.match(run, /--label sprintengine\.studio\.container=1 /u)
  assert.doesNotMatch(run, /-v |--mount|--volume|--privileged|--user/u)
  // The host's default context is not named, so DOCKER_HOST still decides it.
  assert.equal(dockerCommand(null), 'docker')
  assert.equal(dockerCommand('default'), 'docker')
  for (const script of [
    execSessionScript(NAME, { context: 'colima' }),
    execSessionScript(NAME, { context: 'colima', separateUsers: true }),
    removeContainerScript(NAME, 'colima'),
    listContainersScript('colima'),
    copyRepoInScript({ source: '/x', name: NAME, path: '/home/node/work/x', branch: 'b', context: 'colima' }),
    pushOutScript({
      source: '/x',
      name: NAME,
      path: '/home/node/work/x',
      branch: 'b',
      ref: 'refs/sprintengine/containers/0123456789abcdef',
      context: 'colima',
    }),
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

test('the containers Docker lists, and the folder a repository is copied to', () => {
  assert.deepEqual(
    parseContainerList(
      [
        'noise',
        `@@c ${NAME}\t0123456789abcdef\tUp 3 minutes`,
        '@@c sprintengine-fedcba9876543210\t\tExited (0) 2 hours ago',
        '@@c postgres\t\tUp',
      ].join('\n'),
    ),
    [
      { name: NAME, machineId: '0123456789abcdef', status: 'Up 3 minutes' },
      { name: 'sprintengine-fedcba9876543210', machineId: null, status: 'Exited (0) 2 hours ago' },
    ],
  )
  assert.equal(workFolderName('/Users/dev/demo app/'), 'demo-app')
  assert.equal(workFolderName('C:\\work\\repo'), 'repo')
  assert.equal(workFolderName('/Users/dev/..'), 'project')
  assert.equal(workFolderName(null), 'project')
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

test("the agent's login reaches a container's session by name: its value is in no command line", async () => {
  assert.throws(() => execSessionScript(NAME, { passEnv: ['A; id'] }))
  const dir = fakeBin('exec', {
    docker: [
      'case "$1" in',
      '  start) exit 0 ;;',
      '  exec) echo "args: $*"; echo "env: ${CLAUDE_CODE_OAUTH_TOKEN:-unset}" ;;',
      'esac',
    ].join('\n'),
  })
  const run = runnerFor(dir)
  const result = await runOnHost(
    (script, options) => run(script, { ...options, env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-secret' } }),
    execSessionScript(NAME, { passEnv: ['CLAUDE_CODE_OAUTH_TOKEN'] }),
  )
  assert.match(
    result.stdout,
    /args: exec -i -u node -w \/home\/node -e HOME=\/home\/node -e CLAUDE_CODE_OAUTH_TOKEN sprintengine-0123456789abcdef sh -s/u,
  )
  assert.doesNotMatch(
    result.stdout.split('\n').find((line) => line.startsWith('args:'))!,
    /sk-ant-secret/u,
  )
  assert.match(result.stdout, /env: sk-ant-secret/u)
})

test("the host's remote address is copied in without any credential, on stdin, never in a command line", async () => {
  const urls: Record<string, string> = {
    'https://dev:ghp_secret@github.com/acme/app.git': 'https://github.com/acme/app.git',
    'https://ghp_secret@github.com/acme/app.git': 'https://github.com/acme/app.git',
    'https://dev@github.com/acme/app.git': 'https://github.com/acme/app.git',
    'HTTP://u:p@example.com/app.git': 'HTTP://example.com/app.git',
    'git@github.com:acme/app.git': 'git@github.com:acme/app.git',
    'ssh://git@github.com/acme/app.git': 'ssh://git@github.com/acme/app.git',
    'ssh://git:ghp_secret@github.com/acme/app.git': 'ssh://git@github.com/acme/app.git',
  }
  let index = 0
  for (const [given, copied] of Object.entries(urls)) {
    const dir = fakeBin(`url-${index++}`, {
      git: [
        'case "$*" in',
        '  *rev-parse*) exit 0 ;;',
        '  *symbolic-ref*) echo main ;;',
        `  *"remote get-url"*) echo '${given}' ;;`,
        '  *"config user.name"*) echo Dev ;;',
        '  *"config user.email"*) echo dev@example.com ;;',
        '  *bundle*) echo "$*" > "$HOME/bundle-args"; printf BUNDLE ;;',
        'esac',
      ].join('\n'),
      // The container's side: its argv, then the three lines it reads first, then the bundle.
      docker: [
        'echo "docker-args: $*" >&2',
        'IFS= read -r url; IFS= read -r who; IFS= read -r mail',
        'echo "url=$url"; echo "who=$who"; echo "mail=$mail"; echo "rest=$(cat)"',
      ].join('\n'),
    })
    const result = await runOnHost(
      runnerFor(dir),
      copyRepoInScript({
        source: '/Users/dev/app',
        name: NAME,
        path: '/home/node/work/app',
        branch: 'studio/container-01234567',
      }),
    )
    assert.ok(result.stdout.split('\n').includes(`url=${copied}`), `${given}: ${result.stdout}`)
    assert.match(result.stdout, /^who=Dev$/mu)
    assert.match(result.stdout, /^mail=dev@example\.com$/mu)
    assert.match(result.stdout, /^rest=BUNDLE$/mu)
    assert.doesNotMatch(result.stdout, /ghp_secret|u:p@/u)
    assert.doesNotMatch(result.stderr, /github\.com|example\.com/u, 'the address is in no command line')
    // Only what the chat starts from: HEAD and its branch.
    assert.equal(
      execFileSync('cat', [join(scratch, 'bundle-args')], { encoding: 'utf8' }).trim(),
      '-C /Users/dev/app bundle create - HEAD refs/heads/main',
    )
  }
})

test("the branch comes out with every object checked before it lands in the person's repository", () => {
  const script = pushOutScript({
    source: '/x',
    name: NAME,
    path: '/home/node/work/x',
    branch: 'studio/container-01234567',
    ref: 'refs/sprintengine/containers/0123456789abcdef',
  })
  assert.match(script, /git -C "\$src" -c fetch\.fsckObjects=true fetch -q /u)
})

test("a container's exec channel: as root in root's home where the server and agent are separate users, as node in one made before", () => {
  const separate = execSessionScript(NAME, { passEnv: ['CLAUDE_CODE_OAUTH_TOKEN'], separateUsers: true })
  assert.match(
    separate,
    /^exec docker exec -i -u 0 -w \/root -e HOME=\/root -e CLAUDE_CODE_OAUTH_TOKEN sprintengine-[0-9a-f]{16} sh -s$/mu,
  )
  const before = execSessionScript(NAME, { passEnv: ['CLAUDE_CODE_OAUTH_TOKEN'] })
  assert.match(
    before,
    /^exec docker exec -i -u node -w \/home\/node -e HOME=\/home\/node -e CLAUDE_CODE_OAUTH_TOKEN /mu,
  )
  // The copy in is the agent's, readable and writable by its group (the server's) alone.
  const copy = copyRepoInScript({ source: '/x', name: NAME, path: '/home/node/work/x', branch: 'b' })
  assert.match(copy, /exec -i -u node /u)
  assert.ok(copy.includes('umask 007'))
})
