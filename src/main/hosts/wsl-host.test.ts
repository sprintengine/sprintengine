// A WSL machine answers through its helper and its distribution's Studio
// server. These cases pin what main asks each (and in which form: Linux paths,
// argv arrays, deadlines) and how its answers come back, with stand-ins.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import {
  STUB_AGENT_STATE_SOCKET,
  STUB_HELPER_INFO,
  STUB_PLUGIN_COPY,
  STUB_SERVER_DATA_DIR,
  STUB_SERVER_FACTS,
  STUB_SERVER_NODE,
  STUB_SERVER_RESOURCES,
  STUB_SESSION_DIR,
  STUB_PID_DIR,
  type StubTerminalHostHandlers,
  stubWslDistributionLink,
  stubWslHelper,
} from '../../../tests/wsl-helper-stub'
import { createPluginRegistry } from '../plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from '../plugin-registry-instance'
import { createWslHost, nativeGitOutput, wslGitArg, wslHostState } from './wsl-host'
import type { StudioTerminalPluginCopy } from '../../../packages/studio-protocol/src/environment-access'
import { WslSetupError } from './wsl-setup-error'

let temp = ''

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-wsl-host-'))
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(temp, 'no-user-plugins'),
  })
  __setPluginRegistryForTest(registry, registry.loadSync())
})

afterAll(() => {
  __resetPluginRegistryForTest()
  rmSync(temp, { recursive: true, force: true })
})

/** A stand-in for the core's WSL servers, answering `socket` for the agent-state socket. */
function distributionLink(
  socket: () => string | null = () => STUB_AGENT_STATE_SOCKET,
  terminal: StubTerminalHostHandlers = {},
) {
  return stubWslDistributionLink(() => ({ ...STUB_SERVER_FACTS, agentStateSocket: socket() }), terminal)
}

function hostWith(
  handlers: Parameters<typeof stubWslHelper>[1],
  extra: {
    /** What the server's plugin copy answers; 'fails' throws. */
    plugin?: StudioTerminalPluginCopy | 'fails'
    launcher?: 'written' | 'failed'
    skills?: () => readonly string[]
    socket?: () => string | null
    terminal?: StubTerminalHostHandlers
  } = {},
) {
  const helper = stubWslHelper('Debian', handlers)
  const distribution = distributionLink(extra.socket, {
    pluginCopy: () => {
      if (extra.plugin === 'fails') throw new Error('the server could not write it')
      return extra.plugin ?? STUB_PLUGIN_COPY
    },
    ...extra.terminal,
  })
  const launchers: Array<{ node: string; payload: string }> = []
  const host = createWslHost('Debian', {
    readSettings: () => undefined,
    listed: () => undefined,
    helper,
    distribution,
    enabledSkills: extra.skills ?? (() => []),
    survivorDelayMs: 0,
    ensureLauncher: async (_home, server) => {
      launchers.push({ node: server.nodePath, payload: server.resourcesDir })
      if (extra.launcher === 'failed') throw new Error('the distribution refused the write')
    },
  })
  const pluginAsks = () => distribution.asked.filter((ask) => ask.method === 'pluginCopy')
  return { helper, host, distribution, pluginAsks, launchers }
}

test('a git argument that is a Windows path crosses as the path in the distribution', () => {
  assert.equal(
    wslGitArg('C:\\Users\\dev\\repo\\.sprintengine-worktrees\\x'),
    '/mnt/c/Users/dev/repo/.sprintengine-worktrees/x',
  )
  assert.equal(wslGitArg('\\\\wsl.localhost\\Ubuntu\\home\\dev\\wt'), '/home/dev/wt')
  assert.equal(wslGitArg('--git-dir=C:\\repo\\.git'), '--git-dir=/mnt/c/repo/.git')
  assert.equal(wslGitArg('status'), 'status')
  assert.equal(wslGitArg(':(literal)src/[id].tsx'), ':(literal)src/[id].tsx')
  assert.equal(wslGitArg('origin/main'), 'origin/main')
})

