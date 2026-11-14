import { studioNoParams, studioParams, studioParamsRefused, type StudioMethodTable } from './contract.js'
import {
  STUDIO_ENVIRONMENT_ADOPT_CAPABILITY,
  STUDIO_ENVIRONMENT_LAUNCH_TOKENS_CAPABILITY,
  STUDIO_ENVIRONMENT_MACHINE_CAPABILITY,
  STUDIO_ENVIRONMENT_TERMINAL_HOST_CAPABILITY,
  STUDIO_ENVIRONMENT_WORK_CAPABILITY,
  STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY,
  STUDIO_WINDOW_TICKETS_CAPABILITY,
} from './handshake.js'

// What the desktop that holds a machine's Studio asks of it for the people
// using that desktop: a ticket for one of its windows to connect, and a CLI's
// sign-in on that machine with no terminal.
//
// A WSL distribution's or an SSH machine's Studio is reached by the desktop's
// windows directly (design-wsl-ssh-direct): each window's socket goes to a
// loopback route the desktop's shell keeps, which carries it to the machine's
// own window listener. That listener admits a socket only with a ticket it
// minted itself, so the shell asks for one here, over its own connection,
// for each connection of each window. Only that connection may ask: a ticket
// admits a window of Studio's own, which is shown what an owner is shown.
//
// A paired device (the phone, another desktop's window) does not reach the
// machine: an SSH machine or a WSL distribution is reached only from the
// desktop that holds its connection.
//
// Signing a chat's CLI in on the machine (decision R34) runs the CLI's own
// login there as a plain child and reads its link, its one-time code and
// whether it waits for a code pasted back. The client shows them, opens the
// link in its own browser, sends the pasted code back, and waits for the end.

/** A ticket for one connection of a window to this Studio's window listener. */
export type StudioWindowTicketGrant = {
  /** The credential the socket's hello presents: good once, for thirty seconds, from the origin it was asked for. */
  token: string
  /** Where on the window listener the socket goes, with the ticket in its query: `/ws?ticket=…`. */
  path: string
}

/**
 * The kinds of record a desktop hands over to the machine whose chats they
 * concern (`environment.adopt`), in the order they are kept: a workspace
 * first, so what names its chats finds them.
 */
export const STUDIO_ADOPTED_RECORD_KINDS = [
  'workspace',
  'chat',
  'approval-rule',
  'schedule',
  'scheduled-message',
  'usage-limit-resume',
  'pull-request',
] as const

export type StudioAdoptedRecordKind = (typeof STUDIO_ADOPTED_RECORD_KINDS)[number]

/**
 * One record handed over: its kind, its id there, the sha-256 of its body as
 * canonical JSON (keys sorted, no spaces), and the body in the machine's own
 * spelling of its paths. What each body holds is the record as the desktop's
 * own store keeps it: a workspace record; a scheduled agent; a scheduled or
 * held message; `{ workspaceId, agentId }` for a usage-limit resume to keep
 * scheduled; `{ workspaceId, agentId, url, title?, watched?, untold? }` for
 * a pull request a chat opened, `untold` being the news its watch found that
 * the chat has not been told yet.
 *
 * A chat the desktop ran itself (`chat`, id `<workspaceId>:<agentId>`) is
 * `{ workspaceId, agentId, workspaceRoot, files }`: each file the chat keeps,
 * `{ place, path, sha256, bytes, parts }`. `place` is `store` (a path under
 * the chat's workspace store's `conversations/<workspaceId>/`: its
 * transcript, its tools' details, its handoffs) or `attachments`, `images`
 * or `plans` (`<folder>/<file>` in that store of the data directory); `parts`
 * are the sha-256s of its pieces, in order, each staged through `uploads.*`
 * (`MAX_ADOPTED_PART_BYTES`). A saved approval (`approval-rule`, id the
 * rule's) is the rule as the desktop keeps it.
 *
 * A held message's pictures and files travel beside the records
 * (`StudioAdoptedFile`): its body names each in `carried.images` and
 * `carried.files` by the sha-256 of its bytes, and the call stages each once
 * through `uploads.*` and names its upload by that digest.
 */
