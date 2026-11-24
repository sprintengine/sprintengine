import type { ControlRpc } from '../bootstrap/control-rpc'
import { SHELL_METHODS } from '../desktop/server-methods'
import { isExtensionOpenRequest, type ExtensionOpener, type ExtensionOpenRequest } from '../../shared/extension-open'
import { readExtensionOpenOutcome } from '../../shared/extension-open-ipc'

// `extension.open`'s window half across the control channel, when the Studio
// server runs out of process: the windows are the desktop shell's, so the
// server asks the shell, and the shell asks its windows
// (src/main/extension-open-broker.ts). Both halves are here, so the request
// and the handler cannot drift. In process the gateway is handed the shell's
// opener itself.

/**
 * How long the server waits for the shell. The shell asks its windows one at
 * a time, a few seconds each at most, so this leaves room for several silent
 * windows before the server gives up on the shell.
 */
export const EXTENSION_OPEN_ANSWER_MS = 60_000

const NO_SHELL_MESSAGE = 'No Studio window is open on this machine: open Studio and try again.'

/** The server's half: the shell's windows, asked over the control channel. */
export function shellExtensionOpenOverControl(rpc: Pick<ControlRpc, 'call'> | null): ExtensionOpener {
  return async (request) => {
    // A server with no shell (a headless one) has no window to show it in.
    if (!rpc) return { ok: false, code: 'no_window', message: NO_SHELL_MESSAGE }
    const answer = await rpc
      .call(SHELL_METHODS.extensionOpen, pick(request), { timeoutMs: EXTENSION_OPEN_ANSWER_MS })
      .catch(() => null)
    // A shell that cannot be reached, or answers in a shape it should not, is
    // no window as far as the agent can tell.
    return readExtensionOpenOutcome(answer) ?? { ok: false, code: 'no_window', message: NO_SHELL_MESSAGE }
  }
}

/** The shell's half: answer the server's asks with the shell's own windows. */
export function serveExtensionOpen(rpc: Pick<ControlRpc, 'handle'>, opener: ExtensionOpener): void {
  rpc.handle(SHELL_METHODS.extensionOpen, async (params) => {
    if (!isExtensionOpenRequest(params)) {
      throw new Error('An extension is opened with its install key and at most one of a panel or a file.')
    }
    return opener(pick(params))
  })
}

/** Only the fields a window acts on, whatever else rode along. */
function pick(request: ExtensionOpenRequest): ExtensionOpenRequest {
  const { moduleId, panel, file, editor, title } = request
  return {
    moduleId,
    ...(panel !== undefined ? { panel } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(editor !== undefined ? { editor } : {}),
    ...(title !== undefined ? { title } : {}),
  }
}