test("git's absolute paths come back as Windows opens them", () => {
  assert.equal(
    nativeGitOutput(['rev-parse', '--show-toplevel'], '/home/dev/repo\n', 'Ubuntu'),
    '//wsl.localhost/Ubuntu/home/dev/repo\n',
  )
  assert.equal(
    nativeGitOutput(['rev-parse', '--show-toplevel'], '/mnt/c/Users/dev/repo\n', 'Ubuntu'),
    'C:/Users/dev/repo\n',
  )
  assert.equal(nativeGitOutput(['rev-parse', 'HEAD'], 'abc123\n', 'Ubuntu'), 'abc123\n', 'a sha is not a path')
  assert.equal(
    nativeGitOutput(
      ['worktree', 'list', '--porcelain'],
      'worktree /home/dev/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/dev/wt\n',
      'Ubuntu',
    ),
    'worktree //wsl.localhost/Ubuntu/home/dev/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree //wsl.localhost/Ubuntu/home/dev/wt\n',
  )
  assert.equal(nativeGitOutput(['status', '--porcelain'], ' M /not/a/path\n', 'Ubuntu'), ' M /not/a/path\n')
})

test('with -z every worktree record comes back native, not only the first', () => {
  // What `git worktree list --porcelain -z` prints: NUL after each field, and
  // a second NUL between worktrees.
  const listing = [
    'worktree /home/dev/repo',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /home/dev/repo/.sprintengine-worktrees/repo/fix',
    'HEAD def',
    'branch refs/heads/fix',
    '',
    'worktree /mnt/c/Users/dev/other',
    'HEAD 123',
    'detached',
    '',
    '',
  ].join('\0')
  const native = nativeGitOutput(['worktree', 'list', '--porcelain', '-z'], listing, 'Ubuntu').split('\0')
  assert.deepEqual(
    native.filter((field) => field.startsWith('worktree ')),
    [
      'worktree //wsl.localhost/Ubuntu/home/dev/repo',
      'worktree //wsl.localhost/Ubuntu/home/dev/repo/.sprintengine-worktrees/repo/fix',
      'worktree C:/Users/dev/other',
    ],
  )
  assert.equal(native.length, listing.split('\0').length, 'the record structure is kept')
  assert.ok(!native.join('\0').includes('\n'), 'no newline is invented')
})

test("git's subcommand is read past its global options, so a -c value is never taken for it", () => {
  assert.equal(
    nativeGitOutput(['-c', 'core.quotepath=off', 'rev-parse', '--show-toplevel'], '/home/dev/repo\n', 'Ubuntu'),
    '//wsl.localhost/Ubuntu/home/dev/repo\n',
  )
  assert.equal(
    nativeGitOutput(['-C', '/home/dev/repo', 'worktree', 'list', '--porcelain'], 'worktree /home/dev/wt\n', 'Ubuntu'),
    'worktree //wsl.localhost/Ubuntu/home/dev/wt\n',
  )
  // A -c value that looks like a subcommand is still only a value.
  assert.equal(
    nativeGitOutput(['-c', 'rev-parse', 'status', '--porcelain'], ' M /x\n', 'Ubuntu'),
    ' M /x\n',
    'status output is left alone',
  )
})

test("git's stdin crosses to the helper as base64, byte for byte", async () => {
  const { helper, host } = hostWith({ git: () => ({ code: 0, stdout: 'a\0', stderr: '', timedOut: false }) })
  const patch = 'diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-é\r\n+ü\r\n'
  await host.runGit('\\\\wsl.localhost\\Debian\\home\\dev\\repo', ['apply', '--cached', '-'], {
    timeoutMs: null,
    env: {},
    stdin: patch,
  })
  const params = helper.requests[0].params as { stdinB64?: string }
  assert.equal(Buffer.from(params.stdinB64 ?? '', 'base64').toString('utf8'), patch)
  await host.runGit('\\\\wsl.localhost\\Debian\\home\\dev\\repo', ['status'], { timeoutMs: 1_000, env: {} })
  assert.equal('stdinB64' in (helper.requests[1].params as object), false, 'no stdin, no field')
})