export type StudioAdoptedRecord = {
  kind: StudioAdoptedRecordKind
  id: string
  digest: string
  body: Record<string, unknown>
}

/** A file a handed-over record carries: an upload this connection staged, by the sha-256 of its bytes. */
export type StudioAdoptedFile = { uploadId: string; digest: string }

/** What a hand-over came to: what the machine now keeps, and what it kept its own copy of instead, and why. */
export type StudioAdoptResult = {
  held: Array<{ kind: StudioAdoptedRecordKind; id: string }>
  conflicts: Array<{ kind: StudioAdoptedRecordKind; id: string; reason: string }>
}

/** The most records one hand-over carries; a longer one is sent in parts under the same migration. */
export const MAX_ADOPTED_RECORDS = 500

/** The most files one hand-over call stages beside its records: as many as a client may stage at once. */
export const MAX_ADOPTED_FILES = 16

/**
 * The largest piece of a chat's file one upload carries. A call that stages
 * files and names no record keeps them for the records that follow under the
 * same migration, so a transcript of any size goes in parts.
 */
export const MAX_ADOPTED_PART_BYTES = 4 * 1024 * 1024

/**
 * What a Studio is doing that stopping it would end: a chat working (starting,
 * mid-turn, waiting on a person, or running background agents, shells or
 * monitors), and the work it does on its own with no client and no chat
 * working: schedules with a run to come, pull request watches, messages kept
 * to send later, resumes after a usage limit.
 */
export type StudioEnvironmentWork = {
  working: boolean
  schedules: Array<{ id: string; title: string; nextRunAt: number }>
  watches: Array<{ url: string; title: string }>
  /** Messages kept to send into a chat later (scheduled, or held for a turn's end). */
  messages: number
  /** Chats a usage limit stopped, with a resume set for when it resets. */
  resumes: number
}

/** Who a launch token proves an agent to be: the terminal agent the desktop launched. */
export type StudioLaunchIdentity = { workspaceId: string; agentId: string; agentName?: string; cliId?: string }

/** A launch token issued (with its identity) or revoked (`identity` null), by its SHA-256 alone. */
export type StudioLaunchTokenChange = { digest: string; identity: StudioLaunchIdentity | null }

/** The most token changes one call carries: a desktop's live WSL terminal agents, with room. */
export const MAX_LAUNCH_TOKEN_CHANGES = 256

/** A launch file, by its path under the terminal launch directory, and its bytes. */
export type StudioLaunchFile = { path: string; b64: string }

/** What a WSL terminal's launch files may total in one call: a startup script and its host-context file. */
export const MAX_LAUNCH_FILE_BYTES = 512 * 1024

/** Why a session is still working, as the processes it left say (the idle reaper's reasons). */
export type StudioSubtreeLiveReason = 'listening_port' | 'busy_cpu' | 'tool_shell'

/** What is asked of a WSL terminal's processes inside the distribution. */
export type StudioTerminalProcessesAsk =
  /** Whether each session (by its pid file key) still works: a key absent from the answer is undetermined. */
  | { op: 'snapshot'; keys: string[] }
  /** End what a closed session left: its CLI by `--session-id`, and its shell's tree while it runs its script. */
  | { op: 'kill'; cliSessionId: string; key: string }
  /** End every session this desktop's profile launched there (the desktop quit, or one before it did not). */
  | { op: 'endAll' }

/**
 * Where a WSL distribution's Studio wrote the app's Claude plugin copy for the
 * desktop's WSL terminals, as paths in the distribution: what a launch passes
 * as `--plugin-dir`, the one-skill plugins by skill id, and the status line.
 * All empty when its build shipped no plugin.
 */
export type StudioTerminalPluginCopy = {
  pluginDirs: string[]
  skillPluginDirs: Record<string, string>
  statusLineScriptPath: string | null
}

/** A git command for `environment.git`: its folder and arguments as the distribution spells them. */
export type StudioEnvironmentGitAsk = {
  /** An absolute path in the distribution. */
  cwd: string
  args: string[]
  /** Null for no deadline: a git write runs the repository's hooks, and ending one part-way leaves a lock. */
  timeoutMs: number | null
  /** Variables laid over the server's own environment. */
  env?: Record<string, string>
  /** Bytes for git's stdin, in base64, so a patch's CRLFs and a pathspec list's NULs cross unchanged. */
  stdinB64?: string
}

