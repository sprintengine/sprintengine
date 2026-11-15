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
import type { CliPermissionPreset, ExecutionHostId } from './agents.js'
import { isStudioPath } from './key.js'
import { STUDIO_SCHEDULES_CAPABILITY } from './handshake.js'

// A Studio's scheduled agents: a prompt and a schedule, and each time the
// schedule comes round the Studio starts a chat with that prompt, on its own
// machine, whether or not any client is connected. Every server runs the
// schedules in its own store (`server/core/studio-scheduled-agents.ts`), so a
// client asks the Studio the schedule lives on.
//
// The phone and a paired desktop list them on `workspaces:read` and make,
// change, run, pause, resume and close them on `workspaces:operate` (a paired
// device's `workspace:operate`). Each answers what the Studio's gateway tools
// of the same purpose (`schedule.*`) answer, from the same service, so a client
// on the protocol and an agent on MCP read and change one thing.
//
// The record is defined here once; `src/shared/scheduled-agents.ts` re-exports
// each type under the name the app has always used, and the phone imports it
// from here.

export type ScheduledAgentSchedule = {
  /** Five-field cron; several expressions separated by `;`. */
  cron: string
  /** The IANA zone the cron's wall-clock is read in: the machine it runs on. */
  timezone: string
  /**
   * One run, at this instant (epoch ms), instead of the cron's repeats: a
   * message to start a chat with later, once. The cron then names the same
   * minute (`cronForInstant`), so whatever reads the cron alone still reads
   * a true schedule. A one-time schedule that has run is done: the scheduler
   * closes it once its chat has started, and keeps one whose run failed, with
   * no next run, so the failure is seen.
   */
  once?: number
}

/** A skill or an installed MCP server, by id, with the name its chip shows. */
export type ScheduledAgentAttachment = { id: string; name: string }

/**
 * Whether the last run started its chat, and where. `agentId` is the run's
 * chat agent in `workspaceId`; absent on a run recorded before it was kept.
 */
export type ScheduledAgentLastRun =
  { at: number; ok: true; workspaceId: string; agentId?: string } | { at: number; ok: false; message: string }

export type ScheduledAgent = {
  id: string
  /** The scheduled agent's title in the sidebar and its editor. Absent, the prompt's first line is. */
  name?: string
  /**
   * The creator's own label for it, carried onto each run's chat (the agent
   * record's `scheduledAgentTag`) so whoever made it can tell which of its
   * schedules a chat came from. Never shown to the person.
   */
  tag?: string
  /** The first message each run's chat is sent. Its first line is the scheduled agent's title. */
  prompt: string
  schedule: ScheduledAgentSchedule
  /** The project each run starts in. */
  folderPath: string
  /**
   * The machine on this computer each run starts on. Null is this machine,
   * or the distribution a folder inside one lives in; `local` is this machine
   * for such a folder.
   */
  hostId: ExecutionHostId | null
  cli: string
  cliModel: string | null
  /** Absent, the preset chosen for that CLI at run time. */
  permissionPreset: CliPermissionPreset | null
  skills: ScheduledAgentAttachment[]
  mcpServers: ScheduledAgentAttachment[]
  /** A fresh worktree per run, named from this; null runs in the project's checkout. */
  worktree: { name: string } | null
  /** The extension that created it, when one did. */
  ownerModuleId: string | null
  createdAt: number
  updatedAt: number
  lastRun: ScheduledAgentLastRun | null
  /** When a failed last run was last looked at; the card says "Failed" until then. */
  lastFailureSeenAt: number | null
  /**
   * When the person paused it; absent while it runs on its schedule. A paused
   * schedule starts nothing at its times, and the times that pass while it is
   * paused are not made up when it resumes: it runs next at the first time
   * after that. Run now still runs it, and pausing leaves a run already going
   * alone.
   */
  pausedAt?: number
}

/**
 * Every scheduled agent paused at once, apart from each one's own pause:
 * since when, and until when (null until the person resumes them). Resuming
 * them all leaves a schedule paused on its own still paused.
 */
export type ScheduledAgentsPause = { since: number; until: number | null }

/** A scheduled agent as a client lists it: the record plus when it runs next. */
export type ScheduledAgentView = ScheduledAgent & {
  nextRunAt: number | null
  /**
   * Why the machine it lives on cannot run it now, in words ("Codex is not
   * signed in on build-box"): its times pass without a run, which is not a
   * failure, until the machine has what it lacks. Absent when it can run.
   */
  waiting?: string
}

/** One schedule as the protocol answers it: the view, and its schedule in the Studio's words. */
export type StudioSchedule = ScheduledAgentView & {
  /** "Every weekday at 9:00 AM"; null when the cron does not read. */
  scheduleWords: string | null
}

