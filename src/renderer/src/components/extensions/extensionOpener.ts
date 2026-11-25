import type { StudioExtensionCallAnswer } from '../../../../../packages/studio-protocol/src/public'
import type { ChoiceDialogOptions, DialogChoice } from '../ui/ConfirmDialog'

// How a components panel opens a URL in the system browser. Every open, the
// frame's own `shell.openExternal` and a Link or Markdown link the window
// drew alike, is admitted by the window's Studio as the extension and this
// window (the frame's grant, its approval, who asked), asks the person first
// for a web address, and is admitted again just before it happens. The run
// ending withdraws a question it left open.

// Web addresses the person let an extension open without asking again, for
// this window's session, and only while the extension stays installed,
// switched on and approved: taken out, it asks again (`forgetAllowedHosts`).
const allowedHosts = new Map<string, Set<string>>()

export function forgetAllowedHosts(extensionKey: string): void {
  allowedHosts.delete(extensionKey)
}

export type ExtensionOpenerOptions = {
  extensionKey: string
  extensionName: string
  /** `extension.call` as the surface's frame. */
  call: (method: string, params: unknown) => Promise<StudioExtensionCallAnswer>
  dialog: () => { choose(options: ChoiceDialogOptions): Promise<DialogChoice> } | null
  /** The system browser (a web address) once admitted. */
  openWeb: (url: string) => Promise<boolean>
  /** A mail address, once admitted. */
  openMail: (url: string) => void
  /** Aborted when the run ends. */
  signal: AbortSignal
}

export type ExtensionOpener = {
  /** The frame's own open, already admitted once by the bridge. */
  openExternal(url: string): Promise<boolean>
  /** A Link or Markdown link the window drew: admitted first, as the frame's own open is. */
  openLink(url: string): Promise<boolean>
}

export function createExtensionOpener(options: ExtensionOpenerOptions): ExtensionOpener {
  const { extensionKey, signal } = options
  const admitted = async (url: string): Promise<boolean> => {
    if (signal.aborted) return false
    const answer = await options.call('shell.openExternal', { url })
    return answer.ok && !signal.aborted
  }
  const openExternal = async (url: string): Promise<boolean> => {
    if (/^mailto:/iu.test(url)) {
      if (!(await admitted(url))) return false
      options.openMail(url)
      return true
    }
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return false
    }
    let always = false
    if (!allowedHosts.get(extensionKey)?.has(target.host)) {
      const dialog = options.dialog()
      if (!dialog || signal.aborted) return false
      const choice = await dialog.choose({
        title: `${options.extensionName} wants to open ${target.host}`,
        body: url.length > 300 ? `${url.slice(0, 300)}…` : url,
        confirmLabel: 'Open',
        alternateLabel: `Always allow ${target.host}`,
        cancelLabel: 'Cancel',
        signal,
      })
      if (choice === 'cancel') return false
      always = choice === 'alternate'
    }
    if (!(await admitted(url))) return false
    if (always) {
      let hosts = allowedHosts.get(extensionKey)
      if (!hosts) allowedHosts.set(extensionKey, (hosts = new Set()))
      hosts.add(target.host)
    }
    return options.openWeb(url)
  }
  return {
    openExternal,
    openLink: async (url) => (await admitted(url)) && openExternal(url),
  }
}
