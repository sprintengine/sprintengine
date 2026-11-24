// Studio's events: what an extension hears happen in Studio, without asking.
//
// A worker hears the events its extension.json lists (`contributes.events`,
// worker tier, at most `EXTENSION_EVENTS_MAX`) through
// `studio.events.on(event, handler)`, which answers `{ dispose() }`. A worker
// that is not running is started to hear one. Its handler runs as the
// extension's own work: as the person who approved it, and what it asks of
// Studio is held to whoever else the worker serves at that moment.
//
// A surface's frame (a panel, a custom editor, any surface) hears one with
// `studio.on(event, listener)`: no listing needed, since a surface is drawn
// only while someone looks at it, but the same read check, held to the
// extension's approval and to whoever opened the surface (a paired desktop
// window or a browser by what its connection was granted).
//
// Each event needs the permission of what it tells: a workspace's events need
// `workspace:read`, as reading the workspaces does; an agent's status needs
// `conversation:read`, as a chat's status is part of reading the chat, which
// is how Studio's own clients hear it. An extension switched off, stopped,
// killed or not approved as it is hears nothing, nor does one whose approval
// does not hold the event's permission.
//
// The editor's typography is the window's own (each window, paired or in a
// browser, keeps its own appearance), so only a surface hears it, from the
// window that drew it, and it needs no permission.
//
// This table is the one description: the manifest's enum, its permission
// check, the gate at delivery and the guide's reference read it. Pure (no
// Node or DOM APIs).

import type { ExtensionPermission } from './permissions.js'

/** The events a worker may list in `contributes.events`. */
export const EXTENSION_EVENTS = [
  'workspace.created',
  'workspace.removed',
  'agent.status.changed',
  'workspace.changed',
] as const
export type ExtensionEventName = (typeof EXTENSION_EVENTS)[number]

/** Every event a surface's frame may hear with `studio.on`: the worker's, and the window's own typography. */
export const EXTENSION_FRAME_EVENTS = [...EXTENSION_EVENTS, 'editor.typography.changed'] as const
export type ExtensionFrameEventName = (typeof EXTENSION_FRAME_EVENTS)[number]

/** The most events one extension.json may list. */
export const EXTENSION_EVENTS_MAX = 5

/** The most terminals a workspace's event lists. */
export const EXTENSION_EVENT_TERMINALS_MAX = 50

export function isExtensionEventName(value: unknown): value is ExtensionEventName {
  return typeof value === 'string' && (EXTENSION_EVENTS as readonly string[]).includes(value)
}

export function isExtensionFrameEventName(value: unknown): value is ExtensionFrameEventName {
  return typeof value === 'string' && (EXTENSION_FRAME_EVENTS as readonly string[]).includes(value)
}

/** A workspace, as its events carry it. */
export type ExtensionEventWorkspace = {
  workspaceId: string
  name: string
  /** `worktree`: a git worktree of its own; `folder`: a folder opened as it is (or none). */
  kind: 'worktree' | 'folder'
  /** Its folder on the machine that holds it; null for one with no folder. */
  folderPath: string | null
  /** A worktree's branch; null otherwise. */
  branch: string | null
}

/** An agent's status, as `agent.status.changed` says it. */
export type ExtensionAgentState =
  /** It is working: starting, thinking or running a tool. */
  | 'working'
  /** It waits on the person: an approval, or a question in its terminal. */
  | 'blocked'
  /**
   * Its turn ended, its chat was closed, or its process exited (`failed`
   * says whether the turn failed; one the person stopped did not). Said once:
   * a finished agent's close says nothing more.
   */
  | 'done'

export type ExtensionEventPayloads = {
  'workspace.created': ExtensionEventWorkspace
  'workspace.removed': ExtensionEventWorkspace
  'agent.status.changed': {
    workspaceId: string | null
    /** The chat's or the terminal agent's id. */
    agentId: string
    /** A chat, or an agent CLI in a terminal. */
    where: 'chat' | 'terminal'
    /** Its terminal, for an agent in one: the id the terminal service takes. */
    terminalId: string | null
    /** The agent's name, as the sidebar shows it. */
    title: string | null
    state: ExtensionAgentState
    /** Whether its turn or its process failed; a turn the person stopped did not. */
    failed: boolean
    /** When Studio heard it (epoch ms). */
    receivedAt: number
  }
  'workspace.changed': {
    workspace: ExtensionEventWorkspace & {
      /** Its live terminals (at most 50): ids the terminal service takes, and an agent's name where one runs. */
      terminals: Array<{ id: string; title: string | null }>
    }
  }
  'editor.typography.changed': {
    /** The code font's family as the person named it, or null for Studio's default. */
    fontFamily: string | null
    /** The CSS `font-family` the editor draws with. */
    cssFontFamily: string
    fontSize: number
    fontWeight: string
    lineHeight: number
    fontLigatures: boolean
    wordWrap: 'on' | 'off'
    minimap: boolean
  }
}

