// What the tailnet transport says it is, as this phone keeps it. No
// react-native import, so `node --test` can pin it.
//
// The desktop's gateway carries `transportVersion` on `/tailnet/v1/health`
// (unauthenticated), `/tailnet/v1/identity` and the `/tailnet/v1/pair` answer
// (tailnet-routes.ts, TAILNET_TRANSPORT_VERSION). This phone shows it on the
// desktop's detail screen and judges nothing by it: what a desktop serves,
// and whether the two are in step, come from its Studio protocol's welcome
// (`desktopStudio.ts`, `chatOffers.ts`). A desktop from before transport 3
// serves no Studio protocol, which the phone's connection says in words.

/** What a gateway declared, as stored on the session. Absent means a Studio that declared nothing. */
export interface TailnetTransportDeclaration {
  transportVersion: number | null;
}

/** Reads the declaration out of any gateway answer that may carry one: pair, identity, health. */
export function readTransportDeclaration(body: unknown): TailnetTransportDeclaration {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { transportVersion: null };
  const version = (body as Record<string, unknown>).transportVersion;
  return {
    transportVersion: typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : null,
  };
}

/** The transport line on the desktop's detail screen. */
export function describeTransport(session: { tailnetTransportVersion?: number }): string {
  return typeof session.tailnetTransportVersion === "number" ? `tailnet v${session.tailnetTransportVersion}` : "tailnet, version not declared";
}

/**
 * The session with a fresh declaration folded in, or null when nothing moved —
 * so a foreground re-read that finds the same Studio writes nothing to storage.
 */
export function withTransportDeclaration<T extends { tailnetTransportVersion?: number }>(
  session: T,
  declaration: TailnetTransportDeclaration,
): T | null {
  const nextVersion = declaration.transportVersion ?? session.tailnetTransportVersion;
  if (nextVersion === session.tailnetTransportVersion) return null;
  const next = { ...session };
  if (nextVersion !== undefined) next.tailnetTransportVersion = nextVersion;
  return next;
}

/**
 * The session with the desktop's machine mark folded in, or null when it is
 * the one already held. A Studio that answered without one has none: the
 * stored mark is dropped rather than kept, so a mark is never older than the
 * desktop's last word on it.
 */
export function withMachineMark<T extends { machineMark?: { kind: string; color: string } }>(
  session: T,
  machine: { kind: string; color: string } | null,
): T | null {
  const held = session.machineMark;
  if (!machine && !held) return null;
  if (machine && held && machine.kind === held.kind && machine.color === held.color) return null;
  const next = { ...session };
  if (machine) next.machineMark = { kind: machine.kind, color: machine.color };
  else delete next.machineMark;
  return next;
}

/**
 * The session with the desktop's environment id folded in, or null when it is
 * the one already held or the identity said none. An id once said is kept
 * when a later answer says none (a Studio rolled back to a build before ids):
 * the id names the data directory, which a downgrade does not change.
 */
export function withEnvironmentId<T extends { environmentId?: string }>(session: T, environmentId: string | null): T | null {
  if (!environmentId || environmentId === session.environmentId) return null;
  return { ...session, environmentId };
}

/**
 * Why a desktop refused a valid device token, when the refusal was about the
 * tailnet node presenting it rather than the token itself.
 *
 * Studio holds a device token to the Tailscale node it was paired from, and
 * asks `tailscale whois` on every authenticated call. Both refusals are a 401
 * with `{ error: { code, message } }`, which a build that read every 401 as
 * "revoked" turned into a pairing it threw away:
 *
 * - `peer_unverified`: whois could not say which node is calling (Tailscale
 *   restarting, the CLI slow to answer). The desktop retries the lookup within
 *   seconds, so this is a pause, never a revocation.
 * - `peer_mismatch`: the token reached the desktop from another node, which
 *   is what a phone whose Tailscale was reinstalled or signed in afresh looks
 *   like. The token will never work from here again; pairing again is the
 *   fix, but nothing was revoked.
 *
 * Null for any other answer, including a plain 401, which is still a token the
 * desktop no longer knows.
 */
export type TailnetPeerRefusal = { code: "peer_unverified" | "peer_mismatch"; message: string };

export const PEER_UNVERIFIED_SENTENCE =
  "The desktop could not confirm through Tailscale that this is the paired phone. It will try again; check that Tailscale is running on both devices.";
export const PEER_MISMATCH_SENTENCE =
  "The desktop paired this phone as a different Tailscale device, so it no longer accepts it from this one. Pair again to continue.";

export function readPeerRefusal(status: number, body: unknown): TailnetPeerRefusal | null {
  if (status !== 401 || !body || typeof body !== "object" || Array.isArray(body)) return null;
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>).code;
  if (code === "peer_unverified") return { code, message: PEER_UNVERIFIED_SENTENCE };
  if (code === "peer_mismatch") return { code, message: PEER_MISMATCH_SENTENCE };
  return null;
}
