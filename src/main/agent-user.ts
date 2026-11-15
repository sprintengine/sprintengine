import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, lstat, readdir } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

// A Studio server that runs its agents as another user (docs/design/container-chats.md,
// "Two users"). In a chat's container the server runs as root with only the
// capabilities it needs to start a process as someone else (SETUID, SETGID,
// KILL), and its data (the owner token and socket) is in root's own home,
// which the agent cannot enter. Every program the server starts runs as the
// agent's user instead: the agent CLIs, the sign-in flow's CLI, and also git,
// gh, rg, a project's installs and dev servers. A program the server ran as
// itself in the agent's repository would run whatever the agent wrote into
// that repository's configuration (a `core.fsmonitor`, a filter, a hook, an
// npm script) as root, so none is: the server's own processes are the only
// ones that are its.
//
// That is done once, at the server's start, for every way Node starts a
// program, rather than at each call: a call that forgot would be the hole.
// What the server writes for an agent to read (a staged plugin, a pasted
// image, a temporary git index) is shared with the agent's group, the
// server's own group in this mode; everything else it keeps stays its own.

export type AgentUser = { uid: number; gid: number; name: string; home: string }

let current: AgentUser | null = null
/** Where this server keeps what it shares with its agents (`/var/lib/sprintengine-studio-<data dir>`), in that mode. */
let sharedRoot: string | null = null

/** The user this server starts its programs as, or null when they run as the server does (every machine but a container). */
export function agentUser(): AgentUser | null {
  return current
}

/** The agent's home: where its CLIs keep their configuration and sessions. The server's own home unless it runs agents as another user. */
export function agentHome(): string {
  return current?.home ?? homedir()
}

/** The user `uid` names in an `/etc/passwd`, or null when it names none. */
export function passwdEntry(passwd: string, uid: number): { name: string; home: string } | null {
  for (const line of passwd.split('\n')) {
    const [name, , id, , , home] = line.split(':')
    if (name && home && Number(id) === uid && String(uid) === id) return { name, home }
  }
  return null
}

/** The agent's user from the ids the server was started with; throws, in words, when this machine has no such user. */
export function lookUpAgentUser(uid: number, gid: number, passwd = '/etc/passwd'): AgentUser {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0)
    throw new Error('The agent’s user and group are numbers above 0 (never root).')
  let text = ''
  try {
    text = readFileSync(passwd, 'utf8')
  } catch {
    throw new Error(`${passwd} could not be read, so the agent’s user ${uid} is not known here.`)
  }
  const entry = passwdEntry(text, uid)
  if (!entry) throw new Error(`This machine has no user ${uid} to run agents as.`)
  return { uid, gid, ...entry }
}

type Env = Record<string, string | undefined>

/**
 * A child's environment as the agent's: its own home, user name and login
 * name where the server's own (or none) would have been. A home the caller
 * chose for the child on purpose is kept.
 */
export function agentEnv(env: Env, user: AgentUser, server: { home: string; name: string }): Env {
  const next: Env = { ...env }
  if (!next.HOME || next.HOME === server.home) next.HOME = user.home
  for (const key of ['USER', 'LOGNAME'] as const) if (!next[key] || next[key] === server.name) next[key] = user.name
  return next
}

/** The same, for the `KEY=value` list Node hands the operating system. */
export function agentEnvPairs(
  pairs: readonly string[],
  user: AgentUser,
  server: { home: string; name: string },
): string[] {
  const env: Env = {}
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return Object.entries(agentEnv(env, user, server)).map(([key, value]) => `${key}=${value ?? ''}`)
}

type SpawnOptions = { uid?: number; gid?: number; env?: Env; [key: string]: unknown }

/** One call's options as the agent's: its uid and gid unless the caller named some, and its environment. */
export function asAgent(
  options: SpawnOptions | undefined,
  user: AgentUser,
  server: { home: string; name: string },
): SpawnOptions {
  const given = options ?? {}
  return {
    ...given,
    uid: given.uid ?? user.uid,
    gid: given.gid ?? user.gid,
    env: agentEnv((given.env ?? process.env) as Env, user, server),
  }
}

