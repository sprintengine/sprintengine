// The tailnet's and the mesh's wire shapes: this machine's listener (its
// paired devices, the pairing offer, requests from other machines, live
// connections), the other machines a sweep finds, the dev servers published
// on the tailnet, and the machines this Studio drives. The `tailnet.*` and
// `mesh.*` methods (`tailnet.ts`) carry them; Studio's own code re-exports
// them from `src/shared/tailnet*.ts`.
//
// No shape here carries a device token. The one credential that crosses is a
// pairing offer's code (`TailnetPairingOfferView`), answered only to Studio's
// own desktop windows.

// ── This machine's listener: its devices, offers, requests and live state ──

/**
 * Per-device scopes, mirroring the gateway's tool families.
 *
 * Read and operate are separate grants so "watch my backlog from the laptop"
 * does not carry the power to change it.
 *
 * There is no terminal tier. `terminal:observe` and `terminal:control` were
 * retired on 2026-09-29, when terminals stopped crossing the tailnet: a stored
 * device that holds them loads without them (`normalizeTailnetScopes`), and
 * nothing a device can be granted reaches a shell on this machine.
 */
export const TAILNET_SCOPES = [
  'workspace:read',
  'workspace:operate',
  'backlog:read',
  'backlog:operate',
  'conversation:read',
  'conversation:operate',
] as const

export type TailnetScope = (typeof TAILNET_SCOPES)[number]

/**
 * How a paired device came to exist (pair-from-the-scan-and-stay-paired,
 * phase 5). Recorded at mint and never changed: the answer to "what is
 * this row?" when a person cannot place a device in their list.
 *
 * - `code`: someone redeemed a carried pairing link (the QR / URL path).
 * - `approval`: a person here allowed a request from another machine; `by`
 *   is the peer node the transport proved, when whois resolved it.
 * - `agent`: an agent on this machine minted it through
 *   `tailnet.offer_pairing`; `by` is the agent's name.
 * - `reverse`: the other half of a both-ways pairing — THIS machine asked to
 *   drive another, and granted it a device here in the same exchange; `by`
 *   is that machine's name.
 * - `oauth`: an MCP client that signed in with OAuth (`tailnet-oauth.ts`) and
 *   that a person here approved; `by` is the name the client registered. It
 *   holds no device token: it is served by the OAuth access tokens its grant
 *   issues, on the MCP endpoint alone.
 * - `unknown`: a record from before origins were kept.
 */
export type TailnetDeviceOrigin = {
  kind: 'code' | 'approval' | 'agent' | 'reverse' | 'oauth' | 'unknown'
  by: string | null
}

/** A paired device, as any surface may see it. The device token is never part of this. */
export type TailnetDevice = {
  id: string
  name: string
  scopes: TailnetScope[]
  createdAt: string
  /** Last authenticated request, or null for a device that has never connected. */
  lastSeenAt: string | null
  /** Tailscale node name resolved at the last request; null when whois was unavailable. */
  lastPeerNode: string | null
  origin: TailnetDeviceOrigin
  /**
   * When an MCP client's OAuth sign-in ends (origin `oauth`): 30 days after it
   * was approved. Absent for every other device, which does not lapse, and for
   * an OAuth client still between approval and its first token.
   */
  signInEndsAt?: string
}

/** An outstanding pairing offer — what it grants and when it lapses, never the code. */
export type TailnetPairingState = {
  scopes: TailnetScope[]
  expiresAt: string
}

export type TailnetRemoteStatus = {
  /** The user's setting. False in every build until someone turns it on. */
  enabled: boolean
  running: boolean
  /** `address:port` while running, for the pairing URL. */
  endpoint: string | null
  port: number
  /** This machine's Tailscale address, or null when Tailscale is not up. */
  tailnetAddress: string | null
  /** Why the listener is not running when it was asked to be. */
  lastError: string | null
  /** Whether pairing and reachability events raise OS notifications (phase 3). Defaults on. */
  notifications: boolean
  devices: TailnetDevice[]
  pairing: TailnetPairingState | null
  /** Requests from other machines waiting to be approved or denied here. */
  pairRequests: TailnetPairRequest[]
  /**
   * Where an outside MCP client connects, and whether HTTPS is on. Optional
   * because a status from a main process built before MCP sign-in carried
   * none; a surface reads its absence as "say nothing about it".
   */
  mcp?: TailnetMcpAccess
}

