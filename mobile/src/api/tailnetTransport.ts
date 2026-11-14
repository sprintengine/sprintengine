// What the tailnet transport says it speaks, and what this build makes of it
//. No react-native import, so `node --test` can pin it.
//
// The desktop's gateway carries `transportVersion` on `/tailnet/v1/health`
// (unauthenticated), `/tailnet/v1/identity` and the `/tailnet/v1/pair` answer
// (tailnet-routes.ts, TAILNET_TRANSPORT_VERSION). The version bumps when the
// wire changes in a way a client must know about. A desktop before the lane
// went also listed `capabilities` there; what a desktop serves now comes from
// its Studio welcome (`chatOffers.ts`), and a stored list is only shown. Neither side refuses the other over a mismatch — the list
// still draws — but the desktop's row says which side is behind, because a
// person standing at the desktop can update it and a person holding the phone
// can update the app.

/** The oldest transport this build will talk to. */
export const TAILNET_TRANSPORT_MIN = 1;

/**
 * The newest transport this build knows. 2 (2026-09-06) added the terminal
 * surface's change feed and sliced frames; the phone no longer reads either
 * (terminals left it 2026-09-29), but a version-2 Studio is still current.
 */
export const TAILNET_TRANSPORT_KNOWN = 2;

/** What a gateway declared, as stored on the session. Absent fields mean a Studio that declared nothing. */
export interface TailnetTransportDeclaration {
  transportVersion: number | null;
  capabilities: string[] | null;
}

/**
 * Reads the declaration out of any gateway answer that may carry one — pair,
 * identity, health. A missing field is null, not 0 or []: a version-1 Studio
 * sends `transportVersion: 1` and no `capabilities`, and "declared none" must
 * stay distinguishable from "declared an empty list".
 */
export function readTransportDeclaration(body: unknown): TailnetTransportDeclaration {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { transportVersion: null, capabilities: null };
  const record = body as Record<string, unknown>;
  const version = record.transportVersion;
  const capabilities = record.capabilities;
  return {
    transportVersion: typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : null,
    capabilities: Array.isArray(capabilities) ? capabilities.filter((entry): entry is string => typeof entry === "string") : null,
  };
}

/**
 * Where a desktop stands against this build.
 *
 * - `current`: inside the range this build speaks.
 * - `studio-older`: below the minimum. Nothing is refused, but what this build
 *   was written against is not there, and the desktop's row says so.
 * - `app-older`: above what this build knows. The desktop may be sending
 *   shapes this build does not read; the row says the app needs updating.
 * - `unknown`: paired before either side declared anything.
 */
export type TransportStanding = "current" | "studio-older" | "app-older" | "unknown";

export function transportStanding(session: { tailnetTransportVersion?: number }): TransportStanding {
  const version = session.tailnetTransportVersion;
  if (typeof version !== "number") return "unknown";
  if (version < TAILNET_TRANSPORT_MIN) return "studio-older";
  if (version > TAILNET_TRANSPORT_KNOWN) return "app-older";
  return "current";
}

/** The one sentence a desktop row says when the two sides are out of step; null when there is nothing to say. */
export function transportStandingSentence(standing: TransportStanding): string | null {
  switch (standing) {
    case "studio-older":
      return "This desktop's Studio is older than this app expects. Update Studio on the desktop.";
    case "app-older":
      return "This desktop's Studio is newer than this app knows. Update the app.";
    default:
      return null;
  }
}

/** The transport line on the desktop's detail screen: the version, and what it can do, in the desktop's own words. */
export function describeTransport(session: { tailnetTransportVersion?: number; tailnetCapabilities?: string[] }): string {
  const version = typeof session.tailnetTransportVersion === "number" ? `tailnet v${session.tailnetTransportVersion}` : "tailnet, version not declared";
  const capabilities = session.tailnetCapabilities;
  if (!capabilities) return version;
  return capabilities.length > 0 ? `${version} · ${capabilities.join(", ")}` : `${version} · no extras`;
}

/**
 * The session with a fresh declaration folded in, or null when nothing moved —
 * so a foreground re-read that finds the same Studio writes nothing to storage.
 */
export function withTransportDeclaration<T extends { tailnetTransportVersion?: number; tailnetCapabilities?: string[] }>(
  session: T,
  declaration: TailnetTransportDeclaration,
): T | null {
  const nextVersion = declaration.transportVersion ?? session.tailnetTransportVersion;
  const nextCapabilities = declaration.capabilities ?? session.tailnetCapabilities;
  const versionSame = nextVersion === session.tailnetTransportVersion;
  const capabilitiesSame =
    nextCapabilities === session.tailnetCapabilities ||
    (Array.isArray(nextCapabilities) &&
      Array.isArray(session.tailnetCapabilities) &&
      nextCapabilities.length === session.tailnetCapabilities.length &&
      nextCapabilities.every((entry, index) => entry === session.tailnetCapabilities?.[index]));
  if (versionSame && capabilitiesSame) return null;
  const next = { ...session };
  if (nextVersion !== undefined) next.tailnetTransportVersion = nextVersion;
  if (nextCapabilities !== undefined) next.tailnetCapabilities = nextCapabilities;
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