/** How a command run in the distribution ended. Each stream is capped; `truncated` when one was cut. */
export type StudioEnvironmentRunOutcome = {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  spawnFailed?: boolean
  truncated?: boolean
}

/** The distribution's home, and the config-home variables its login shell sets, as Linux paths. */
export type StudioEnvironmentHome = {
  home: string
  env: { CLAUDE_CONFIG_DIR?: string; CODEX_HOME?: string; XDG_CONFIG_HOME?: string }
}

/** The most bytes of git stdin `environment.git` carries: it rides in one client frame. */
export const MAX_ENVIRONMENT_GIT_STDIN_BYTES = 768 * 1024

/** A sign-in that started: its link, the code to type there, and whether a code is pasted back. */
export type StudioSignInStarted =
  { ok: true; id: string; url: string; code: string | null; paste: boolean } | { ok: false; message: string }

/** How a sign-in ended. */
export type StudioSignInDone = { ok: true } | { ok: false; message: string }

export type StudioEnvironmentAccessMethodMap = {
  /**
   * What stopping this Studio would end, asked by the desktop that holds it:
   * before it stops a WSL distribution's server for being idle, and for the
   * quit question that names what stops with it.
   */
  'environment.work': { params: Record<string, never>; result: StudioEnvironmentWork }
  /**
   * A ticket for one connection of one of the shell's windows. Only the
   * desktop's own shell connection may ask (the method is the shell's, not
   * merely an owner's): an owner's web tab and a paired app are refused.
   */
  'environment.windowTicket': {
    params: { windowKey: string; origin: string }
    result: StudioWindowTicketGrant
  }
  /**
   * The window has gone (closed, reloaded, crashed): its unspent tickets are
   * void and its connections end. The desktop's shell alone asks.
   */
  'environment.revokeWindow': { params: { windowKey: string }; result: { revoked: true } }
  /**
   * Keep records the desktop that holds this Studio kept for its chats, so
   * they go on here with no desktop watching (design-environment-migration).
   * Safe to repeat: a record already kept under the same digest is held
   * again and nothing changes; one already here under another is left as
   * this Studio has it and reported. Answered only for what is on disk.
   */
  'environment.adopt': {
    params: { commandId: string; migrationId: string; records: StudioAdoptedRecord[]; files?: StudioAdoptedFile[] }
    result: StudioAdoptResult
  }
  /**
   * The launch tokens of the desktop's terminal agents that run inside this
   * machine (a WSL terminal is the desktop's pty, its agent runs here), by
   * digest: an agent whose MCP bridge presents one to this Studio's gateway
   * is that agent, as on the desktop. The token itself never crosses.
   * `replace` drops every token the desktop did not name again (a
   * reconnect, which may have missed a revoke). The desktop's shell alone asks.
   */
  'environment.launchTokens': {
    params: { tokens: StudioLaunchTokenChange[]; replace?: boolean }
    result: { held: number }
  }
  /**
   * Write (`write`, under the terminal launch directory, each file private) or
   * remove (`remove`, by top-level name) a WSL terminal's launch files: its
   * startup script, which holds the launch's secrets, and its host-context
   * file. The desktop's shell alone asks: the terminal is its pty.
   */
  'environment.launchFiles': {
    params: { write?: StudioLaunchFile[]; remove?: string[] }
    result: { paths: string[] }
  }
  /** Read or end the processes the desktop's WSL terminals left. The desktop's shell alone asks. */
  'environment.terminalProcesses': {
    params: StudioTerminalProcessesAsk
    result: { verdicts?: Record<string, StudioSubtreeLiveReason | null>; killed?: number[] }
  }
  /**
   * Build the app's Claude plugin copy for the desktop's WSL terminals from
   * this Studio's own resources, with the Studio skills the person chose
   * (`enabledSkills`, by id), and say where it is. The desktop's shell alone asks.
   */
  'environment.pluginCopy': { params: { enabledSkills: string[] }; result: StudioTerminalPluginCopy }
  /**
   * Run git in a folder of this distribution for the desktop that holds it
   * (`git -C <cwd> <args>`), with this Studio's login environment. The
   * desktop's shell alone asks.
   */
  'environment.git': { params: StudioEnvironmentGitAsk; result: StudioEnvironmentRunOutcome }
  /** This distribution's home and config-home variables. The desktop's shell alone asks. */
  'environment.home': { params: Record<string, never>; result: StudioEnvironmentHome }
  /** Start the CLI's own login on this machine, for a provider whose CLI has one that needs no terminal. */
  'providers.signInStart': { params: { commandId: string; providerId: string }; result: StudioSignInStarted }
  /** Send the code the browser showed back to a sign-in that asked for one. */
  'providers.signInPaste': { params: { commandId: string; id: string; code: string }; result: { ok: boolean } }
  /** Answered when the sign-in ends, however long the person takes (the login's own limit is fifteen minutes). */
  'providers.signInWait': { params: { commandId: string; id: string }; result: StudioSignInDone }
  /** Stop a sign-in. */
  'providers.signInCancel': { params: { commandId: string; id: string }; result: { ok: boolean } }
}

