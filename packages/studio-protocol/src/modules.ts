import {
  studioParams,
  studioParamsRefused,
  studioNoParams,
  type StudioParsed,
  type StudioMethodTable,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_EXTENSION_FRAMES_CAPABILITY, STUDIO_EXTENSION_HOST_CAPABILITY } from './handshake.js'
import type {
  ExtensionContent,
  ExtensionSettingValues,
  ExtensionSettingValueView,
  StudioExtensionContentRequest,
  ExtensionContributionsResult,
  ExtensionFrameDocument,
  StudioExtensionApproval,
  StudioExtensionDevFolder,
  ModuleRegistrySnapshot,
  ModuleRegistrySnapshotWriteResult,
  ThirdPartyModuleListResult,
  StudioCatalogueEntryView,
  StudioCatalogueSource,
  StudioCatalogueView,
} from './extensions-types.js'

// What a Studio's modules say to its clients. A module is a capability its
// server runs (a bundled one, or an extension the person installed and
// approved); its main half emits events for its own client half and raises bell
// rows, and both reach every client following these streams.
//
// - `extension.events`: what the modules emit, every module's or one's
//   (`{ moduleId }`). FIFO per module; nothing is replayed to a client that
//   subscribes later, so a client half reads the durable answer from its
//   module and treats an event as a signal.
// - `extension.notifications`: the bell. The rows the server still keeps come
//   first (a module's launch failure is raised before any client listens),
//   then each new one; a row's `id` is unique per server run, so a client
//   that hears the kept rows again after a reconnect files each once.
//
// - `extension.read` and `extension.operate`: a method a module declared
//   (`MainHost.registerMethods`), by the module's id and the method's name.
//   A method is declared `read` or `operate`; each is called only through its
//   own entry, so a client granted `extensions:read` reaches a module's reads and
//   never its writes. An operate carries the client's `commandId`, is audited,
//   and a retry under the same id is answered with the first answer. The
//   module's own params validator reads `params`; what it refuses is
//   `invalid_params` in the module's words. What the module's handler answers
//   comes back as the result, its own refusals (`{ ok: false, code }`)
//   included; the protocol's refusals are a module that does not run here
//   (`extension_unavailable`) and a name it does not declare under that entry
//   (`extension_method_unknown`).
//
// - `extension.list`: every module this Studio knows, whether it is switched on
//   and running here, and the methods it declares.
// - `extension.setEnabled`, `extension.install`, `extension.approve`,
//   `extension.uninstall`: what runs here. Each is an owner's
//   (`STUDIO_MODULES_OWNER`), a mutation under the client's `commandId`, and
//   answers the server's own outcome as its result. Installing, approving and
//   uninstalling change what the server loads at its next start; switching a
//   module on or off applies at once where its main half can load live.
//   An extension beyond content runs only once the person approved it as it is
//   now: `extension.approve` names the fingerprint the person was shown, and is
//   refused when the extension changed since.
//
// - `extension.installed`: every extension installed here, with its approval,
//   its signature, where it came from and whether it runs; what Settings and the
//   Extensions door list. `extension.contributions`: what the approved
//   extensions add to a client (commands, menus, top bar items, panels, doors,
//   settings sections), as their extension.json declares it; no code.
//   `extension.changed`: what is installed or approved here changed, so a
//   client lists them again. `extension.content`: one piece of what a content
//   extension adds (a syntax's grammar), its file read here, held to the bytes
//   the extension was verified with and checked, served as data and never as
//   a path, to every client alike. `extension.settings` and
//   `extension.setSetting`: the values of the settings an extension declares,
//   which Settings shows and changes and the extension's own code reads; both
//   need `settings:write`, as Studio's own settings do, and
//   `extension.settingsChanged` says whose changed, from any writer.
// - Under `extension-frames`: `extension.frame`, the document one panel, door
//   or settings section is drawn from in its sandboxed frame (built here from
//   the extension's verified entry, Studio's bootstrap and the theme the client
//   names); and `extension.call`, one host call a frame made, which the client
//   that drew the frame passes on. The call is checked here as the extension
//   (its approval) and as this connection (its grant), and answers the
//   method's result or the refusal's code and words.
// - Under `extension-editors` as well: `extension.frame` also builds a custom
//   editor's frame (`point: customEditors`), and the frame methods `files.read`
//   and `files.write` carry bytes (`encoding: base64`), answer the file's
//   sha256, and write only over the bytes that were read (`expectedSha256`,
//   refused `conflict` otherwise): what a client's editor session reads and
//   saves the file with, as the extension and as that connection.
//   `extension.reportRegistry`: the module registry a window resolved, its window
//   halves included, which the Studio's own `module.*` agent tools report. It
//   is the window's own report, so an owner's only
//   (`STUDIO_MODULES_REPORT_OWNER`): a paired app has no window of this
//   Studio's to report.
//
// The streams, the calls and the list need `extensions:read` (`extension.operate`,
// `extensions:operate`, which carries it); none of those is held to an owner's
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