test('a distribution row reads as a host state', () => {
  assert.equal(wslHostState({ name: 'Ubuntu', isDefault: true, state: 'Running', version: 2 }).state, 'ready')
  assert.equal(wslHostState({ name: 'Ubuntu', isDefault: true, state: 'Stopped', version: 2 }).state, 'stopped')
  assert.equal(wslHostState({ name: 'Ubuntu', isDefault: true, state: 'Converting', version: 2 }).state, 'starting')
  assert.equal(wslHostState(undefined).state, 'unavailable')
})

test('git runs through the helper with Linux paths, the runner env and its deadline; a write keeps none', async () => {
  const { helper, host } = hostWith({
    git: () => ({ code: 0, stdout: '/home/dev/repo\n', stderr: '', timedOut: false }),
  })
  const git = await host.runGit('\\\\wsl.localhost\\Debian\\home\\dev\\repo', ['rev-parse', '--show-toplevel'], {
    timeoutMs: 15_000,
    env: { LC_ALL: 'C' },
  })
  assert.equal(git.stdout, '//wsl.localhost/Debian/home/dev/repo\n')
  assert.deepEqual(helper.requests[0], {
    method: 'git',
    params: { cwd: '/home/dev/repo', args: ['rev-parse', '--show-toplevel'], timeoutMs: 15_000, env: { LC_ALL: 'C' } },
    timeoutMs: 25_000,
  })
  await host.runGit('C:\\repo', ['worktree', 'add', 'C:\\repo\\wt'], { timeoutMs: null, env: {} })
  assert.deepEqual(helper.requests[1].params, {
    cwd: '/mnt/c/repo',
    args: ['worktree', 'add', '/mnt/c/repo/wt'],
    timeoutMs: null,
    env: {},
  })
  assert.equal(helper.requests[1].timeoutMs, null, 'main waits as long as the write takes')
})

test('a command is an argv run by the helper, and a helper that cannot start is a failed run, not a throw', async () => {
  const { helper, host } = hostWith({
    run: () => ({ code: 0, stdout: 'git version 2.43.0\n', stderr: '', timedOut: false }),
  })
  const outcome = await host.runCommand(['git', '--version'], { timeoutMs: 5_000, cwd: 'C:\\repo' })
  assert.equal(outcome.stdout, 'git version 2.43.0\n')
  assert.deepEqual(helper.requests[0].params, { argv: ['git', '--version'], cwd: '/mnt/c/repo', timeoutMs: 5_000 })
  helper.failWith = new WslSetupError("Couldn't set up WSL: no network to download Node.js", {
    fatal: true,
    code: 'node-download',
  })
  await helper.shutdown()
  const failed = await host.runCommand(['git', '--version'], { timeoutMs: 5_000 })
  assert.equal(failed.spawnFailed, true)
  assert.match(failed.stderr, /no network to download Node\.js/u)
  assert.equal(host.summary().state, 'unavailable', 'the machine says why it cannot be used')
  assert.match(host.summary().reason ?? '', /no network/u)
})

