import type {
  StudioAgentProcess,
  StudioProcessKind,
  StudioProcessState,
} from '../../../packages/studio-protocol/src/public'
import { STUDIO_PROCESS_MAX_COMMAND, studioProcessId } from '../../../packages/studio-protocol/src/public'

// What this machine's processes say about the programs agents started: the
// pure half of the `processes` domain (agent-process-domain.ts), fed by the
// reads in agent-process-reader.ts and tested on their fixture output.
//
// Every process an agent starts inherits the agent's identity in its
// environment, and keeps it after its parent dies and the system adopts it.
// That is the whole signal: a process carrying `SPRINTENGINE_WORKSPACE_ID` was
// started, at some remove, by one of Studio's agents. What it is relative to
// the rest is read off the tree:
//
// - `studio`: this Studio's own process, what it runs under, and any process
//   of the Studio app (its helpers, the MCP bridge an agent's CLI starts).
//   Never listed, never signalled.
// - `agent`: an agent's CLI, by its program's name, or a tagged process
//   Studio started directly (a chat's CLI, an agent terminal's shell). Those
//   are Sessions, not Processes, and are never signalled from here.
// - `tool-shell`: a shell an agent's CLI is running a command in. Transparent:
//   what it runs is the agent's work.
// - `program`: everything else.
//
// A row is the top of what an agent started: a tagged program whose nearest
// tagged-or-Studio ancestor is not a tagged program (a process that sets its
// own title, as npm does, loses the environment ps can read, so untagged
// programs in between are looked through). What it started is folded into it.
// Under a live agent, most of what runs is the turn's own short work and the
// CLI's own MCP servers, so a row there is only what holds a port or is a
// browser, or has been running a long time out of a tool call; with no agent
// above it (the system adopted it) every tagged program is a row.

/** The identity an agent's launch puts in the environment, as far as a process carries it. */
export type AgentIdentity = { workspaceId: string; agentId?: string; sessionId?: string }

/** One process of this user's, as read. */
export type ScannedProcess = {
  pid: number
  ppid: number
  pgid: number
  /** ms epoch, to the second. */
  startedAt: number
  rssBytes: number
  /** Its command line, without its environment. */
  command: string
  /** Null when its environment carries no workspace id, or could not be read. */
  identity: AgentIdentity | null
  /** A zombie: ended, waiting on its parent. Neither listed nor signalled. */
  defunct?: boolean
}

export type ProcessSnapshot = {
  processes: ScannedProcess[]
  /** The TCP ports each pid listens on. */
  listeners: ReadonlyMap<number, readonly number[]>
  scannedAt: number
}

export type ProcessRole = 'studio' | 'agent' | 'tool-shell' | 'program'

/** How long an adopted process has to have run before it is a row: a daemon forking away is not left behind. */
export const ADOPTED_MIN_AGE_MS = 5_000
/** How long a program under a live agent has to have run, holding no port, to be a row. */
export const LONG_RUNNING_MS = 15 * 60_000

// Every shell Claude Code's Bash tool runs sources its snapshot from here.
const CLAUDE_TOOL_SHELL_SIGNATURE = '.claude/shell-snapshots/'
// The gateway bridge every agent's CLI starts, run by the Studio app's own binary.
const STUDIO_MCP_BRIDGE_SIGNATURE = 'mcp-stdio-bridge'

// The agent CLIs Studio drives, by their program's name.
const AGENT_CLI_NAMES = new Set(['claude', 'codex', 'cursor-agent', 'opencode', 'gemini', 'grok', 'kimi'])
// The same CLIs run as a script by a JavaScript runtime.
const AGENT_CLI_SCRIPTS = [
  '@anthropic-ai/claude-code/',
  '@openai/codex/',
  '/opencode-ai/',
  '@google/gemini-cli/',
  '/claude-agent-sdk/',
]
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'])
// What runs something else: named after what it runs where it can be.
const WRAPPERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bunx', 'env', 'nohup', 'timeout', 'caffeinate'])
const INTERPRETERS = /^(node|nodejs|bun|deno|python\d*(?:\.\d+)?|ruby|php|perl)$/iu

const ENV_IDENTITY_KEYS = {
  workspaceId: 'SPRINTENGINE_WORKSPACE_ID',
  agentId: 'SPRINTENGINE_AGENT_ID',
  sessionId: 'SPRINTENGINE_CONVERSATION_SESSION_ID',
} as const
const IDENTITY_VALUE = /^[A-Za-z0-9._:-]{1,200}$/u