const COMMAND_ID = '"commandId" names this request: 1 to 200 characters.'
const SIGN_IN_ID = '"id" is the sign-in this answers, as its start named it.'

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const commandId = (value: Record<string, unknown>) => text(value.commandId, 200)
const signInId = (value: Record<string, unknown>) => text(value.id, 200)

const OWN_WINDOW =
  'It admits a window of Studio’s own, shown what an owner is shown, so only the desktop that holds this Studio asks.'
const WINDOW_KEY = '"windowKey" names the window: 1 to 200 characters.'
const ADOPTS =
  'It writes this Studio’s own stores with the records the desktop that holds it kept, so only that desktop asks.'
const HOLDS =
  'It names this Studio’s schedules and watched pull requests, for the desktop that holds it to decide whether to stop it.'
const SIGNS_IN = 'It runs a CLI’s login on this machine and keeps its credential here.'
const PROVES =
  'It says which agent a launch token proves, for the terminal agents the desktop that holds this Studio launched, so only that desktop asks.'
const TOKEN_ID = /^[A-Za-z0-9_.:-]{1,200}$/u
const LAUNCHES =
  'It writes, reads and ends what the desktop that holds this Studio launched here in its own terminals, so only that desktop asks.'
const LAUNCH_ENTRY = /^[A-Za-z0-9._-]{1,200}$/u
const PID_KEY = /^[A-Za-z0-9._-]{1,200}$/u
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const MACHINE =
  'It runs git and reads the home on this machine for the desktop that holds this Studio, so only that desktop asks.'
const machine = {
  scope: null,
  mutation: false,
  capability: STUDIO_ENVIRONMENT_MACHINE_CAPABILITY,
  owner: MACHINE,
  shell: MACHINE,
} as const
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u
/** A day: past it, a deadline is a mistake rather than a wait. */
const MAX_GIT_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** An absolute path in the distribution, as git takes it. */
function linuxPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !value.includes('\0')
}
const terminalHost = {
  scope: null,
  mutation: false,
  capability: STUDIO_ENVIRONMENT_TERMINAL_HOST_CAPABILITY,
  owner: LAUNCHES,
  shell: LAUNCHES,
} as const

/** A launch file's path: plain segments under the launch directory, its first a plain name. */
function launchPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 400 || value.includes('\\') || value.includes('\0')) return false
  const segments = value.split('/')
  return LAUNCH_ENTRY.test(segments[0]) && segments.every((part) => part !== '' && part !== '.' && part !== '..')
}

function launchIdentity(value: unknown): StudioLaunchIdentity | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  if (typeof entry.workspaceId !== 'string' || !TOKEN_ID.test(entry.workspaceId)) return undefined
  if (typeof entry.agentId !== 'string' || !TOKEN_ID.test(entry.agentId)) return undefined
  for (const key of ['agentName', 'cliId'] as const)
    if (entry[key] !== undefined && !text(entry[key], 200)) return undefined
  return {
    workspaceId: entry.workspaceId,
    agentId: entry.agentId,
    ...(typeof entry.agentName === 'string' ? { agentName: entry.agentName } : {}),
    ...(typeof entry.cliId === 'string' ? { cliId: entry.cliId } : {}),
  }
}

