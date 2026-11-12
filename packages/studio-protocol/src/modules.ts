import { studioParams, studioParamsRefused, studioNoParams, type StudioTopicTable } from './contract.js'
import { STUDIO_MODULES_CAPABILITY } from './handshake.js'

// What a Studio's modules say to its clients. A module is a capability its
// server runs (a bundled one, or an extension the person installed and
// trusted); its main half emits events for its own client half and raises bell
// rows, and both reach every client following these streams.
//
// - `module.events`: what the modules emit, every module's or one's
//   (`{ moduleId }`). FIFO per module; nothing is replayed to a client that
//   subscribes later, so a client half reads the durable answer from its
//   module and treats an event as a signal.
// - `module.notifications`: the bell. The rows the server still keeps come
//   first (a module's launch failure is raised before any client listens),
//   then each new one; a row's `id` is unique per server run, so a client
//   that hears the kept rows again after a reconnect files each once.
//
// Both need `modules:read`, which is not held to an owner's connection, and
// are offered under the `modules` capability only where a module kernel runs.

/** One event a module emitted, stamped by the server with the module that sent it. */
export type StudioModuleEvent = {
  /** The emitting module's manifest id, stamped by the server: a module cannot emit as another. */
  sourceModuleId: string
  /** The module's own name for the event; it needs no prefix. */
  topic: string
  /** A JSON value; absent for a bare signal. */
  payload?: unknown
  /** Epoch ms at emission. */
  emittedAt: number
}

export type StudioModuleNotificationSeverity = 'info' | 'warning' | 'error'

/** The module door a bell row opens: one of the module's own surfaces, and a view in it. */
export type StudioModuleNotificationTarget = {
  surfaceId: string
  viewId?: string
}

/** A bell row a module raised. */
export type StudioModuleNotification = {
  /** Unique per server run: what keeps a row heard twice from being filed twice. */
  id: string
  /** The raising module's manifest id, stamped by the server. */
  sourceModuleId: string
  /** The module's display name, or its id when its manifest is not resolvable. */
  sourceModuleName: string
  severity: StudioModuleNotificationSeverity
  title: string
  body?: string
  target?: StudioModuleNotificationTarget
  /** Epoch ms at emission. */
  emittedAt: number
}

/** `module.events` params: every module's events, or one module's. */
export type StudioModuleEventsParams = { moduleId?: string }

export type StudioModulesTopicMap = {
  'module.events': { params: StudioModuleEventsParams; payload: StudioModuleEvent; stream: 'push' }
  'module.notifications': { params: Record<string, never>; payload: StudioModuleNotification; stream: 'push' }
}

/** A manifest id, as the module kernel accepts one. */
const MAX_MODULE_ID_CHARS = 200

export const STUDIO_MODULES_TOPICS: StudioTopicTable<StudioModulesTopicMap> = {
  'module.events': {
    scope: 'modules:read',
    capability: STUDIO_MODULES_CAPABILITY,
    push: true,
    params: (value) => {
      if (value.moduleId === undefined) return studioParams({})
      if (
        typeof value.moduleId !== 'string' ||
        value.moduleId.length === 0 ||
        value.moduleId.length > MAX_MODULE_ID_CHARS
      )
        return studioParamsRefused('"moduleId" is a module id, when given.')
      return studioParams({ moduleId: value.moduleId })
    },
  },
  'module.notifications': {
    scope: 'modules:read',
    capability: STUDIO_MODULES_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
