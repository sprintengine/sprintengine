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

export function registerStudioWindowTicketIpc(ipcMain: IpcMain, issuer: StudioWindowTicketIssuer): void {
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
      sender.off('did-start-navigation', navigated as never)
      if (windows.get(sender.id) === watched) windows.delete(sender.id)
      issuer.revokeWindow(watched.key)
    }
    // The top-level document is being replaced; a same-document navigation
    // (a hash change) keeps it.
    const navigated = (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (details?.isMainFrame === false || details?.isSameDocument) return
      end()
    }
    sender.on('destroyed', end)
    sender.on('render-process-gone', end)
    sender.on('did-start-navigation', navigated as never)
    return watched
  }

  ipcMain.handle(STUDIO_WINDOW_TICKET_CHANNEL, async (event: IpcMainInvokeEvent): Promise<StudioWindowTicket> => {
    assertAppSender(event)
    const origin = studioWindowOrigin(event.senderFrame?.url ?? '')
    if (!origin) throw new Error('This window has no origin Studio can admit.')
    const { key } = watch(event.sender)
    return issuer.windowTicket({ windowKey: key, origin })
  })
}