export type ExtensionEventSpec = {
  /** What the extension's approval must hold; null for none. */
  permission: ExtensionPermission | null
  /** What whoever opened a surface must hold for it to hear the event there; null for none. */
  invoker: 'workspace:read' | 'conversation:read' | null
  /** Who hears it: a worker and a surface, or a surface alone (the window's own). */
  heard: 'worker' | 'frame'
  /** For the guide: when it is delivered. */
  summary: string
  /** For the guide: the payload, as a type. */
  payload: string
}

const WORKSPACE =
  "{ workspaceId: string; name: string; kind: 'worktree' | 'folder'; folderPath: string | null; branch: string | null }"

export const EXTENSION_EVENT_SPECS: Readonly<Record<ExtensionFrameEventName, ExtensionEventSpec>> = {
  'workspace.created': {
    permission: 'workspace:read',
    invoker: 'workspace:read',
    heard: 'worker',
    summary: 'A workspace was made: for a new chat, a worktree, or by an agent or extension.',
    payload: WORKSPACE,
  },
  'workspace.removed': {
    permission: 'workspace:read',
    invoker: 'workspace:read',
    heard: 'worker',
    summary: 'A workspace was removed; the payload is what it was.',
    payload: WORKSPACE,
  },
  'agent.status.changed': {
    permission: 'conversation:read',
    invoker: 'conversation:read',
    heard: 'worker',
    summary:
      'A chat or a terminal agent changed status: `working`, `blocked` (it waits on the person) or `done` (its turn ended, its chat closed or its process exited; `failed` when the turn failed). Said once per change of state, not for every step it takes, and `done` once.',
    payload:
      "{ workspaceId: string | null; agentId: string; where: 'chat' | 'terminal'; terminalId: string | null; title: string | null; state: 'working' | 'blocked' | 'done'; failed: boolean; receivedAt: number }",
  },
  'workspace.changed': {
    permission: 'workspace:read',
    invoker: 'workspace:read',
    heard: 'worker',
    summary:
      'A workspace changed: renamed, its branch or folder changed, or a terminal in it opened or closed. Studio has no one focused workspace (each window has its own), so it says which.',
    payload: `{ workspace: ${WORKSPACE.slice(0, -2)}; terminals: { id: string; title: string | null }[] } }`,
  },
  'editor.typography.changed': {
    permission: null,
    invoker: null,
    heard: 'frame',
    summary:
      'The code font the window’s editor draws with changed. A surface hears it from the window that drew it, the current one first; a worker cannot, since each window has its own.',
    payload:
      "{ fontFamily: string | null; cssFontFamily: string; fontSize: number; fontWeight: string; lineHeight: number; fontLigatures: boolean; wordWrap: 'on' | 'off'; minimap: boolean }",
  },
}

/** A worker's handler for one event. */
export type ExtensionEventHandler<E extends ExtensionEventName> = (
  payload: Readonly<ExtensionEventPayloads[E]>,
) => void | Promise<void>

/** `studio.events`, in a worker. */
export type ExtensionWorkerEvents = {
  /**
   * Hear `event`, which extension.json must list (`contributes.events`); an
   * event it does not list throws. Handlers run one after another, in the
   * order Studio heard the events. What it answers stops hearing.
   */
  on<E extends ExtensionEventName>(event: E, handler: ExtensionEventHandler<E>): { dispose(): void }
}

/** The guide's table of events. */
export function extensionEventReference(): string {
  const escape = (value: string) => value.replaceAll('|', '\\|')
  return [
    '| Event | Needs | Heard by | Payload | When |',
    '|---|---|---|---|---|',
    ...EXTENSION_FRAME_EVENTS.map((event) => {
      const spec = EXTENSION_EVENT_SPECS[event]
      return `| \`${event}\` | ${spec.permission ? `\`${spec.permission}\`` : '—'} | ${spec.heard === 'worker' ? 'a worker, a surface' : 'a surface'} | \`${escape(spec.payload)}\` | ${escape(spec.summary)} |`
    }),
  ].join('\n')
}