test("the reaper reads sessions by pid-file key from the distribution's server; a failed read, or none running, holds them all", async () => {
  let fail = false
  const { host, distribution } = hostWith(
    {},
    {
      terminal: {
        processes: () => {
          if (fail) throw new Error('gone')
          return { verdicts: { 'sid-a-1': 'listening_port', 'sid-b-2': null } }
        },
      },
    },
  )
  const refs = [
    { sessionId: 'a', rootPid: 11, startupScriptPath: 'C:\\Users\\dev\\terminal-startup\\sid-a-1.sh' },
    { sessionId: 'b', rootPid: 12, startupScriptPath: 'C:\\Users\\dev\\terminal-startup\\sid-b-2.sh' },
    { sessionId: 'c', rootPid: 13, startupScriptPath: 'C:\\Users\\dev\\terminal-startup\\sid-c-3.sh' },
    { sessionId: 'd', rootPid: 14 },
  ]
  assert.equal((await host.probeSubtrees(refs)).size, 0, 'a server that is not running is not started to be asked')
  assert.equal(distribution.asked.length, 0)
  distribution.running = true
  const verdicts = await host.probeSubtrees(refs)
  assert.deepEqual(distribution.asked[0], {
    method: 'processes',
    params: { op: 'snapshot', keys: ['sid-a-1', 'sid-b-2', 'sid-c-3'] },
    started: false,
  })
  assert.equal(verdicts.get('a'), 'listening_port')
  assert.equal(verdicts.get('b'), null)
  assert.equal(verdicts.has('c'), false, 'no verdict is undetermined')
  assert.equal(verdicts.has('d'), false, 'no pid file, no verdict')
  fail = true
  assert.equal((await host.probeSubtrees(refs)).size, 0)
})
test('the survivor kill names the session id and the pid file, and does nothing without either', async () => {
  const { host, distribution } = hostWith({}, { terminal: { processes: () => ({ killed: [101, 102] }) } })
  assert.deepEqual(
    await host.killSessionSurvivors('11111111-2222', { startupScriptPath: 'C:\\x\\terminal-startup\\k-1.sh' }),
    [101, 102],
  )
  assert.deepEqual(distribution.asked[0].params, { op: 'kill', cliSessionId: '11111111-2222', key: 'k-1' })
  // A plain terminal has no CLI session: its shell's subtree is still ended.
  await host.killSessionSurvivors('', { startupScriptPath: 'C:\\x\\terminal-startup\\k-2.sh' })
  assert.deepEqual(distribution.asked[1].params, { op: 'kill', cliSessionId: '', key: 'k-2' })
  assert.deepEqual(await host.killSessionSurvivors(''), [])
  assert.equal(distribution.asked.length, 2)
})
test('CLI detection is one request, read with the same parser as every probe', async () => {
  const { helper, host } = hostWith({
    'cli.detect': () => ({
      results: [
        { found: true, path: '/home/dev/.local/bin/claude', output: 'Welcome\n2.1.4 (Claude Code)', timedOut: false },
        { found: false },
        { error: 'EACCES' },
      ],
    }),
  })
  const results = await host.detectClis([
    { cli: 'claude-code' },
    { cli: 'codex', runtime: { command: '/opt/codex/bin/codex' } },
    { cli: 'opencode' },
    { cli: 'not-a-cli' },
  ])
  const asked = (helper.requests[0].params as { requests: Array<{ binary: string }> }).requests
  assert.deepEqual(
    asked.map((request) => request.binary),
    ['claude', '/opt/codex/bin/codex', 'opencode'],
  )
  assert.deepEqual(
    results.map((result) => [result.cli, result.installed, result.version, result.resolvedPath, result.hostId]),
    [
      ['claude-code', true, '2.1.4 (Claude Code)', '/home/dev/.local/bin/claude', 'wsl:Debian'],
      ['codex', false, null, null, 'wsl:Debian'],
      ['opencode', false, null, null, 'wsl:Debian'],
      ['not-a-cli', false, null, null, 'wsl:Debian'],
    ],
  )
  assert.equal(results[1].error, null, 'not found is an answer')
  assert.equal(results[2].error, 'EACCES', 'a failed check is not "not installed"')
  assert.match(results[3].error ?? '', /No plugin manifest/u)
  assert.equal('force' in (helper.requests[0].params as object), false, 'a plain read may reuse remembered versions')
})

// The helper keeps each binary's `--version` while its size and mtime stand
// still, and an npm update can leave both of a launcher script unchanged: the
// check after an update, and Re-check, must make it run `--version` again.
test('a forced detection tells the helper to look again', async () => {
  const { helper, host } = hostWith({ 'cli.detect': () => ({ results: [{ found: false }] }) })
  await host.detectClis([{ cli: 'claude-code' }], { force: true })
  assert.equal((helper.requests[0].params as { force?: boolean }).force, true)
})

