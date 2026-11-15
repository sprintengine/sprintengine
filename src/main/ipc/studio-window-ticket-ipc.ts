import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import {
  STUDIO_WINDOW_TICKET_CHANNEL,
  studioWindowOrigin,
  type StudioWindowTicket,
} from '../../shared/studio-connection'
import { assertAppSender } from './ipc-sender'

// A Studio window's ticket for one connection to its Studio server's window
// listener. Only an app window's own top-level document is given one (the
// check every IPC that acts for the person makes), so a subframe, a webview
// guest or a page the window navigated to gets none, and the ticket is good
// only from that document's origin.
//
// Each document is a window of its own to the server: named afresh when it
// loads, and revoked the moment it goes (a navigation or reload, a crashed
// renderer, a closed window), which ends its connections there at once rather
// than whenever its sockets time out.

/** Who mints tickets: the server in this process, or the one main supervises. */
export type StudioWindowTicketIssuer = {
  windowTicket(request: { windowKey: string; origin: string }): Promise<StudioWindowTicket>
  revokeWindow(windowKey: string): void
}

type Watched = { key: string; generation: number }

/** The webContents id a window key names (`window-<id>-<generation>`), or null for a key that is not one. */
export function webContentsIdOfWindowKey(windowKey: string): number | null {
  const match = /^window-(\d+)-\d+$/.exec(windowKey)
  return match ? Number(match[1]) : null
}

/**
 * Each window document, named afresh when it loads (`window-<id>-<generation>`),
 * and `onGone` told the moment it goes: a navigation or reload, a crashed
 * renderer, a closed window. A server that keys a window's connections by
 * this name ends them then, rather than whenever their sockets time out.
 */
export function createWindowDocuments(onGone: (windowKey: string) => void): {
  /** The document's key, watched from its first ask. */
  keyOf(sender: WebContents): string
  /** Whether the key still names a live document. */
  isCurrent(sender: WebContents, windowKey: string): boolean
} {
  const windows = new Map<number, Watched>()
  let generations = 0
  function watch(sender: WebContents): Watched {
    const known = windows.get(sender.id)
    if (known) return known
    const watched: Watched = { key: '', generation: ++generations }
    watched.key = `window-${sender.id}-${watched.generation}`
    windows.set(sender.id, watched)
    const end = () => {
      sender.off('destroyed', end)
      sender.off('render-process-gone', end)
      sender.off('did-navigate', end)
      if (windows.get(sender.id) === watched) windows.delete(sender.id)
      onGone(watched.key)
    }
    // `did-navigate` is the top-level document replaced: a navigation that
    // committed, a reload included. It is not `did-start-navigation`, which
    // Electron emits before `will-navigate` (checked with this repository's
    // Electron), so it fires for a navigation the window guard then refuses,
    // and would cut a document that stays. A hash change is
    // `did-navigate-in-page` and keeps the document, as does a subframe's
    // navigation (`did-frame-navigate`).
    sender.on('destroyed', end)
    sender.on('render-process-gone', end)
    sender.on('did-navigate', end)
    return watched
  }
  return {
    keyOf: (sender) => watch(sender).key,
    isCurrent: (sender, windowKey) => windows.get(sender.id)?.key === windowKey,
  }
}

export function registerStudioWindowTicketIpc(ipcMain: IpcMain, issuer: StudioWindowTicketIssuer): void {
  const documents = createWindowDocuments((windowKey) => issuer.revokeWindow(windowKey))

  ipcMain.handle(STUDIO_WINDOW_TICKET_CHANNEL, async (event: IpcMainInvokeEvent): Promise<StudioWindowTicket> => {
    assertAppSender(event)
    const origin = studioWindowOrigin(event.senderFrame?.url ?? '')
    if (!origin) throw new Error('This window has no origin Studio can admit.')
    const windowKey = documents.keyOf(event.sender)
    const ticket = await issuer.windowTicket({ windowKey, origin })
    // The document may have gone while the server minted it (or while a
    // server still starting was waited for, when a revoke reaches nothing):
    // revoke again now the server can hear it, so the ticket is void too.
    if (!documents.isCurrent(event.sender, windowKey)) {
      issuer.revokeWindow(windowKey)
      throw new Error('This window changed while it was connecting to Studio.')
    }
    return ticket
  })
}
