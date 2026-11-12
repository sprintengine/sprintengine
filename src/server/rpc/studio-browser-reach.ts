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