const isOptions = (value: unknown): value is SpawnOptions =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The arguments of one `child_process` call with its options made the
 * agent's: `(file, [args], [options], [callback])`, or `(command, [options],
 * [callback])` for `exec` and `execSync`, as Node reads them.
 */
export function agentArguments(
  kind: 'file' | 'command',
  args: readonly unknown[],
  user: AgentUser,
  server: { home: string; name: string },
): unknown[] {
  const out = [...args]
  let at = 1
  if (kind === 'file' && (Array.isArray(out[1]) || (out[1] == null && out.length > 2))) at = 2
  if (isOptions(out[at])) out[at] = asAgent(out[at] as SpawnOptions, user, server)
  else if (out[at] === undefined || typeof out[at] === 'function') {
    if (at === 2 && out[1] === undefined) out[1] = []
    out.splice(at, out[at] === undefined ? 1 : 0, asAgent(undefined, user, server))
  }
  return out
}

let hooked = false

/** Node's own `child_process` exports: the object every caller's functions are read from. */
const nodeChildProcess = (): Record<string, unknown> & { ChildProcess: typeof ChildProcess } =>
  createRequire('/')('node:child_process') as Record<string, unknown> & { ChildProcess: typeof ChildProcess }

/**
 * Make every program this process starts the agent's, from now on. Every
 * asynchronous start (`spawn`, `exec`, `execFile`, `fork`, and any library's,
 * however it holds the function) goes through `ChildProcess.prototype.spawn`
 * with its arguments already read, so that one is wrapped; the synchronous
 * ones are wrapped at the module's exports, and ES modules' bindings are made
 * to match.
 */
export function startProgramsAsAgent(user: AgentUser): void {
  if (hooked) return
  hooked = true
  const server = { home: homedir(), name: process.env.USER || process.env.LOGNAME || 'root' }
  const exports = nodeChildProcess()
  const proto = exports.ChildProcess.prototype as unknown as {
    spawn(options: { uid?: number; gid?: number; envPairs?: string[] }): unknown
  }
  const spawn = proto.spawn
  proto.spawn = function (this: unknown, options) {
    const next = { ...options }
    if (next.uid === undefined) next.uid = user.uid
    if (next.gid === undefined) next.gid = user.gid
    next.envPairs = agentEnvPairs(next.envPairs ?? [], user, server)
    return spawn.call(this, next)
  }
  for (const [name, kind] of [
    ['spawnSync', 'file'],
    ['execFileSync', 'file'],
    ['execSync', 'command'],
  ] as const) {
    const original = exports[name] as (...args: unknown[]) => unknown
    exports[name] = (...args: unknown[]) => original(...agentArguments(kind, args, user, server))
  }
  syncBuiltinESMExports()
}

/**
 * Become a server whose programs run as `user`: its group becomes the agent's
 * (so what it shares, it shares with the agent and no one else), its umask
 * lets that group in, it stands in the agent's home rather than its own, and
 * every program it starts is the agent's. Its home stays its own, so what it
 * keeps for itself (its stores, its temporary files) stays where the agent
 * cannot enter.
 */
export function becomeAgentServer(user: AgentUser, options: { dataDir: string; runRoot?: string }): void {
  if (typeof process.setgid !== 'function' || typeof process.setgroups !== 'function')
    throw new Error('Running agents as another user needs a POSIX system.')
  process.setgroups([user.gid])
  process.setgid(user.gid)
  process.umask(0o007)
  process.chdir(user.home)
  startProgramsAsAgent(user)
  current = user
  sharedRoot = join(
    options.runRoot ?? '/var/lib',
    `sprintengine-studio-${createHash('sha256').update(options.dataDir).digest('hex').slice(0, 12)}`,
  )
  agentSharedFolder()
}

/** For tests: forget the agent's user (the hooks, once made, stay). */
export function resetAgentUserForTests(user: AgentUser | null = null, shared: string | null = null): void {
  current = user
  sharedRoot = user ? shared : null
}

// ── What the server writes for the agent ────────────────────────────────────

/**
 * Refuse a write a client asked this server to make (a save, a new file, a
 * rename) unless its real folder is in the agent's home. A server whose
 * agents run as another user is root, and root may write its own files (its
 * installed tree, the system's): a folder the agent made a link to one of
 * those, in its repository, must not carry a person's save there. `realFolder`
 * is the folder as the file system resolved it, links and all.
 */
export function assertAgentTerritory(realFolder: string): void {
  if (!current) return
  let home = current.home
  try {
    home = realpathSync(current.home)
  } catch {
    // Its home as named.
  }
  const rel = relative(home, realFolder)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new Error(
    `In a container, Studio writes only inside ${current.home}, and ${realFolder} is outside it (a link may lead there), so Studio did not write.`,
  )
}

/**
 * Let the agent's group into a directory this server made for the agent to
 * read (`write`: and write in, as git does with a temporary index). Nothing
 * outside the agent mode, and nothing that is a link or that this process
 * does not own: it never widens what someone else put there.
 */
export async function shareDirectoryWithAgent(path: string, options: { write?: boolean } = {}): Promise<void> {
  if (!current) return
  const found = await lstat(path)
  if (!found.isDirectory() || found.isSymbolicLink() || found.uid !== process.getuid?.()) return
  await chmod(path, options.write ? 0o770 : 0o750)
}

/** The same, synchronously, for a directory made with `mkdirSync`. */
export function shareDirectoryWithAgentSync(path: string): void {
  if (!current) return
  const found = lstatSync(path)
  if (!found.isDirectory() || found.isSymbolicLink() || found.uid !== process.getuid?.()) return
  chmodSync(path, 0o750)
}

/**
 * Let the agent's group read a tree this server staged for it (a plugin's
 * files): directories 0750, files 0640, links left as they are. Only what
 * this process owns is changed.
 */
export async function shareTreeWithAgent(root: string): Promise<void> {
  if (!current) return
  const uid = process.getuid?.()
  const walk = async (path: string): Promise<void> => {
    const found = await lstat(path)
    if (found.isSymbolicLink() || found.uid !== uid) return
    if (found.isDirectory()) {
      await chmod(path, 0o750)
      for (const name of await readdir(path)) await walk(join(path, name))
    } else if (found.isFile()) await chmod(path, 0o640)
  }
  await walk(root)
}

/**
 * A folder this server shares with its agents, made if it is not there: in
 * a directory under `/var/lib` of the server's own, which the agent's group may
 * enter and read and nobody but the server may write in. One there already
 * is used only when it is this server's own: a real directory, owned by this
 * process's user and the agent's group, closed to everyone else. Null outside
 * the agent mode, where the caller keeps its files where it always has.
 */
export function agentSharedFolder(...names: string[]): string | null {
  if (!current || !sharedRoot) return null
  const runRoot = join(sharedRoot, '..')
  mkdirSync(runRoot, { recursive: true, mode: 0o755 })
  let dir = sharedRoot
  for (const name of ['', ...names]) {
    dir = name ? join(dir, name) : dir
    try {
      mkdirSync(dir, { mode: 0o750 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const found = lstatSync(dir)
    if (!found.isDirectory() || found.isSymbolicLink() || found.uid !== process.getuid?.() || found.gid !== current.gid)
      throw new Error(`${dir} is not a folder this server made for its agents, so it does not use it.`)
    chmodSync(dir, 0o750)
  }
  return dir
}

/**
 * A folder under the data directory whose files an agent is told the path of
 * (a sent picture, a file a device sent): there, or in the folder the server
 * shares with its agents when they run as another user.
 */
export function agentFacingDirectory(dataDir: string, name: string): string {
  return agentSharedFolder(name) ?? join(dataDir, name)
}

/**
 * Where a server's agents find its MCP gateway (the socket and the file that
 * names it): the data directory itself, or the folder it shares with them
 * when they run as another user (the data directory is the server's alone).
 */
export function agentGatewayDirectory(dataDir: string): string {
  return agentSharedFolder() ?? dataDir
}

/** The mode a folder the agent reads from is made with: the owner's alone, or the agent's group's too in this mode. */
export function agentReadableDirMode(): number {
  return current ? 0o750 : 0o700
}

/** The mode a file the agent reads is written with: the owner's alone, or the agent's group's too in this mode. */
export function agentReadableFileMode(): number {
  return current ? 0o640 : 0o600
}
