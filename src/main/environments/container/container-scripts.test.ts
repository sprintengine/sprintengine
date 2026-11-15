import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import {
  copyRepoInScript,
  dockerStatusScript,
  execSessionScript,
  parseContainerList,
  parseDockerStatus,
  pushOutScript,
  removeContainerScript,
  runContainerScript,
  workFolderName,
} from './container-scripts'
import { dockerSearchPath, localHostRunner, runOnHost, shellQuote, sshRemoteLine } from './docker-host'

const scratch = mkdtempSync(join(tmpdir(), 'se-container-scripts-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A directory holding stand-ins for `docker` and `colima`, each a script answering as told. */
function fakeBin(name: string, tools: Record<string, string>): string {
  const dir = join(scratch, name)
  execFileSync('mkdir', ['-p', dir])
  for (const [tool, body] of Object.entries(tools)) {
    const path = join(dir, tool)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  return dir
}

const IMAGE = 'sprintengine-studio-agent:0123456789ab'

async function statusWith(dir: string) {
  const run = localHostRunner({ env: { PATH: `${dir}:/usr/bin:/bin`, HOME: scratch }, searchPath: false })
  const result = await runOnHost(run, dockerStatusScript(IMAGE), { timeoutMs: 10_000 })
  return parseDockerStatus(result.stdout, 'this Mac')
}

test('a word survives the shell, whatever it holds', () => {
  for (const word of ["it's", 'a b', '$(touch x)', '`id`', '"q"', 'back\\slash', '', 'line\nbreak'])
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(word)}`], { encoding: 'utf8' }), word)
  assert.throws(() => shellQuote('nul\0'))
  // An SSH machine's login shell is handed the script as one word to `sh -c`.
  assert.equal(
    execFileSync('/bin/sh', ['-c', sshRemoteLine('echo \'one\' "two"')], { encoding: 'utf8' }).trim(),
    'one two',
  )
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
    fakeBin('no-image', { docker: 'case "$1" in version) echo 28.0.0 ;; image) exit 1 ;; esac' }),
  )
  assert.equal(noImage.imageReady, false)
  assert.equal(noImage.words, 'Docker 28.0.0 is running on this Mac.')
  // A login profile's greeting before the answer is not the answer.
  assert.equal(parseDockerStatus('Welcome to build-box\n@@docker missing\n', 'build-box').state, 'missing')
  assert.equal(parseDockerStatus('', 'build-box').state, 'unreachable')
})

test('only names Studio minted are spelled bare in a script', () => {
  assert.throws(() => execSessionScript('sprintengine-x; rm -rf /'))
  assert.throws(() => removeContainerScript('postgres'))
  assert.throws(() =>
    runContainerScript({ name: 'sprintengine-0123456789abcdef', image: 'x; id', machineId: '0123456789abcdef' }),
  )
  assert.throws(() =>
    copyRepoInScript({
      source: '/x',
      name: 'sprintengine-0123456789abcdef',
      path: '/etc/passwd',
      branch: 'b',
    }),
  )
  assert.throws(() =>
    pushOutScript({
      source: '/x',
      name: 'sprintengine-0123456789abcdef',
      path: '/home/node/work/x',
      branch: 'b',
      ref: 'refs/heads/main',
    }),
  )
  // A folder's path is a quoted word, whatever it holds.
  const script = copyRepoInScript({
    source: "/Users/dev/it's $(here)",
    name: 'sprintengine-0123456789abcdef',
    path: '/home/node/work/x',
    branch: 'studio/container-01234567',
  })
  assert.ok(script.includes(`src='/Users/dev/it'\\''s $(here)'`))
  assert.match(
    runContainerScript({ name: 'sprintengine-0123456789abcdef', image: IMAGE, machineId: '0123456789abcdef' }),
    /--label sprintengine\.studio\.container=1 /u,
  )
  // Never a mount of the host's folders.
  assert.doesNotMatch(
    runContainerScript({ name: 'sprintengine-0123456789abcdef', image: IMAGE, machineId: '0123456789abcdef' }),
    /-v |--mount|--volume/u,
  )
})

test("a container is removed only when it carries Studio's label", async () => {
  const dir = fakeBin('labels', {
    docker: [
      'case "$1 $2" in',
      '  "inspect -f")',
      '    case "$3" in',
      '      \'{{.Id}}\') [ "$4" = sprintengine-aaaaaaaaaaaaaaaa ] && exit 1; echo id ;;',
      '      *) [ "$4" = sprintengine-bbbbbbbbbbbbbbbb ] && echo 1 || echo "" ;;',
      '    esac ;;',
      '  "rm -f") echo "removed $3" >&2 ;;',
      'esac',
    ].join('\n'),
  })
  const run = localHostRunner({ env: { PATH: `${dir}:/usr/bin:/bin` }, searchPath: false })
  const gone = await runOnHost(run, removeContainerScript('sprintengine-aaaaaaaaaaaaaaaa'))
  assert.match(gone.stdout, /@@removed absent/u)
  const ours = await runOnHost(run, removeContainerScript('sprintengine-bbbbbbbbbbbbbbbb'))
  assert.match(ours.stdout, /@@removed yes/u)
  const theirs = await runOnHost(run, removeContainerScript('sprintengine-cccccccccccccccc'))
  assert.match(theirs.stdout, /@@removed not-ours/u)
  assert.doesNotMatch(theirs.stderr, /removed/u)
})

test('the containers Docker lists, and the folder a repository is copied to', () => {
  assert.deepEqual(
    parseContainerList(
      [
        'noise',
        '@@c sprintengine-0123456789abcdef\t0123456789abcdef\tUp 3 minutes',
        '@@c sprintengine-fedcba9876543210\t\tExited (0) 2 hours ago',
        '@@c postgres\t\tUp',
      ].join('\n'),
    ),
    [
      { name: 'sprintengine-0123456789abcdef', machineId: '0123456789abcdef', status: 'Up 3 minutes' },
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
  assert.throws(() => execSessionScript('sprintengine-0123456789abcdef', { passEnv: ['A; id'] }))
  const dir = fakeBin('exec', {
    docker: [
      'case "$1" in',
      '  start) exit 0 ;;',
      '  exec) echo "args: $*"; echo "env: ${CLAUDE_CODE_OAUTH_TOKEN:-unset}" ;;',
      'esac',
    ].join('\n'),
  })
  const run = localHostRunner({ env: { PATH: `${dir}:/usr/bin:/bin` }, searchPath: false })
  const result = await runOnHost(
    (script, options) => run(script, { ...options, env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-secret' } }),
    execSessionScript('sprintengine-0123456789abcdef', { passEnv: ['CLAUDE_CODE_OAUTH_TOKEN'] }),
  )
  assert.match(
    result.stdout,
    /args: exec -i -u node -w \/home\/node -e HOME=\/home\/node -e CLAUDE_CODE_OAUTH_TOKEN sprintengine-0123456789abcdef sh -s/u,
  )
  assert.doesNotMatch(result.stdout.split('\n')[0]!, /sk-ant-secret/u)
  assert.match(result.stdout, /env: sk-ant-secret/u)
})