const signIn = {
  scope: 'settings:write',
  mutation: true,
  capability: STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY,
  owner: SIGNS_IN,
} as const

export const STUDIO_ENVIRONMENT_ACCESS_METHODS: StudioMethodTable<StudioEnvironmentAccessMethodMap> = {
  'environment.work': {
    scope: null,
    mutation: false,
    capability: STUDIO_ENVIRONMENT_WORK_CAPABILITY,
    owner: HOLDS,
    shell: HOLDS,
    params: () => studioParams({}),
  },
  'environment.windowTicket': {
    scope: null,
    mutation: false,
    capability: STUDIO_WINDOW_TICKETS_CAPABILITY,
    owner: OWN_WINDOW,
    shell: OWN_WINDOW,
    params: (value) => {
      if (!text(value.windowKey, 200)) return studioParamsRefused(WINDOW_KEY)
      if (!text(value.origin, 200)) return studioParamsRefused('"origin" is the origin the window’s socket says.')
      return studioParams({ windowKey: value.windowKey, origin: value.origin })
    },
  },
  'environment.revokeWindow': {
    scope: null,
    mutation: false,
    capability: STUDIO_WINDOW_TICKETS_CAPABILITY,
    owner: OWN_WINDOW,
    shell: OWN_WINDOW,
    params: (value) =>
      text(value.windowKey, 200) ? studioParams({ windowKey: value.windowKey }) : studioParamsRefused(WINDOW_KEY),
  },
  'environment.adopt': {
    scope: null,
    mutation: true,
    capability: STUDIO_ENVIRONMENT_ADOPT_CAPABILITY,
    owner: ADOPTS,
    shell: ADOPTS,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!(typeof value.migrationId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value.migrationId)))
        return studioParamsRefused('"migrationId" names the hand-over: 1 to 128 of [A-Za-z0-9_-].')
      const given = value.records
      // None, only when it stages parts for the records that follow.
      const least = Array.isArray(value.files) && value.files.length > 0 ? 0 : 1
      if (!Array.isArray(given) || given.length < least || given.length > MAX_ADOPTED_RECORDS)
        return studioParamsRefused(
          `"records" holds 1 to ${MAX_ADOPTED_RECORDS} records, or none when "files" stages parts for the records that follow.`,
        )
      const kinds: readonly string[] = STUDIO_ADOPTED_RECORD_KINDS
      const records: StudioAdoptedRecord[] = []
      for (const entry of given) {
        const record = entry as Record<string, unknown> | null
        if (
          !record ||
          typeof record !== 'object' ||
          typeof record.kind !== 'string' ||
          !kinds.includes(record.kind) ||
          !text(record.id, 200) ||
          !(typeof record.digest === 'string' && /^[0-9a-f]{64}$/u.test(record.digest)) ||
          !record.body ||
          typeof record.body !== 'object' ||
          Array.isArray(record.body)
        )
          return studioParamsRefused(
            'Each record is { kind, id, digest, body }: a kind this Studio keeps, its id, the sha-256 of its body, and the body.',
          )
        records.push({
          kind: record.kind as StudioAdoptedRecordKind,
          id: record.id,
          digest: record.digest,
          body: record.body as Record<string, unknown>,
        })
      }
      const staged = value.files
      if (
        staged !== undefined &&
        !(
          Array.isArray(staged) &&
          staged.length <= MAX_ADOPTED_FILES &&
          staged.every(
            (file) =>
              file !== null &&
              typeof file === 'object' &&
              text((file as Record<string, unknown>).uploadId, 200) &&
              /^[0-9a-f]{64}$/u.test(String((file as Record<string, unknown>).digest)),
          )
        )
      )
        return studioParamsRefused(
          `"files" lists at most ${MAX_ADOPTED_FILES} { uploadId, digest }: an upload this connection staged and the sha-256 of its bytes.`,
        )
      const files = (staged as StudioAdoptedFile[] | undefined)?.map(({ uploadId, digest }) => ({ uploadId, digest }))
      return studioParams({
        commandId: value.commandId as string,
        migrationId: value.migrationId,
        records,
        ...(files?.length ? { files } : {}),
      })
    },
  },
  'environment.launchTokens': {
    scope: null,
    mutation: false,
    capability: STUDIO_ENVIRONMENT_LAUNCH_TOKENS_CAPABILITY,
    owner: PROVES,
    shell: PROVES,
    params: (value) => {
      const given = value.tokens
      if (!Array.isArray(given) || given.length > MAX_LAUNCH_TOKEN_CHANGES)
        return studioParamsRefused(`"tokens" lists at most ${MAX_LAUNCH_TOKEN_CHANGES} { digest, identity }.`)
      const tokens: StudioLaunchTokenChange[] = []
      for (const entry of given) {
        const change = entry as Record<string, unknown> | null
        const identity = change && typeof change === 'object' ? launchIdentity(change.identity) : undefined
        if (
          !change ||
          typeof change.digest !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(change.digest) ||
          identity === undefined
        )
          return studioParamsRefused(
            'Each token is { digest, identity }: the sha-256 of the token, and { workspaceId, agentId } it proves, or null when it is revoked.',
          )
        tokens.push({ digest: change.digest, identity })
      }
      if (value.replace !== undefined && typeof value.replace !== 'boolean')
        return studioParamsRefused('"replace" is true or false, when given.')
      return studioParams({ tokens, ...(value.replace === true ? { replace: true } : {}) })
    },
  },
  'environment.launchFiles': {
    ...terminalHost,
    params: (value) => {
      const write = value.write
      const remove = value.remove
      if (write === undefined && remove === undefined)
        return studioParamsRefused('Say what to "write", what to "remove", or both.')
      let bytes = 0
      const files: StudioLaunchFile[] = []
      if (write !== undefined) {
        if (!Array.isArray(write) || write.length === 0 || write.length > 16)
          return studioParamsRefused('"write" lists 1 to 16 { path, b64 }.')
        for (const entry of write) {
          const file = entry as Record<string, unknown> | null
          if (!file || typeof file !== 'object' || !launchPath(file.path) || typeof file.b64 !== 'string')
            return studioParamsRefused(
              'Each file is { path, b64 }: a path of plain names under the launch directory, and its bytes in base64.',
            )
          bytes += file.b64.length
          files.push({ path: file.path, b64: file.b64 })
        }
        if (bytes > (MAX_LAUNCH_FILE_BYTES * 4) / 3 + 64)
          return studioParamsRefused(`A terminal's launch files total at most ${MAX_LAUNCH_FILE_BYTES} bytes.`)
      }
      if (
        remove !== undefined &&
        !(
          Array.isArray(remove) &&
          remove.length <= 64 &&
          remove.every((name) => typeof name === 'string' && LAUNCH_ENTRY.test(name))
        )
      )
        return studioParamsRefused('"remove" lists at most 64 plain names in the launch directory.')
      return studioParams({
        ...(files.length > 0 ? { write: files } : {}),
        ...(remove !== undefined ? { remove: remove as string[] } : {}),
      })
    },
  },
  'environment.terminalProcesses': {
    ...terminalHost,
    params: (value) => {
      if (value.op === 'endAll') return studioParams({ op: 'endAll' as const })
      if (value.op === 'snapshot') {
        const keys = value.keys
        if (
          !Array.isArray(keys) ||
          keys.length > 256 ||
          !keys.every((key) => typeof key === 'string' && PID_KEY.test(key))
        )
          return studioParamsRefused('"keys" lists at most 256 sessions\' pid file keys.')
        return studioParams({ op: 'snapshot' as const, keys: keys as string[] })
      }
      if (value.op === 'kill') {
        const cliSessionId = value.cliSessionId
        const key = value.key
        if (
          typeof cliSessionId !== 'string' ||
          (cliSessionId !== '' && !/^[A-Za-z0-9._:-]{1,128}$/u.test(cliSessionId))
        )
          return studioParamsRefused('"cliSessionId" is the CLI\'s session id, or empty.')
        if (typeof key !== 'string' || (key !== '' && !PID_KEY.test(key)))
          return studioParamsRefused('"key" is the session\'s pid file key, or empty.')
        if (!cliSessionId && !key) return studioParamsRefused('Name the CLI session, the pid file key, or both.')
        return studioParams({ op: 'kill' as const, cliSessionId, key })
      }
      return studioParamsRefused('"op" is snapshot, kill or endAll.')
    },
  },
  'environment.pluginCopy': {
    ...terminalHost,
    params: (value) => {
      const skills = value.enabledSkills
      if (
        !Array.isArray(skills) ||
        skills.length > 64 ||
        !skills.every((skill) => typeof skill === 'string' && SKILL_ID.test(skill))
      )
        return studioParamsRefused('"enabledSkills" lists at most 64 Studio skill ids.')
      return studioParams({ enabledSkills: [...new Set(skills as string[])] })
    },
  },
  'environment.git': {
    ...machine,
    params: (value) => {
      if (!linuxPath(value.cwd)) return studioParamsRefused('"cwd" is an absolute path in the distribution.')
      const args = value.args
      if (
        !Array.isArray(args) ||
        args.length > 4096 ||
        !args.every((arg) => typeof arg === 'string' && arg.length <= 65_536 && !arg.includes('\0'))
      )
        return studioParamsRefused('"args" lists git\'s arguments, as strings without NUL.')
      const timeoutMs = value.timeoutMs
      if (
        timeoutMs !== null &&
        !(
          typeof timeoutMs === 'number' &&
          Number.isInteger(timeoutMs) &&
          timeoutMs > 0 &&
          timeoutMs <= MAX_GIT_TIMEOUT_MS
        )
      )
        return studioParamsRefused('"timeoutMs" is a positive number of milliseconds, or null for no deadline.')
      let env: Record<string, string> | undefined
      if (value.env !== undefined) {
        const entries =
          value.env && typeof value.env === 'object' && !Array.isArray(value.env) ? Object.entries(value.env) : null
        if (
          !entries ||
          entries.length > 64 ||
          !entries.every(([name, text]) => ENV_NAME.test(name) && typeof text === 'string')
        )
          return studioParamsRefused('"env" holds at most 64 plain variables.')
        env = Object.fromEntries(entries) as Record<string, string>
      }
      const stdinB64 = value.stdinB64
      if (
        stdinB64 !== undefined &&
        !(
          typeof stdinB64 === 'string' &&
          BASE64.test(stdinB64) &&
          stdinB64.length <= (MAX_ENVIRONMENT_GIT_STDIN_BYTES * 4) / 3 + 4
        )
      )
        return studioParamsRefused(`"stdinB64" is base64, of at most ${MAX_ENVIRONMENT_GIT_STDIN_BYTES} bytes.`)
      return studioParams({
        cwd: value.cwd,
        args: args as string[],
        timeoutMs: timeoutMs as number | null,
        ...(env ? { env } : {}),
        ...(stdinB64 !== undefined ? { stdinB64: stdinB64 as string } : {}),
      })
    },
  },
  'environment.home': { ...machine, params: studioNoParams },
  'providers.signInStart': {
    ...signIn,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!text(value.providerId, 100)) return studioParamsRefused('"providerId" names the provider to sign in.')
      return studioParams({ commandId: value.commandId as string, providerId: value.providerId })
    },
  },
  'providers.signInPaste': {
    ...signIn,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!signInId(value)) return studioParamsRefused(SIGN_IN_ID)
      if (!text(value.code, 4_096)) return studioParamsRefused('"code" is the code the browser showed.')
      return studioParams({ commandId: value.commandId as string, id: value.id as string, code: value.code })
    },
  },
  'providers.signInWait': {
    ...signIn,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!signInId(value)) return studioParamsRefused(SIGN_IN_ID)
      return studioParams({ commandId: value.commandId as string, id: value.id as string })
    },
  },
  'providers.signInCancel': {
    ...signIn,
    params: (value) => {
      if (!commandId(value)) return studioParamsRefused(COMMAND_ID)
      if (!signInId(value)) return studioParamsRefused(SIGN_IN_ID)
      return studioParams({ commandId: value.commandId as string, id: value.id as string })
    },
  },
}
