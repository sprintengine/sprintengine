import {
  studioParams,
  studioParamsRefused,
  studioNoParams,
  type StudioParsed,
  type StudioMethodTable,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_MODULES_CAPABILITY } from './handshake.js'
import type {
  ModuleRegistrySnapshot,
  ModuleRegistrySnapshotWriteResult,
  ThirdPartyModuleListResult,
  ThirdPartyRendererEntriesResult,
} from './extensions-types.js'

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
// - `module.list`: every module this Studio knows, whether it is switched on
//   and running here, and the methods it declares.
// - `module.setEnabled`, `module.install`, `module.setTrust`,
//   `module.uninstall`: what runs here. Each is an owner's
//   (`STUDIO_MODULES_OWNER`), a mutation under the client's `commandId`, and
//   answers the server's own outcome as its result. Installing, trusting and
//   uninstalling change what the server loads at its next start; switching a
//   module on or off applies at once where its main half can load live.
//
// - `module.installed`: every extension installed here, with its trust, where
//   it came from and whether it runs; what Settings and the Extensions door
//   list. `module.rendererEntries`: the trusted extensions' window halves, for
//   a desktop window of this Studio to run. `module.changed`: what is
//   installed or trusted here changed, so a window lists and loads them again.
// - `module.setAppState`: the person's values for the modules' Settings
//   sections, which their main halves read here (`settings:write`).
//   `module.reportRegistry`: the module registry a window resolved, its window
//   halves included, which the Studio's own `module.*` agent tools report. It
//   is the window's own report, so an owner's only
//   (`STUDIO_MODULES_REPORT_OWNER`): a paired app has no window of this
//   Studio's to report.
//
// The streams, the calls and the list need `modules:read` (`module.operate`,
// `modules:operate`, which carries it); none of those is held to an owner's
// connection. The family is offered under the `modules` capability only where
// a module kernel runs.

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

/** Why changing what runs on a Studio is an owner's. */
export const STUDIO_MODULES_OWNER =
  'It changes what runs on this machine: an extension’s code is installed, trusted, started or stopped.'

/** Why `module.reportRegistry` is an owner's only. */
export const STUDIO_MODULES_REPORT_OWNER =
  'It is the report of this Studio’s own window: which modules it resolved, which the agents’ module tools read.'

/** A method a module declares, by name and access. */
export type StudioModuleDeclaredMethod = { name: string; access: 'read' | 'operate' }

/** One module as its Studio holds it. */
export type StudioModuleSummary = {
  id: string
  name: string
  version: number
  /** The app's own module, or an extension the person installed. */
  source: 'bundled' | 'third-party'
  /** Switched on: the person's choice, or its default. */
  enabled: boolean
  /** Running here now: its main half loaded, or (a window-only extension) its manifest. */
  running: boolean
  /** Why a switched-on module does not run: not trusted, a bad signature, another host API, a failed load. */
  blocked?: string
  /** What it declares (`module.read` / `module.operate`), empty while it is not running. */
  methods: StudioModuleDeclaredMethod[]
}

/** A lifecycle change's outcome: done, or the server's refusal in its words. */
export type StudioModuleLifecycleAnswer<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string }

/** A module's trust as its signature and the person's grant classify it. */
export type StudioModuleTrust = 'trusted' | 'signed' | 'unsigned' | 'invalid'

/** Why an uninstall was refused when another owner holds the module: the plugin install that put it there. */
export type StudioModuleUninstallRefusal = {
  ok: false
  message: string
  /** Set when a marketplace or GitHub plugin install owns it: uninstall that plugin instead. */
  pluginId?: string
}

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
  /** Every module this Studio knows. */
  'module.list': { params: Record<string, never>; result: { modules: StudioModuleSummary[] } }
  /**
   * Switch a module on or off here (`null`: back to its default). Kept for the
   * next start, and applied at once where its main half loads live. Answers
   * the module as it now is, or null for one this Studio does not hold.
   */
  'module.setEnabled': {
    params: { moduleId: string; enabled: boolean | null; commandId: string }
    result: StudioModuleLifecycleAnswer<{ module: StudioModuleSummary | null }>
  }
  /** Install the extension in a folder on this machine. It runs once trusted, from the next start. */
  'module.install': {
    params: { path: string; commandId: string }
    result:
      | { ok: true; moduleId: string; trust: StudioModuleTrust }
      | { ok: false; message: string; issues?: Array<{ path: string; message: string }> }
  }
  /** Trust an installed extension's manifest and code as they are now, or withdraw trust. */
  'module.setTrust': {
    params: { moduleId: string; trusted: boolean; commandId: string }
    result: StudioModuleLifecycleAnswer
  }
  /** Remove an extension added from a folder, and what was kept for it. */
  'module.uninstall': {
    params: { moduleId: string; commandId: string }
    result: { ok: true; removedModuleIds: string[] } | StudioModuleUninstallRefusal
  }
  /** Every extension installed here, with its trust, origin and launch state. */
  'module.installed': { params: Record<string, never>; result: ThirdPartyModuleListResult }
  /** The trusted extensions' window halves, read and checked against their verified bytes now. */
  'module.rendererEntries': { params: Record<string, never>; result: ThirdPartyRendererEntriesResult }
  /** The person's values for the modules' Settings sections, by `module:<id>` namespace. */
  'module.setAppState': {
    params: { state: Record<string, Record<string, unknown>>; commandId: string }
    result: Record<string, never>
  }
  /** The module registry a window resolved; refused, with why, when it is not one. */
  'module.reportRegistry': {
    params: { snapshot: ModuleRegistrySnapshot; commandId: string }
    result: ModuleRegistrySnapshotWriteResult
  }
}

