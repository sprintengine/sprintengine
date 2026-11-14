import { createHash, randomBytes } from 'node:crypto'

// Every agent Studio launches is issued its own gateway token, bound to the
// conversation it belongs to, and taken back when the launch ends. The MCP
// bridge the agent's CLI starts presents it on its `sprintengine.studio/connect`,
// and the gateway takes the agent's identity from the token, never from what
// the connection declares beside it.
//
// A declared identity is only a claim: any process of this user could open the
// gateway's socket and say it is any agent. That was enough while the identity
// only labelled the audit and capped an agent's own launches, but an app's
// tools reach the conversations it started, so a claim would let any local
// agent reach tools an app offered to someone else's chat. The token is what
// a launch holds and nothing else does: it is handed to the CLI in its own
// environment (inside a WSL distribution, its startup script's, with the
// distribution's own Studio told only its digest) and is never written
// into a file or onto a command line.
//
// Tokens are kept as their SHA-256, in this process only: a restart voids
// every one, as it ends every launch. With the server in a process of its own,
// the shell's terminals outlive a server restart, so the shell tells the server
// each digest it issues and revokes, and every live one again when a server
// starts.

export type GatewayLaunchIdentity = {
  workspaceId: string
  agentId: string
  agentName?: string
  cliId?: string
}

// Issued here, by digest.
const tokens = new Map<string, GatewayLaunchIdentity>()

/**
 * Who told this process about tokens it did not issue: `shell`, the desktop
 * shell, about its terminal agents' (the server out of process); and
 * `environment-owner`, the desktop that holds this Studio, about its WSL
 * terminal agents that run here. Each issuer's tokens are kept apart, so one
 * replacing what it told never drops another's, nor a token issued here.
 */
export type LaunchTokenIssuer = 'shell' | 'environment-owner'
const imported = new Map<LaunchTokenIssuer, Map<string, GatewayLaunchIdentity>>()

function importedFrom(issuer: LaunchTokenIssuer): Map<string, GatewayLaunchIdentity> {
  let held = imported.get(issuer)
  if (!held) imported.set(issuer, (held = new Map()))
  return held
}

function lookup(key: string): GatewayLaunchIdentity | undefined {
  const own = tokens.get(key)
  if (own) return own
  for (const held of imported.values()) {
    const found = held.get(key)
    if (found) return found
  }
  return undefined
}

/**
 * A launch token issued or revoked in this process, by digest: the shell tells
 * the Studio server out of process about the terminal launches it makes, so
 * the server's gateway can prove their bridges (phase 6, 6.3). Never the token.
 */
export type LaunchTokenChange = { digest: string; identity: GatewayLaunchIdentity | null }
const listeners = new Set<(change: LaunchTokenChange) => void>()

/** Hear every issue (`identity` set) and revoke (`identity` null). Returns the unsubscribe. */
export function onGatewayLaunchTokenChange(listener: (change: LaunchTokenChange) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function announce(change: LaunchTokenChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change)
    } catch {
      // A listener's failure is not the launch's.
    }
  }
}

// A connection a token proved lives only as long as the token: when the last
// holder of a digest lets it go (revoked here, by its issuer, replaced away,
// or pushed out by the bound), every connection it proved is ended.
const endedListeners = new Set<(digest: string) => void>()

/** Hear a token stop proving anything here, by digest. Returns the unsubscribe. */
export function onGatewayLaunchTokenEnded(listener: (digest: string) => void): () => void {
  endedListeners.add(listener)
  return () => {
    endedListeners.delete(listener)
  }
}

function noteGone(key: string): void {
  if (lookup(key)) return
  for (const listener of [...endedListeners]) {
    try {
      listener(key)
    } catch {
      // One listener's failure does not keep the others' connections open.
    }
  }
}

/** Whether a token, by digest, still proves its launch here. */
export function isGatewayLaunchTokenLive(key: string): boolean {
  return lookup(key) !== undefined
}

/** Every token issued in this process, by digest: what a restarted server is told again. */
export function liveGatewayLaunchTokens(): LaunchTokenChange[] {
  return [...tokens].map(([key, identity]) => ({ digest: key, identity: { ...identity } }))
}