/** Every schedule a Studio holds, and whether they are all paused. */
export type StudioSchedules = {
  schedules: StudioSchedule[]
  pausedAll: ScheduledAgentsPause | null
  /**
   * Why none of them runs now though none is paused, in words: what this
   * Studio hands to another machine could not be read, so nothing it may
   * hand over runs here until it can. Absent while they run.
   */
  held?: string
}

/** A skill or MCP server a schedule attaches: by id, or by id with the name its chip shows. */
export type StudioScheduleAttachment = string | ScheduledAgentAttachment

/**
 * Where each run starts: a workspace's project and machine (`workspaces.list`),
 * or, for an owner, a project by its folder (`workspaceRoot`) and the machine
 * on this computer it is on (`hostId`: `local` or `wsl:<distro>`; absent, the
 * one the folder says). The desktop's own New chat schedules by folder.
 */
export type StudioSchedulePlace = { workspaceId?: string; workspaceRoot?: string; hostId?: ExecutionHostId }

/**
 * What making a schedule takes: its place (a workspace, or an owner's folder;
 * exactly one) and its members. A CLI, a model and the rest are each only
 * where one was picked.
 */
export type StudioScheduleDraft = StudioSchedulePlace & StudioScheduleDraftMembers

/** A draft's members beside its place. */
export type StudioScheduleDraftMembers = {
  /** The first message each run is sent. */
  prompt: string
  /** Five-field cron; for a one-time schedule, the cron naming the same minute. */
  cron: string
  /** The IANA zone the cron is read in; the Studio's own when absent. */
  timezone?: string
  /** Run once, at this instant (epoch ms), rather than repeating. */
  once?: number
  /** The agent CLI; the one last picked on that Studio when absent. */
  cli?: string
  model?: string
  permissionPreset?: CliPermissionPreset
  /** Each run in a fresh worktree of its own. */
  worktree?: boolean
  /** What each run's worktree and its branch are named from; implies `worktree`. */
  worktreeName?: string
  name?: string
  /** The skills and installed MCP servers attached to each run, by id (a name beside it is kept for its chip). */
  skills?: StudioScheduleAttachment[]
  mcpServers?: StudioScheduleAttachment[]
}

/**
 * What changing a schedule takes: its id and what changes. Anything left out
 * stays as it was; `model` and `name` empty clear them, `worktree` false runs
 * in the project's checkout, and a `cron` without `once` makes a one-time
 * schedule repeat. A place, when given, moves it.
 */
export type StudioScheduleChange = { id: string } & Partial<StudioScheduleDraftMembers> & StudioSchedulePlace

type Commanded<T> = T & { commandId: string }

/** The refusals a schedule's change may answer with beyond every method's. */
export type StudioScheduleRefusalCode =
  'not_found' | 'unknown_workspace' | 'workspace_folder_missing' | 'no_cli_selected'

export type StudioSchedulesMethodMap = {
  /** Every schedule, with when each runs next; `schedules.changed` tells every change after. */
  'schedules.list': { params: Record<string, never>; result: StudioSchedules }
  'schedules.create': {
    params: Commanded<StudioScheduleDraft>
    result: { schedule: StudioSchedule }
    errors: StudioScheduleRefusalCode
  }
  'schedules.update': {
    params: Commanded<StudioScheduleChange>
    result: { schedule: StudioSchedule }
    errors: StudioScheduleRefusalCode
  }
  /** Start no run at its times until resumed. A run already going is left to finish. */
  'schedules.pause': { params: Commanded<{ id: string }>; result: { schedule: StudioSchedule }; errors: 'not_found' }
  /** Run on its schedule again, from its first time after now. */
  'schedules.resume': { params: Commanded<{ id: string }>; result: { schedule: StudioSchedule }; errors: 'not_found' }
  /**
   * Start a run now, without waiting for its time: a new chat with its prompt,
   * answered once the chat has started. Refused `conversation_start_failed`
   * when it could not start one (its last run still working, a CLI missing).
   */
  'schedules.runNow': {
    params: Commanded<{ id: string }>
    result: { workspaceId: string }
    errors: 'not_found' | 'conversation_start_failed'
  }
  /** Stop and remove it. The chats its past runs started are left as they are. */
  'schedules.delete': { params: Commanded<{ id: string }>; result: { removed: string }; errors: 'not_found' }
  /** Its failed last run has been looked at: it no longer says "Failed". */
  'schedules.markSeen': { params: Commanded<{ id: string }>; result: { schedule: StudioSchedule }; errors: 'not_found' }
  /**
   * Start no run of any of them until `until` (epoch ms), or until resumed
   * (null). A run already going is left to finish, and each one's own pause
   * stays as it is.
   */
  'schedules.pauseAll': {
    params: Commanded<{ until: number | null }>
    result: { pausedAll: ScheduledAgentsPause }
  }
  /** End the pause of them all. One paused on its own stays paused. */
  'schedules.resumeAll': { params: { commandId: string }; result: { pausedAll: null } }
}

