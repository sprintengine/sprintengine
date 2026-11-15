import { ControlRpcError, type ControlRpc } from '../bootstrap/control-rpc'
import type { StudioContainersCall, StudioContainersDomain } from '../rpc/studio-containers'
import { SERVER_EVENTS, SHELL_METHODS } from './server-methods'

// The desktop's server in a process of its own serves `containers.*` by asking
// main, which runs Docker and holds the SSH sessions and the keychain
// (`serveContainersToServer`, main/environments/container/containers-domain.ts):
// one control-channel call per domain call, and main's word that something
// changed for the `containers.changed` stream.

/** How long each call may take: a first image build and the copy take many minutes. */
export const CONTAINER_CALL_TIMEOUT_MS: Record<StudioContainersCall, number> = {
  status: 2 * 60_000,
  startDocker: 10 * 60_000,
  create: 90 * 60_000,
  list: 2 * 60_000,
  push: 20 * 60_000,
  remove: 10 * 60_000,
  tokenStatus: 30_000,
  setToken: 30_000,
  clearToken: 30_000,
}

export function shellContainersDomain(rpc: Pick<ControlRpc, 'call' | 'on'>): StudioContainersDomain {
  const ask = <T>(call: StudioContainersCall, args: Record<string, unknown> = {}): Promise<T> =>
    rpc.call<T>(SHELL_METHODS.containers, { call, args }, { timeoutMs: CONTAINER_CALL_TIMEOUT_MS[call] }).catch(
      (error: unknown) => {
        if (error instanceof ControlRpcError && error.code === 'timeout')
          throw new Error('Docker did not answer in time. See Settings › Machines › Containers.')
        throw error
      },
    )
  return {
    status: (host) => ask('status', { host }),
    startDocker: (host) => ask('startDocker', { host }),
    create: (request) => ask('create', { ...request }),
    list: () => ask('list'),
    push: (id) => ask('push', { id }),
    remove: (target) => ask('remove', { ...target }),
    tokenStatus: () => ask('tokenStatus'),
    setToken: (token) => ask('setToken', { token }),
    clearToken: () => ask('clearToken'),
    onChanged: (listener) => rpc.on(SERVER_EVENTS.containersChanged, () => listener()),
  }
}
