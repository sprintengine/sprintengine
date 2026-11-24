import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  ADOPTED_MIN_AGE_MS,
  LONG_RUNNING_MS,
  analyzeProcesses,
  describeProcess,
  identityFromEnvironment,
  parseLsofCwds,
  parseLsofListeners,
  parseLstart,
  parseMacProcesses,
  parseProcStat,
  type ProcessSnapshot,
  type ScannedProcess,
} from './agent-process-scan'
import { parseProcNetListeners } from './agent-process-reader'

// What the `processes` domain reads off a machine: the parsers on fixture
// output of `ps`, `lsof` and `/proc`, and which processes become rows.

const UID = 501
const LSTART = 'Wed Nov 11 23:23:52 2026'
const ENV_A =
  'PATH=/usr/bin HOME=/Users/dev SPRINTENGINE_WORKSPACE_ID=ws-a SPRINTENGINE_MCP_CHANNEL_TOKEN=secret SPRINTENGINE_AGENT_ID=agent-a SPRINTENGINE_CONVERSATION_SESSION_ID=conv_a'

test('the identity is read off an environment block, and nothing else of it is kept', () => {
  assert.deepEqual(identityFromEnvironment(` ${ENV_A}`), {
    workspaceId: 'ws-a',
    agentId: 'agent-a',
    sessionId: 'conv_a',
  })
  assert.deepEqual(identityFromEnvironment('A=1\0SPRINTENGINE_WORKSPACE_ID=ws-b\0'), { workspaceId: 'ws-b' })
  assert.equal(identityFromEnvironment('SPRINTENGINE_AGENT_ID=agent-a'), null)
  // A key inside another value is not the key.
  assert.equal(identityFromEnvironment('X=SPRINTENGINE_WORKSPACE_ID=ws-c'), null)
  assert.equal(identityFromEnvironment('SPRINTENGINE_WORKSPACE_ID=$(rm -rf)'), null)
})

test('lstart reads as local time to the second', () => {
  assert.equal(parseLstart(LSTART), new Date(2026, 10, 11, 23, 23, 52).getTime())
  assert.equal(parseLstart('Mon Nov  2 20:25:59 2026'), new Date(2026, 10, 2, 20, 25, 59).getTime())
  assert.ok(Number.isNaN(parseLstart('yesterday')))
})

test('ps -E is split where the command line ends, read from the same processes without -E', () => {
  const withEnv = [
    // An argument with spaces and an `=` in it: only what follows the command line is environment.
    `  ${UID}  3747     1  3745   5456 ${LSTART}     python3 -m http.server 8731 --title a=b c ${ENV_A}`,
    // npm sets its own title and the environment ps reads goes with it.
    `  ${UID}  4455     1  4454   2000 ${LSTART}     npm exec next dev                  `,
    // Another user's: never read.
    `  0  9000     1  9000   1000 ${LSTART}     /usr/sbin/daemon ${ENV_A}`,
    `  ${UID}  4600  4455  4454      0 ${LSTART}     <defunct>`,
    'garbage line',
  ].join('\n')
  const argsOnly = [
    ' 3747 python3 -m http.server 8731 --title a=b c',
    ' 4455 npm exec next dev                  ',
    ' 9000 /usr/sbin/daemon',
    ' 4600 <defunct>',
  ].join('\n')
  const parsed = parseMacProcesses(withEnv, argsOnly, UID)
  assert.deepEqual(
    parsed.map((entry) => entry.pid),
    [3747, 4455, 4600],
  )
  const server = parsed[0]!
  assert.equal(server.command, 'python3 -m http.server 8731 --title a=b c')
  assert.deepEqual(server.identity, { workspaceId: 'ws-a', agentId: 'agent-a', sessionId: 'conv_a' })
  assert.equal(server.rssBytes, 5456 * 1024)
  assert.equal(server.pgid, 3745)
  assert.equal(parsed[1]!.identity, null)
  assert.equal(parsed[2]!.defunct, true)
  // A process whose two reads disagree keeps no identity rather than a guessed one.
  const raced = parseMacProcesses(withEnv, ' 3747 python3 -m something.else', UID)
  assert.equal(raced[0]!.identity, null)
})

test('lsof listeners keep every address, sorted and once each; cwds are read per pid', () => {
  const listeners = parseLsofListeners(
    ['p100', 'f5', 'n*:5173', 'f6', 'n[::1]:5173', 'n192.168.1.4:9000', 'p200', 'n127.0.0.1:3000', 'nbogus'].join('\n'),
  )
  assert.deepEqual(
    [...listeners],
    [
      [100, [5173, 9000]],
      [200, [3000]],
    ],
  )
  assert.deepEqual(
    [...parseLsofCwds('p100\nfcwd\nn/Users/dev/app\np200\nfcwd\nn/Users/dev/my app')],
    [
      [100, '/Users/dev/app'],
      [200, '/Users/dev/my app'],
    ],
  )
})

