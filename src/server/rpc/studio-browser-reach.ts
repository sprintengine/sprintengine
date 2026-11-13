import {
  STUDIO_TERMINAL_HANDOFF_CAPABILITY,
  STUDIO_TERMINALS_CAPABILITY,
} from '../../../packages/studio-protocol/src/public'

// A browser never reaches this machine's terminals, an owner's own tab
// included: a terminal is a shell on the machine, served to Studio's own
// windows and the owner's credential only. The grant cannot say it (an
// owner's tab holds an owner's grant), so the connection does: the router and
// the connection refuse a browser's terminal methods and streams, and Resume
// in terminal (`session.terminalHandoff`), which starts one on this machine;
// its welcome offers neither capability.

export const BROWSER_NO_TERMINALS = 'A browser never reaches this machine’s terminals.'

const TERMINAL_CAPABILITIES: ReadonlySet<string> = new Set([
  STUDIO_TERMINALS_CAPABILITY,
  STUDIO_TERMINAL_HANDOFF_CAPABILITY,
])

/** Whether a method or stream is one a browser connection is refused. */
export function refusedToBrowser(
  spec: { capability?: string | null } | undefined,
  browser: boolean | undefined,
): boolean {
  return browser === true && typeof spec?.capability === 'string' && TERMINAL_CAPABILITIES.has(spec.capability)
}

/** The capabilities a browser connection's welcome offers. */
export function browserCapabilities(capabilities: readonly string[]): string[] {
  return capabilities.filter((capability) => !TERMINAL_CAPABILITIES.has(capability))
}

// What the table holds to Studio's own desktop windows (`window`): a method
// whose answer carries a credential, or that lets someone reach this machine
// from elsewhere. A window's connection is one the window listener admitted
// with a ticket main minted for one of its windows (`windowKey`); everything
// else is refused, an owner's web tab (a browser, whatever its session), a
// script or app holding the owner's credential, and the shell included.

export const WINDOW_ONLY = 'This is served only to Studio’s own desktop windows.'

/** Whether a method or stream the table holds to Studio's own windows is refused to this connection. */
export function refusedOutsideWindow(
  spec: { window?: string } | undefined,
  who: { ownWindow?: boolean; windowKey?: string; browser?: boolean },
): boolean {
  if (typeof spec?.window !== 'string') return false
  return !(who.ownWindow === true && who.windowKey !== undefined && who.browser !== true)
}
