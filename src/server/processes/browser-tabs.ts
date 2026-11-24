import type { StudioBrowserTab } from '../../../packages/studio-protocol/src/public'

// The built-in browser's tabs, as the server serves them (`browserTabs.*`).
// The browser is the desktop shell's (its pages are Electron guests), so the
// server only carries what the shell says: in process the shell's browser
// manager is handed in directly; out of process the server asks the shell
// over its control channel (`SHELL_METHODS.browserTabs*`).

export type StudioBrowserTabs = {
  /** Every tab open in the built-in browser, the longest-open first. */
  list(): Promise<StudioBrowserTab[]>
  /** Close a tab as its pane's close button does; false when there was none, or no window took it. */
  close(tabId: string): Promise<boolean>
}

/**
 * A page's address as a connection other than an owner's reads it: its
 * scheme, host and path, without what rides in the rest (a query's tokens, a
 * fragment's, a userinfo's password). What is not an address is left out.
 */
export function addressWithoutSecrets(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'about:' || parsed.protocol === 'data:') return `${parsed.protocol}`
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return ''
  }
}

/**
 * The tabs as one connection reads them. Every title goes through that
 * connection's redaction, as a chat's text does; a connection that is not an
 * owner's reads each address without its query, fragment or userinfo.
 */
export function tabsForReader(
  tabs: readonly StudioBrowserTab[],
  reader: { owner: boolean; redact: <T>(value: T) => T },
): StudioBrowserTab[] {
  return tabs.map((tab) => ({
    ...tab,
    title: reader.redact(tab.title),
    url: reader.owner ? tab.url : addressWithoutSecrets(tab.url),
  }))
}
