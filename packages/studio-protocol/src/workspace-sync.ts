import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_WORKSPACE_SYNC_CAPABILITY } from './handshake.js'

// The desktop's own windows' workspace registry: the workspaces and windows
// main records, which every window of the desktop mirrors. A window seeds its
// mirror from `workspaceSync.snapshot`, hears each change on the
// `workspaceSync.events` stream (sequenced; a gap is bridged with
// `workspaceSync.eventsAfter`, else a new snapshot), and makes its own changes
// with `workspaceSync.dispatch`, which answers the event main recorded, or the
// snapshot to reconcile with when it refused. Settle, Un-settle, Snooze and
// Wake from a window are decided on the reading of the chat the window made
// them on (`workspaceSync.lifecycle`). The window also says what only it
// knows and main's rest sweep reads: its Settled chats settings and each
// module chat's run state.
//
// Beside the registry: the one-time hydration from a window's own stored copy
// (`workspaceRegistry.*`), the window's backup of that copy
// (`workspaceBackup.*`), and the folders a chat started without a project runs
// in (`projectlessChats.*`).
//
// Each is an owner's (`STUDIO_WORKSPACE_SYNC_OWNER`). Another client reads
// the workspaces with `workspaces.list` and changes a chat's record with the
// `conversation.*` lifecycle methods.
//
// The registry's own shapes (a workspace, a window, each command and event)
// are the desktop's, defined in `src/shared/workspace-sync.ts` and checked
// there by main's registry when a command arrives; they cross here as records.

/** Why only an owner reaches the workspace registry. */
export const STUDIO_WORKSPACE_SYNC_OWNER =
  "It is the desktop's own windows' registry of workspaces and windows, with their layout and placement, which only those windows mirror and change; another device reads the workspaces with workspaces.list and changes a chat's record with the conversation lifecycle methods."

type Fields = Record<string, unknown>
type Commanded<T> = T & { commandId: string }

/** One recorded change to the registry, as `src/shared/workspace-sync.ts` defines it. */
export type StudioWorkspaceSyncEvent = {
  id: string
  type: string
  sourceWindowId: string
  sequence: number
  createdAt: number
  payload: unknown
  [member: string]: unknown
}

/** The registry whole, at a sequence. */
export type StudioWorkspaceSyncSnapshot = { sequence: number; state: Fields }

/** What a dispatch answers: the event main recorded, or why not with the snapshot to reconcile with. */
export type StudioWorkspaceSyncCommandResult =
  | { ok: true; event: StudioWorkspaceSyncEvent; snapshot?: StudioWorkspaceSyncSnapshot }
  | { ok: false; reason: string; message: string; snapshot?: StudioWorkspaceSyncSnapshot }

/** A rest gesture's answer: the reading main committed, or why not with the chat as it stands. */
export type StudioWorkspaceLifecycleResult =
  | { ok: true; workspaceId: string; committed: unknown }
  | { ok: false; code: string; message: string; current?: unknown }

/** Main's answer to a window's one-time hydration offer. */
export type StudioWorkspaceRegistryHydrateResult = {
  changed: boolean
  reason: 'seeded' | 'already_present' | 'refused_dangerous_empty' | 'seeded_empty_intent'
  classification?: string
  seededWorkspaceCount?: number
  droppedRecordIds?: string[]
}

/** The window's backup of its stored copy. */
export type StudioWorkspaceBackupPayload = { version: number; writtenAt: string; data: unknown }
export type StudioWorkspaceBackupReadResult =
  | { ok: true; payload: StudioWorkspaceBackupPayload }
  | { ok: false; reason: 'missing' | 'unreadable' | 'parse_error'; message?: string }
export type StudioWorkspaceBackupWriteResult = { ok: boolean; message?: string }

export type StudioWorkspaceSyncMethodMap = {
  'workspaceSync.snapshot': { params: Record<string, never>; result: StudioWorkspaceSyncSnapshot }
  /** The recorded events after `sequence`, in order, as far back as main keeps them. */
  'workspaceSync.eventsAfter': { params: { sequence: number }; result: { events: StudioWorkspaceSyncEvent[] } }
  /** One change from the window `windowId` names, as its `command` says it. */
  'workspaceSync.dispatch': {
    params: Commanded<{ windowId: string; command: Fields }>
    result: StudioWorkspaceSyncCommandResult
  }
  /** A window's Settle, Un-settle, Snooze or Wake now, on the reading of the chat it made it on. */
  'workspaceSync.lifecycle': { params: Commanded<{ request: Fields }>; result: StudioWorkspaceLifecycleResult }
  /** The window's Settled chats settings, which main's rest sweep reads. */
  'workspaceSync.setSettledChatsSettings': {
    params: Commanded<{ settings: Fields }>
    result: Record<string, never>
  }
  /** Each module chat's run state as its provider in the window reports it (null for none). */
  'workspaceSync.setModuleRunStates': {
    params: Commanded<{ states: Record<string, unknown> }>
    result: Record<string, never>
  }
  /** Whether main has never written a registry, so a window's stored copy may seed it. */
  'workspaceRegistry.needsHydration': { params: Record<string, never>; result: { needsHydration: boolean } }
  /** Seed main's registry from a window's stored copy, once; a no-op once main has one. */
  'workspaceRegistry.hydrate': {
    params: Commanded<{ payload: Fields }>
    result: StudioWorkspaceRegistryHydrateResult
  }
  'workspaceBackup.read': { params: Record<string, never>; result: StudioWorkspaceBackupReadResult }
  'workspaceBackup.write': {
    params: Commanded<{ payload: StudioWorkspaceBackupPayload }>
    result: StudioWorkspaceBackupWriteResult
  }
  /** The folder New chat's "No project" is scoped to while it is open. */
  'projectlessChats.root': { params: Record<string, never>; result: { path: string } }
  /** A folder of its own for one chat started without a project, named after its first words. */
  'projectlessChats.createFolder': { params: Commanded<{ prompt?: string }>; result: { path: string } }
}

