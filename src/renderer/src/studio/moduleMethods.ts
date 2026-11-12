import { STUDIO_MODULES_CAPABILITY } from '../../../../packages/studio-protocol/src/public'
import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import type { ModuleCallAnswer, ModuleMethodContract } from '../../../shared/modules/methods'
import type { ModuleMethodCall, ModuleMethodCaller } from '../modules/renderer-host'
import { windowStudioClient } from './windowStudioClient'

// A module's renderer half calls its own declared methods over the window's
// Studio connection: `module.read` for a read, `module.operate` for an
// operate (under the caller's command id, or one made for the call). The
// answer is the module's own, or the refusal Studio or the connection gave:
// a module renderer never sees a throw.

type Answer = ModuleCallAnswer<ModuleMethodContract>

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function refusal(error: unknown): Answer {
  const code = (error as { code?: unknown } | null)?.code
  return {
    ok: false,
    code: typeof code === 'string' && code ? code : 'unavailable',
    message: error instanceof Error ? error.message : String(error),
  }
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