/** Which surface a frame draws. `customEditors` only where the Studio offers `extension-editors`. */
export type StudioExtensionSurfacePoint = 'panels' | 'doors' | 'settingsSections' | 'customEditors'

/** `extension.frame`'s params. */
export type StudioExtensionFrameRequest = {
  moduleId: string
  point: StudioExtensionSurfacePoint
  /** The contribution's id in extension.json. */
  id: string
  /** The client's theme, by id; the document is drawn in it when this Studio knows it. */
  theme?: string
}

/** One host call a frame made: the extension, the frame method and its params. */
export type StudioExtensionCall = {
  moduleId: string
  /**
   * The hash of the frame document the call came from (`extension.frame`). A
   * call is held to what was approved when that document was built, and one
   * from a document built before the extension's access changed is refused
   * `frame_outdated`: the client draws the surface again.
   */
  frame: string
  method: string
  params?: unknown
}

/** What a host call came to: the method's result, or why it was refused or failed. */
export type StudioExtensionCallAnswer = { ok: true; result: unknown } | { ok: false; code: string; message: string }

/** Why changing what runs on a Studio is an owner's. */
export const STUDIO_MODULES_OWNER =
  'It changes what runs on this machine: an extension’s code is installed, approved, started or stopped.'

/** Why `extension.reportRegistry` is an owner's only. */
export const STUDIO_MODULES_REPORT_OWNER =
  'It is the report of this Studio’s own window: which modules it resolved, which the agents’ module tools read.'

/** A method a module declares, by name and access. */
export type StudioModuleDeclaredMethod = { name: string; access: 'read' | 'operate' }

/** One module as its Studio holds it. */
export type StudioModuleSummary = {
  id: string
  name: string
  /** A built-in module's integer, or an extension's semver. */
  version: number | string
  /** The app's own module, or an extension the person installed. */
  source: 'bundled' | 'third-party'
  /** Switched on: the person's choice, or its default. */
  enabled: boolean
  /** Running here now: its main half loaded, or (a window-only extension) its manifest. */
  running: boolean
  /** Why a switched-on module does not run: not approved, a bad signature, a failed load. */
  blocked?: string
  /** What it declares (`extension.read` / `extension.operate`), empty while it is not running. */
  methods: StudioModuleDeclaredMethod[]
}

/** A lifecycle change's outcome: done, or the server's refusal in its words. */
export type StudioModuleLifecycleAnswer<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string }