export type StudioWorkspaceSyncMethod = keyof StudioWorkspaceSyncMethodMap

export type StudioWorkspaceSyncTopicMap = {
  /** Each change main records, whoever made it, in sequence. Nothing is replayed: ask `workspaceSync.eventsAfter`. */
  'workspaceSync.events': { params: Record<string, never>; payload: StudioWorkspaceSyncEvent; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
const COMMAND_WORDS = '"commandId" names this command: a string of 1 to 200 characters.'

function commanded<P>(read: (value: Fields) => StudioParsed<P>): (value: Fields) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_WORDS)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

function record<K extends string>(name: K, words: string) {
  return (value: Fields): StudioParsed<{ [P in K]: Fields }> =>
    isRecord(value[name]) ? studioParams({ [name]: value[name] } as { [P in K]: Fields }) : refuse(words)
}

const owned = { owner: STUDIO_WORKSPACE_SYNC_OWNER, capability: STUDIO_WORKSPACE_SYNC_CAPABILITY } as const
const reading = { ...owned, scope: 'workspaces:read', mutation: false } as const
const writing = { ...owned, scope: 'workspaces:operate', mutation: true } as const

export const STUDIO_WORKSPACE_SYNC_METHODS: StudioMethodTable<StudioWorkspaceSyncMethodMap> = {
  'workspaceSync.snapshot': { ...reading, params: studioNoParams },
  'workspaceSync.eventsAfter': {
    ...reading,
    params: (value) =>
      typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence >= 0
        ? studioParams({ sequence: value.sequence })
        : refuse('"sequence" is the last sequence the window applied.'),
  },
  'workspaceSync.dispatch': {
    ...writing,
    params: commanded((value) => {
      if (!id(value.windowId)) return refuse('"windowId" names the window the change is made in.')
      if (!isRecord(value.command) || typeof value.command.type !== 'string')
        return refuse('"command" is one registry change, with its "type".')
      return studioParams({ windowId: value.windowId, command: value.command })
    }),
  },
  'workspaceSync.lifecycle': {
    ...writing,
    params: commanded(record('request', '"request" is the chat, its gesture and the reading it was made on.')),
  },
  'workspaceSync.setSettledChatsSettings': {
    ...writing,
    params: commanded(record('settings', '"settings" is the Settled chats settings.')),
  },
  'workspaceSync.setModuleRunStates': {
    ...writing,
    params: commanded(record('states', '"states" maps each module chat to its run state, or null.')),
  },
  'workspaceRegistry.needsHydration': { ...reading, params: studioNoParams },
  'workspaceRegistry.hydrate': {
    ...writing,
    params: commanded(record('payload', '"payload" is the window\'s stored copy.')),
  },
  'workspaceBackup.read': { ...reading, params: studioNoParams },
  'workspaceBackup.write': {
    ...writing,
    params: commanded((value) => {
      const payload = value.payload
      if (
        !isRecord(payload) ||
        typeof payload.version !== 'number' ||
        typeof payload.writtenAt !== 'string' ||
        !('data' in payload)
      )
        return refuse('"payload" is the backup: its "version", "writtenAt" and "data".')
      return studioParams({ payload: { version: payload.version, writtenAt: payload.writtenAt, data: payload.data } })
    }),
  },
  'projectlessChats.root': { ...reading, params: studioNoParams },
  'projectlessChats.createFolder': {
    ...writing,
    params: commanded((value) => {
      if (value.prompt === undefined) return studioParams({})
      return typeof value.prompt === 'string' && value.prompt.length <= 100_000
        ? studioParams({ prompt: value.prompt })
        : refuse('"prompt" is the chat\'s first words, which name its folder.')
    }),
  },
}

export const STUDIO_WORKSPACE_SYNC_TOPICS: StudioTopicTable<StudioWorkspaceSyncTopicMap> = {
  'workspaceSync.events': {
    scope: 'workspaces:read',
    owner: STUDIO_WORKSPACE_SYNC_OWNER,
    capability: STUDIO_WORKSPACE_SYNC_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
