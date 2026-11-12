import {
  studioParams,
  studioParamsRefused,
  studioNoParams,
  type StudioMethodTable,
  type StudioTopicTable,
} from './contract.js'
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
// - `module.read` and `module.operate`: a method a module declared
//   (`MainHost.registerMethods`), by the module's id and the method's name.
//   A method is declared `read` or `operate`; each is called only through its
//   own entry, so a client granted `modules:read` reaches a module's reads and
//   never its writes. An operate carries the client's `commandId`, is audited,
//   and a retry under the same id is answered with the first answer. The
//   module's own params validator reads `params`; what it refuses is
//   `invalid_params` in the module's words. What the module's handler answers
//   comes back as the result, its own refusals (`{ ok: false, code }`)
//   included; the protocol's refusals are a module that does not run here
//   (`module_unavailable`) and a name it does not declare under that entry
//   (`module_method_unknown`).
//
// All of them need `modules:read` (`module.operate`, `modules:operate`, which
// carries it); neither is held to an owner's connection, and the family is
// offered under the `modules` capability only where a module kernel runs.

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

/** A module method's name: a lower-case letter, then letters, digits, dots and dashes. The module id is its namespace. */
export const STUDIO_MODULE_METHOD_PATTERN = /^[a-z][a-zA-Z0-9.-]*$/u
/** The longest name a module method may have. */
export const STUDIO_MODULE_METHOD_MAX_CHARS = 100

/** Whether a value is a name a module may declare a method under. */
export function isStudioModuleMethodName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= STUDIO_MODULE_METHOD_MAX_CHARS &&
    STUDIO_MODULE_METHOD_PATTERN.test(value)
  )
}

/** One call of a module's method: the module, the method, and its params as the module defines them. */
export type StudioModuleCall = {
  moduleId: string
  method: string
  /** Read by the module's own validator; absent when the method takes none. */
  params?: unknown
}

/**
 * What a module's method answered: its result, or its own refusal, in its own
 * code and words. The protocol's refusals (the module or the method is not
 * there, the params are not the method's) are the request's errors instead.
 */
export type StudioModuleAnswer = { ok: true; result: unknown } | { ok: false; code: string; message: string }

export type StudioModulesMethodMap = {
  /** Call a method the module declared `read`. */
  'module.read': {
    params: StudioModuleCall
    result: StudioModuleAnswer
    errors: 'module_unavailable' | 'module_method_unknown'
  }
  /** Call a method the module declared `operate`, once per `commandId`. */
  'module.operate': {
    params: StudioModuleCall & { commandId: string }
    result: StudioModuleAnswer
    errors: 'module_unavailable' | 'module_method_unknown'
  }
}

/** `module.events` params: every module's events, or one module's. */
export type StudioModuleEventsParams = { moduleId?: string }

export type StudioModulesTopicMap = {
  'module.events': { params: StudioModuleEventsParams; payload: StudioModuleEvent; stream: 'push' }
  'module.notifications': { params: Record<string, never>; payload: StudioModuleNotification; stream: 'push' }
}

/** A manifest id, as the module kernel accepts one. */
const MAX_MODULE_ID_CHARS = 200

function moduleId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MODULE_ID_CHARS
}

function parseCall(value: Record<string, unknown>) {
  if (!moduleId(value.moduleId)) return studioParamsRefused('"moduleId" is the module\'s manifest id.')
  if (!isStudioModuleMethodName(value.method))
    return studioParamsRefused(
      `"method" is a name the module declared: a lower-case letter, then letters, digits, dots and dashes, at most ${STUDIO_MODULE_METHOD_MAX_CHARS}.`,
    )
  const call: StudioModuleCall = { moduleId: value.moduleId, method: value.method }
  if (value.params !== undefined) call.params = value.params
  return studioParams(call)
}

const MAX_COMMAND_ID_CHARS = 200

export const STUDIO_MODULES_METHODS: StudioMethodTable<StudioModulesMethodMap> = {
  'module.read': {
    scope: 'modules:read',
    mutation: false,
    capability: STUDIO_MODULES_CAPABILITY,
    params: parseCall,
  },
  'module.operate': {
    scope: 'modules:operate',
    mutation: true,
    capability: STUDIO_MODULES_CAPABILITY,
    params: (value) => {
      const call = parseCall(value)
      if (!call.ok) return call
      if (
        typeof value.commandId !== 'string' ||
        value.commandId.length === 0 ||
        value.commandId.length > MAX_COMMAND_ID_CHARS
      )
        return studioParamsRefused('"commandId" is the client\'s id for this command.')
      return studioParams({ ...call.params, commandId: value.commandId })
    },
  },
}

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