export type StudioModulesMethodMap = {
  /** Call a method the module declared `read`. */
  'extension.read': {
    params: StudioModuleCall
    result: StudioModuleAnswer
    errors: 'extension_unavailable' | 'extension_method_unknown'
  }
  /** Call a method the module declared `operate`, once per `commandId`. */
  'extension.operate': {
    params: StudioModuleCall & { commandId: string }
    result: StudioModuleAnswer
    errors: 'extension_unavailable' | 'extension_method_unknown'
  }
  /** Every module this Studio knows. */
  'extension.list': { params: Record<string, never>; result: { modules: StudioModuleSummary[] } }
  /**
   * Switch a module on or off here (`null`: back to its default). Kept for the
   * next start, and applied at once where its main half loads live. Answers
   * the module as it now is, or null for one this Studio does not hold.
   */
  'extension.setEnabled': {
    params: { moduleId: string; enabled: boolean | null; commandId: string }
    result: StudioModuleLifecycleAnswer<{ module: StudioModuleSummary | null }>
  }
  /**
   * Install the extension in a folder on this machine, under `local.<id>`. It
   * runs once approved (`approval`); a new version of an approved extension
   * keeps its approval when it asks for no more. Symbolic links in the folder
   * are left out of the copy and named in `strippedLinks`.
   */
  'extension.install': {
    params: { path: string; commandId: string }
    result:
      | { ok: true; moduleId: string; approval: StudioExtensionApproval; strippedLinks: string[] }
      | { ok: false; message: string; issues?: Array<{ path: string; message: string }> }
  }
  /**
   * Approve an installed extension as it is now: `fingerprint` is the one the
   * person was shown (`extension.installed`). Refused when it changed since.
   */
  'extension.approve': {
    params: { moduleId: string; fingerprint: string; commandId: string }
    result: StudioModuleLifecycleAnswer
  }
  /** Remove an installed extension, and what was kept for it. */
  'extension.uninstall': {
    params: { moduleId: string; commandId: string }
    result: { ok: true; removedModuleIds: string[] } | { ok: false; message: string }
  }
  /**
   * The catalogues Browse shows: the official one, the community one and the
   * ones the person added, each from its last copy, with why it could not be
   * read when it could not. `refresh`: fetch them again first.
   */
  'extension.catalogues': { params: { refresh?: boolean }; result: { catalogues: StudioCatalogueView[] } }
  /** One extension's page in one catalogue. */
  'extension.catalogueEntry': {
    params: { catalogue: string; id: string }
    result: { ok: true; entry: StudioCatalogueEntryView } | { ok: false; message: string }
  }
  /** One catalogue image's bytes, held to its sha256. */
  'extension.catalogueImage': {
    params: { catalogue: string; path: string; sha256: string }
    result: { ok: true; mime: string; base64: string } | { ok: false; message: string }
  }
  /** Add a catalogue by its git URL (the client asked the person first); answers it as read now. */
  'extension.catalogueAdd': {
    params: { url: string; commandId: string }
    result: StudioModuleLifecycleAnswer<{ catalogue: StudioCatalogueView }>
  }
  /** Remove a catalogue the person added. What was installed from it stays, and no longer updates. */
  'extension.catalogueRemove': { params: { url: string; commandId: string }; result: StudioModuleLifecycleAnswer }
  /**
   * Install from a catalogue entry (`{ catalogue, id }`) or a git URL
   * (`{ git, ref?, path? }`): Studio checks out the pinned commit (or the
   * ref's), installs only the extension's folder and refuses bytes or a
   * manifest the catalogue does not vouch for. As `extension.install`
   * answers; `leftOut` names what a Claude Code plugin had that Studio does not install.
   */
  'extension.installFrom': {
    params: { from: StudioExtensionInstallSource; commandId: string }
    result:
      | {
          ok: true
          moduleId: string
          approval: StudioExtensionApproval
          strippedLinks: string[]
          leftOut?: string[]
        }
      | {
          ok: false
          message: string
          issues?: Array<{ path: string; message: string }>
          /** A Claude Code plugin marketplace's plugin folders, when the repository's root is one: name one as `path`. */
          folders?: string[]
        }
  }
  /**
   * Install the newer release the catalogue an extension came from lists:
   * `version` is the one the person was shown, refused when the catalogue
   * lists another now.
   */
  'extension.update': {
    params: { moduleId: string; version?: string; commandId: string }
    result:
      | { ok: true; moduleId: string; approval: StudioExtensionApproval; strippedLinks: string[] }
      | { ok: false; message: string }
  }
  /**
   * The development folders registered here, in the order they load (after
   * every installed extension): each with the extension it holds, or why none.
   */
  'extension.devFolders': { params: Record<string, never>; result: { folders: StudioExtensionDevFolder[] } }
  /**
   * Register a folder on this machine as a development folder: its extension
   * loads from where it is, under `local.<id>`, and Studio reads it again on
   * every save. It runs once the person approves it (`extension.approve`);
   * a save asks again only when it asks for more. Registering one already
   * registered reads it again now.
   */
  'extension.devLoad': {
    params: { path: string; commandId: string }
    result:
      | { ok: true; moduleId: string; path: string; added: boolean; approval: StudioExtensionApproval }
      | {
          ok: false
          code: 'invalid_argument' | 'extension_invalid' | 'unavailable'
          message: string
          issues?: Array<{ path: string; message: string }>
        }
  }
  /** Take a development folder out; its approval goes with it. */
  'extension.devUnload': {
    params: { path: string; commandId: string }
    result:
      | { ok: true; path: string; moduleId: string | null }
      | { ok: false; code: 'not_found' | 'unavailable'; message: string; loaded?: string[] }
  }
  /** Every extension installed here, with its approval, signature, origin and launch state. */
  'extension.installed': { params: Record<string, never>; result: ThirdPartyModuleListResult }
  /** What the approved extensions add to a client, as their extension.json declares it. */
  'extension.contributions': { params: Record<string, never>; result: ExtensionContributionsResult }
  /**
   * The document one surface is drawn from: the extension's entry, read and
   * checked against its verified bytes now, in Studio's frame, themed as
   * `theme` (a built-in theme's id) when this Studio knows it.
   */
  'extension.frame': {
    params: StudioExtensionFrameRequest
    result: ExtensionFrameDocument
    errors: 'extension_unavailable'
  }
  /** One piece of what a content extension adds, checked here, as data. */
  'extension.content': {
    params: StudioExtensionContentRequest
    result: ExtensionContent
    errors: 'extension_unavailable'
  }
  /** The values of the settings an extension declares: each the person's, else its default. */
  'extension.settings': {
    params: { moduleId: string }
    result: ExtensionSettingValues
    errors: 'extension_unavailable'
  }
  /** Set one declared setting (`null`: back to its default), held to what extension.json declares of it. */
  'extension.setSetting': {
    params: { moduleId: string; key: string; value: ExtensionSettingValueView | null; commandId: string }
    result: StudioModuleLifecycleAnswer<{ values: Record<string, ExtensionSettingValueView> }>
  }
  /** One host call a frame made, as the extension and as this connection. */
  'extension.call': {
    params: StudioExtensionCall & { commandId: string }
    result: StudioExtensionCallAnswer
  }
  /** The module registry a window resolved; refused, with why, when it is not one. */
  'extension.reportRegistry': {
    params: { snapshot: ModuleRegistrySnapshot; commandId: string }
    result: ModuleRegistrySnapshotWriteResult
  }
}

