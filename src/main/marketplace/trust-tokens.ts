import { randomBytes } from 'node:crypto'

import type { MarketplaceTrustPin } from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'

// The trust decision a person takes at an install prompt, held in main.
//
// The prompt used to answer with a boolean the renderer sent back
// (`trustGranted: true`) beside a registry entry the renderer also sent back,
// so anything that could reach the IPC could install any entry it liked by
// saying yes on somebody's behalf. Now `verify` is the only thing that can say yes: it
// resolves the entry itself, discloses what it found, and hands the renderer
// an opaque token naming that entry and a pin of the exact content disclosed.
// The install spends the token. It is one-time, expires, and never leaves
// this process, so the renderer can carry the decision but never forge it.

export type TrustPin = MarketplaceTrustPin

export type TrustGrant = {
  entryId: string
  pin: TrustPin
  // The entry the disclosure was read from, resolved in main from the app's
  // registry. The install uses this rather than reading the registry again,
  // so a registry refresh between the prompt and the click cannot change what
  // gets installed.
  entry?: MarketplacePluginEntry
}

export type IssueTrustTokenInput = TrustGrant

export const TRUST_TOKEN_TTL_MS = 10 * 60 * 1000

export type TrustTokenStore = {
  issue(input: IssueTrustTokenInput): string
  // Spends the token: whatever the answer, the token is gone afterwards. A
  // token presented for a different entry than it was issued for is burned
  // too — a mismatch is a caller that should not have had it.
  consume(token: string, entryId: string): TrustGrant | null
}

export function createTrustTokenStore(options: { now?: () => number; ttlMs?: number } = {}): TrustTokenStore {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? TRUST_TOKEN_TTL_MS
  const tokens = new Map<string, { grant: TrustGrant; expiresAt: number }>()

  function prune(): void {
    const at = now()
    for (const [token, held] of tokens) if (held.expiresAt <= at) tokens.delete(token)
  }

  function live(token: string): { grant: TrustGrant; expiresAt: number } | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const held = tokens.get(token)
    if (!held) return null
    if (held.expiresAt <= now()) {
      tokens.delete(token)
      return null
    }
    return held
  }

  return {
    issue(input) {
      prune()
      const token = randomBytes(32).toString('base64url')
      tokens.set(token, {
        grant: {
          entryId: input.entryId,
          pin: { ...input.pin, componentDigests: { ...input.pin.componentDigests } },
          ...(input.entry ? { entry: input.entry } : {}),
        },
        expiresAt: now() + ttlMs,
      })
      return token
    },
    consume(token, entryId) {
      const held = live(token)
      if (!held) return null
      tokens.delete(token)
      return held.grant.entryId === entryId ? held.grant : null
    },
  }
}

// Whether the content an install staged is the content the prompt disclosed:
// the digests are compared, never where the content came from.
export function trustPinsMatch(disclosed: TrustPin, staged: TrustPin): boolean {
  if (disclosed.manifestSha256 !== staged.manifestSha256) return false
  const a = Object.entries(disclosed.componentDigests)
  const b = staged.componentDigests
  if (a.length !== Object.keys(b).length) return false
  return a.every(([path, digest]) => b[path] === digest)
}

// One store per main process: a token is only ever spent by the process that
// issued it.
const processStore = createTrustTokenStore()

export function issueTrustToken(input: IssueTrustTokenInput): string {
  return processStore.issue(input)
}

export function consumeTrustToken(token: string, entryId: string): TrustGrant | null {
  return processStore.consume(token, entryId)
}