function bounded(held: Map<string, GatewayLaunchIdentity>): void {
  while (held.size > MAX_LIVE_TOKENS) {
    const oldest = held.keys().next().value!
    held.delete(oldest)
    if (held === tokens) announce({ digest: oldest, identity: null })
    noteGone(oldest)
  }
}

/**
 * A token `issuer` issued or revoked (the shell's terminal launches, out of
 * process; the desktop's WSL terminal agents), known here by its digest alone.
 */
export function applyGatewayLaunchTokenChange(issuer: LaunchTokenIssuer, change: LaunchTokenChange): void {
  if (!/^[0-9a-f]{64}$/.test(change.digest)) return
  const held = importedFrom(issuer)
  if (change.identity) {
    held.set(change.digest, {
      workspaceId: change.identity.workspaceId,
      agentId: change.identity.agentId,
      ...(change.identity.agentName ? { agentName: change.identity.agentName } : {}),
      ...(change.identity.cliId ? { cliId: change.identity.cliId } : {}),
    })
    bounded(held)
  } else if (held.delete(change.digest)) noteGone(change.digest)
}

/**
 * Tokens `issuer` names, by digest. `replace` first drops every token that
 * issuer told before and does not name again, so a desktop that reconnects
 * leaves none it revoked meanwhile; tokens issued here, or told by another
 * issuer, are not its to drop. Answers how many tokens the issuer holds here.
 */
export function applyGatewayLaunchTokenChanges(
  issuer: LaunchTokenIssuer,
  change: { tokens: LaunchTokenChange[]; replace?: boolean },
): number {
  const held = importedFrom(issuer)
  if (change.replace) {
    const named = new Set(change.tokens.filter((entry) => entry.identity).map((entry) => entry.digest))
    for (const key of [...held.keys()])
      if (!named.has(key)) {
        held.delete(key)
        noteGone(key)
      }
  }
  for (const entry of change.tokens) applyGatewayLaunchTokenChange(issuer, entry)
  return held.size
}

// A launch that never ends is a leak, not a security property; this bounds it.
const MAX_LIVE_TOKENS = 4096

/** A token's digest: what the issuer tells, and what a connection it proved is tied to. */
export function gatewayLaunchTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Issue a token for one launch. `token` registers one the caller already minted. */
export function issueGatewayLaunchToken(identity: GatewayLaunchIdentity, token?: string): string {
  const issued = token ?? `selaunch_${randomBytes(32).toString('base64url')}`
  const key = gatewayLaunchTokenDigest(issued)
  tokens.set(key, {
    workspaceId: identity.workspaceId,
    agentId: identity.agentId,
    ...(identity.agentName ? { agentName: identity.agentName } : {}),
    ...(identity.cliId ? { cliId: identity.cliId } : {}),
  })
  bounded(tokens)
  announce({ digest: key, identity: tokens.get(key) ?? null })
  return issued
}

/** The launch ended: its token proves nothing from now on. */
export function revokeGatewayLaunchToken(token: string | null | undefined): void {
  if (!token) return
  const key = gatewayLaunchTokenDigest(token)
  if (!tokens.delete(key)) return
  announce({ digest: key, identity: null })
  noteGone(key)
}

/** Who a token was issued to, or null for a token no live launch holds. */
export function resolveGatewayLaunchToken(token: string): GatewayLaunchIdentity | null {
  if (!token) return null
  const found = lookup(gatewayLaunchTokenDigest(token))
  return found ? { ...found } : null
}

/**
 * The launch identity a child's environment names (`SPRINTENGINE_WORKSPACE_ID`
 * and `SPRINTENGINE_AGENT_ID`, with its name and CLI), or null for a child
 * that is no agent of a conversation.
 */
export function launchIdentityOfEnv(env: Readonly<Record<string, string | undefined>>): GatewayLaunchIdentity | null {
  const workspaceId = env.SPRINTENGINE_WORKSPACE_ID?.trim()
  const agentId = env.SPRINTENGINE_AGENT_ID?.trim()
  if (!workspaceId || !agentId) return null
  const agentName = env.SPRINTENGINE_AGENT_NAME?.trim()
  const cliId = env.SPRINTENGINE_AGENT_CLI?.trim()
  return { workspaceId, agentId, ...(agentName ? { agentName } : {}), ...(cliId ? { cliId } : {}) }
}