/** `extension.events` params: every module's events, or one module's. */
export type StudioModuleEventsParams = { moduleId?: string }

export type StudioModulesTopicMap = {
  'extension.events': { params: StudioModuleEventsParams; payload: StudioModuleEvent; stream: 'push' }
  'extension.notifications': { params: Record<string, never>; payload: StudioModuleNotification; stream: 'push' }
  /** What is installed or approved here changed: list and load the extensions again. */
  'extension.changed': { params: Record<string, never>; payload: Record<string, never>; stream: 'push' }
  /** An extension's settings values changed: read them again (`extension.settings`). */
  'extension.settingsChanged': { params: Record<string, never>; payload: { moduleId: string }; stream: 'push' }
}

/**
 * Where `extension.installFrom` installs from: a catalogue's entry, or a git
 * URL. A catalogue install names the whole release the person was shown (its
 * page, `StudioCatalogueEntryView`): the version, commit, content hash,
 * source and owner id, `null` when the page named none. A catalogue that
 * lists anything else since is refused, never installed in its place.
 */
export type StudioExtensionInstallSource =
  | {
      catalogue: string
      id: string
      version: string
      commit: string
      contentHash: string
      source: StudioCatalogueSource
      ownerId: number | null
    }
  | { git: string; ref?: string; path?: string }

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
/** The longest contribution or theme id. */
const MAX_SURFACE_ID_CHARS = 200
/** The longest approval fingerprint: `sha256-` and its digest. */
const MAX_FINGERPRINT_CHARS = 128
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
  capability: STUDIO_EXTENSION_HOST_CAPABILITY,
} as const

