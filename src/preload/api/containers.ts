import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import {
  CONTAINER_CHANNELS,
  type ContainerCreateRequest,
  type ContainerCreateResult,
  type ContainerHost,
  type ContainerResult,
  type ContainerSummary,
  type ContainerTokenStatus,
  type DockerStatus,
} from '../../shared/containers'

// Chats in containers (docs/design/container-chats.md): main runs Docker and holds their sessions.
export const containersApi = {
  containerDockerStatus: (host: ContainerHost): Promise<DockerStatus> =>
    ipcRenderer.invoke(CONTAINER_CHANNELS.status, { host }),
  containerStartDocker: (host: ContainerHost): Promise<DockerStatus> =>
    ipcRenderer.invoke(CONTAINER_CHANNELS.start, { host }),
  containerCreate: (request: ContainerCreateRequest): Promise<ContainerCreateResult> =>
    ipcRenderer.invoke(CONTAINER_CHANNELS.create, request),
  containersList: (): Promise<ContainerSummary[]> => ipcRenderer.invoke(CONTAINER_CHANNELS.list),
  containerRemove: (target: { id: string } | { host: ContainerHost; name: string }): Promise<ContainerResult> =>
    ipcRenderer.invoke(CONTAINER_CHANNELS.remove, target),
  containerPush: (id: string): Promise<ContainerResult> => ipcRenderer.invoke(CONTAINER_CHANNELS.push, { id }),
  containerTokenStatus: (): Promise<ContainerTokenStatus> => ipcRenderer.invoke(CONTAINER_CHANNELS.tokenStatus),
  containerTokenSet: (token: string): Promise<ContainerResult> =>
    ipcRenderer.invoke(CONTAINER_CHANNELS.tokenSet, { token }),
  containerTokenClear: (): Promise<ContainerResult> => ipcRenderer.invoke(CONTAINER_CHANNELS.tokenClear),
  onContainersChanged: (cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.on(CONTAINER_CHANNELS.changed, handler)
    return () => ipcRenderer.removeListener(CONTAINER_CHANNELS.changed, handler)
  },
} satisfies Partial<ElectronApi>
