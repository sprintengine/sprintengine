import { ControlRpcError, type ControlRpc } from '../bootstrap/control-rpc'
import type { StudioContainersCall, StudioContainersDomain } from '../rpc/studio-containers'
import { SERVER_EVENTS, SHELL_METHODS } from './server-methods'

// The desktop's server in a process of its own serves `containers.*` by asking
// main, which runs Docker and holds the SSH sessions and the keychain
// (`serveContainersToServer`, main/environments/container/containers-domain.ts):
// one control-channel call per domain call, and main's word that something
// changed for the `containers.changed` stream.

/**
 * How long each call may take. A create, push or remove is a mutation, which a
 * client waits on however long it takes: a first image build and the copy take
 * many minutes. The status and the list are reads, which a client gives up on
 * after a minute (the client runtime's read timeout): their budget here is
 * under it, so a slow host is said in these words rather than the client's
 * "did not answer in time". Main's own probes are bounded at 30 s
 * (`ContainerChats`' timing), a passphrase asked within them.
 */
export const CONTAINER_CALL_TIMEOUT_MS: Record<StudioContainersCall, number> = {
  status: 50_000,
  startDocker: 10 * 60_000,
  create: 90 * 60_000,
  list: 50_000,
  push: 20 * 60_000,
  remove: 10 * 60_000,
  tokenStatus: 30_000,
  setToken: 30_000,
  clearToken: 30_000,
}

export function shellContainersDomain(rpc: Pick<ControlRpc, 'call' | 'on'>): StudioContainersDomain {
  const ask = <T>(call: StudioContainersCall, args: Record<string, unknown> = {}): Promise<T> =>
    rpc
      .call<T>(SHELL_METHODS.containers, { call, args }, { timeoutMs: CONTAINER_CALL_TIMEOUT_MS[call] })
      .catch((error: unknown) => {
        if (error instanceof ControlRpcError && error.code === 'timeout')
          throw new Error('Docker did not answer in time. See Settings › Machines › Containers.')
        throw error
      })
  return {
    status: (host) => ask('status', { host }),
    startDocker: (host) => ask('startDocker', { host }),
    create: (request, commandId) => ask('create', { ...request, commandId }),
    list: () => ask('list'),
    push: (id, commandId) => ask('push', { id, commandId }),
    remove: (target, commandId) => ask('remove', { ...target, commandId }),
    tokenStatus: () => ask('tokenStatus'),
    setToken: (token) => ask('setToken', { token }),
    clearToken: () => ask('clearToken'),
    onChanged: (listener) => rpc.on(SERVER_EVENTS.containersChanged, () => listener()),
  }
}
