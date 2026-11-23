import {
  STUDIO_EXTENSION_HOST_CAPABILITY,
  type StudioExtensionInstallSource,
  type StudioModulesMethodMap,
} from '../../../../packages/studio-protocol/src/public'
import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import { windowStudioClient, windowStudioIsAnotherMachine, windowStudioWelcome } from './windowStudioClient'

// What runs on the window's Studio, changed from Settings: switching a module
// on or off, installing an extension from a folder, approving it, and
// uninstalling one added from a folder. Each is an owner's command
// (`extension.setEnabled`, `.install`, `.approve`, `.uninstall`) under a command
// id made for the call. None throws: a refusal, Studio's or the connection's,
// is an answer the caller shows.

type Lifecycle =
  | 'extension.setEnabled'
  | 'extension.install'
  | 'extension.approve'
  | 'extension.uninstall'
  | 'extension.devLoad'
  | 'extension.devUnload'
  | 'extension.installFrom'
  | 'extension.update'
  | 'extension.catalogueAdd'
  | 'extension.catalogueRemove'
type Params<M extends Lifecycle> = Omit<StudioModulesMethodMap[M]['params'], 'commandId'>
type Result<M extends Lifecycle> = StudioModulesMethodMap[M]['result']

export type ModuleLifecycleClient = {
  setEnabled(moduleId: string, enabled: boolean | null): Promise<Result<'extension.setEnabled'>>
  install(path: string): Promise<Result<'extension.install'>>
  /** Approve it as the person was shown it: `fingerprint` from `extension.installed`. */
  approve(moduleId: string, fingerprint: string): Promise<Result<'extension.approve'>>
  uninstall(moduleId: string): Promise<Result<'extension.uninstall'>>
  /** Register a development folder: its extension loads from where it is, and again on every save. */
  devLoad(path: string): Promise<Result<'extension.devLoad'>>
  devUnload(path: string): Promise<Result<'extension.devUnload'>>
  /** Install from a catalogue entry or a git URL; it never installs from a link alone. */
  installFrom(from: StudioExtensionInstallSource): Promise<Result<'extension.installFrom'>>
  /** Install the newer release the catalogue an extension came from lists: `version`, the one the person was shown. */
  update(moduleId: string, version?: string): Promise<Result<'extension.update'>>
  /** Add a catalogue by its git URL, once the person said yes. */
  addCatalogue(url: string): Promise<Result<'extension.catalogueAdd'>>
  removeCatalogue(url: string): Promise<Result<'extension.catalogueRemove'>>
}

function commandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const refused = (message: string) => ({ ok: false as const, code: 'unavailable' as const, message })

/** One lifecycle command over a client: Studio's answer, or why it could not be asked. */
export async function sendModuleLifecycle<M extends Lifecycle>(
  client: StudioClient,
  method: M,
  params: Params<M>,
): Promise<Result<M>> {
  if (!client.supports(STUDIO_EXTENSION_HOST_CAPABILITY)) return refused('This Studio does not run extensions.')
  try {
    return await client.request(method, { ...params, commandId: commandId() } as StudioModulesMethodMap[M]['params'])
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error))
  }
}

/** The lifecycle over a client. */
export function moduleLifecycleOver(client: () => Promise<StudioClient>): ModuleLifecycleClient {
  const send = async <M extends Lifecycle>(method: M, params: Params<M>): Promise<Result<M>> => {
    let connected: StudioClient
    try {
      connected = await client()
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error))
    }
    return sendModuleLifecycle(connected, method, params)
  }
  return {
    setEnabled: (moduleId, enabled) => send('extension.setEnabled', { moduleId, enabled }),
    install: (path) => send('extension.install', { path }),
    approve: (moduleId, fingerprint) => send('extension.approve', { moduleId, fingerprint }),
    uninstall: (moduleId) => send('extension.uninstall', { moduleId }),
    devLoad: (path) => send('extension.devLoad', { path }),
    devUnload: (path) => send('extension.devUnload', { path }),
    installFrom: (from) => send('extension.installFrom', { from }),
    update: (moduleId, version) => send('extension.update', { moduleId, ...(version ? { version } : {}) }),
    addCatalogue: (url) => send('extension.catalogueAdd', { url }),
    removeCatalogue: (url) => send('extension.catalogueRemove', { url }),
  }
}

/**
 * The lifecycle over this window's own Studio connection: null in a window
 * that has none, and in one whose Studio is another machine (a browser tab),
 * where a folder picked here is not on the Studio's disk and the window's own
 * copy of the switches is not the person's choice for that machine.
 */
export function windowModuleLifecycle(
  api: Parameters<typeof windowStudioClient>[0] | undefined = typeof window === 'undefined' ? undefined : window.api,
): ModuleLifecycleClient | null {
  if (typeof api?.studioWindowTicket !== 'function' || windowStudioIsAnotherMachine(api)) return null
  return moduleLifecycleOver(() => windowStudioClient(api))
}

/**
 * The lifecycle over this window's Studio, for what names nothing on this
 * window's disk: installing from a catalogue or a git URL, approving what it
 * installed, reviewing an update, and adding or removing a catalogue. Any
 * window with a Studio, a browser tab included; null when its Studio says this
 * window's grant is not its owner's (the Studio refuses one anyway). Folder
 * installs and development folders stay `windowModuleLifecycle`'s.
 */
export function windowCatalogueLifecycle(
  api: Parameters<typeof windowStudioClient>[0] | undefined = typeof window === 'undefined' ? undefined : window.api,
): ModuleLifecycleClient | null {
  if (typeof api?.studioWindowTicket !== 'function') return null
  if (windowStudioWelcome(api)?.grant.owner === false) return null
  return moduleLifecycleOver(() => windowStudioClient(api))
}