/**
 * The MCP endpoint as a person gives it to an outside client (Claude Code,
 * Codex, any MCP client that signs in with OAuth): the URL, and the HTTPS front
 * door that Tailscale Serve can put before it.
 */
export type TailnetMcpAccess = {
  /** The URL to give a client, or null while the listener is not running. HTTPS when HTTPS is on. */
  url: string | null
  /** The plain-HTTP URL on the tailnet address, kept beside the HTTPS one for clients that take either. */
  httpUrl: string | null
  https: TailnetHttpsState
}

/**
 * HTTPS through Tailscale Serve. `enabled` is the person's setting; `state`
 * is what happened when it was applied, `message` why when it did not work.
 */
export type TailnetHttpsState = {
  enabled: boolean
  state: 'off' | 'starting' | 'on' | 'error'
  /** `https://<node>.<tailnet>.ts.net` while on. */
  origin: string | null
  message: string | null
}

/** What `tailnet.offerPairing` answers: the one-time code, shown once and never re-readable. */
export type TailnetPairingOfferView = {
  token: string
  scopes: TailnetScope[]
  expiresAt: string
  /** Full pairing URL when the listener is up, so a QR encodes one scannable string. */
  pairingUrl: string | null
}

/**
 * A pairing request waiting for a person to answer it on the machine being
 * driven.
 *
 * The other pairing path — a code minted here and carried to the other machine
 * — stays exactly as it was: a machine with nobody in front of it cannot
 * approve anything, which is the normal case for a server and a common one for
 * a desktop in another room. This adds a path rather than replacing one.
 */
export type TailnetPairRequest = {
  id: string
  /** The name the requesting client asked to be known by, once paired. */
  deviceName: string
  /**
   * Tailscale's name for the requesting node, or null when `whois` could not
   * resolve it. Null is shown as the bare address and marked unverified rather
   * than dropped: refusing an unresolvable peer would make the feature dead on
   * any machine without the Tailscale CLI, which is most of them.
   */
  peerNode: string | null
  /** The tailnet address the request arrived from. */
  peerAddress: string
  // The six digits the person types to allow the request are deliberately not
  // here: they are shown on the ASKING machine only, and read off that screen.
  // This record is what a status, an event and the tools carry, and a code
  // anything on this machine could read would be one nobody had to look at
  // the other screen for. The store keeps it (`TailnetPairRequestWithCode`).
  createdAt: string
  expiresAt: string
  /**
   * The scopes the asking machine asked for.
   *
   * A request, never a grant: what is actually granted is whatever the person
   * here approves, and the approving surface may tick any subset or superset of
   * this. It exists so that surface can open pre-ticked to what was asked for
   * rather than to a house default the asker never wanted — the difference
   * between answering the question that was put and answering a different one.
   *
   * An asker that names nothing (an older build, or a client that does not
   * care) is recorded as `TAILNET_LEGACY_REQUEST_SCOPES`, the same set every
   * pairing path defaulted to before this field existed.
   *
   * Optional in the TYPE, always present at runtime: this machine's store fills
   * it on every request it accepts. It is optional because a status payload
   * from a main process older than this field would not carry one, and a
   * consumer must read it as `request.requestedScopes ?? TAILNET_LEGACY_REQUEST_SCOPES`
   * rather than as an empty grant.
   */
  requestedScopes?: TailnetScope[]
  /**
   * Present when the request is an MCP client signing in with OAuth rather
   * than a Studio or a phone asking to pair. The name is the client's own
   * claim; `redirectHost` is where the approval is sent, and so who gets the
   * access. Surfaces show both as untrusted text and never as links.
   */
  oauth?: TailnetOAuthRequestView
  /** A sign-in retried from the same machine, replacing the one it left waiting. */
  retry?: true
}

/** What an approving surface shows of an OAuth sign-in (see `TailnetPairRequest.oauth`). */
export type TailnetOAuthRequestView = {
  /** The name the client gave itself. Untrusted display text. */
  clientName: string
  /**
   * Where the approval is sent. A loopback host (`localhost`, `127.0.0.1`)
   * means a client on the computer whose browser opened the sign-in page; any
   * other is a web service, and whoever runs it gets the access.
   */
  redirectHost: string
  redirectKind: 'loopback' | 'https'
  /**
   * Arrived over HTTPS through Tailscale Serve, where the machine named is the
   * one Serve reports and a program on this machine could have claimed any.
   */
  viaServe?: true
}

