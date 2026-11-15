import {
  STUDIO_CONTAINERS_CAPABILITY,
  type ContainerCreateRequest,
  type ContainerCreateResult,
  type ContainerHost,
  type ContainerRemoveTarget,
  type ContainerResult,
  type ContainerSummary,
  type ContainerTokenStatus,
  type DockerStatus,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to chats' containers (docs/design/container-chats.md):
// `containers.*` and the `containers.changed` stream on the window's own
// Studio, an owner's, under the names the window's IPC had. Claude Code's
// token for them is served to Studio's own desktop windows only.

export type ContainersApi = {
  /** Docker on a host, in words. */
  containerDockerStatus(host: ContainerHost): Promise<DockerStatus>
  /** Start Colima on a host, where Studio can. */
  containerStartDocker(host: ContainerHost): Promise<DockerStatus>
  /** Make a container for a chat and copy its repository in; the chat then starts on it as on a machine. */
  containerCreate(request: ContainerCreateRequest): Promise<ContainerCreateResult>
  /** Every container Studio made, so none is left behind unseen. */
  containersList(): Promise<ContainerSummary[]>
  containerRemove(target: { id: string } | { host: ContainerHost; name: string; context?: string | null }): Promise<ContainerResult>
  /** Bring a container's branch out and push it from its host. */
  containerPush(id: string): Promise<ContainerResult>
  /** A container was made, removed or pushed, or one being made moved a step: list again. Kept across reconnects. */
  onContainersChanged(cb: () => void): () => void
  /** Whether Claude Code's token for chats in containers is kept (never the token itself). */
  containerTokenStatus(): Promise<ContainerTokenStatus>
  /** Keep a token from `claude setup-token`, sealed, for containers made from now on. */
  containerTokenSet(token: string): Promise<ContainerResult>
  containerTokenClear(): Promise<ContainerResult>
}

function commandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function removeTarget(
  target: { id: string } | { host: ContainerHost; name: string; context?: string | null },
): ContainerRemoveTarget {
  return 'id' in target ? { id: target.id } : { host: target.host, name: target.name, context: target.context ?? null }
}

type TicketApi = NonNullable<Parameters<typeof windowStudioClient>[0]>

/**
 * The calls over a window's Studio: this window's (`containersApi`), or, for a
 * harness that runs the window's code outside Electron, the one its ticket
 * source names.
 */
export function createContainersApi(api?: TicketApi): ContainersApi {
  const served = async () => {
    const client = await windowStudioClient(api)
    if (!client.supports(STUDIO_CONTAINERS_CAPABILITY)) throw new Error('This Studio does not make containers.')
    return client
  }
  return {
    containerDockerStatus: async (host) => (await served()).request('containers.status', { host }),
    containerStartDocker: async (host) =>
      (await served()).request('containers.startDocker', { host, commandId: commandId() }),
    containerCreate: async (request) =>
      (await served()).request('containers.create', { ...request, commandId: commandId() }),
    containersList: async () => (await (await served()).request('containers.list', {})).containers,
    containerRemove: async (target) =>
      (await served()).request('containers.remove', { ...removeTarget(target), commandId: commandId() }),
    containerPush: async (id) => (await served()).request('containers.push', { id, commandId: commandId() }),
    onContainersChanged: (cb) =>
      followWindowStudioPush({
        topic: 'containers.changed',
        params: {},
        capability: STUDIO_CONTAINERS_CAPABILITY,
        ...(api ? { api } : {}),
        onPayload: () => cb(),
        // A change itself carries nothing: the listener lists again.
        onReopen: () => cb(),
      }),
    containerTokenStatus: async () => (await served()).request('containers.tokenStatus', {}),
    containerTokenSet: async (token) => (await served()).request('containers.setToken', { token, commandId: commandId() }),
    containerTokenClear: async () => (await served()).request('containers.clearToken', { commandId: commandId() }),
  }
}

export const containersApi: ContainersApi = createContainersApi()
