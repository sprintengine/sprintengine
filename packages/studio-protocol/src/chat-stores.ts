import {
  studioNoParams,
  studioParams,
  studioParamsRefused,
  type StudioMethodDefinition,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import type { MachineColour, MachineKind } from './agent-settings.js'
import { STUDIO_CHAT_STORES_CAPABILITY } from './handshake.js'

// What a Studio keeps beside its chats, for every chat at once: the usage
// limits its agents reported (`usageLimits.*`), the chats a limit stopped and
// the resume each can have (`usageLimitResumes.*`), the messages a person
// scheduled or queued into a chat (`scheduledMessages.*`), the priced usage
// report (`usage.report`), and the sessions an agent CLI saved on the
// machine, to bring in as chats (`conversationImport.*`).
//
// The conversation lane's per-chat frames (`conversation.scheduled`,
// `conversation.usageLimits`) are one chat's projection of the same stores
// for a client following that chat; these are the stores whole, as the
// desktop's own windows draw them: every chat's tray from one answer, the
// Settings switch, the usage dashboard.
//
// Grants. Reading a chat's held and scheduled messages and its limit notice is
// `conversation:read`; changing them drives the chat, `conversation:operate`.
// The limits themselves are the plan's, `providers:read`. Switching the
// resume for every chat is a setting, `settings:write`. The usage report and
// the import are an owner's: one reads every agent's logs on this machine and
// asks the paired machines for theirs, the other reads the CLIs' own session
// files in the home folder and makes chats from them.
//
// `src/shared` re-exports each type under the name the app has always used.

// ── Usage limits ────────────────────────────────────────────────────────────

export type UsageLimitProvider = 'claude' | 'codex'

export const USAGE_LIMIT_PROVIDERS: readonly UsageLimitProvider[] = ['claude', 'codex']

export type UsageLimitBilling = 'subscription' | 'api' | 'unknown'

/** The provider's own word for where a window stands; `rejected` is a limit reached. */
export type UsageLimitStatus = 'allowed' | 'warning' | 'rejected'

export type UsageLimitWindow = {
  /** Stable across sources and updates (`five_hour`, `seven_day`, `codex:primary`…): partial updates merge on it. */
  id: string
  label: string
  /** 0..100. Null when the source said where the window stands but not how full it is. */
  usedPercent: number | null
  /** Epoch ms the window resets, or null when not reported. */
  resetsAt: number | null
  /** How long the window is, for the pace marker; absent when unknown. */
  durationMs?: number
  /**
   * `model` for a window that meters one model's use (Claude's model
   * weeklies, a Codex bucket under its own limit id): it holds back a chat on
   * that model, not the provider. Absent for an account-wide window, which
   * holds back every turn.
   */
  scope?: 'model'
  status: UsageLimitStatus
  /** When this window was last reported (epoch ms). */
  observedAt: number
}

export type UsageLimitSnapshot = {
  provider: UsageLimitProvider
  billing: UsageLimitBilling
  /** The plan the provider named (`max`, `plus`…), when it did. */
  plan?: string
  windows: UsageLimitWindow[]
  /** The newest of the windows' readings (epoch ms). */
  observedAt: number
}

/** One snapshot per provider that has something to show. */
export type UsageLimitsState = { snapshots: UsageLimitSnapshot[] }

// ── Usage-limit resumes ─────────────────────────────────────────────────────

/** Which of the plan's limits ran out, as the notice names it; null when the source did not say. */
export type UsageLimitKind = 'session' | 'weekly' | null

/** A chat by its identity: the agent record it is, in the workspace that holds it. */
export type UsageLimitResumeChat = { workspaceId: string; agentId: string }

export type UsageLimitResumeNotice = UsageLimitResumeChat & {
  provider: UsageLimitProvider
  limit: UsageLimitKind
  /** When the limit lifts (epoch ms), or null when nothing said. */
  resetsAt: number | null
  /** When the turn was stopped. */
  hitAt: number
  /** When the continuation goes out (epoch ms), or null while none is scheduled. */
  resumeAt: number | null
  /**
   * The continuation was sent and the chat refused it, in the chat's words.
   * The notice stays, saying so, until Retry or Dismiss; nothing is scheduled.
   */
  failure?: string
}

export type UsageLimitResumeState = {
  /** Schedule the resume for every chat a usage limit stops. Off by default: a resume spends the person's plan. */
  autoResume: boolean
  notices: UsageLimitResumeNotice[]
}

/** What one chat's notice is asked: schedule its resume, cancel it but keep the notice, dismiss both, or retry one that failed. */
export type UsageLimitResumeAction = 'schedule' | 'cancel' | 'dismiss' | 'retry'

/**
 * What a window asks of the resumes: one chat's action, or the setting.
 * (`usageLimitResumes.update` takes the first, `usageLimitResumes.setAuto` the
 * second.)
 */
export type UsageLimitResumeUpdate =
  (UsageLimitResumeChat & { kind: UsageLimitResumeAction }) | { kind: 'auto'; enabled: boolean }

// ── Scheduled and held messages ─────────────────────────────────────────────

/** A chat by its identity: the agent record it is, in the workspace that holds it. */
export type ScheduledMessageChat = { workspaceId: string; agentId: string }

export type ScheduledMessage = ScheduledMessageChat & {
  id: string
  text: string
  /** When it goes out (epoch ms). */
  sendAt: number
  createdAt: number
  /**
   * Held for the end of the chat's turn rather than for a time: a message a
   * composer queued while this chat was working, handed to the Studio so it
   * goes even once that client sleeps or closes. It went due when it was
   * held, so it waits on the turn from the start.
   */
  queued?: true
  /**
   * Sent once this provider's usage limit has lifted, rather than at a time
   * the person picked: `sendAt` is the reset as it was known when it was
   * scheduled, and when that comes the limit is asked again, so a window that
   * resets later (a weekly one behind the session's) moves it to that reset.
   */
  untilLimitReset?: UsageLimitProvider
  /**
   * What a held message carries beside its words: its pictures and files by
   * name (kept on the Studio's disk until it goes), its skills by id, and the
   * files and folders of the chat's folder it mentions. Absent for one that
   * carries nothing, and for every message scheduled for a time.
   */
  carries?: ScheduledMessageCarries
  /**
   * It came due while the chat was working, and waits for the turn to end
   * (epoch ms it first came due). Absent while it is still ahead.
   */
  waitingSince?: number
  /** It is on its way into the chat now. Never kept in the file. */
  sending?: true
  /**
   * It went out and the chat refused it, in the chat's words. It stays, saying
   * so, until Retry, Edit or Delete; nothing is scheduled.
   */
  failure?: string
}

/** What a held message carries, as a tray names it; each list absent when empty. */
export type ScheduledMessageCarries = {
  images?: string[]
  files?: string[]
  skills?: string[]
  mentions?: Array<{ path: string; kind: 'file' | 'folder'; line?: number; endLine?: number }>
}

export type ScheduledMessagesState = { messages: ScheduledMessage[] }

/**
 * What a window asks: schedule a message into a chat, move one to another
 * time, send one now (a failed one included), or delete one.
 */
export type ScheduledMessageUpdate =
  | (ScheduledMessageChat & {
      kind: 'schedule'
      text: string
      sendAt: number
      untilLimitReset?: UsageLimitProvider
    })
  | { kind: 'reschedule'; id: string; sendAt: number }
  | { kind: 'send-now'; id: string }
  | { kind: 'delete'; id: string }

/** A message a chat's composer queued while its turn ran, for the Studio to hold and send when the turn ends. */
export type ScheduledMessageHoldRequest = ScheduledMessageChat & { text: string }

export type ScheduledMessageHoldAnswer = { ok: true; id: string } | { ok: false; reason: string }

/** A message is a turn a person typed; this keeps a pasted novel out of a small file. */
export const MAX_SCHEDULED_MESSAGE_LENGTH = 100_000

// ── The usage report ────────────────────────────────────────────────────────

/** Where the prices came from: the live list fetched today, an older copy of it, or the bundled table alone. */
export type UsagePricingSource = 'live' | 'cached' | 'bundled'

export type UsageReportRequest = {
  /** Epoch ms, inclusive. */
  from: number
  /** Epoch ms, exclusive. */
  to: number
  /**
   * Scan the logs now and fetch the price list again, rather than answer from
   * the last scan. With `peers` asking, it is passed on to the paired machines
   * instead, and this machine answers from its last scan.
   */
  refresh?: boolean
  /**
   * What to do about the paired machines. `cached` (the default) asks none of
   * them and counts what each last answered, so the answer never waits on the
   * network; `ask` asks every one now; `await` asks again only those whose
   * answer said they were still reading their logs, and waits for the read.
   * The dashboard asks in that order, drawing each answer as it comes.
   */
  peers?: UsagePeerMode
  /** Count only these machines (`UsageReportMachine.id`); absent or empty counts every one. */
  machines?: string[]
}

export type UsagePeerMode = 'cached' | 'ask' | 'await'

export const USAGE_PEER_MODES: readonly UsagePeerMode[] = ['cached', 'ask', 'await']

export type UsageReportTokens = {
  /** Fresh input: not read from or written to the prompt cache. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** The agent a session ran: an agent CLI's id (`claude-code`, `codex`, `opencode`…), or the provider's id for one that is not a CLI. */
export type UsageAgentId = string

export type UsageReportAgent = {
  id: UsageAgentId
  sessions: number
  tokens: UsageReportTokens
  /** Priced cost, plus what the agent reported for turns it priced itself. */
  costUsd: number
  /** Tokens no price was found for; they are in `tokens`, not in `costUsd`. */
  unpricedTokens: number
}

export type UsageReportModel = {
  agent: UsageAgentId
  model: string
  tokens: UsageReportTokens
  /** Null when nothing priced this model's tokens. */
  costUsd: number | null
  requests: number
}

/** One agent's usage in one hour. */
export type UsageReportPoint = {
  hour: number
  agent: UsageAgentId
  tokens: number
  costUsd: number
}

export type UsageReportSource = {
  id: string
  /** Session logs found. */
  found: number
  error: string | null
}

/**
 * Where a machine's figures came from:
 * - `local`: this machine's own logs;
 * - `ok`: the machine answered just now;
 * - `cached`: it did not answer, and what it answered last is counted;
 * - `offline`: it did not answer and has never answered, so nothing is counted;
 * - `unsupported`: its Studio does not serve usage yet;
 * - `unauthorized`: the pairing was revoked, or may not read it;
 * - `error`: it answered, but not with figures.
 */
export type UsageMachineStatus = 'local' | 'ok' | 'cached' | 'offline' | 'unsupported' | 'unauthorized' | 'error'

/** One machine's part of the report, counted with every machine in it (not just the ones filtered to). */
export type UsageReportMachine = {
  /** `local` for this machine, else the paired machine's connection id. */
  id: string
  label: string
  kind: MachineKind
  color: MachineColour
  status: UsageMachineStatus
  /** The machine said its figures predate a read of its logs that is running now. */
  scanning: boolean
  /** When that machine last read its logs, by its own answer. */
  scannedAt: number | null
  /** When this desktop last heard figures from it; null for this machine. */
  fetchedAt: number | null
  /** What went wrong, in the words of the side that knows; null when nothing did. */
  detail: string | null
  costUsd: number
  tokens: number
  sessions: number
}

export type UsageReport = {
  from: number
  to: number
  /** When the logs were last read (epoch ms), or null before the first scan finished. */
  scannedAt: number | null
  pricing: { source: UsagePricingSource; fetchedAt: number | null }
  totals: {
    tokens: UsageReportTokens
    costUsd: number
    /** What the cache reads saved over paying full input price for the same tokens. */
    cacheSavingsUsd: number
    sessions: number
    requests: number
    unpricedTokens: number
  }
  agents: UsageReportAgent[]
  models: UsageReportModel[]
  points: UsageReportPoint[]
  sources: UsageReportSource[]
  /**
   * This machine, then each paired machine. A session found on two machines (a
   * shared or synced home folder, a restored backup) counts once, on the
   * machine first in this list that has it.
   */
  machines: UsageReportMachine[]
  /** Sessions in the report that more than one machine had, counted once. */
  sharedSessions: number
}

export const LOCAL_USAGE_MACHINE_ID = 'local'

export type UsageReportResult = { ok: true; report: UsageReport } | { ok: false; message: string }

// ── Conversation import ─────────────────────────────────────────────────────

/**
 * The CLIs whose saved sessions the import reads. Each one keeps every session
 * it ran as a transcript on disk, under the CLI's own home, and resumes one by
 * its id; a chat made from one carries that id, so its next message continues
 * the same session rather than starting over.
 */
export type ConversationImportSource = 'claude-code' | 'codex'

export const CONVERSATION_IMPORT_SOURCES: readonly ConversationImportSource[] = ['claude-code', 'codex']

/** One session a CLI saved, as the picker lists it. */
export type ConversationImportSession = {
  source: ConversationImportSource
  /** The CLI's own id for the session: what it resumes by. */
  sessionId: string
  title: string
  /** The folder the session ran in, which the chat works in too. */
  folderPath: string
  startedAt: number
  /** When the session was last active: its newest record's time, else its file's. */
  updatedAt: number
  /** A chat here already carries this session. */
  imported: boolean
}

/** The sessions that ran in one folder, newest first. */
export type ConversationImportFolder = {
  folderPath: string
  /** The folder's own name, for the row. */
  name: string
  lastActiveAt: number
  sessions: ConversationImportSession[]
}

export type ConversationImportScanResult =
  | {
      ok: true
      /** Newest first. Only folders that still exist on this machine. */
      folders: ConversationImportFolder[]
      /** The CLIs whose home was found here, whether or not it held a session. */
      sources: ConversationImportSource[]
    }
  | { ok: false; message: string }

export type ConversationImportInput = {
  sessions: Array<{ source: ConversationImportSource; sessionId: string }>
}

export type ConversationImportResult =
  | {
      ok: true
      /** One chat per session it made, in the order asked. */
      imported: Array<{ source: ConversationImportSource; sessionId: string; workspaceId: string; agentId: string }>
      /** Sessions a chat already carried, left as they were. */
      skipped: number
      failed: Array<{ source: ConversationImportSource; sessionId: string; title: string; message: string }>
    }
  | { ok: false; message: string }

/** More than any picker offers at once. */
export const CONVERSATION_IMPORT_MAX_SESSIONS = 500

// ── The methods ─────────────────────────────────────────────────────────────

type Commanded<P> = P & { commandId: string }

export type StudioChatStoresMethodMap = {
  /** The usage limits as the Studio last heard them; `usageLimits.changed` tells every change after. */
  'usageLimits.get': { params: Record<string, never>; result: UsageLimitsState }
  /** The chats a usage limit stopped, and the setting; `usageLimitResumes.changed` tells every change after. */
  'usageLimitResumes.get': { params: Record<string, never>; result: UsageLimitResumeState }
  /** One chat's notice: schedule, cancel, dismiss or retry its resume. Answered with the state after it. */
  'usageLimitResumes.update': {
    params: Commanded<UsageLimitResumeChat & { action: UsageLimitResumeAction }>
    result: UsageLimitResumeState
  }
  /** The setting that schedules the resume for every chat a limit stops. */
  'usageLimitResumes.setAuto': { params: Commanded<{ enabled: boolean }>; result: UsageLimitResumeState }
  /** Every chat's scheduled and held messages; `scheduledMessages.changed` tells every change after. */
  'scheduledMessages.get': { params: Record<string, never>; result: ScheduledMessagesState }
  /** Schedule, move, send now or delete one. Answered with the state after it. */
  'scheduledMessages.update': { params: Commanded<{ update: ScheduledMessageUpdate }>; result: ScheduledMessagesState }
  /**
   * Hold a message the chat's composer queued while its turn ran, and send it
   * when the turn ends: a window's queue is gone with a reload, the Studio's
   * file is not. Held once per command id, so a retried ask holds it once.
   */
  'scheduledMessages.hold': { params: Commanded<ScheduledMessageHoldRequest>; result: ScheduledMessageHoldAnswer }
  /** Every agent's token use and its price, on this machine and on the machines paired with it. */
  'usage.report': { params: UsageReportRequest; result: UsageReportResult }
  /** The sessions the agent CLIs saved on this machine, by the folder each ran in. */
  'conversationImport.scan': { params: Record<string, never>; result: ConversationImportScanResult }
  /** A chat for each session named, in the folder it ran in, carrying its id. */
  'conversationImport.import': { params: Commanded<ConversationImportInput>; result: ConversationImportResult }
}

export type StudioChatStoresMethod = keyof StudioChatStoresMethodMap

export type StudioChatStoresTopicMap = {
  /** The usage limits, whole, each time a reading changes them. Nothing is replayed: ask `usageLimits.get`. */
  'usageLimits.changed': { params: Record<string, never>; payload: UsageLimitsState; stream: 'push' }
  /** The resumes, whole, each time one moves. Nothing is replayed: ask `usageLimitResumes.get`. */
  'usageLimitResumes.changed': { params: Record<string, never>; payload: UsageLimitResumeState; stream: 'push' }
  /** The scheduled and held messages, whole, each time one moves. Nothing is replayed: ask `scheduledMessages.get`. */
  'scheduledMessages.changed': { params: Record<string, never>; payload: ScheduledMessagesState; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const refuse = (message: string): StudioParamsRefusal => studioParamsRefused(message)

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'
const CHAT = '"workspaceId" and "agentId" name the chat.'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** A message's words, trimmed, or null for none or too many. */
function words(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= MAX_SCHEDULED_MESSAGE_LENGTH ? text : null
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

function chat(value: Record<string, unknown>): StudioParsed<ScheduledMessageChat> {
  return id(value.workspaceId) && id(value.agentId)
    ? studioParams({ workspaceId: value.workspaceId, agentId: value.agentId })
    : refuse(CHAT)
}

const RESUME_ACTIONS: readonly UsageLimitResumeAction[] = ['schedule', 'cancel', 'dismiss', 'retry']

/** A scheduled message's change, as a window sends it, or null for anything else. */
export function parseScheduledMessageUpdate(input: unknown): ScheduledMessageUpdate | null {
  if (!record(input)) return null
  if (input.kind === 'schedule') {
    if (!id(input.workspaceId) || !id(input.agentId) || !time(input.sendAt)) return null
    const text = words(input.text)
    if (!text) return null
    const untilLimitReset = USAGE_LIMIT_PROVIDERS.find((provider) => provider === input.untilLimitReset)
    return {
      kind: 'schedule',
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      text,
      sendAt: input.sendAt,
      ...(untilLimitReset ? { untilLimitReset } : {}),
    }
  }
  if (!id(input.id)) return null
  if (input.kind === 'reschedule')
    return time(input.sendAt) ? { kind: 'reschedule', id: input.id, sendAt: input.sendAt } : null
  if (input.kind === 'send-now' || input.kind === 'delete') return { kind: input.kind, id: input.id }
  return null
}

function usageReport(value: Record<string, unknown>): StudioParsed<UsageReportRequest> {
  if (typeof value.from !== 'number' || !Number.isFinite(value.from)) return refuse('"from" is a time, epoch ms.')
  if (typeof value.to !== 'number' || !Number.isFinite(value.to) || value.to < value.from)
    return refuse('"to" is a time, epoch ms, no earlier than "from".')
  if (value.refresh !== undefined && typeof value.refresh !== 'boolean') return refuse('"refresh" is true or false.')
  const peers = USAGE_PEER_MODES.find((mode) => mode === value.peers)
  if (value.peers !== undefined && !peers) return refuse('"peers" is cached, ask or await.')
  if (
    value.machines !== undefined &&
    !(Array.isArray(value.machines) && value.machines.length <= 200 && value.machines.every(id))
  )
    return refuse('"machines" is a list of machine ids.')
  return studioParams({
    from: value.from,
    to: value.to,
    ...(value.refresh === true ? { refresh: true } : {}),
    ...(peers ? { peers } : {}),
    ...(value.machines === undefined ? {} : { machines: [...(value.machines as string[])] }),
  })
}

function importSessions(value: Record<string, unknown>): StudioParsed<ConversationImportInput> {
  const list = value.sessions
  if (!Array.isArray(list) || list.length > CONVERSATION_IMPORT_MAX_SESSIONS)
    return refuse(`"sessions" is a list of at most ${CONVERSATION_IMPORT_MAX_SESSIONS} { source, sessionId }.`)
  const sessions: ConversationImportInput['sessions'] = []
  for (const entry of list) {
    const source = record(entry) ? CONVERSATION_IMPORT_SOURCES.find((known) => known === entry.source) : undefined
    if (!source || !record(entry) || !id(entry.sessionId))
      return refuse('Each session is { source: "claude-code" | "codex", sessionId }.')
    sessions.push({ source, sessionId: entry.sessionId })
  }
  return studioParams({ sessions })
}

// ── The table ───────────────────────────────────────────────────────────────

const USAGE_REPORT_OWNER =
  "It reads every agent's logs on this machine, with the folders they ran in, and asks the paired machines for theirs."
const IMPORT_OWNER =
  "It reads the agent CLIs' own session files in this machine's home folder, and makes chats in the folders they name."

const held = (
  scope: 'conversation:read' | 'conversation:operate' | 'conversation:create' | 'providers:read' | 'settings:write',
  mutation: boolean,
) => ({ scope, mutation, capability: STUDIO_CHAT_STORES_CAPABILITY }) as const

const resumeUpdate: StudioMethodDefinition<StudioChatStoresMethodMap['usageLimitResumes.update']> = {
  ...held('conversation:operate', true),
  params: commanded((value) => {
    const at = chat(value)
    if (!at.ok) return at
    const action = RESUME_ACTIONS.find((known) => known === value.action)
    return action ? studioParams({ ...at.params, action }) : refuse('"action" is schedule, cancel, dismiss or retry.')
  }),
}

export const STUDIO_CHAT_STORES_METHODS: StudioMethodTable<StudioChatStoresMethodMap> = {
  'usageLimits.get': { ...held('providers:read', false), params: studioNoParams },
  'usageLimitResumes.get': { ...held('conversation:read', false), params: studioNoParams },
  'usageLimitResumes.update': resumeUpdate,
  'usageLimitResumes.setAuto': {
    ...held('settings:write', true),
    params: commanded((value) =>
      typeof value.enabled === 'boolean'
        ? studioParams({ enabled: value.enabled })
        : refuse('"enabled" is true or false.'),
    ),
  },
  'scheduledMessages.get': { ...held('conversation:read', false), params: studioNoParams },
  'scheduledMessages.update': {
    ...held('conversation:operate', true),
    params: commanded((value) => {
      const update = parseScheduledMessageUpdate(value.update)
      return update
        ? studioParams({ update })
        : refuse(
            '"update" is { kind: "schedule", workspaceId, agentId, text, sendAt, untilLimitReset? }, or { kind: "reschedule", id, sendAt }, { kind: "send-now", id } or { kind: "delete", id }.',
          )
    }),
  },
  'scheduledMessages.hold': {
    ...held('conversation:operate', true),
    params: commanded((value) => {
      const at = chat(value)
      if (!at.ok) return at
      const text = words(value.text)
      return text
        ? studioParams({ ...at.params, text })
        : refuse(`"text" is the message, 1 to ${MAX_SCHEDULED_MESSAGE_LENGTH} characters.`)
    }),
  },
  'usage.report': { ...held('providers:read', false), owner: USAGE_REPORT_OWNER, params: usageReport },
  'conversationImport.scan': { ...held('conversation:create', false), owner: IMPORT_OWNER, params: studioNoParams },
  'conversationImport.import': {
    ...held('conversation:create', true),
    owner: IMPORT_OWNER,
    params: commanded(importSessions),
  },
}

export const STUDIO_CHAT_STORES_TOPICS: StudioTopicTable<StudioChatStoresTopicMap> = {
  'usageLimits.changed': {
    scope: 'providers:read',
    capability: STUDIO_CHAT_STORES_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'usageLimitResumes.changed': {
    scope: 'conversation:read',
    capability: STUDIO_CHAT_STORES_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'scheduledMessages.changed': {
    scope: 'conversation:read',
    capability: STUDIO_CHAT_STORES_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
