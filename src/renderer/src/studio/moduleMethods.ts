import { STUDIO_EXTENSION_HOST_CAPABILITY } from '../../../../packages/studio-protocol/src/public'
import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import type { ModuleCallAnswer, ModuleMethodContract } from '../../../shared/modules/methods'
import type { ModuleMethodCall, ModuleMethodCaller } from '../modules/renderer-host'
import { windowStudioClient } from './windowStudioClient'
import { copy } from '../../../shared/copy'

// A module's renderer half calls its own declared methods over the window's
// Studio connection: `extension.read` for a read, `extension.operate` for an
// operate (under the caller's command id, or one made for the call). The
// answer is the module's own, or the refusal Studio or the connection gave:
// a module renderer never sees a throw.

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
  if (!client.supports(STUDIO_EXTENSION_HOST_CAPABILITY))
    return { ok: false, code: 'unavailable', message: copy.studio.moduleMethods.thisStudioDoesNotServe }
  const named = {
    moduleId: call.moduleId,
    method: call.method,
    ...(call.params === undefined ? {} : { params: call.params }),
  }
  try {
    return call.access === 'operate'
      ? await client.request('extension.operate', { ...named, commandId: call.commandId ?? randomId() })
      : await client.request('extension.read', named)
  } catch (error) {
    return refusal(error)
  }
}

/** The caller `RendererHost.methods` uses in a window: over the window's own Studio client. */
export function windowModuleMethodCaller(api?: Parameters<typeof windowStudioClient>[0]): ModuleMethodCaller {
  return async (call) => {
    const windowApi = api ?? (typeof window === 'undefined' ? undefined : window.api)
    if (typeof windowApi?.studioWindowTicket !== 'function')
      return { ok: false, code: 'unavailable', message: copy.studio.moduleMethods.thisWindowHasNoStudio }
    let client: StudioClient
    try {
      client = await windowStudioClient(windowApi)
    } catch (error) {
      return refusal(error)
    }
    return callModuleMethod(client, call)
  }
}
