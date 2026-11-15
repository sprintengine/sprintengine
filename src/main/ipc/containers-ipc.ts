import type { IpcMain } from 'electron'

import { CONTAINER_CHANNELS, parseContainerHost } from '../../shared/containers'
import type { ContainerChats } from '../environments/container/container-chats'

// The renderer's way to chats' containers (docs/design/container-chats.md).
// Every payload is checked here: hosts, folders and ids come from a window,
// which is trusted with nothing more than asking.

function idOf(payload: unknown): string | null {
  const id = (payload as { id?: unknown } | null)?.id
  return typeof id === 'string' && /^[a-f0-9]{16}$/u.test(id) ? id : null
}

const noHost = { ok: false as const, message: 'Which machine the container is on was not said.' }

export function registerContainersIpc(ipcMain: IpcMain, containers: ContainerChats): () => void {
  const handle = (channel: string, run: (payload: unknown) => unknown) =>
    ipcMain.handle(channel, (_event, payload) => run(payload))
  handle(CONTAINER_CHANNELS.status, (payload) => {
    const host = parseContainerHost((payload as { host?: unknown } | null)?.host)
    return host
      ? containers.status(host)
      : { state: 'unreachable', words: noHost.message, imageReady: false, canStart: null }
  })
  handle(CONTAINER_CHANNELS.start, (payload) => {
    const host = parseContainerHost((payload as { host?: unknown } | null)?.host)
    return host
      ? containers.startDocker(host)
      : { state: 'unreachable', words: noHost.message, imageReady: false, canStart: null }
  })
  handle(CONTAINER_CHANNELS.create, (payload) => {
    const record = (payload ?? {}) as Record<string, unknown>
    const host = parseContainerHost(record.host)
    if (!host) return noHost
    const folder = record.folder
    if (folder !== null && (typeof folder !== 'string' || !folder.trim() || folder.includes('\0')))
      return { ok: false, message: 'The project folder was not said.' }
    return containers.create({
      host,
      folder: typeof folder === 'string' ? folder : null,
      label: typeof record.label === 'string' ? record.label : '',
      image: { kind: 'studio-default' },
    })
  })
  handle(CONTAINER_CHANNELS.list, () => containers.list())
  handle(CONTAINER_CHANNELS.remove, (payload) => {
    const id = idOf(payload)
    if (id) return containers.remove({ id })
    const record = (payload ?? {}) as Record<string, unknown>
    const host = parseContainerHost(record.host)
    if (!host || typeof record.name !== 'string') return { ok: false, message: 'That container is not one of yours.' }
    return containers.remove({ host, name: record.name })
  })
  handle(CONTAINER_CHANNELS.push, (payload) => {
    const id = idOf(payload)
    return id ? containers.push(id) : { ok: false, message: 'That container is not one of yours.' }
  })
  return () => {
    for (const [key, channel] of Object.entries(CONTAINER_CHANNELS))
      if (key !== 'changed') ipcMain.removeHandler(channel)
  }
}