function namedModule(value: Record<string, unknown>): StudioParsed<{ moduleId: string; commandId: string }> {
  if (!moduleId(value.moduleId)) return studioParamsRefused('"moduleId" is the module\'s manifest id.')
  const command = commandIdOf(value)
  if (!command.ok) return command
  return studioParams({ moduleId: value.moduleId, commandId: command.params })
}

/** The longest git URL a catalogue or an install may name. */
const MAX_URL_CHARS = 512

function shortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

/** A catalogue entry's git source, as its page showed it. */
function catalogueSourceOf(value: unknown): StudioCatalogueSource | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (!shortText(source.url, MAX_URL_CHARS) || !shortText(source.ref, 256)) return null
  if (source.path !== undefined && !shortText(source.path, 512)) return null
  return { url: source.url, ref: source.ref, ...(source.path !== undefined ? { path: source.path as string } : {}) }
}

function catalogueUrlParams(value: Record<string, unknown>): StudioParsed<{ url: string; commandId: string }> {
  if (!shortText(value.url, MAX_URL_CHARS)) return studioParamsRefused('"url" is the catalogue\'s git URL.')
  const command = commandIdOf(value)
  if (!command.ok) return command
  return studioParams({ url: value.url, commandId: command.params })
}

function devFolderParams(value: Record<string, unknown>): StudioParsed<{ path: string; commandId: string }> {
  if (typeof value.path !== 'string' || value.path.trim().length === 0 || value.path.length > MAX_PATH_CHARS)
    return studioParamsRefused('"path" is the development folder on this machine.')
  const command = commandIdOf(value)
  if (!command.ok) return command
  return studioParams({ path: value.path, commandId: command.params })
}

