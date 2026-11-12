import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { ForeignIpcSenderError } from './ipc-sender'

// Every IPC handler main registers answers the app's own windows and nobody
// else, without each handler having to ask. `ipcMain` hears whatever holds an
// `ipcRenderer`: the app's windows, but also anything that could ever get its
// hands on one in a page that is not ours — a webview guest's preload, a
// window that navigated somewhere it should not be. A handler that reads a
// file or starts a process for whoever calls it is only as safe as the least
// trusted of those, so the check sits at registration, where no handler can
// be added without it: `handle`, `on` and their relatives are wrapped on the
// `ipcMain` instance itself, before anything registers.
//
// A refused invoke rejects (the caller learns it was refused); a refused
// message is dropped. A `once` listener or `handleOnce` handler is spent only
// by a sender it answers, so a foreign message sent first cannot use it up
// before the app's own arrives.
//
// The same wrap holds which channels may be registered at all
// (`mayRegister`): main's entry passes the IPC inventory
// (shared/ipc-inventory.ts), so a channel nobody has said is the shell's, or
// named as moving to the Studio protocol, fails the moment it registers,
// lazily registered ones included, rather than shipping as one more path.

type Trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => boolean
type Refused = (channel: string, event: IpcMainEvent | IpcMainInvokeEvent) => void
type MayRegister = (channel: string) => boolean
type Listener = (event: IpcMainEvent, ...args: any[]) => void
type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

const GUARDED = Symbol.for('sprintengine.ipcSenderGuard')

/** A registration on a channel the inventory does not list. */
export class UnlistedIpcChannelError extends Error {
  constructor(channel: string) {
    super(
      `IPC channel "${channel}" is not in src/shared/ipc-inventory.ts. A window.api domain belongs on the ` +
        "Studio protocol; a channel that is the desktop shell's own needs a row there saying why.",
    )
    this.name = 'UnlistedIpcChannelError'
  }
}

export function guardIpcSenders(
  ipcMain: IpcMain,
  isTrusted: Trusted,
  onRefused: Refused = () => {},
  mayRegister: MayRegister = () => true,
): void {
  const target = ipcMain as IpcMain & { [GUARDED]?: true }
  if (target[GUARDED]) return
  target[GUARDED] = true

  const handle = ipcMain.handle.bind(ipcMain)
  const removeHandler = ipcMain.removeHandler.bind(ipcMain)
  const on = ipcMain.on.bind(ipcMain)
  const prepend = ipcMain.prependListener.bind(ipcMain)
  const prependOnce = ipcMain.prependOnceListener.bind(ipcMain)
  const removeListener = ipcMain.removeListener.bind(ipcMain)

  // The wrapper each listener was registered as, per channel, so removing the
  // listener the caller knows removes the one ipcMain holds.
  const wrappers = new Map<string, Map<Listener, Listener[]>>()
  const remember = (channel: string, listener: Listener, wrapped: Listener) => {
    const byListener = wrappers.get(channel) ?? new Map<Listener, Listener[]>()
    wrappers.set(channel, byListener)
    byListener.set(listener, [...(byListener.get(listener) ?? []), wrapped])
  }
  // The wrapper to take off for `listener`: `exact` when the caller knows it,
  // otherwise the most recent, as EventEmitter itself removes the most recent.
  const forget = (channel: string, listener: Listener, exact?: Listener): Listener | undefined => {
    const byListener = wrappers.get(channel)
    const list = byListener?.get(listener)
    if (!byListener || !list || list.length === 0) return undefined
    const index = exact ? list.lastIndexOf(exact) : list.length - 1
    if (index < 0) return undefined
    const [wrapped] = list.splice(index, 1)
    if (list.length === 0) byListener.delete(listener)
    if (byListener.size === 0) wrappers.delete(channel)
    return wrapped
  }

  const guardedHandler = (channel: string, handler: Handler, once: boolean): Handler => {
    return (event, ...args) => {
      if (!isTrusted(event)) {
        onRefused(channel, event)
        throw new ForeignIpcSenderError()
      }
      if (once) removeHandler(channel)
      return handler(event, ...args)
    }
  }

  const guardedListener = (channel: string, listener: Listener, once: boolean): Listener => {
    const wrapped: Listener = (event, ...args) => {
      if (!isTrusted(event)) {
        onRefused(channel, event)
        return
      }
      if (once) {
        forget(channel, listener, wrapped)
        removeListener(channel, wrapped)
      }
      listener(event, ...args)
    }
    remember(channel, listener, wrapped)
    return wrapped
  }

  const listed = (channel: string): string => {
    if (!mayRegister(channel)) throw new UnlistedIpcChannelError(channel)
    return channel
  }

  target.handle = (channel, handler) => handle(listed(channel), guardedHandler(channel, handler, false))
  target.handleOnce = (channel, handler) => handle(listed(channel), guardedHandler(channel, handler, true))
  target.on = (channel, listener) => on(listed(channel), guardedListener(channel, listener, false))
  target.addListener = target.on
  target.once = (channel, listener) => on(listed(channel), guardedListener(channel, listener, true))
  // EventEmitter's own signature allows a symbol, which no renderer can send
  // on: only a string channel is a renderer's to reach.
  target.prependListener = (channel, listener) =>
    typeof channel === 'string'
      ? prepend(listed(channel), guardedListener(channel, listener, false))
      : prepend(channel, listener)
  target.prependOnceListener = (channel, listener) =>
    typeof channel === 'string'
      ? prepend(listed(channel), guardedListener(channel, listener, true))
      : prependOnce(channel, listener)
  target.removeListener = (channel, listener) => {
    const wrapped = typeof channel === 'string' ? forget(channel, listener as Listener) : undefined
    return removeListener(channel, (wrapped ?? listener) as Listener)
  }
  target.off = target.removeListener
  const removeAllListeners = ipcMain.removeAllListeners.bind(ipcMain)
  target.removeAllListeners = (channel?: string) => {
    if (channel === undefined) wrappers.clear()
    else wrappers.delete(channel)
    return removeAllListeners(channel)
  }
}