/**
 * What a surface learns when it answers a request: the device, and fresh status.
 *
 * `code_mismatch` carries how many tries remain; on the last one the request
 * is declined outright and the answer says so, so the card does not offer
 * another go at a request that no longer exists.
 */
export type TailnetApprovePairRequestView =
  | { ok: true; device: TailnetDevice; status: TailnetRemoteStatus }
  | {
      ok: false
      /** `approve_in_window`: an MCP client's sign-in, which only a window here may approve. */
      code: 'request_not_found' | 'code_required' | 'approve_in_window'
      message: string
      status: TailnetRemoteStatus
    }
  | {
      ok: false
      code: 'code_mismatch'
      message: string
      status: TailnetRemoteStatus
      attemptsLeft: number
      /** True when this mismatch was the last allowed and the request has been declined. */
      declined: boolean
    }

/** One inbound device's live connections, derived from open sockets — never persisted. */
export type TailnetLiveDevice = {
  deviceId: string
  deviceName: string
  /** An RPC stream is open right now. */
  connected: boolean
  /** Epoch ms of the first socket in the current connected stretch, or null. */
  connectedSince: number | null
  /**
   * Epoch ms of the last observed activity — a socket opening or closing, or
   * an authenticated HTTP call — on this device, or null.
   */
  lastActivityAt: number | null
  /**
   * Transport-proven identity of the peer holding the sockets: Tailscale's
   * name for the node when `whois` resolved it, and the address the last
   * socket arrived from. Distinct from `deviceName`, which is what the client
   * CALLED itself at pairing. No user agent or platform: nothing on this
   * transport sends one, and a field main does not hold is not reported.
   */
  peerNode: string | null
  peerAddress: string | null
}

export type TailnetLiveState = {
  /**
   * The service's monotonic change counter at the time of the read, so a
   * subscriber can drop this snapshot when a pushed payload already applied
   * is newer (the initial read resolving after a push — the mount race).
   */
  revision: number
  devices: TailnetLiveDevice[]
}

/**
 * How a pair request stopped waiting. Distinct because the surfaces say
 * different things — an answer given here, an answer nobody gave, and a
 * listener that went away underneath the request are three stories.
 */
export type TailnetPairRequestPhase = 'received' | 'approved' | 'denied' | 'expired' | 'cancelled'

export type TailnetLiveEvent =
  | { kind: 'listener'; running: true }
  /**
   * Down, with the reason when it was ASKED to be up: a port already taken
   * or an interface that vanished at boot reaches every window as this,
   * without waiting for someone to open Settings. `error` is null for a
   * stop that was requested.
   */
  | { kind: 'listener'; running: false; error: string | null }
  | {
      kind: 'pair-request'
      phase: TailnetPairRequestPhase
      requestId: string
      deviceName: string
      peerNode: string | null
      /** An MCP client signing in with OAuth rather than a machine asking to pair. */
      oauth?: true
      /** A sign-in retried from the same machine: announced already, so not notified again. */
      retry?: true
    }
  | { kind: 'device-connection'; deviceId: string; deviceName: string; connected: boolean }
  | { kind: 'devices-changed' }
  /**
   * Nothing happened: the listener as it stands, delivered when a client
   * follows `tailnet.changed`, and so again after it reconnects.
   */
  | { kind: 'current' }

export type TailnetPushPayload = {
  /**
   * Monotonically increasing per service lifetime: a subscriber applies a payload
   * only when it is newer than the last one applied, so out-of-order delivery
   * or a late initial read can never roll presence backwards.
   */
  revision: number
  event: TailnetLiveEvent
  status: TailnetRemoteStatus
  live: TailnetLiveState
}

// ── The other machines on the tailnet, as a sweep finds them ──

/**
 * What a peer's unauthenticated health endpoint says about itself.
 *
 * This is the WHOLE of what discovery learns from another machine: which
 * product answers, and which versions it speaks. Nothing about that machine,
 * its user, its workspaces, or its paired devices — the health route is written
 * to say no more, and a test pins that it does not.
 */
export type TailnetPeerStudio = {
  product: string
  transportVersion: number
  protocolVersions: string[]
}