/** `module.events` params: every module's events, or one module's. */
export type StudioModuleEventsParams = { moduleId?: string }

export type StudioModulesTopicMap = {
  'module.events': { params: StudioModuleEventsParams; payload: StudioModuleEvent; stream: 'push' }
  'module.notifications': { params: Record<string, never>; payload: StudioModuleNotification; stream: 'push' }
  /** What is installed or trusted here changed: list and load the extensions again. */
  'module.changed': { params: Record<string, never>; payload: Record<string, never>; stream: 'push' }
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
/** The longest folder path an install may name. */
const MAX_PATH_CHARS = 4096

function commandIdOf(value: Record<string, unknown>): StudioParsed<string> {
  return typeof value.commandId === 'string' &&
    value.commandId.length > 0 &&
    value.commandId.length <= MAX_COMMAND_ID_CHARS
    ? studioParams(value.commandId)
    : studioParamsRefused('"commandId" is the client\'s id for this command.')
}

/** Changing what runs here: an owner's, under its command id. */
const lifecycle = {
  scope: null,
  owner: STUDIO_MODULES_OWNER,
  mutation: true,
  capability: STUDIO_MODULES_CAPABILITY,
} as const

function namedModule(value: Record<string, unknown>): StudioParsed<{ moduleId: string; commandId: string }> {
  if (!moduleId(value.moduleId)) return studioParamsRefused('"moduleId" is the module\'s manifest id.')
  const command = commandIdOf(value)
  if (!command.ok) return command
  return studioParams({ moduleId: value.moduleId, commandId: command.params })
}

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
  'module.list': {
    scope: 'modules:read',
    mutation: false,
    capability: STUDIO_MODULES_CAPABILITY,
    params: studioNoParams,
  },
  'module.setEnabled': {
    ...lifecycle,
    params: (value) => {
      const named = namedModule(value)
      if (!named.ok) return named
      if (value.enabled !== null && typeof value.enabled !== 'boolean')
        return studioParamsRefused('"enabled" is true, false, or null for the module\'s default.')
      return studioParams({ ...named.params, enabled: value.enabled })
    },
  },
  'module.install': {
    ...lifecycle,
    params: (value) => {
      if (typeof value.path !== 'string' || value.path.trim().length === 0 || value.path.length > MAX_PATH_CHARS)
        return studioParamsRefused('"path" is the folder on this machine the extension is in.')
      const command = commandIdOf(value)
      if (!command.ok) return command
      return studioParams({ path: value.path, commandId: command.params })
    },
  },
  'module.setTrust': {
    ...lifecycle,
    params: (value) => {
      const named = namedModule(value)
      if (!named.ok) return named
      if (typeof value.trusted !== 'boolean') return studioParamsRefused('"trusted" is true or false.')
      return studioParams({ ...named.params, trusted: value.trusted })
    },
  },
  'module.uninstall': { ...lifecycle, params: namedModule },
  'module.installed': {
    scope: 'modules:read',
    mutation: false,
    capability: STUDIO_MODULES_CAPABILITY,
    params: studioNoParams,
  },
  'module.rendererEntries': {
    scope: 'modules:read',
    mutation: false,
    capability: STUDIO_MODULES_CAPABILITY,
    params: studioNoParams,
  },
  'module.setAppState': {
    scope: 'settings:write',
    mutation: true,
    capability: STUDIO_MODULES_CAPABILITY,
    params: (value) => {
      const command = commandIdOf(value)
      if (!command.ok) return command
      const state = value.state
      if (
        state === null ||
        typeof state !== 'object' ||
        Array.isArray(state) ||
        !Object.values(state).every((bag) => bag !== null && typeof bag === 'object' && !Array.isArray(bag))
      )
        return studioParamsRefused('"state" is each module section\'s values by its namespace.')
      return studioParams({ state: state as Record<string, Record<string, unknown>>, commandId: command.params })
    },
  },
  'module.reportRegistry': {
    scope: null,
    owner: STUDIO_MODULES_REPORT_OWNER,
    mutation: true,
    capability: STUDIO_MODULES_CAPABILITY,
    params: (value) => {
      const command = commandIdOf(value)
      if (!command.ok) return command
      const snapshot = value.snapshot
      // The Studio's own reader holds every member to its shape; here, that there is one.
      if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot))
        return studioParamsRefused('"snapshot" is the module registry the window resolved.')
      return studioParams({ snapshot: snapshot as ModuleRegistrySnapshot, commandId: command.params })
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
  'module.changed': {
    scope: 'modules:read',
    capability: STUDIO_MODULES_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
