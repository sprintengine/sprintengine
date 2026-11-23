import { parseExtensionInstallLink, type ExtensionInstallLink } from '../shared/extension-install-link'

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