/** A machine on this tailnet, as a connect picker shows it. */
export type TailnetPeer = {
  /** Tailscale's stable node id. Survives a rename; the display name does not. */
  id: string
  /** Short host name — what a person recognises in a picker. */
  hostName: string
  /** Full MagicDNS name when the tailnet has it enabled. */
  dnsName: string | null
  /** The tailnet address to dial. */
  address: string
  os: string | null
  /** Tailscale's own view of reachability, not ours. */
  online: boolean
  /** True for this machine; a picker lists it but never offers it as a target. */
  isSelf: boolean
  /**
   * When Tailscale last heard from this node, as an ISO string, or null.
   *
   * Tailscale's own `LastSeen`, passed through rather than interpreted: it is
   * the only last-seen a machine that has never paired with us has, so an
   * offline row can still say how long ago it was awake. Null covers a node
   * Tailscale reports without the field and the zero timestamp it writes for a
   * node it has never seen — both are "we do not know", which is a different
   * thing from "a long time ago" and must not be shown as one.
   *
   * Optional in the TYPE, always set by the scanner: a scan payload held over
   * from a build older than this field carries no `lastSeenAt` at all, and a
   * consumer must read a missing one as null rather than as a date.
   */
  lastSeenAt?: string | null
  /**
   * The Studio listener that answered the probe, or null.
   *
   * Null is "nothing answered on the probed port", which covers a peer with its
   * listener off, a peer listening on a different port, and a peer not running
   * Studio at all. Discovery cannot tell those apart and does not pretend to.
   */
  studio: TailnetPeerStudio | null
}

/** The result of one discovery sweep. */
export type TailnetPeerScan = {
  /** False when the Tailscale CLI is absent, or the daemon did not answer. */
  tailscaleAvailable: boolean
  /** Plain-language reason the sweep found nothing. Null when it succeeded. */
  unavailableReason: string | null
  /** The port probed on every peer. Peers listening elsewhere are invisible by design. */
  probedPort: number
  peers: TailnetPeer[]
}

// ── Dev servers this machine publishes on the tailnet ──

/** One published dev server. */
export type TailnetShareView = {
  /** The loopback port the dev server listens on. */
  localPort: number
  /** The HTTPS port Tailscale publishes it at. */
  servePort: number
  /** What a phone opens. */
  url: string
}

export type TailnetShareStatus = {
  /** False when Tailscale is absent, signed out, or the daemon is down. */
  available: boolean
  /** This machine's MagicDNS name, when it has one. */
  dnsName: string | null
  /** Every loopback port this machine currently publishes. */
  shares: TailnetShareView[]
  /**
   * True when the ladder is full, so the UI can explain a refusal before the
   * person triggers one.
   */
  ladderFull: boolean
}

/**
 * `share` is the mapping that now exists, and is null for an unshare — which
 * succeeds by leaving nothing behind. Callers read `status` for the new truth
 * either way.
 */
export type TailnetShareResult =
  | { ok: true; share: TailnetShareView | null; status: TailnetShareStatus }
  | { ok: false; message: string; status: TailnetShareStatus }

// ── The machines this Studio drives (the mesh) ──

/**
 * One machine this Studio is paired with.
 *
 * The device token is deliberately NOT here: it stays in the store of the
 * Studio that holds the pairing and is never answered to a client, so nothing
 * a window can read is a credential.
 */
export type MeshConnection = {
  /** Local id for this pairing record. Ours, not the remote machine's. */
  id: string
  /** What to call the machine in the UI — its tailnet host name where we could resolve one. */
  machineName: string
  /** `address:port` of that machine's listener. */
  endpoint: string
  /** The device id the remote machine issued us, so a person can match it to a row in ITS settings. */
  deviceId: string
  /** The name we paired under (this machine's name), for the same reason. */
  deviceName: string
  /** What that machine granted us. Refreshed from the remote on every browse. */
  scopes: TailnetScope[]
  pairedAt: string
  lastConnectedAt: string | null
  /**
   * How this pairing came about (pair-from-the-scan-and-stay-paired): a
   * carried link, a request someone approved over there, or the reverse half
   * of a both-ways pairing that machine asked for. `unknown` for records
   * written before this was kept.
   */
  pairedVia: 'link' | 'request' | 'reverse' | 'unknown'
  /**
   * The environment id that machine's Studio says it is (its `identity`
   * answer), kept from the first time it said one. The same whatever the
   * machine is called or whichever address reaches it; absent until a build
   * that says it has answered.
   */
  environmentId?: string
}

export type MeshPairResult = { ok: true; connection: MeshConnection } | { ok: false; code: string; message: string }

/**
 * A pairing we have ASKED for and are waiting on, as a window sees
 * it. The collect secret is not here and never leaves main.
 */