/**
 * The identity in an environment block written as `KEY=value` entries
 * separated by whitespace (ps) or NULs (/proc). Only the three ids are read:
 * values are ids, with no spaces in them, and nothing else of the
 * environment (a token among it) is kept.
 */
export function identityFromEnvironment(env: string): AgentIdentity | null {
  const read = (key: string): string | undefined => {
    const match = new RegExp(`(?:^|[\\s\\0])${key}=([^\\s\\0]*)`, 'u').exec(env)
    const value = match?.[1]
    return value && IDENTITY_VALUE.test(value) ? value : undefined
  }
  const workspaceId = read(ENV_IDENTITY_KEYS.workspaceId)
  if (!workspaceId) return null
  const agentId = read(ENV_IDENTITY_KEYS.agentId)
  const sessionId = read(ENV_IDENTITY_KEYS.sessionId)
  return { workspaceId, ...(agentId ? { agentId } : {}), ...(sessionId ? { sessionId } : {}) }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LSTART = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u

/** `ps -o lstart` under the C locale (`Wed Nov 11 23:23:52 2026`, local time), in ms; NaN when it is not one. */
export function parseLstart(value: string): number {
  const match = LSTART.exec(value.trim())
  if (!match) return Number.NaN
  const month = MONTHS.indexOf(match[1]!)
  if (month < 0) return Number.NaN
  return new Date(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ).getTime()
}

const PS_WITH_ENV_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/u
const PS_ARGS_ROW = /^\s*(\d+)\s+(.*)$/u

/**
 * macOS: `ps -E -ww -axo uid=,pid=,ppid=,pgid=,rss=,lstart=,command=` prints
 * each command line with its environment after it, and nothing marks where
 * one ends: an argument may hold spaces and `=`. So the same processes are
 * read once more without `-E` (`ps -ww -axo pid=,command=`), and the
 * environment is what follows that command line. A process whose two reads do
 * not start alike (it changed in between, or set its own title) is kept with
 * no identity. Only `uid`'s processes are kept.
 */
export function parseMacProcesses(withEnv: string, argsOnly: string, uid: number): ScannedProcess[] {
  const commands = new Map<number, string>()
  for (const line of argsOnly.split('\n')) {
    const match = PS_ARGS_ROW.exec(line)
    if (match) commands.set(Number(match[1]), match[2]!)
  }
  const out: ScannedProcess[] = []
  for (const line of withEnv.split('\n')) {
    const match = PS_WITH_ENV_ROW.exec(line)
    if (!match || Number(match[1]) !== uid) continue
    const pid = Number(match[2])
    const startedAt = parseLstart(match[6]!)
    if (!Number.isFinite(startedAt)) continue
    const full = match[7]!
    const command = commands.get(pid)
    const known = command !== undefined && full.startsWith(command)
    const shown = known ? command : full
    out.push({
      pid,
      ppid: Number(match[3]),
      pgid: Number(match[4]),
      startedAt,
      rssBytes: Number(match[5]) * 1024,
      command: shown,
      identity: known ? identityFromEnvironment(full.slice(command.length)) : null,
      ...(/<defunct>|^\(.*\)$/u.test(shown.trim()) ? { defunct: true } : {}),
    })
  }
  return out
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -Fpn` prints `p<pid>` and then one
 * `n<address>:<port>` per listening socket. Every address counts: a server
 * bound to a LAN address is as much left running as one on loopback.
 */
export function parseLsofListeners(stdout: string): Map<number, number[]> {
  const out = new Map<number, number[]>()
  let pid = 0
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0
    else if (line.startsWith('n') && pid > 0) {
      const port = Number(/:(\d+)$/u.exec(line)?.[1])
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      const ports = out.get(pid) ?? []
      if (!ports.includes(port)) ports.push(port)
      out.set(pid, ports)
    }
  }
  for (const ports of out.values()) ports.sort((a, b) => a - b)
  return out
}

/** `lsof -a -d cwd -Fpn -p <pids>`: each pid's folder. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid = 0
  for (const raw of stdout.split('\n')) {
    if (raw.startsWith('p')) pid = Number(raw.slice(1)) || 0
    else if (raw.startsWith('n') && pid > 0 && !out.has(pid)) out.set(pid, raw.slice(1))
  }
  return out
}

/**
 * Linux's `/proc/<pid>/stat`: the fields after the command's name, which is
 * in parentheses and may itself hold spaces and parentheses.
 */
export function parseProcStat(
  stat: string,
): { state: string; ppid: number; pgid: number; startTicks: number; rssPages: number } | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u)
  if (fields.length < 22) return null
  return {
    state: fields[0]!,
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    startTicks: Number(fields[19]),
    rssPages: Number(fields[21]),
  }
}

// ── Naming ──────────────────────────────────────────────────────────────────

const BROWSER =
  /(?:^|\/)(Google Chrome(?: for Testing| Canary| Beta| Dev)?|Chromium|chrome-headless-shell|headless_shell|chrome|chromium(?:-browser)?|msedge|Microsoft Edge|firefox|Brave Browser|brave)( Helper[^/]*?)?(?=\s|$)/iu

function browserBrand(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('chromium')) return 'Chromium'
  if (lower.includes('edge')) return 'Edge'
  if (lower.includes('firefox')) return 'Firefox'
  if (lower.includes('brave')) return 'Brave'
  return 'Chrome'
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A command line's words; good enough for names, never for what is run. */
function words(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean)
}

export type ProcessDescription = {
  name: string
  kind: StudioProcessKind
  /** A shell, a package runner or a bare interpreter: a row names what it runs instead, where it can. */
  generic: boolean
}

const SERVER_SCRIPTS: Array<{ test: RegExp; name: (rest: string[]) => string }> = [
  {
    test: /(?:^|\/)vite(?:\.js|\.mjs)?$/u,
    name: (rest) => (rest[0] === 'preview' ? 'Vite preview' : 'Vite dev server'),
  },
  {
    test: /(?:^|\/)next(?:\.js)?$/u,
    name: (rest) => (rest[0] === 'dev' ? 'Next.js dev server' : 'Next.js server'),
  },
  { test: /(?:^|\/)wrangler(?:\.js)?$/u, name: () => 'Wrangler dev server' },
  { test: /(?:^|\/)webpack(?:-dev-server)?(?:\.js)?$/u, name: () => 'webpack dev server' },
  { test: /(?:^|\/)astro(?:\.js|\.mjs)?$/u, name: () => 'Astro dev server' },
  { test: /(?:^|\/)nuxi?(?:\.js|\.mjs)?$/u, name: () => 'Nuxt dev server' },
  { test: /(?:^|\/)storybook(?:\.js)?$/u, name: () => 'Storybook' },
  { test: /(?:^|\/)http-server(?:\.js)?$/u, name: () => 'http-server' },
  { test: /(?:^|\/)serve(?:\.js)?$/u, name: () => 'serve' },
  { test: /(?:^|\/)uvicorn$/u, name: () => 'uvicorn' },
]

/** A process's name in words, and what kind of program it is. */
export function describeProcess(command: string): ProcessDescription {
  const browser = BROWSER.exec(command)
  // Only when the browser is the program, not an argument naming one: its
  // path holds no space, unless it is inside an app bundle's (`Google
  // Chrome.app/Contents/MacOS/Google Chrome`).
  const before = browser ? command.slice(0, browser.index) : ''
  if (browser && (!/\s/u.test(before) || /^\/[^\n]*?\.app\/Contents\/[^\s]*(?:\s[^\s-][^\s]*)*$/u.test(before))) {
    const brand = browserBrand(browser[1]!)
    if (browser[2]) return { name: `${brand} helper`, kind: 'browser', generic: false }
    return {
      name: /\s--headless(?:[=\s]|$)/u.test(command) ? `Headless ${brand}` : brand,
      kind: 'browser',
      generic: false,
    }
  }
  const argv = words(command)
  const program = basename(argv[0] ?? '').replace(/^-/u, '')
  if (program === 'next-server' || program.startsWith('next-server')) {
    return { name: 'Next.js server', kind: 'server', generic: false }
  }
  if (program === 'workerd') return { name: 'workerd', kind: 'server', generic: false }
  const scriptAt = (from: number): ProcessDescription | null => {
    for (let index = from; index < argv.length; index++) {
      const word = argv[index]!
      for (const server of SERVER_SCRIPTS) {
        if (server.test.test(word)) return { name: server.name(argv.slice(index + 1)), kind: 'server', generic: false }
      }
    }
    return null
  }
  if (SHELLS.has(program)) return { name: program, kind: 'program', generic: true }
  if (WRAPPERS.has(program) || (program === 'bun' && argv[1] === 'x')) {
    return scriptAt(1) ?? { name: argv.slice(0, 3).map(basename).join(' '), kind: 'program', generic: true }
  }
  if (INTERPRETERS.test(program)) {
    const interpreter = program.toLowerCase().replace(/\d+(?:\.\d+)?$/u, '')
    const module = argv.indexOf('-m')
    if (module > 0 && argv[module + 1]) {
      const name = argv[module + 1]!
      return {
        name: `${interpreter} ${name}`,
        kind: name === 'http.server' || name === 'uvicorn' ? 'server' : 'program',
        generic: false,
      }
    }
    const known = scriptAt(1)
    if (known) return known
    const script = argv.slice(1).find((word) => !word.startsWith('-'))
    return script
      ? { name: `${interpreter} ${basename(script)}`, kind: 'program', generic: false }
      : { name: interpreter, kind: 'program', generic: true }
  }
  return scriptAt(0) ?? { name: program || 'process', kind: 'program', generic: false }
}

// ── Roles and rows ──────────────────────────────────────────────────────────

export type ProcessAnalysisOptions = {
  /** This Studio's own process. */
  selfPid: number
  /** Whether a command line is the Studio app's own (its binary, its helpers). */
  isStudioCommand?: (command: string) => boolean
  now: number
}

/** A row with the pids folded into it: what `stop` signals. */
export type ProcessRow = StudioAgentProcess & { memberPids: number[]; protectedInside: boolean }

export type ProcessAnalysis = {
  byPid: ReadonlyMap<number, ScannedProcess>
  roles: ReadonlyMap<number, ProcessRole>
  rows: ProcessRow[]
  /** What `pid` started, minus Studio and the agents' CLIs and what they run. */
  members(pid: number): { pids: number[]; protectedInside: boolean }
}

function isAgentCli(command: string): boolean {
  const argv = words(command)
  const program = basename(argv[0] ?? '')
  if (AGENT_CLI_NAMES.has(program)) return true
  if (INTERPRETERS.test(program)) {
    const script = argv.slice(1).find((word) => !word.startsWith('-')) ?? ''
    if (AGENT_CLI_NAMES.has(basename(script).replace(/\.(?:c|m)?js$/u, ''))) return true
    return AGENT_CLI_SCRIPTS.some((marker) => script.includes(marker))
  }
  return false
}

function isShell(command: string): boolean {
  return SHELLS.has(basename(words(command)[0] ?? '').replace(/^-/u, ''))
}

/** Studio's own program, as anyone's process tree shows it. */
export function isStudioAppCommand(command: string): boolean {
  return (
    command.includes(STUDIO_MCP_BRIDGE_SIGNATURE) ||
    /SprintEngine Studio(?: Helper[^/]*)?(?:\.app\/|\.exe|$|\s)/u.test(command) ||
    /(?:^|\/)sprintengine-studio(?:\s|$)/u.test(command)
  )
}

export function analyzeProcesses(snapshot: ProcessSnapshot, options: ProcessAnalysisOptions): ProcessAnalysis {
  const byPid = new Map<number, ScannedProcess>()
  for (const proc of snapshot.processes) byPid.set(proc.pid, proc)
  const children = new Map<number, ScannedProcess[]>()
  for (const proc of snapshot.processes) {
    if (proc.ppid === proc.pid) continue
    const list = children.get(proc.ppid)
    if (list) list.push(proc)
    else children.set(proc.ppid, [proc])
  }

  // What this Studio runs under is never one of an agent's programs, even
  // when it was itself started from an agent's shell.
  const selfLine = new Set<number>()
  for (let pid = options.selfPid, hops = 0; pid > 1 && hops < 64 && !selfLine.has(pid); hops++) {
    selfLine.add(pid)
    pid = byPid.get(pid)?.ppid ?? 0
  }
  const isStudioCommand = options.isStudioCommand ?? isStudioAppCommand

  const roles = new Map<number, ProcessRole>()
  const roleOf = (pid: number, depth = 0): ProcessRole | null => {
    const known = roles.get(pid)
    if (known) return known
    const proc = byPid.get(pid)
    if (!proc) return null
    let role: ProcessRole
    if (selfLine.has(pid) || isStudioCommand(proc.command)) role = 'studio'
    else {
      const parent = depth < 256 && proc.ppid !== pid ? roleOf(proc.ppid, depth + 1) : null
      if (isAgentCli(proc.command) || (proc.identity && parent === 'studio')) role = 'agent'
      else if (parent === 'agent' && (proc.command.includes(CLAUDE_TOOL_SHELL_SIGNATURE) || isShell(proc.command)))
        role = 'tool-shell'
      else role = 'program'
    }
    roles.set(pid, role)
    return role
  }
  for (const proc of snapshot.processes) roleOf(proc.pid)

  const ancestors = function* (proc: ScannedProcess): Generator<ScannedProcess> {
    const seen = new Set<number>([proc.pid])
    for (let pid = proc.ppid; pid > 0 && !seen.has(pid);) {
      seen.add(pid)
      const up = byPid.get(pid)
      if (!up) return
      yield up
      pid = up.ppid
    }
  }

  const memberCache = new Map<number, { pids: number[]; protectedInside: boolean }>()
  const members = (pid: number) => {
    const cached = memberCache.get(pid)
    if (cached) return cached
    const pids: number[] = []
    let protectedInside = false
    const seen = new Set<number>()
    const queue = [pid]
    while (queue.length > 0) {
      const next = queue.shift()!
      if (seen.has(next)) continue
      seen.add(next)
      const role = roles.get(next)
      if (next !== pid && (role === 'studio' || role === 'agent')) {
        protectedInside = true
        continue
      }
      pids.push(next)
      for (const child of children.get(next) ?? []) queue.push(child.pid)
    }
    const found = { pids, protectedInside }
    memberCache.set(pid, found)
    return found
  }

  // The agents running now, by workspace and agent.
  const runningAgents = new Set<string>()
  for (const proc of snapshot.processes) {
    if (roles.get(proc.pid) === 'agent' && proc.identity?.agentId && !proc.defunct)
      runningAgents.add(`${proc.identity.workspaceId}\0${proc.identity.agentId}`)
  }

  const rows: ProcessRow[] = []
  for (const proc of snapshot.processes) {
    if (!proc.identity || proc.defunct || roles.get(proc.pid) !== 'program') continue
    // The nearest ancestor that is not an untagged program decides: a tagged
    // program above means this one is folded into that row.
    let host: ScannedProcess | null = null
    let attached = false
    for (const up of ancestors(proc)) {
      const role = roles.get(up.pid)
      if (role === 'studio' || role === 'agent') {
        attached = true
        host ??= up
        break
      }
      if (host === null && (role === 'tool-shell' || up.identity)) host = up
    }
    const hostRole = host ? roles.get(host.pid) : null
    if (host && hostRole === 'program') continue

    const age = options.now - proc.startedAt
    const folded = members(proc.pid)
    const ports = [...new Set(folded.pids.flatMap((pid) => snapshot.listeners.get(pid) ?? []))].sort((a, b) => a - b)
    const described = folded.pids.map((pid) => describeProcess(byPid.get(pid)!.command))
    const browser = described.find((entry) => entry.kind === 'browser')
    const notable = ports.length > 0 || browser !== undefined
    if (attached) {
      // The CLI's own machinery (its MCP servers, its watcher) sits right under it.
      const underCli = hostRole === 'agent' || hostRole === 'studio'
      if (!notable && (underCli || age < LONG_RUNNING_MS)) continue
    } else if (age < ADOPTED_MIN_AGE_MS) continue

    const own = described[0]!
    const specific = described.find((entry) => !entry.generic && entry.kind !== 'program')
    const description = browser ?? (own.generic ? (specific ?? own) : own)
    const agentId = proc.identity.agentId
    const agentRunning =
      attached || (agentId !== undefined && runningAgents.has(`${proc.identity.workspaceId}\0${agentId}`))
    const state: StudioProcessState = attached ? 'with-agent' : agentRunning ? 'on-its-own' : 'left-behind'
    const kind: StudioProcessKind = browser
      ? 'browser'
      : ports.length > 0 || described.some((entry) => entry.kind === 'server')
        ? 'server'
        : 'program'
    rows.push({
      id: studioProcessId(proc.pid, proc.startedAt),
      pid: proc.pid,
      startedAt: proc.startedAt,
      name: description.name,
      kind,
      command: proc.command.slice(0, STUDIO_PROCESS_MAX_COMMAND),
      ports,
      memoryBytes: folded.pids.reduce((sum, pid) => sum + (byPid.get(pid)?.rssBytes ?? 0), 0),
      childCount: folded.pids.length - 1,
      state,
      agentRunning,
      workspaceId: proc.identity.workspaceId,
      ...(agentId ? { agentId } : {}),
      ...(proc.identity.sessionId ? { sessionId: proc.identity.sessionId } : {}),
      memberPids: folded.pids,
      protectedInside: folded.protectedInside,
    })
  }
  rows.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
  return { byPid, roles, rows, members }
}

/** A row as the wire carries it. */
export function wireProcess(row: ProcessRow, cwd?: string): StudioAgentProcess {
  const { memberPids: _members, protectedInside: _protected, ...wire } = row
  return cwd ? { ...wire, cwd } : wire
}
