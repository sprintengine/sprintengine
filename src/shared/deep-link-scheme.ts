import { STUDIO_LINK_SCHEME, STUDIO_LINK_SCHEMES } from '../../packages/studio-protocol/src/chat-link'

// The URL scheme the app answers to, registered with the OS in
// `main/app-lifecycle`: the one the link grammar reads and writes
// (`packages/studio-protocol/src/chat-link.ts`), so what the OS hands over is
// what the parser takes.
export const CURRENT_DEEP_LINK_SCHEME = STUDIO_LINK_SCHEME

export const DEEP_LINK_SCHEMES = STUDIO_LINK_SCHEMES

/**
 * Arguments to relaunch with, less any link the app was opened with: on
 * Windows and Linux a link that launches the app arrives as an argument, and
 * startup has already acted on it, so a relaunch for a setting would sign in
 * or open the chat again.
 */
export function withoutDeepLinks(args: readonly string[]): string[] {
  return args.filter((arg) => !DEEP_LINK_SCHEMES.some((scheme) => arg.toLowerCase().startsWith(`${scheme}:`)))
}