test('/proc reads: stat past a name with spaces and parentheses, and the listening sockets', () => {
  const fields = ['S', '1', '77', '77', '0', '-1', '0', '0', '0', '0', '0', '1', '2', '0', '0', '20', '0', '1', '0']
  const stat = `123 (my (odd) name) ${[...fields, '98765', '1000', '2500'].join(' ')}`
  assert.deepEqual(parseProcStat(stat), { state: 'S', ppid: 1, pgid: 77, startTicks: 98765, rssPages: 2500 })
  assert.equal(parseProcStat('nonsense'), null)
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1',
    '   1: 0100007F:1F90 0100007F:D3A2 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1',
  ].join('\n')
  assert.deepEqual([...parseProcNetListeners(table)], [['4242', 5173]])
})

test('names say what a program is: browsers, dev servers by command, else the program', () => {
  const name = (command: string) => describeProcess(command).name
  assert.equal(
    name(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9222 --autoplay-policy=no-user-gesture-required',
    ),
    'Headless Chrome',
  )
  assert.equal(
    name('/Users/dev/Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    'Chromium',
  )
  assert.equal(describeProcess('/usr/bin/chromium --headless').kind, 'browser')
  // A browser named as an argument is not a browser.
  assert.equal(describeProcess('node scrape.mjs /usr/bin/chromium').kind, 'program')
  assert.equal(name('node /Users/dev/app/node_modules/.bin/vite --port 5173'), 'Vite dev server')
  assert.equal(name('node /Users/dev/app/node_modules/.bin/vite preview --port 4173'), 'Vite preview')
  assert.equal(name('node /Users/dev/site/node_modules/.bin/next dev -p 3000'), 'Next.js dev server')
  assert.equal(name('next-server (v15.5.0)'), 'Next.js server')
  assert.equal(name('/Users/dev/site/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve'), 'workerd')
  assert.equal(name('npm exec wrangler dev'), 'Wrangler dev server')
  assert.equal(
    name(
      '/opt/homebrew/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python -I -m http.server 8000',
    ),
    'python http.server',
  )
  assert.equal(describeProcess('python3 -m http.server').kind, 'server')
  assert.equal(name('node repl.cjs /tmp/profile'), 'node repl.cjs')
  assert.equal(name('/opt/homebrew/bin/colima daemon start default'), 'colima')
  assert.equal(describeProcess('/bin/zsh -c sleep 600').generic, true)
  assert.equal(describeProcess('npm run dev').generic, true)
})

// ── Rows ────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 24, 12)
const DAY = 24 * 60 * 60_000
const SELF = 10

let nextStart = NOW - 9 * DAY
function proc(pid: number, ppid: number, command: string, extra: Partial<ScannedProcess> = {}): ScannedProcess {
  return {
    pid,
    ppid,
    pgid: extra.pgid ?? pid,
    startedAt: extra.startedAt ?? (nextStart += 1000),
    rssBytes: extra.rssBytes ?? 1_000_000,
    command,
    identity: null,
    ...extra,
  }
}
const A = { workspaceId: 'ws-a', agentId: 'agent-a', sessionId: 'conv_a' }
const B = { workspaceId: 'ws-b', agentId: 'agent-b' }
const C = { workspaceId: 'ws-b', agentId: 'agent-c' }
const STUDIO_BIN = '/Applications/SprintEngine Studio.app/Contents/MacOS/SprintEngine Studio'

function machine(): ProcessSnapshot {
  nextStart = NOW - 9 * DAY
  const processes: ScannedProcess[] = [
    proc(1, 0, '/sbin/launchd'),
    proc(SELF, 1, STUDIO_BIN),
    // Agent A's chat: its CLI, the CLI's watcher and bridge, an MCP server, a tool shell.
    proc(20, SELF, '/Users/dev/.local/bin/claude --output-format stream-json', { identity: A }),
    proc(21, 20, "/bin/sh -c { trap '' TERM; read -r _ <&3; kill -TERM 0; }", { identity: A }),
    proc(
      22,
      20,
      `${STUDIO_BIN} /Applications/SprintEngine Studio.app/Contents/Resources/automation/mcp-stdio-bridge.mjs`,
      {
        identity: A,
      },
    ),
    proc(23, 20, 'npm exec @acme/some-mcp', { startedAt: NOW - 2 * DAY }),
    proc(24, 23, 'node /Users/dev/.npm/_npx/acme/some-mcp.js', { identity: A, startedAt: NOW - 2 * DAY }),
    proc(30, 20, '/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1.sh && npm run dev', {
      identity: A,
    }),
    // A dev server in that tool shell: under npm, which loses its identity to its own title.
    proc(31, 30, 'npm run dev', { startedAt: NOW - 60_000 }),
    proc(32, 31, 'node /Users/dev/app/node_modules/.bin/vite', { identity: A, startedAt: NOW - 60_000 }),
    proc(33, 32, '/Users/dev/app/node_modules/@esbuild/darwin-arm64/bin/esbuild --service', {
      identity: A,
      startedAt: NOW - 60_000,
    }),
    // A short command in the tool shell, and a long quiet one.
    proc(34, 30, 'git status', { identity: A, startedAt: NOW - 2_000 }),
    proc(35, 30, 'sleep 3600', { identity: A, startedAt: NOW - LONG_RUNNING_MS - 1 }),
    // Left behind by agent B, whose CLI is gone: headless Chrome with a helper,
    // and a python server.
    proc(
      40,
      1,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9333',
      {
        identity: B,
        rssBytes: 100_000_000,
      },
    ),
    proc(
      41,
      40,
      '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer',
      { identity: B, pgid: 40, rssBytes: 50_000_000 },
    ),
    proc(42, 1, 'python3 -m http.server 8765', { identity: B }),
    // Handed to the system by agent A, which is still running: on its own.
    proc(50, 1, 'python3 -m http.server 8766', { identity: A }),
    // Just adopted: a daemon forking away, not yet a row.
    proc(51, 1, 'python3 -m http.server 8767', { identity: B, startedAt: NOW - ADOPTED_MIN_AGE_MS + 1000 }),
    // Untagged: never a row, whatever it holds.
    proc(60, 1, 'node /Users/dev/other/server.js'),
    // A zombie keeps no row.
    proc(61, 1, '<defunct>', { identity: B, defunct: true }),
    // A script that runs an agent's CLI: the CLI is not folded into the row.
    proc(70, 1, 'node /Users/dev/orchestrate.mjs', { identity: C }),
    proc(71, 70, 'codex exec fix-it', { identity: C, pgid: 70 }),
  ]
  return {
    processes,
    listeners: new Map([
      [33, [5173]],
      [42, [8765]],
      [50, [8766]],
      [60, [9999]],
      [40, [9333]],
    ]),
    scannedAt: NOW,
  }
}

test('rows are the top of what agents started, with their state and what they started folded in', () => {
  // Agent B's chat was settled; the rest are open.
  const analysis = analyzeProcesses(machine(), {
    selfPid: SELF,
    now: NOW,
    chatOpen: (workspaceId, agentId) => !(workspaceId === 'ws-b' && agentId === 'agent-b'),
  })
  const rows = new Map(analysis.rows.map((row) => [row.pid, row]))
  assert.deepEqual(
    [...rows.keys()].sort((a, b) => a - b),
    [32, 35, 40, 42, 50, 70],
  )
  // Under its agent: the dev server under the npm wrapper, named by what it is.
  const vite = rows.get(32)!
  assert.deepEqual(
    [vite.state, vite.name, vite.kind, vite.ports, vite.childCount, vite.agentRunning],
    ['with-agent', 'Vite dev server', 'server', [5173], 1, true],
  )
  assert.equal(vite.id, `32-${Math.floor(vite.startedAt / 1000)}`)
  assert.deepEqual([vite.workspaceId, vite.agentId, vite.sessionId], ['ws-a', 'agent-a', 'conv_a'])
  assert.equal(rows.get(35)!.state, 'with-agent')
  // Left behind: the browser holds its helper's memory too.
  const chrome = rows.get(40)!
  assert.deepEqual(
    [chrome.state, chrome.name, chrome.kind, chrome.childCount, chrome.memoryBytes, chrome.agentRunning],
    ['left-behind', 'Headless Chrome', 'browser', 1, 150_000_000, false],
  )
  assert.equal(rows.get(42)!.state, 'left-behind')
  assert.equal(rows.get(50)!.state, 'on-its-own')
  assert.equal(rows.get(50)!.agentRunning, true)
  // The agent's CLI under a script is not the script's to fold, nor to stop with it.
  assert.deepEqual(rows.get(70)!.memberPids, [70])
  assert.equal(rows.get(70)!.protectedInside, true)

  assert.equal(analysis.roles.get(SELF), 'studio')
  assert.equal(analysis.roles.get(22), 'studio')
  assert.equal(analysis.roles.get(20), 'agent')
  assert.equal(analysis.roles.get(71), 'agent')
  assert.equal(analysis.roles.get(30), 'tool-shell')
  // Oldest first.
  assert.deepEqual(
    analysis.rows.map((row) => row.startedAt),
    [...analysis.rows.map((row) => row.startedAt)].sort((a, b) => a - b),
  )
})

test('what Studio runs under is never a row, even when an agent started it', () => {
  const snapshot = machine()
  // A development build of Studio started from agent A's tool shell.
  snapshot.processes.push(
    proc(80, 30, 'node /Users/dev/studio/node_modules/.bin/electron-vite dev', { identity: A }),
    proc(81, 80, '/Users/dev/studio/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .', {
      identity: A,
    }),
  )
  snapshot.listeners = new Map([...snapshot.listeners, [80, [5174]]])
  const analysis = analyzeProcesses(snapshot, { selfPid: 81, now: NOW })
  assert.equal(
    analysis.rows.some((row) => row.pid === 80 || row.pid === 81),
    false,
  )
})

test('a chat still open whose CLI rests is not left behind: what it started waits as agent idle', () => {
  const snapshot = machine()
  const ask = (chatOpen?: (workspaceId: string, agentId: string | undefined) => boolean | null) =>
    analyzeProcesses(snapshot, { selfPid: SELF, now: NOW, ...(chatOpen ? { chatOpen } : {}) }).rows.find(
      (row) => row.pid === 42,
    )!.state
  assert.equal(
    ask(() => true),
    'agent-idle',
  )
  // Not known here (another Studio's chat, a registry not loaded): idle, never left behind.
  assert.equal(ask(), 'agent-idle')
  assert.equal(
    ask(() => null),
    'agent-idle',
  )
  assert.equal(
    ask(() => false),
    'left-behind',
  )
})

test('a terminal multiplexer and everything in its panes is neither listed nor folded into a row', () => {
  const snapshot = machine()
  snapshot.processes.push(
    // An agent started a tmux server; a person attached later and runs a shell and a server in its panes.
    proc(90, 1, 'tmux new-session -d -s work', { identity: B }),
    proc(91, 90, '-zsh', { identity: B }),
    proc(92, 91, 'python3 -m http.server 9090', { identity: B }),
    // A script left behind that started a tmux server of its own.
    proc(95, 1, 'node /Users/dev/runner.mjs', { identity: B }),
    proc(96, 95, 'tmux -L agent new-session -d', { identity: B, pgid: 95 }),
    proc(97, 96, 'bash', { identity: B, pgid: 95 }),
  )
  snapshot.listeners = new Map([...snapshot.listeners, [92, [9090]]])
  const analysis = analyzeProcesses(snapshot, { selfPid: SELF, now: NOW, chatOpen: () => false })
  const pids = analysis.rows.map((row) => row.pid)
  for (const pid of [90, 91, 92, 96, 97]) assert.equal(pids.includes(pid), false, String(pid))
  const runner = analysis.rows.find((row) => row.pid === 95)!
  assert.deepEqual(runner.memberPids, [95])
  assert.equal(runner.protectedInside, true)
  assert.equal(analysis.roles.get(90), 'multiplexer')
})

test('a look-alike inside another value does not tag a process, and two disagreeing ids are no identity', () => {
  // ps joins the environment with spaces, so a value holding spaces can carry a look-alike.
  assert.deepEqual(
    identityFromEnvironment(
      ' NOTE=see SPRINTENGINE_WORKSPACE_ID=fake here SPRINTENGINE_WORKSPACE_ID=ws-real HOME=/Users/dev',
    ),
    { workspaceId: 'ws-real' },
  )
  assert.equal(
    identityFromEnvironment(' NOTE=x SPRINTENGINE_WORKSPACE_ID=fake PATH=/bin SPRINTENGINE_WORKSPACE_ID=ws-real'),
    null,
  )
  assert.equal(identityFromEnvironment(' NOTE=see SPRINTENGINE_WORKSPACE_ID=fake here'), null)
  // NUL-separated entries are read whole.
  assert.equal(identityFromEnvironment('NOTE=a SPRINTENGINE_WORKSPACE_ID=fake\0PATH=/bin\0'), null)
  assert.deepEqual(identityFromEnvironment('NOTE=a SPRINTENGINE_WORKSPACE_ID=fake\0SPRINTENGINE_WORKSPACE_ID=ws-1\0'), {
    workspaceId: 'ws-1',
  })
})