export const STUDIO_MODULES_METHODS: StudioMethodTable<StudioModulesMethodMap> = {
  'extension.read': {
    scope: 'extensions:read',
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: parseCall,
  },
  'extension.operate': {
    scope: 'extensions:operate',
    mutation: true,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
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
  'extension.list': {
    scope: 'extensions:read',
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: studioNoParams,
  },
  'extension.setEnabled': {
    ...lifecycle,
    params: (value) => {
      const named = namedModule(value)
      if (!named.ok) return named
      if (value.enabled !== null && typeof value.enabled !== 'boolean')
        return studioParamsRefused('"enabled" is true, false, or null for the module\'s default.')
      return studioParams({ ...named.params, enabled: value.enabled })
    },
  },
  'extension.install': {
    ...lifecycle,
    params: (value) => {
      if (typeof value.path !== 'string' || value.path.trim().length === 0 || value.path.length > MAX_PATH_CHARS)
        return studioParamsRefused('"path" is the folder on this machine the extension is in.')
      const command = commandIdOf(value)
      if (!command.ok) return command
      return studioParams({ path: value.path, commandId: command.params })
    },
  },
  'extension.approve': {
    ...lifecycle,
    params: (value) => {
      const named = namedModule(value)
      if (!named.ok) return named
      if (
        typeof value.fingerprint !== 'string' ||
        !value.fingerprint.startsWith('sha256-') ||
        value.fingerprint.length > MAX_FINGERPRINT_CHARS
      )
        return studioParamsRefused('"fingerprint" is the approval fingerprint the person was shown.')
      return studioParams({ ...named.params, fingerprint: value.fingerprint })
    },
  },
  'extension.uninstall': { ...lifecycle, params: namedModule },
  'extension.catalogues': {
    scope: 'extensions:read',
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: (value) => {
      if (value.refresh !== undefined && typeof value.refresh !== 'boolean')
        return studioParamsRefused('"refresh" is true to fetch the catalogues again first.')
      return studioParams(value.refresh === true ? { refresh: true } : {})
    },
  },
  'extension.catalogueEntry': {
    scope: 'extensions:read',
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: (value) => {
      if (!shortText(value.catalogue, MAX_URL_CHARS + 4))
        return studioParamsRefused('"catalogue" is the catalogue\'s id.')
      if (!shortText(value.id, MAX_MODULE_ID_CHARS)) return studioParamsRefused('"id" is the extension\'s install key.')
      return studioParams({ catalogue: value.catalogue, id: value.id })
    },
  },
  'extension.catalogueImage': {
    scope: 'extensions:read',
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: (value) => {
      if (!shortText(value.catalogue, MAX_URL_CHARS + 4))
        return studioParamsRefused('"catalogue" is the catalogue\'s id.')
      if (!shortText(value.path, 512)) return studioParamsRefused('"path" is the image\'s path in the catalogue.')
      if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256))
        return studioParamsRefused('"sha256" is the image\'s digest.')
      return studioParams({ catalogue: value.catalogue, path: value.path, sha256: value.sha256 })
    },
  },
  'extension.catalogueAdd': { ...lifecycle, params: catalogueUrlParams },
  'extension.catalogueRemove': { ...lifecycle, params: catalogueUrlParams },
  'extension.installFrom': {
    ...lifecycle,
    params: (value) => {
      const command = commandIdOf(value)
      if (!command.ok) return command
      const from = value.from
      if (typeof from !== 'object' || from === null || Array.isArray(from))
        return studioParamsRefused('"from" is `{ catalogue, id }` or `{ git, ref?, path? }`.')
      const source = from as Record<string, unknown>
      if (source.git !== undefined) {
        if (!shortText(source.git, MAX_URL_CHARS))
          return studioParamsRefused('"from.git" is the repository\'s git URL.')
        if (source.ref !== undefined && !shortText(source.ref, 256))
          return studioParamsRefused('"from.ref" is a branch, tag or commit.')
        if (source.path !== undefined && !shortText(source.path, 512))
          return studioParamsRefused('"from.path" is the extension\'s folder in the repository.')
        return studioParams({
          from: {
            git: source.git,
            ...(source.ref !== undefined ? { ref: source.ref as string } : {}),
            ...(source.path !== undefined ? { path: source.path as string } : {}),
          },
          commandId: command.params,
        })
      }
      if (!shortText(source.catalogue, MAX_URL_CHARS + 4) || !shortText(source.id, MAX_MODULE_ID_CHARS))
        return studioParamsRefused(
          '"from" is `{ catalogue, id, version, commit, contentHash, source, ownerId }` or `{ git, ref?, path? }`.',
        )
      // The whole release the page showed: what installs is that, or nothing.
      if (!shortText(source.version, 64))
        return studioParamsRefused('"from.version" is the version the person was shown.')
      if (typeof source.commit !== 'string' || !/^[0-9a-f]{40}$/.test(source.commit))
        return studioParamsRefused('"from.commit" is the release\'s commit.')
      if (typeof source.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(source.contentHash))
        return studioParamsRefused('"from.contentHash" is the release\'s content hash.')
      const shown = catalogueSourceOf(source.source)
      if (!shown)
        return studioParamsRefused('"from.source" is the entry\'s source the person was shown, `{ url, ref, path? }`.')
      if (source.ownerId !== null && !(Number.isSafeInteger(source.ownerId) && (source.ownerId as number) > 0))
        return studioParamsRefused('"from.ownerId" is the owner id the person was shown, or null.')
      return studioParams({
        from: {
          catalogue: source.catalogue,
          id: source.id,
          version: source.version,
          commit: source.commit,
          contentHash: source.contentHash,
          source: shown,
          ownerId: source.ownerId as number | null,
        },
        commandId: command.params,
      })
    },
  },
  'extension.update': {
    ...lifecycle,
    params: (value) => {
      const named = namedModule(value)
      if (!named.ok) return named
      if (value.version !== undefined && !shortText(value.version, 64))
        return studioParamsRefused('"version" is the version the person was shown.')
      return studioParams({
        ...named.params,
        ...(value.version !== undefined ? { version: value.version as string } : {}),
      })
    },
  },
  // A development folder is a path on this machine, and what runs from it is
  // the owner's to choose: listing them names paths, so it is the owner's too.
  'extension.devFolders': {
    scope: null,
    owner: STUDIO_MODULES_OWNER,
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: studioNoParams,
  },
  'extension.devLoad': { ...lifecycle, params: devFolderParams },
  'extension.devUnload': { ...lifecycle, params: devFolderParams },
  'extension.installed': {
    scope: 'extensions:read',
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: studioNoParams,
  },
  'extension.contributions': {
    scope: 'extensions:read',
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: studioNoParams,
  },
  'extension.frame': {
    scope: 'extensions:read',
    mutation: false,
    capability: STUDIO_EXTENSION_FRAMES_CAPABILITY,
    params: (value) => {
      if (!moduleId(value.moduleId)) return studioParamsRefused('"moduleId" is the extension\'s install key.')
      if (
        value.point !== 'panels' &&
        value.point !== 'doors' &&
        value.point !== 'settingsSections' &&
        value.point !== 'customEditors'
      )
        return studioParamsRefused('"point" is panels, doors, settingsSections or customEditors.')
      if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_SURFACE_ID_CHARS)
        return studioParamsRefused('"id" is the contribution\'s id in extension.json.')
      if (value.theme !== undefined && (typeof value.theme !== 'string' || value.theme.length > MAX_SURFACE_ID_CHARS))
        return studioParamsRefused('"theme" is a theme\'s id, when given.')
      return studioParams({
        moduleId: value.moduleId,
        point: value.point,
        id: value.id,
        ...(value.theme === undefined ? {} : { theme: value.theme }),
      })
    },
  },
  'extension.content': {
    scope: 'extensions:read',
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: (value) => {
      if (!moduleId(value.moduleId)) return studioParamsRefused('"moduleId" is the extension\'s install key.')
      if (value.kind !== 'syntax') return studioParamsRefused('"kind" is syntax.')
      if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_SURFACE_ID_CHARS)
        return studioParamsRefused('"id" is the contribution\'s id in extension.json.')
      return studioParams({ moduleId: value.moduleId, kind: value.kind, id: value.id })
    },
  },
  'extension.settings': {
    // Settings may hold a server address or a token: read only by a
    // connection that may change Studio's settings.
    scope: 'settings:write',
    mutation: false,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: (value) =>
      moduleId(value.moduleId)
        ? studioParams({ moduleId: value.moduleId })
        : studioParamsRefused('"moduleId" is the extension\'s install key.'),
  },
  'extension.setSetting': {
    // A declared setting is one of Studio's settings, not an extension's
    // operation: the person's own browser tab changes it as it changes any.
    scope: 'settings:write',
    mutation: true,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    params: (value) => {
      const named = namedModule(value)
      if (!named.ok) return named
      if (typeof value.key !== 'string' || value.key.length === 0 || value.key.length > 64)
        return studioParamsRefused('"key" is a setting\'s key in extension.json.')
      const setting = value.value
      const scalar =
        setting === null ||
        typeof setting === 'boolean' ||
        (typeof setting === 'number' && Number.isFinite(setting)) ||
        (typeof setting === 'string' && setting.length <= 4096)
      if (!scalar) return studioParamsRefused('"value" is text, a number, true or false, or null for the default.')
      return studioParams({ ...named.params, key: value.key, value: setting as ExtensionSettingValueView | null })
    },
  },
  'extension.call': {
    scope: 'extensions:read',
    mutation: true,
    capability: STUDIO_EXTENSION_FRAMES_CAPABILITY,
    params: (value) => {
      if (!moduleId(value.moduleId)) return studioParamsRefused('"moduleId" is the extension\'s install key.')
      if (typeof value.frame !== 'string' || !/^[0-9a-f]{64}$/u.test(value.frame))
        return studioParamsRefused('"frame" is the hash of the frame document the call came from.')
      if (typeof value.method !== 'string' || !/^[a-z][a-zA-Z.]{0,63}$/u.test(value.method))
        return studioParamsRefused('"method" is a frame method\'s name.')
      const command = commandIdOf(value)
      if (!command.ok) return command
      return studioParams({
        moduleId: value.moduleId,
        frame: value.frame,
        method: value.method,
        ...(value.params === undefined ? {} : { params: value.params }),
        commandId: command.params,
      })
    },
  },
  'extension.reportRegistry': {
    scope: null,
    owner: STUDIO_MODULES_REPORT_OWNER,
    mutation: true,
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
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
  'extension.events': {
    scope: 'extensions:read',
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
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
  'extension.notifications': {
    scope: 'extensions:read',
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'extension.changed': {
    scope: 'extensions:read',
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'extension.settingsChanged': {
    scope: 'extensions:read',
    capability: STUDIO_EXTENSION_HOST_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
