import {
  STUDIO_EXTENSION_HOST_CAPABILITY,
  type StudioModulesMethodMap,
} from '../../../../packages/studio-protocol/src/public'
import { extensionHostRefusal } from './moduleMethods'
import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import { windowStudioClient, windowStudioIsAnotherMachine } from './windowStudioClient'

// What runs on the window's Studio, changed from Settings: switching a module
// on or off, installing an extension from a folder, trusting it, and
// uninstalling one added from a folder. Each is an owner's command
// (`extension.setEnabled`, `.install`, `.setTrust`, `.uninstall`) under a command
// id made for the call. None throws: a refusal, Studio's or the connection's,
// is an answer the caller shows.

type Lifecycle = 'extension.setEnabled' | 'extension.install' | 'extension.setTrust' | 'extension.uninstall'
type Params<M extends Lifecycle> = Omit<StudioModulesMethodMap[M]['params'], 'commandId'>
type Result<M extends Lifecycle> = StudioModulesMethodMap[M]['result']

export type ModuleLifecycleClient = {
  setEnabled(moduleId: string, enabled: boolean | null): Promise<Result<'extension.setEnabled'>>
  install(path: string): Promise<Result<'extension.install'>>
  setTrust(moduleId: string, trusted: boolean): Promise<Result<'extension.setTrust'>>
  uninstall(moduleId: string): Promise<Result<'extension.uninstall'>>
}

function commandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const refused = (message: string) => ({ ok: false as const, message })

/** One lifecycle command over a client: Studio's answer, or why it could not be asked. */
export async function sendModuleLifecycle<M extends Lifecycle>(
  client: StudioClient,
  method: M,
  params: Params<M>,
): Promise<Result<M>> {
  if (!client.supports(STUDIO_EXTENSION_HOST_CAPABILITY))
    return refused(extensionHostRefusal(client, 'This Studio does not run extensions.'))
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
    setTrust: (moduleId, trusted) => send('extension.setTrust', { moduleId, trusted }),
    uninstall: (moduleId) => send('extension.uninstall', { moduleId }),
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