test("prepare asks the distribution's server for the plugin copy with the chosen skills, and exposes the integration", async () => {
  let skills: readonly string[] = ['studio-canvas']
  const { host, pluginAsks, launchers } = hostWith(
    { home: () => ({ home: '/home/dev', env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work', BAD: 'relative' } }) },
    { skills: () => skills },
  )
  assert.equal(host.agentIntegration(), null, 'nothing before the helper is up')
  await host.prepare()
  // The server builds it from its own resources: only the skill ids cross.
  assert.deepEqual(
    pluginAsks().map((ask) => ask.params),
    [['studio-canvas']],
  )
  // The launcher runs the server's Node on its tree's resources.
  assert.deepEqual(launchers, [{ node: STUB_SERVER_NODE, payload: STUB_SERVER_RESOURCES }])
  const integration = host.agentIntegration()
  assert.ok(integration)
  assert.equal(
    integration.agentStateSocketPath,
    STUB_AGENT_STATE_SOCKET,
    "hooks report to the distribution's server, which relays them here",
  )
  assert.equal(integration.commandRuntime.executable, STUB_SERVER_NODE)
  assert.equal(
    integration.commandRuntime.toCommandPath?.('\\\\wsl.localhost\\Debian\\home\\dev\\repo\\x.mjs'),
    '/home/dev/repo/x.mjs',
  )
  assert.deepEqual(integration.pluginDirs, STUB_PLUGIN_COPY.pluginDirs)
  // The one-skill plugins travel with it, so a WSL launch that invokes
  // `/backlog` is handed the distribution's own copy of that skill.
  assert.deepEqual(integration.skillPluginDirs, STUB_PLUGIN_COPY.skillPluginDirs)
  assert.equal(integration.statusLineScriptPath, STUB_PLUGIN_COPY.statusLineScriptPath)
  // Hooks and the gateway run the distribution's own launcher, never the
  // pinned Node or this version's payload folder, which an update prunes.
  assert.deepEqual(integration.commandRuntime.launcher, {
    path: '/home/dev/.sprintengine/bin/studio-run',
    shell: 'posix',
  })
  assert.deepEqual(integration.studioMcpEntry, {
    command: '/bin/sh',
    args: ['/home/dev/.sprintengine/bin/studio-run', 'mcp'],
    // The distribution's own gateway, found by its server's data directory.
    env: { SPRINTENGINE_USER_DATA_DIR: STUB_SERVER_DATA_DIR },
    envVarNames: ['SPRINTENGINE_MCP_CHANNEL_TOKEN'],
  })
  assert.equal(JSON.stringify(integration.studioMcpEntry).includes(STUB_SERVER_RESOURCES), false)
  assert.deepEqual(integration.home, {
    host: '/home/dev',
    native: '\\\\wsl.localhost\\Debian\\home\\dev',
    env: { CLAUDE_CONFIG_DIR: '\\\\wsl.localhost\\Debian\\home\\dev\\.claude-work' },
  })
  const target = host.launchTarget()
  assert.equal(target.kind === 'wsl' && target.integration?.agentStateSocketPath, STUB_AGENT_STATE_SOCKET)
  // Its launch files and pid files are the distribution's server's.
  assert.equal(target.kind === 'wsl' && target.sessionDir, STUB_SESSION_DIR)
  assert.equal(target.kind === 'wsl' && target.pidDir, STUB_PID_DIR)

  // A second prepare against the same helper and server does nothing again.
  await host.prepare()
  assert.equal(pluginAsks().length, 1)
  // A skill switched on since is a different copy: the next launch asks again.
  skills = ['studio-canvas', 'studio-backlog']
  await host.prepare()
  assert.deepEqual(pluginAsks()[1]?.params, ['studio-canvas', 'studio-backlog'])
})

test("a launcher that could not be written leaves hooks and the gateway naming the server's Node", async () => {
  const { host } = hostWith({ home: () => ({ home: '/home/dev' }) }, { launcher: 'failed' })
  await host.prepare()
  const integration = host.agentIntegration()
  assert.ok(integration)
  assert.equal(integration.commandRuntime.launcher, undefined, 'no command may name a launcher that is not there')
  assert.equal(integration.studioMcpEntry.command, STUB_SERVER_NODE)
  assert.deepEqual(integration.studioMcpEntry.args, [`${STUB_SERVER_RESOURCES}/automation/mcp-stdio-bridge.mjs`])
})

test('a helper that cannot start fails prepare with its reason, and one without the copy still launches', async () => {
  const { helper, host } = hostWith({}, { plugin: 'fails' })
  helper.failWith = new WslSetupError("Couldn't set up WSL: WSL is not installed on this PC.", {
    fatal: true,
    code: 'wsl-missing',
  })
  await assert.rejects(host.prepare(), /WSL is not installed on this PC/u)
  assert.equal(host.agentIntegration(), null)

  const ok = hostWith({ home: () => ({ home: '/home/dev' }) }, { plugin: 'fails' })
  await ok.host.prepare()
  assert.deepEqual(
    ok.host.agentIntegration()?.pluginDirs,
    [],
    'no copy, no --plugin-dir: the workspace install carries it',
  )
})

test('prepare does not finish on a preparation for a helper that restarted under it', async () => {
  // The helper restarts while `home` is being read: the first preparation is
  // for a helper that is gone, and a launch must not go ahead without hooks,
  // socket or gateway because of it.
  const first = { ...STUB_HELPER_INFO }
  const second = { ...STUB_HELPER_INFO, appDir: '/home/dev/.local/share/sprintengine-studio/0.4.1' }
  let current = first
  let homes = 0
  const helper = stubWslHelper('Debian', {
    home: () => {
      homes += 1
      if (homes === 1) current = second
      return { home: '/home/dev' }
    },
  })
  helper.info = () => current
  helper.start = async () => current
  const host = createWslHost('Debian', {
    readSettings: () => undefined,
    listed: () => undefined,
    helper,
    distribution: distributionLink(),
    enabledSkills: () => [],
    survivorDelayMs: 0,
  })
  await host.prepare()
  assert.equal(homes, 2, 'prepared again for the helper that is running now')
  assert.equal(host.agentIntegration()?.home.host, '/home/dev', 'and is ready for it')
  assert.equal(host.agentIntegration()?.agentStateSocketPath, STUB_AGENT_STATE_SOCKET)

  // One that keeps restarting fails with a reason rather than looping.
  let flips = 0
  const flapping = stubWslHelper('Debian', {
    home: () => {
      flips += 1
      current = { ...STUB_HELPER_INFO, appDir: `/run/flip-${flips}` }
      return { home: '/home/dev' }
    },
  })
  flapping.info = () => current
  flapping.start = async () => current
  const unstable = createWslHost('Debian', {
    readSettings: () => undefined,
    listed: () => undefined,
    helper: flapping,
    distribution: distributionLink(),
    enabledSkills: () => [],
  })
  await assert.rejects(unstable.prepare(), /kept restarting/u)
})

test("a launch is prepared against the distribution's server, and a server that changed builds its copy again", async () => {
  let socket: string | null = STUB_AGENT_STATE_SOCKET
  const { host, distribution, pluginAsks } = hostWith({ home: () => ({ home: '/home/dev' }) }, { socket: () => socket })
  await host.prepare()
  assert.equal(distribution.connects(), 1, 'the server is started for the launch')
  assert.equal(pluginAsks().length, 1, 'the copy is built by the server the launch runs against')

  // The server came back with its socket elsewhere: the next launch prepares
  // again, so its hooks never name a socket nothing listens on.
  socket = '/tmp/sprintengine-1000/agent-state-abc.sock'
  await host.prepare()
  assert.equal(pluginAsks().length, 2)
  assert.equal(host.agentIntegration()?.agentStateSocketPath, socket)

  // A server whose socket did not open: no launch that would report nowhere.
  socket = null
  await assert.rejects(host.prepare(), /could not open the socket its terminal agents report to/u)
})

test('a host with no distribution server prepares no launch, and still reads the home', async () => {
  const helper = stubWslHelper('Debian', { home: () => ({ home: '/home/dev' }) })
  const host = createWslHost('Debian', { readSettings: () => undefined, listed: () => undefined, helper })
  await assert.rejects(host.prepare(), /WSL terminals start where Studio's server runs/u)
  assert.equal(host.agentIntegration(), null)
  assert.equal((await host.homeDir())?.host, '/home/dev', 'the home needs no launch')
})

test("a launch's files are written into the distribution server's launch directory by relative name, and nowhere else", async () => {
  const { host, distribution } = hostWith({
    home: () => ({ home: '/home/dev' }),
  })
  await host.prepare()
  const launchAsks = () => distribution.asked.filter((ask) => ask.method !== 'pluginCopy')
  const dir = STUB_SESSION_DIR
  await host.writeLaunchFiles?.([
    { path: `${dir}/sid-1-17.sh`, content: "export A='1'\n" },
    { path: `${dir}/host-context-sid-1/rules/host-context.mdc`, content: 'é' },
  ])
  assert.deepEqual(launchAsks()[0], {
    method: 'launchFiles',
    params: {
      write: [
        { path: 'sid-1-17.sh', b64: Buffer.from("export A='1'\n").toString('base64') },
        { path: 'host-context-sid-1/rules/host-context.mdc', b64: Buffer.from('é').toString('base64') },
      ],
    },
    started: true,
  })
  await assert.rejects(
    host.writeLaunchFiles?.([{ path: '/home/dev/.bashrc', content: 'x' }]) ?? Promise.reject(new Error('none')),
    /not inside the launch directory/u,
  )
  host.discardLaunchFiles?.([`${dir}/sid-1-17.sh`, `${dir}/host-context-sid-1`, '/etc/passwd', undefined])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(launchAsks()[1], {
    method: 'launchFiles',
    params: { remove: ['sid-1-17.sh', 'host-context-sid-1'] },
    started: false,
  })
  // A server that is not running is not started to tidy.
  distribution.running = false
  host.discardLaunchFiles?.([`${dir}/sid-2-18.sh`])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(launchAsks().length, 2)
})
test('at quit the survivor kill gives no grace and starts nothing', async () => {
  const { host, distribution } = hostWith({}, { terminal: { processes: () => ({ killed: [7] }) } })
  assert.deepEqual(
    await host.killSessionSurvivors('', { startupScriptPath: '/x/sessions/k-1.sh', quitting: true }),
    [],
    'no server running: nothing is started for it',
  )
  assert.equal(distribution.running, false)
  distribution.running = true
  const started = Date.now()
  assert.deepEqual(
    await host.killSessionSurvivors('', { startupScriptPath: '/x/sessions/k-1.sh', quitting: true }),
    [7],
  )
  assert.ok(Date.now() - started < 1_000)
})
test("a WSL host's launch tokens are its distribution server's, and its directory watches its helper's", async () => {
  const { helper, host, distribution } = hostWith({})
  assert.equal(host.issueChannelToken?.(null), undefined, 'a launch with no agent has nothing to prove')
  const identity = { workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'codex' }
  const token = host.issueChannelToken?.(identity) ?? ''
  assert.deepEqual(distribution.tokens.get(token), identity)
  host.revokeChannelToken?.(token)
  assert.equal(distribution.tokens.size, 0)
  const heard: Array<string | null> = []
  const watcher = host.watchDir?.('\\\\wsl.localhost\\Debian\\home\\dev\\repo\\.git', true, (name) => heard.push(name))
  assert.ok(watcher)
  const errors: Error[] = []
  watcher.on('error', (error) => errors.push(error))
  assert.equal(helper.watches[0].path, '/home/dev/repo/.git', 'watched as Linux names it')
  assert.equal(helper.watches[0].recursive, true)
  helper.watches[0].listener('HEAD')
  assert.deepEqual(heard, ['HEAD'])
  helper.watches[0].onError()
  assert.equal(errors.length, 1)
  watcher.close()
  assert.equal(helper.watches[0].closed, true)
})

test("a session holds the distribution's server, and lets it go", () => {
  const { host, distribution } = hostWith({})
  host.retainSession('sid#1')
  assert.deepEqual([...distribution.holds], ['Debian/sid#1'])
  host.releaseSession('sid#1')
  assert.equal(distribution.holds.size, 0)
})

test("a WSL host's CLI runtime is its own command, tagged with the machine", () => {
  const host = createWslHost('Ubuntu', {
    readSettings: () => ({ enabled: true, cliCommands: { codex: ' /home/dev/.local/bin/codex ' }, env: {} }),
    listed: () => undefined,
    helper: stubWslHelper('Ubuntu'),
  })
  assert.deepEqual(host.cliRuntime('codex', { command: 'C:\\tools\\codex.cmd' }), {
    command: '/home/dev/.local/bin/codex',
    hostId: 'wsl:Ubuntu',
  })
  assert.deepEqual(host.cliRuntime('claude-code', undefined), { command: '', hostId: 'wsl:Ubuntu' })
})
