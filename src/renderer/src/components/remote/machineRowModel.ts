// What a machine row says about a machine, wherever one is drawn: its short
// name and its platform word. How it stands is the environment list's
// (`src/shared/environment-status.ts`).

/**
 * The name a row shows for a machine. A tailnet FQDN
 * (`sam-macbook-air.tailabc123.ts.net`) is one machine's name plus a tail
 * that is the same on every row — it pushes the part a person reads out of a
 * narrow row and into an ellipsis. The first label is the name; anything
 * without a dotted tail is left exactly as it was typed.
 */
export function shortMachineName(name: string): string {
  const trimmed = name.trim()
  // Only a hostname is shortened, and only when the whole string is one:
  // "Sam's MacBook Air. Studio" is a typed name with a full stop in it, and
  // "100.64.0.101" is an address — a first label from either would be a lie.
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(trimmed)) return trimmed
  if (/^\d+(?:\.\d+)+$/u.test(trimmed)) return trimmed
  return trimmed.split('.')[0] ?? trimmed
}

/**
 * The platform word on a machine row's supporting line, or null.
 *
 * Four sources feed the Machines list and each spells the OS its own way —
 * Tailscale says `macOS`, `windows`, `linux`, `android`, `iOS`; a pairing
 * record may say nothing at all. This maps what we get onto the words a person
 * uses, and returns NULL rather than a guess for anything unrecognised: a row
 * reading "linux-ish" or echoing a raw `win32` says less than a row that leaves
 * the slot out and lets the name and the glyph carry it.
 */
export function platformLabel(os: string | null | undefined): string | null {
  const value = (os ?? '').trim().toLowerCase()
  if (!value) return null
  if (value.includes('mac') || value.includes('darwin') || value.includes('osx')) return 'macOS'
  if (value.includes('ios') || value.includes('iphone') || value.includes('ipad')) return 'iOS'
  // After the macOS test: "darwin" contains "win".
  if (value.includes('win')) return 'Windows'
  if (value.includes('android')) return 'Android'
  if (value.includes('linux')) return 'Linux'
  return null
}
