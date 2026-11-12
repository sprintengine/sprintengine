import {
  STUDIO_MODULE_SERVICES_METHODS,
  STUDIO_MODULES_CAPABILITY,
  type StudioModuleServicesMethodMap,
} from '../../../../packages/studio-protocol/src/public'
import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import type { ModuleCallAnswer, ModuleMethodContract } from '../../../shared/modules/methods'
import {
  moduleServiceRefusal,
  type ModuleMethodCall,
  type ModuleMethodCaller,
  type ModuleServiceAnswer,
  type ModuleServiceCaller,
  type ModuleServiceMethod,
  type ModuleServiceParams,
} from '../modules/renderer-host'
import { windowStudioClient } from './windowStudioClient'

// A module's renderer half calls its own declared methods over the window's
// Studio connection: `module.read` for a read, `module.operate` for an
// operate (under the caller's command id, or one made for the call). The
// answer is the module's own, or the refusal Studio or the connection gave:
// a module renderer never sees a throw.
//
// The host's services a module's window half calls (the Backlog's writes,
// the usage query) go over the same client: a read as it is, a write under a
// command id made for the call.

type Answer = ModuleCallAnswer<ModuleMethodContract>

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** What a thrown request said: the protocol's code when it carried one. */
function refusalOf(error: unknown): { code: string; message: string } {
  const code = (error as { code?: unknown } | null)?.code
  return {
    code: typeof code === 'string' && code ? code : 'unavailable',
    message: error instanceof Error ? error.message : String(error),
  }
}

function refusal(error: unknown): Answer {
  return { ok: false, ...refusalOf(error) }
}

/** One call over a client: the protocol's entry for its access, the module's answer as it came. */
export async function callModuleMethod(client: StudioClient, call: ModuleMethodCall): Promise<Answer> {
  if (!client.supports(STUDIO_MODULES_CAPABILITY))
    return { ok: false, code: 'unavailable', message: 'This Studio does not serve module methods.' }
  const named = {
    moduleId: call.moduleId,
    method: call.method,
    ...(call.params === undefined ? {} : { params: call.params }),
  }
  try {
    return call.access === 'operate'
      ? await client.request('module.operate', { ...named, commandId: call.commandId ?? randomId() })
      : await client.request('module.read', named)
  } catch (error) {
    return refusal(error)
  }
}

/** The caller `RendererHost.methods` uses in a window: over the window's own Studio client. */
export function windowModuleMethodCaller(api?: Parameters<typeof windowStudioClient>[0]): ModuleMethodCaller {
  return async (call) => {
    const windowApi = api ?? (typeof window === 'undefined' ? undefined : window.api)
    if (typeof windowApi?.studioWindowTicket !== 'function')
      return { ok: false, code: 'unavailable', message: 'This window has no Studio connection.' }
    let client: StudioClient
    try {
      client = await windowStudioClient(windowApi)
    } catch (error) {
      return refusal(error)
    }
    return callModuleMethod(client, call)
  }
}

/** One host-service call over a client: the service's answer, or the refusal in its words. */
export async function callModuleService<M extends ModuleServiceMethod>(
  client: StudioClient,
  method: M,
  params: ModuleServiceParams<M>,
): Promise<ModuleServiceAnswer<M>> {
  if (!client.supports(STUDIO_MODULES_CAPABILITY))
    return moduleServiceRefusal(method, 'unavailable', 'This Studio does not serve host services to modules.')
  // A write (a mutation in the contract) is sent under a command id made here.
  const sent = (
    STUDIO_MODULE_SERVICES_METHODS[method].mutation ? { ...params, commandId: randomId() } : params
  ) as StudioModuleServicesMethodMap[M]['params']
  try {
    return await client.request(method, sent)
  } catch (error) {
    const { code, message } = refusalOf(error)
    return moduleServiceRefusal(method, code, message)
  }
}

/** The caller the Backlog writes and `queryUsage` use in a window: over the window's own Studio client. */
export function windowModuleServiceCaller(api?: Parameters<typeof windowStudioClient>[0]): ModuleServiceCaller {
  return async (method, params) => {
    const windowApi = api ?? (typeof window === 'undefined' ? undefined : window.api)
    if (typeof windowApi?.studioWindowTicket !== 'function')
      return moduleServiceRefusal(method, 'unavailable', 'This window has no Studio connection.')
    let client: StudioClient
    try {
      client = await windowStudioClient(windowApi)
    } catch (error) {
      return moduleServiceRefusal(method, 'unavailable', refusalOf(error).message)
    }
    return callModuleService(client, method, params)
  }
}
