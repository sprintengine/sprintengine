import {
  EXTENSION_LINK_READY_CHANNEL,
  parseExtensionInstallLink,
  type ExtensionInstallLink,
} from '../shared/extension-install-link'

// Where an install link (`sprintengine://extensions/…`) lands: the workspace
// window that last said it is listening opens the extension's page in
// Settings → Extensions. A link that arrives with no window listening (it
// launched the app) waits for the first one. The link only ever opens the
// page; nothing here installs. Repeats of one link within a few seconds (a
// browser handing it over twice) are ignored.

const REPEAT_MS = 3_000

export type ExtensionLinkRouter<W> = {
  open(raw: string): void
  /** A window is listening: it takes a link that was waiting. */
  ready(win: W): void
  /** A window went away. */
  gone(win: W): void
}

export function createExtensionLinkRouter<W>(deps: {
  send: (win: W, link: ExtensionInstallLink) => void
  /** Bring a window forward. */
  focus: (win: W) => void
  /** No workspace window is listening: open one (it says when it is). */
  openWindow: () => void
  now?: () => number
}): ExtensionLinkRouter<W> {
  const now = deps.now ?? Date.now
  const listening: W[] = []
  let waiting: ExtensionInstallLink | null = null
  let last: { raw: string; at: number } | null = null
  return {
    open(raw) {
      if (last && last.raw === raw && now() - last.at < REPEAT_MS) return
      last = { raw, at: now() }
      const link = parseExtensionInstallLink(raw)
      const win = listening.at(-1)
      if (win === undefined) {
        waiting = link
        deps.openWindow()
        return
      }
      deps.focus(win)
      deps.send(win, link)
    },
    ready(win) {
      if (!listening.includes(win)) listening.push(win)
      if (!waiting) return
      const link = waiting
      waiting = null
      deps.focus(win)
      deps.send(win, link)
    },
    gone(win) {
      const at = listening.indexOf(win)
      if (at !== -1) listening.splice(at, 1)
    },
  }
}

type LinkContents = { on(event: 'did-navigate' | 'render-process-gone', listener: () => void): unknown }
type LinkWindow = { once(event: 'closed', listener: () => void): unknown }

/** A workspace window saying it is listening for install links, and going away. */
export function registerExtensionLinkIpc<C extends LinkContents, W extends LinkWindow>(deps: {
  ipcMain: { on(channel: string, listener: (event: { sender: C }) => void): unknown }
  router: Pick<ExtensionLinkRouter<W>, 'ready' | 'gone'>
  windowOf: (contents: C) => W | null
  isWorkspaceWindow: (contents: C) => boolean
}): void {
  const watched = new WeakSet<C>()
  deps.ipcMain.on(EXTENSION_LINK_READY_CHANNEL, (event) => {
    const contents = event.sender
    const win = deps.isWorkspaceWindow(contents) ? deps.windowOf(contents) : null
    if (!win) return
    if (!watched.has(contents)) {
      watched.add(contents)
      const gone = () => deps.router.gone(win)
      contents.on('did-navigate', gone)
      contents.on('render-process-gone', gone)
      win.once('closed', gone)
    }
    deps.router.ready(win)
  })
}