export type StudioSchedulesMethod = keyof StudioSchedulesMethodMap

export type StudioSchedulesTopicMap = {
  /** Every schedule, whole, each time one moves. Nothing is replayed: ask `schedules.list`. */
  'schedules.changed': { params: Record<string, never>; payload: StudioSchedules; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const refuse = (message: string): StudioParamsRefusal => studioParamsRefused(message)

/** The longest prompt a schedule carries, as a message a person typed. */
export const STUDIO_SCHEDULE_MAX_PROMPT = 100_000
/** The most skills or MCP servers one schedule attaches. */
export const STUDIO_SCHEDULE_MAX_ATTACHMENTS = 100

const PRESETS: readonly CliPermissionPreset[] = ['none', 'manual', 'auto', 'bypass']

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function short(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length <= max
}
function attachments(value: unknown): StudioScheduleAttachment[] | null {
  if (!Array.isArray(value) || value.length > STUDIO_SCHEDULE_MAX_ATTACHMENTS) return null
  const read: StudioScheduleAttachment[] = []
  for (const entry of value) {
    if (id(entry)) read.push(entry)
    else if (
      typeof entry === 'object' &&
      entry !== null &&
      id((entry as Record<string, unknown>).id) &&
      short((entry as Record<string, unknown>).name, 500)
    )
      read.push({ id: (entry as { id: string }).id, name: (entry as { name: string }).name })
    else return null
  }
  return read
}

const HOST = /^(local|wsl:[^\s\\/:]{1,100})$/u

type ReadPlace = StudioSchedulePlace

/** Where it runs, when the request says: a workspace, or a folder with its machine; not both. */
function placeMembers(value: Record<string, unknown>): StudioParsed<ReadPlace> {
  const place: ReadPlace = {}
  if (value.workspaceId !== undefined && value.workspaceRoot !== undefined)
    return refuse('Name the project by "workspaceId" or by "workspaceRoot", not both.')
  if (value.workspaceId !== undefined) {
    if (!id(value.workspaceId)) return refuse('"workspaceId" names a workspace, from workspaces.list.')
    place.workspaceId = value.workspaceId
  }
  if (value.workspaceRoot !== undefined) {
    if (!isStudioPath(value.workspaceRoot)) return refuse('"workspaceRoot" is the project\'s folder.')
    place.workspaceRoot = value.workspaceRoot
  }
  if (value.hostId !== undefined) {
    if (place.workspaceRoot === undefined) return refuse('"hostId" goes with "workspaceRoot".')
    if (typeof value.hostId !== 'string' || !HOST.test(value.hostId))
      return refuse('"hostId" is local or wsl:<distribution>.')
    place.hostId = value.hostId as ExecutionHostId
  }
  return studioParams(place)
}

/** The members a draft and a change share, each read where it was sent. */
function draftMembers(value: Record<string, unknown>): StudioParsed<Partial<StudioScheduleDraftMembers>> {
  const draft: Partial<StudioScheduleDraftMembers> = {}
  if (value.prompt !== undefined) {
    if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > STUDIO_SCHEDULE_MAX_PROMPT)
      return refuse(`"prompt" is the first message, 1 to ${STUDIO_SCHEDULE_MAX_PROMPT} characters.`)
    draft.prompt = value.prompt
  }
  if (value.cron !== undefined) {
    if (typeof value.cron !== 'string' || !value.cron.trim() || value.cron.length > 1000)
      return refuse('"cron" is five-field cron, several separated by ";".')
    draft.cron = value.cron
  }
  if (value.timezone !== undefined) {
    if (!id(value.timezone)) return refuse('"timezone" is an IANA zone.')
    draft.timezone = value.timezone
  }
  if (value.once !== undefined) {
    if (typeof value.once !== 'number' || !Number.isSafeInteger(value.once) || value.once < 0)
      return refuse('"once" is an instant, epoch ms.')
    draft.once = value.once
  }
  if (value.cli !== undefined) {
    if (!id(value.cli)) return refuse('"cli" names an agent CLI, from cliRuntimes.list.')
    draft.cli = value.cli
  }
  if (value.model !== undefined) {
    if (!short(value.model)) return refuse('"model" is the CLI\'s model id, or empty for its default.')
    draft.model = value.model
  }
  if (value.permissionPreset !== undefined) {
    const preset = PRESETS.find((known) => known === value.permissionPreset)
    if (!preset) return refuse('"permissionPreset" is none, manual, auto or bypass.')
    draft.permissionPreset = preset
  }
  if (value.worktree !== undefined) {
    if (typeof value.worktree !== 'boolean') return refuse('"worktree" is true or false.')
    draft.worktree = value.worktree
  }
  if (value.worktreeName !== undefined) {
    if (!short(value.worktreeName)) return refuse('"worktreeName" is a name of at most 200 characters.')
    draft.worktreeName = value.worktreeName
  }
  if (value.name !== undefined) {
    if (!short(value.name)) return refuse('"name" is a title of at most 200 characters, or empty.')
    draft.name = value.name
  }
  if (value.skills !== undefined) {
    const read = attachments(value.skills)
    if (!read) return refuse('"skills" is a list of skill ids, each alone or as { id, name }.')
    draft.skills = read
  }
  if (value.mcpServers !== undefined) {
    const read = attachments(value.mcpServers)
    if (!read) return refuse('"mcpServers" is a list of MCP server ids, each alone or as { id, name }.')
    draft.mcpServers = read
  }
  return studioParams(draft)
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse('"commandId" names this command: a string of 1 to 200 characters.')
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

/** A draft for `schedules.create`, or why not. */
export function parseStudioScheduleDraft(value: Record<string, unknown>): StudioParsed<StudioScheduleDraft> {
  const place = placeMembers(value)
  if (!place.ok) return place
  const read = draftMembers(value)
  if (!read.ok) return read
  const { prompt, cron } = read.params
  const { workspaceId, workspaceRoot, hostId } = place.params
  if ((workspaceId === undefined && workspaceRoot === undefined) || prompt === undefined || cron === undefined)
    return refuse('A schedule needs "workspaceId" (or an owner\'s "workspaceRoot"), "prompt" and "cron".')
  const at: StudioSchedulePlace =
    workspaceId !== undefined ? { workspaceId } : { workspaceRoot, ...(hostId ? { hostId } : {}) }
  return studioParams({ ...read.params, ...at, prompt, cron })
}

/** A change for `schedules.update`, or why not. */
export function parseStudioScheduleChange(value: Record<string, unknown>): StudioParsed<StudioScheduleChange> {
  if (!id(value.id)) return refuse('"id" names the schedule, from schedules.list.')
  const place = placeMembers(value)
  if (!place.ok) return place
  const read = draftMembers(value)
  if (!read.ok) return read
  const { workspaceId, workspaceRoot, hostId } = place.params
  const at =
    workspaceId !== undefined
      ? { workspaceId }
      : workspaceRoot !== undefined
        ? { workspaceRoot, ...(hostId ? { hostId } : {}) }
        : {}
  return studioParams({ ...read.params, ...at, id: value.id })
}

const read = { scope: 'workspaces:read', mutation: false, capability: STUDIO_SCHEDULES_CAPABILITY } as const
const operate = { scope: 'workspaces:operate', mutation: true, capability: STUDIO_SCHEDULES_CAPABILITY } as const

type OneSchedule = StudioSchedulesMethodMap[
  'schedules.pause' | 'schedules.resume' | 'schedules.runNow' | 'schedules.delete' | 'schedules.markSeen']

const oneSchedule: StudioMethodDefinition<OneSchedule> = {
  ...operate,
  params: commanded((value) =>
    id(value.id) ? studioParams({ id: value.id }) : refuse('"id" names the schedule, from schedules.list.'),
  ),
}

export const STUDIO_SCHEDULES_METHODS: StudioMethodTable<StudioSchedulesMethodMap> = {
  'schedules.list': { ...read, params: studioNoParams },
  'schedules.create': { ...operate, params: commanded(parseStudioScheduleDraft) },
  'schedules.update': { ...operate, params: commanded(parseStudioScheduleChange) },
  'schedules.pause': oneSchedule,
  'schedules.resume': oneSchedule,
  'schedules.runNow': oneSchedule,
  'schedules.delete': oneSchedule,
  'schedules.markSeen': oneSchedule,
  'schedules.pauseAll': {
    ...operate,
    params: commanded((value) =>
      value.until === null || (typeof value.until === 'number' && Number.isSafeInteger(value.until) && value.until > 0)
        ? studioParams({ until: value.until as number | null })
        : refuse('"until" is an instant (epoch ms), or null for until they are resumed.'),
    ),
  },
  'schedules.resumeAll': { ...operate, params: commanded(() => studioParams({})) },
}

export const STUDIO_SCHEDULES_TOPICS: StudioTopicTable<StudioSchedulesTopicMap> = {
  'schedules.changed': {
    scope: 'workspaces:read',
    capability: STUDIO_SCHEDULES_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
