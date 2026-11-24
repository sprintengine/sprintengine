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