export type MeshPairRequestView = {
  requestId: string
  endpoint: string
  machineName: string
  /**
   * The six digits the person at the other machine must TYPE to allow this
   * (pair-from-the-scan-and-stay-paired, phase 2). Minted over there; shown
   * large here so it can be read out.
   */
  comparisonCode: string
  expiresAt: string
  /** True when this request also offers the other machine a device here (phase 6). */
  reverseOffered: boolean
}

/**
 * How a request THIS machine made stopped waiting, or that it still is.
 * `failed` is the one phase the other machine never said: the wait ended
 * here (the credential could not be saved, or the reverse grant could not
 * be minted) and `detail` says why.
 */
export type MeshPairRequestPhase = 'waiting' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'failed'

/**
 * Whether a paired machine answers right now (phase 4), as main last checked
 * it. `unauthorized` is the one refusal that is not "asleep": the machine
 * answered and refused our credential, so it was revoked over there.
 */
export type MeshMachineReachability = {
  connectionId: string
  machineName: string
  /** A check is in flight; `reachable` is the previous answer meanwhile. */
  checking: boolean
  reachable: boolean
  unauthorized: boolean
  /** Epoch ms of the last completed check, or null before the first. */
  checkedAt: number | null
  /** Epoch ms of the last time the machine answered, or null if it never has. */
  lastReachedAt: number | null
  /** The failure in a sentence when not reachable; null otherwise. */
  detail: string | null
}

export type MeshRequestPairingResult =
  { ok: true; request: MeshPairRequestView } | { ok: false; code: string; message: string }

/**
 * The mesh's lifecycle, on the `mesh.changed` stream.
 *
 * Distinct from a followed conversation's frame channel, which carries its
 * events to the one window that owns the pane. These are the whole-app facts
 * every window may care about — a machine paired or forgotten, answering or
 * not — pushed on one stream so chrome (the Remote glyph, toasts) never polls.
 */
export type MeshEvent =
  | { kind: 'machine-paired'; revision: number; connection: MeshConnection }
  | { kind: 'machine-forgotten'; revision: number; connectionId: string; machineName: string }
  /**
   * A paired machine said which Studio it is for the first time, or now says
   * it is another (`MeshConnection.environmentId`). Whatever lists pairings
   * by environment reads the list again.
   */
  | { kind: 'machine-identified'; revision: number; connectionId: string; environmentId: string }
  /**
   * A request this machine made to pair with another (phase 3): main owns
   * the wait, so every surface — not just the panel that asked — can show
   * the code while it waits and the answer when it lands. `connection` rides
   * on `approved`; `detail` on `failed` and `denied`.
   */
  | {
      kind: 'pair-request'
      revision: number
      phase: MeshPairRequestPhase
      request: MeshPairRequestView
      connection?: MeshConnection
      detail?: string
    }
  | ({ kind: 'machine-reachability'; revision: number } & MeshMachineReachability)
  /**
   * A paired machine said its workspace list or conversation list changed
   * (2026-09-05, the change feed). Carries nothing else: a surface that
   * shows that machine re-reads it through the mesh's browse, which is the
   * read it already knows how to do — and no longer does on a timer.
   */
  | {
      kind: 'remote-changed'
      revision: number
      connectionId: string
      machineName: string
      what: 'workspaces' | 'conversations'
    }
  /**
   * Nothing happened: the requests waiting and each machine's last
   * reachability as they stand, delivered when a client follows
   * `mesh.changed`, and so again after it reconnects.
   */
  | ({ kind: 'current' } & MeshLiveState)

/**
 * The initial read behind `mesh.changed` (`mesh.liveState`), so a window that mounts (or
 * reloads) mid-wait starts where every other window is. Carries the same
 * monotonic `revision` the events do; a subscriber keeps whichever is newer.
 */
export type MeshLiveState = {
  revision: number
  /** Requests this machine made that are still waiting to be answered. */
  requests: MeshPairRequestView[]
  /** The last reachability answer per paired machine; absent before the first check. */
  reachability: MeshMachineReachability[]
}

/**
 * What forgetting a machine did, from the Mesh's side.
 *
 * The ids are reported back rather than assumed: a caller that passed both and
 * got one null knows the other half was already gone, which is a different
 * story from "nothing happened" and the difference a row needs to explain
 * itself.
 */
export type MeshForgetMachineResult = {
  connections: MeshConnection[]
  revokedDeviceId: string | null
  forgottenConnectionId: string | null
}

/** The same, plus the fresh listener status the inbound revoke produced. */
export type TailnetForgetMachineResult = MeshForgetMachineResult & {
  status: TailnetRemoteStatus
}
