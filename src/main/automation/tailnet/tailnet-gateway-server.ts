import { randomBytes } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Duplex } from 'stream'

import { isSupportedMcpProtocolVersion, SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../../shared/mcp/protocol'
import { STUDIO_MCP_SERVER_NAME } from '../../../shared/product-identity'
import { toolError, type McpConnectionContext, type McpToolRegistration } from '../../../shared/modules/mcp-tools'
import {
  createMcpDispatcher,
  type McpClientToolHooks,
  type McpToolCallEvent,
  declaredProtocolVersion,
  isRecord,
  jsonRpcErrorResponse,
  jsonRpcIdOf,
  unsupportedProtocolVersionMessage,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  type McpDispatchGate,
} from '../mcp-dispatch'
import { isAllowedTailnetBindAddress } from './tailnet-interface'
import {
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_PAIR_COLLECT_PATH,
  TAILNET_PAIR_REQUEST_PATH,
  TAILNET_CLIENT_UPDATE_MESSAGE,
  TAILNET_RETIRED_PATHS,
  TAILNET_STREAM_PATH,
  TAILNET_STUDIO_PATH,
  TAILNET_TRANSPORT_VERSION,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'
import type { TailnetOAuthStore } from './tailnet-oauth'
import {
  createTailnetOAuthHttp,
  isTailnetOAuthPath,
  type TailnetListenerKind,
  type TailnetOAuthHttp,
  type TailnetPublicOrigins,
} from './tailnet-oauth-http'
import { isTailnetAddress } from './tailnet-interface'
import type { TailnetFileUploads } from './tailnet-file-uploads'
import type { TailnetCollectOutcome, TailnetDeviceStore, TailnetPeerCheck } from './tailnet-devices'
import type { TailnetPeerResolver } from './tailnet-peer-identity'
import { acceptWebSocket, webSocketStream, type WebSocketPeer } from '../../../server/web/web-socket'
import {
  createTailnetDeviceAuthenticator,
  isDesktopWindowOrigin,
  tailnetStudioClientId,
  type TailnetStudioHost,
} from './tailnet-studio-endpoint'
import { TAILNET_PEER_REFUSED_AUDIT_TOOL } from '../gateway-audit'
import { normalizeAddress } from './tailnet-peer-identity'
import { parseTailnetEndpoint } from './tailnet-remote-client'
import { normalizeTailnetScopes, type TailnetReverseGrant } from '../../../shared/tailnet'
import { tailnetDevicePrincipal, type TailnetDevice } from '../../../shared/tailnet'
import { authorizeStudioAccess } from '../../../../packages/studio-protocol/src/permissions'
import {
  TAILNET_ROUTE_ACCESS,
  tailnetToolAccess,
  type TailnetHttpRoute,
  type TailnetUpgradeRoute,
} from './tailnet-scopes'
import {
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  encodeCloseFrame,
  encodePongFrame,
  encodeTextFrame,
  enableTcpKeepAlive,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WEBSOCKET_CLOSE_GOING_AWAY,
  WEBSOCKET_CLOSE_REVOKED,
} from './websocket-frames'

// The opt-in tailnet listener: the same ~60-tool gateway surface the local
// socket serves, reachable from another machine on the tailnet.
//
// This reverses the gateway's original loopback-only decision for the remote case only, and does so
// under the epic's constraints: bound to the Tailscale interface address and
// nothing else, off unless a person enabled it, every request carrying a device
// token the desktop minted, every remote mutation audited with the device and
// the Tailscale peer it came from. The Unix socket is untouched — local clients
// keep using it, with filesystem permissions still their whole auth model.
//
// A device token is also held to the tailnet node it was paired from: every
// authenticated route and every WebSocket upgrade goes through `admitPeer`,
// which asks whois who is calling and refuses a token presented from any other
// node. The threat model is on `verifyPeer` in `tailnet-devices.ts`.
//
// The MCP endpoint is Streamable HTTP as a stock MCP client expects it: one
// JSON-RPC message per POST, answered with one JSON object (which the
// transport allows for every request), 202 with no body for a notification, a
// session minted on `initialize` for a client of the revisions that keep one,
// and 405 for the GET stream and DELETE this server does not offer. Beside it,
// WebSockets for clients that need a persistent channel — the RPC stream
// (tool-list notifications, connection-scoped identity) and the Studio
// protocol a paired device speaks (`/tailnet/v1/studio`). No SSE and no resumption: they are advertised
// nowhere, so nothing can quietly depend on a half version.
//
// An outside MCP client that has not paired can sign in with OAuth instead
// (`tailnet-oauth-http.ts`): the 401 names where to start, the person
// approves it in the Studio window, and its access tokens open the MCP
// endpoint and nothing else.
//
// With HTTPS on, the same handlers also answer on a loopback listener that
// Tailscale Serve proxies to from https://<node>.<tailnet>.ts.net. Serve sets
// `X-Forwarded-For` to the tailnet address of the node that connected
// (replacing any the client sent), and that is the peer on that listener and
// only there: on the tailnet listener the socket's own address is the peer, as
// it always was. A process on this machine can also reach that loopback port
// and write the header itself, claiming to be any node, so the listener
// serves only what a forged node cannot use: the OAuth sign-in (which a person
// still approves in the window, and which may then name a node it did not come
// from) and the MCP endpoint for OAuth access tokens (already bound to their
// node by the token). Device tokens, pairing and streams are refused there,
// and Host is checked on every request.

export {
  TAILNET_HEALTH_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_WS_TICKET_PATH,
  TAILNET_STREAM_PATH,
  // The wire's own version lives beside the paths; re-exported here so a
  // caller that already imports the server keeps one import.
  TAILNET_TRANSPORT_VERSION,
} from './tailnet-routes'

/** The advisory connection-metadata declaration; only the stateful WebSocket can hold it. */
const CONNECT_METHOD = 'sprintengine.studio/connect'

const MAX_MCP_BODY_BYTES = 1024 * 1024
const MAX_CONTROL_BODY_BYTES = 64 * 1024
/** Long enough to open a socket, short enough that a leaked URL is worthless. */
const WS_TICKET_TTL_MS = 30_000
/** A WebSocket key as RFC 6455 has it: sixteen random bytes in base64. */
const WEBSOCKET_KEY = /^[A-Za-z0-9+/]{22}==$/u

export type TailnetGatewayServerOptions = {
  bindAddress: string
  /** 0 binds an ephemeral port; only tests use it, since a discoverable listener needs a fixed one. */
  port: number
  serverName: string
  serverVersion: string
  /**
   * This Studio's environment id (`welcome.environment.id` on the Studio
   * protocol), said on `identity` so a paired desktop knows which Studio a
   * pairing reaches, whatever the machine is called or how it is reached.
   */
  environmentId?: string
  /** The tools a connection may see, per request: client tools differ by connection. */
  resolveTools: (context?: McpConnectionContext) => McpToolRegistration[]
  /** Client tools: a stream is told alone when its list grows. */
  clientTools?: McpClientToolHooks & { track(context: McpConnectionContext, notify: () => void): () => void }
  /** The gateway's own mutation classification, so scopes cannot drift from the audit's. */
  isMutation: (toolName: string) => boolean
  devices: TailnetDeviceStore
  peers: TailnetPeerResolver
  /**
   * How a device should draw this machine (`identity`'s `machine`): the kind
   * and colour the person chose, else the defaults another desktop gives it.
   * Absent, or throwing, `identity` leaves it out and the device draws its own.
   */
  machine?: () => { kind: string; color: string } | null
  /**
   * Where the files a device sends with a message are kept: they go with the
   * device when it is removed.
   */
  fileUploads?: Pick<TailnetFileUploads, 'forgetDevice'>
  /**
   * Fired when a peer asks to pair, so the surfaces that answer these
   * can refresh without polling. It carries no detail: a listener's job is to
   * go and read the requests, not to be told about one it has not authorised.
   */
  onPairRequested?: () => void
  /**
   * An approved asker's collect carried the reverse half of a both-ways
   * pairing (phase 6): a device the asker minted for THIS machine on its own
   * listener. Only fired for a grant whose endpoint is the asker's own
   * transport-proven address — a body cannot point this machine's credential
   * store at a third party — and only on the collect that took our token,
   * so it rides on an approval a person here already gave.
   */
  onReverseGrant?: (input: { grant: TailnetReverseGrant; askerName: string; peerNode: string | null }) => void
  /**
   * Device activity, for the live-state push (remote-sessions-ux): a device's
   * RPC stream opening or closing — fired exactly once per transition, so the
   * service above derives "connected" without holding a socket reference of
   * its own — and every
   * authenticated HTTP call (`request`), which is activity on a device that
   * may hold no socket at all. Opens and requests carry the peer as the
   * transport saw it, resolved at the same point `recordSeen` is.
   */
  onActivity?: (event: TailnetGatewayActivity) => void
  onToolCall?: (event: McpToolCallEvent) => void
  now?: () => number
  log?: (message: string) => void
  /**
   * OAuth sign-in for the MCP endpoint (`tailnet-oauth.ts`). Absent, the
   * endpoint takes paired device tokens only, as it always did.
   */
  oauth?: { store: TailnetOAuthStore }
  /**
   * The origins this Studio answers to, read per request: the tailnet address
   * and its MagicDNS names, and the HTTPS origin Tailscale Serve publishes.
   * Absent, the bound tailnet address alone.
   */
  publicOrigins?: () => TailnetPublicOrigins
  /**
   * This machine's Studio server, for a paired device's socket on
   * `/tailnet/v1/studio`, read when one opens: the server is built after the
   * gateway, and a Studio without one answers the socket unavailable.
   */
  studio?: () => TailnetStudioHost | null
}

type TailnetGatewayPeer = { peerNode: string | null; peerAddress: string }

export type TailnetGatewayActivity =
  | ({ kind: 'stream'; device: TailnetDevice; open: true } & TailnetGatewayPeer)
  | { kind: 'stream'; device: TailnetDevice; open: false }
  | ({ kind: 'request'; device: TailnetDevice } & TailnetGatewayPeer)

export type TailnetGatewayServer = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  /** The address actually bound, or null while stopped. */
  address(): { address: string; port: number } | null
  /**
   * Also listen on 127.0.0.1 (an ephemeral port) for Tailscale Serve to put
   * HTTPS in front of; answers the port. Only while the tailnet listener runs.
   */
  openServeListener(): Promise<number>
  closeServeListener(): Promise<void>
  /** The loopback listener Tailscale Serve proxies to, while it is up. */
  serveAddress(): { address: string; port: number } | null
  notifyToolsListChanged(): void
  /** Live WebSocket streams, by device — diagnostics and tests. */
  streamCount(): number
}

type StreamSession = {
  socket: Duplex
  deviceId: string
  /** When it was opened, against every socket of the device (`admitDeviceSocket`). */
  opened: number
  /** Its messages read and not yet answered. */
  queued: number
  /** The device as authenticated at upgrade, for the close announcement. */
  device: TailnetDevice
  context: McpConnectionContext
  /** Ends the stream's place among the connections client tools tell about a longer list. */
  untrack?: () => void
  /** Aborted when the stream closes: what it queued is not run, and what it is running is cancelled. */
  ended: AbortController
  /** The device-budget releases of its messages still waiting their turn: let go the moment it closes. */
  waiting: Set<() => void>
}

/** A device's Studio protocol socket, for revocation, shutdown and the connected state. */
type StudioSocket = { peer: WebSocketPeer; deviceId: string; opened: number }

/**
 * Sockets one device may hold at once, its Studio sockets and its tool
 * streams together: one budget, so neither route opens around it. A paired
 * desktop holds one Studio socket per window that reads this machine (each
 * window has its own client: the band, its open chats, a diff window), and
 * its server one more; a window lets its socket go after five idle minutes.
 * Past this the oldest goes, of either kind, for a client that leaks them or
 * a phone's half-open socket. At eight, a ninth window evicted the first,
 * whose reconnect evicted the next, round and round.
 */
export const MAX_SOCKETS_PER_DEVICE = 32

/** Unspent upgrade tickets one device may hold; asking for another lets its oldest go. */
export const MAX_TICKETS_PER_DEVICE = 32

/**
 * A tool stream's messages read and not yet answered. They are answered one
 * at a time, in order; a client that sends faster than that is closed, rather
 * than queued for without end.
 */
export const MAX_STREAM_QUEUED_MESSAGES = 64

/**
 * Requests one device may have waiting or running at once, over its tool
 * streams and Studio sockets together. Work lasts only as long as the
 * connection that asked for it: one that closes drops what it had waiting and
 * cancels what it was running. A running request that has not stopped yet
 * still counts here, so a device that closes and reopens its sockets cannot
 * pile up work past this.
 */
export const MAX_DEVICE_OUTSTANDING_REQUESTS = 128

/** JSON-RPC's server-defined range: the device has too many requests waiting or running. */
const JSONRPC_DEVICE_BUSY = -32000

/** What a tool stream may have waiting to be written to a client that is not reading, before it is closed. */
export const MAX_STREAM_UNSENT_BYTES = 8 * 1024 * 1024

/**
 * The largest answer a device is sent, on the MCP endpoint or a tool stream:
 * one larger is answered with an error instead. The files a tool reads are
 * bounded where they are read; this bounds what any tool answers.
 */
export const MAX_DEVICE_ANSWER_BYTES = 8 * 1024 * 1024

const DEVICE_BUSY_MESSAGE =
  'This device has too many requests waiting or running. Try again when some have been answered.'

/** How long a closed tool stream waits for its client to close too before it is destroyed. */
const STREAM_CLOSE_GRACE_MS = 1_000

/** RFC 6455 §7.4.1: the endpoint is closing because the peer broke its policy. */
const WEBSOCKET_CLOSE_POLICY = 1008

export function createTailnetGatewayServer(options: TailnetGatewayServerOptions): TailnetGatewayServer {
  const now = options.now ?? (() => Date.now())
  let server: Server | null = null
  let serveServer: Server | null = null
  let unsubscribeRevocations: (() => void) | null = null
  const streams = new Set<StreamSession>()
  // `origin`: the one a desktop window's Studio socket will say, named when
  // the ticket was asked for; null for every other socket, which says none.
  const tickets = new Map<string, { deviceId: string; expiresAtMs: number; origin: string | null }>()
  const studioSockets = new Set<StudioSocket>()
  // Each device's requests waiting or running, on every route (MAX_DEVICE_OUTSTANDING_REQUESTS).
  const deviceWork = new Map<string, number>()
  // Each socket's place in its device's budget: newer is larger.
  let socketsOpened = 0
  // Streamable HTTP sessions of the revisions that keep one (2025-03-26 to
  // 2025-11-25), minted on `initialize`. A session holds one connection
  // context, so a client's `notifications/cancelled` finds the call it names;
  // it is a device's and no other's.
  const mcpSessions = new Map<string, { deviceId: string; context: McpConnectionContext; lastUsedAt: number }>()

  function boundOrigins(): TailnetPublicOrigins {
    const bound = server?.address()
    if (!bound || typeof bound !== 'object') return { tailnet: [], serve: null }
    const host = bound.address.includes(':') ? `[${bound.address}]` : bound.address
    return { tailnet: [`http://${host}:${bound.port}`], serve: null }
  }

  const oauthHttp: TailnetOAuthHttp | null = options.oauth
    ? createTailnetOAuthHttp({
        store: options.oauth.store,
        devices: options.devices,
        origins: options.publicOrigins ?? boundOrigins,
        onPairRequested: () => options.onPairRequested?.(),
        onToolCall: options.onToolCall,
        now,
        log: options.log,
      })
    : null

  const dispatcher = createMcpDispatcher({
    serverName: options.serverName,
    serverVersion: options.serverVersion,
    resolveTools: options.resolveTools,
    ...(options.clientTools ? { clientTools: options.clientTools } : {}),
    onToolCall: options.onToolCall,
  })

  async function start(): Promise<void> {
    if (server) return
    // The bind guard is the epic's hard rule and it runs BEFORE listen(), so a
    // misconfigured address can never produce even a momentarily-open port.
    if (!isAllowedTailnetBindAddress(options.bindAddress)) {
      throw new Error(
        `Refusing to bind the tailnet gateway to ${options.bindAddress || '(empty)'}: only a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48) or loopback is allowed.`,
      )
    }
    const next = createListener('tailnet')
    await listen(next, options.port, options.bindAddress)
    // Revocation must reach a device that is already mid-stream, not just its
    // next request: a live WebSocket would otherwise keep serving a device the
    // user just removed.
    // The files a removed device sent go with it, as a removed browser's do:
    // those it sent on the Studio socket are kept under its Studio client id,
    // and those it sent on the conversation lane, before that went, under
    // its bare id (a chat still naming one keeps it from the week's prune).
    const unsubscribeRevoked = options.devices.onDeviceRevoked((deviceId) => {
      closeStreamsFor(deviceId)
      try {
        options.fileUploads?.forgetDevice(tailnetStudioClientId(deviceId))
        options.fileUploads?.forgetDevice(deviceId)
      } catch (error) {
        options.log?.(`tailnet uploads of a removed device were not removed: ${message(error)}`)
      }
    })
    // A narrowed grant needs no push to the RPC stream or the Studio socket:
    // each re-reads the device on every message it answers.
    unsubscribeRevocations = unsubscribeRevoked
    server = next
  }

  function createListener(via: TailnetListenerKind): Server {
    const next = createServer((request, response) => {
      void handleRequest(request, response, via).catch((error) => {
        options.log?.(`tailnet gateway request failed: ${message(error)}`)
        writeJson(response, 500, { error: { code: 'internal_error', message: 'The request could not be completed.' } })
      })
    })
    next.on('upgrade', (request, socket, head) => {
      void handleUpgrade(request, socket, head, via).catch((error) => {
        options.log?.(`tailnet gateway upgrade failed: ${message(error)}`)
        rejectUpgrade(socket, 500, 'internal_error')
      })
    })
    return next
  }

  async function listen(next: Server, port: number, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        next.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        next.removeListener('error', onError)
        resolve()
      }
      next.once('error', onError)
      next.once('listening', onListening)
      next.listen(port, host)
    })
    next.on('error', (error) => options.log?.(`tailnet gateway server error: ${error.message}`))
  }

  async function openServeListener(): Promise<number> {
    if (!server) throw new Error('The tailnet listener is not running.')
    const bound = serveServer?.address()
    if (bound && typeof bound === 'object') return bound.port
    const behindServe = createListener('serve')
    await listen(behindServe, 0, '127.0.0.1')
    serveServer = behindServe
    const address = behindServe.address()
    return address && typeof address === 'object' ? address.port : 0
  }

  async function closeServeListener(): Promise<void> {
    const current = serveServer
    serveServer = null
    if (!current) return
    await new Promise<void>((resolve) => {
      current.close(() => resolve())
      current.closeIdleConnections?.()
    })
  }

  async function stop(): Promise<void> {
    const current = server
    if (!current) return
    server = null
    const behindServe = serveServer
    serveServer = null
    mcpSessions.clear()
    unsubscribeRevocations?.()
    unsubscribeRevocations = null
    tickets.clear()
    for (const stream of [...streams]) {
      // Send the close frame, then destroy rather than waiting for the peer's
      // reply: a client that never answers must not be able to hang shutdown.
      closeStream(stream, WEBSOCKET_CLOSE_GOING_AWAY, 'Server stopping.')
      stream.socket.destroy()
    }
    streams.clear()
    // The listener is going, not the Studio: a device's client comes back
    // when the listener does, and resumes by its cursors.
    for (const studio of [...studioSockets]) studio.peer.close(WEBSOCKET_CLOSE_GOING_AWAY, 'Server stopping.')
    studioSockets.clear()
    await Promise.all(
      [current, behindServe].map((listener) =>
        listener
          ? new Promise<void>((resolve) => {
              listener.close(() => resolve())
              listener.closeIdleConnections?.()
            })
          : Promise.resolve(),
      ),
    )
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    via: TailnetListenerKind,
  ): Promise<void> {
    // Any `Origin` means a browser made this request. No client of this
    // transport is a browser, and a page on a tailnet machine must not be able
    // to drive the gateway through a user's browser (DNS-rebinding class).
    // Refusing outright is the honest rule; there is no origin to allow.
    // Behind Tailscale Serve, only a node on this tailnet is served. Serve
    // marks a request that came in through Funnel (from the internet), and
    // one with no tailnet address behind it came from this machine or from
    // nowhere Serve knows: neither is a caller this listener is for.
    const behindServe = via === 'serve' ? serveRefusal(request) : null
    if (behindServe) {
      writeJson(response, 403, { error: behindServe })
      return
    }
    // The loopback listener behind Serve is for MCP clients signing in with
    // OAuth and nothing else. Anything on this machine can reach it and write
    // the forwarded address itself, so it must open nothing a forged node
    // could use: no device tokens (their node binding is the whole point of
    // them), no pairing, no streams. What is left is a sign-in a person still
    // has to approve, and access tokens, which are bound already.
    if (via === 'serve') {
      const servedPath = pathOf(request.url)
      if (!oauthHttp || !oauthHttp.originFor(request, 'serve')) {
        writeJson(response, 421, {
          error: { code: 'host_not_allowed', message: 'This Studio does not answer to that host name here.' },
        })
        return
      }
      if (!isTailnetOAuthPath(servedPath) && !(servedPath === TAILNET_MCP_PATH && request.method === 'POST')) {
        writeJson(response, 404, {
          error: {
            code: 'not_served_over_https',
            message:
              'Over HTTPS this Studio serves MCP sign-in and the MCP endpoint only. Paired apps use its tailnet address.',
          },
        })
        return
      }
    }
    if (request.headers.origin) {
      writeJson(response, 403, {
        error: {
          code: 'origin_not_allowed',
          message: 'Browser-originated requests are not accepted on this transport.',
        },
      })
      return
    }
    const path = pathOf(request.url)
    const method = request.method ?? 'GET'
    const peerAddress = peerAddressOf(request, via)

    // A route transport 3 took away is asked for only by a build from before
    // it: it is told to update, whoever it is, before any credential is read.
    if (TAILNET_RETIRED_PATHS.has(path)) {
      writeJson(response, 426, { error: { code: 'client_update_required', message: TAILNET_CLIENT_UPDATE_MESSAGE } })
      return
    }

    if (method === 'GET' && path === TAILNET_HEALTH_PATH) {
      // Unauthenticated on purpose: peer discovery probes it to learn
      // that a machine speaks this transport. It therefore says only what a
      // prospective client must know to talk, and nothing about this machine,
      // its user, its workspaces, or whether any device is paired.
      writeJson(response, 200, {
        product: STUDIO_MCP_SERVER_NAME,
        transportVersion: TAILNET_TRANSPORT_VERSION,
        protocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      })
      return
    }

    // OAuth's discovery documents, registration, sign-in page and token
    // endpoint: before the auth gate, since they are how a client without a
    // credential gets one.
    if (
      oauthHttp &&
      (await oauthHttp.handle(request, response, {
        via,
        peerAddress,
        identify: () => options.peers.identify(peerAddress),
      }))
    )
      return

    if (method === 'POST' && path === TAILNET_PAIR_PATH) {
      const body = await readJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
      if (body === undefined) return
      const outcome = options.devices.redeemPairing({
        token: isRecord(body) ? body.pairingToken : undefined,
        deviceName: isRecord(body) ? body.deviceName : undefined,
        // The node redeeming the code is the one the new token is bound to.
        peer: await options.peers.identify(peerAddress),
      })
      if (!outcome.ok) {
        // 401 for a bad or missing credential, 400 for a malformed request:
        // a client must be able to tell "wrong code" from "you forgot a field".
        const status = outcome.code === 'invalid_device_name' ? 400 : 401
        writeJson(response, status, { error: { code: outcome.code, message: outcome.message } })
        return
      }
      writeJson(response, 200, {
        deviceId: outcome.device.id,
        deviceName: outcome.device.name,
        deviceToken: outcome.deviceToken,
        scopes: outcome.device.scopes,
        // What it just paired with, in the exchange it already made: a client
        // learns the wire it is on without a second call to health.
        transportVersion: TAILNET_TRANSPORT_VERSION,
      })
      return
    }

    if (path === TAILNET_PAIR_REQUEST_PATH && (method === 'POST' || method === 'GET')) {
      await handlePairRequest(request, response, method, peerAddress)
      return
    }
    if (path === TAILNET_PAIR_COLLECT_PATH && method === 'POST') {
      await handlePairCollect(request, response, peerAddress)
      return
    }

    // The MCP endpoint offers no GET stream and no session teardown, which
    // Streamable HTTP has a server without them answer with 405. Before the
    // auth gate: nothing is served by either, so there is nothing to protect.
    if (path === TAILNET_MCP_PATH && method !== 'POST') {
      response.setHeader('Allow', 'POST')
      writeJson(response, 405, {
        error: {
          code: 'method_not_allowed',
          message: 'This MCP endpoint takes one JSON-RPC message per POST and opens no event stream.',
        },
      })
      return
    }

    // Every route a token opens is matched, judged and run from one table:
    // a path that is no route is not found, before any handler, and a route
    // is run only by the handler of the route that was judged.
    const route = tailnetDeviceRouteOf(method, path)
    const caller = authenticate(request, route, via)
    if (!caller.ok) {
      writeUnauthorized(response, unauthorizedOrigin(request, via), caller)
      return
    }
    const device = caller.device
    // Every route below — identity, ws-ticket and the MCP endpoint — is behind this one check, so
    // none can skip it.
    const admitted = await admitPeer(device, peerAddress, path)
    if (!admitted.ok) {
      writePeerRefused(response, unauthorizedOrigin(request, via), admitted)
      return
    }
    const { peerNode } = admitted
    options.devices.recordSeen(device.id, peerNode)
    options.onActivity?.({ kind: 'request', device, peerNode, peerAddress })
    if (!route) {
      writeJson(response, 404, {
        error: { code: 'not_found', message: `No tailnet gateway route for ${method} ${path}.` },
      })
      return
    }
    const decision = authorizeStudioAccess(tailnetDevicePrincipal(device.scopes), TAILNET_ROUTE_ACCESS[route])
    if (!decision.ok) {
      writeJson(response, 403, {
        error: { code: 'tailnet_scope_required', message: 'This device may not use that on this machine.' },
      })
      return
    }
    await httpRoutes[route]({ request, response, device, peerNode })
  }

  type RouteCall = {
    request: IncomingMessage
    response: ServerResponse
    device: TailnetDevice
    peerNode: string | null
  }

  /** What each authenticated HTTP route does, once `handleRequest` has judged it. */
  const httpRoutes: { readonly [R in TailnetHttpRoute]: (call: RouteCall) => Promise<void> | void } = {
    identity: ({ response, device }) => {
      // How the device should draw this desktop: the kind and colour the
      // person chose, else the defaults another desktop gives it. Absent from
      // a desktop built before it was sent; a device draws its own default then.
      let machine: { kind: string; color: string } | null = null
      try {
        machine = options.machine?.() ?? null
      } catch {
        machine = null
      }
      writeJson(response, 200, {
        ...(machine ? { machine } : {}),
        deviceId: device.id,
        deviceName: device.name,
        scopes: device.scopes,
        ...(options.environmentId ? { environmentId: options.environmentId } : {}),
        serverInfo: { name: options.serverName, version: options.serverVersion },
        transportVersion: TAILNET_TRANSPORT_VERSION,
        protocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      })
    },
    'ws-ticket': async ({ request, response, device }) => {
      // The upgrade carries its credential in the query string, where it lands
      // in proxy logs and browser history — so what it carries is a 30-second
      // single-use ticket, never the long-lived device token.
      const body = await readOptionalJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
      if (body === undefined) return
      // A desktop window's Studio socket says the window's origin, as any
      // browser socket must; the ticket names it, and only it opens with it.
      const origin = body && typeof body === 'object' ? (body as Record<string, unknown>).origin : undefined
      if (origin !== undefined && (typeof origin !== 'string' || !isDesktopWindowOrigin(origin))) {
        writeJson(response, 400, {
          error: { code: 'origin_not_allowed', message: 'A ticket names a desktop window’s origin, or none.' },
        })
        return
      }
      const ticket = `mctk_${randomBytes(24).toString('base64url')}`
      const expiresAtMs = now() + WS_TICKET_TTL_MS
      pruneTickets()
      // A device asking for ticket after ticket holds only its newest few.
      const held = [...tickets].filter(([, entry]) => entry.deviceId === device.id)
      for (const [stale] of held.slice(0, Math.max(0, held.length - MAX_TICKETS_PER_DEVICE + 1))) tickets.delete(stale)
      tickets.set(ticket, { deviceId: device.id, expiresAtMs, origin: origin ?? null })
      // `studioPath` says this machine serves the Studio protocol: a device
      // that finds it missing is talking to a build from before it.
      writeJson(response, 200, {
        ticket,
        expiresAt: new Date(expiresAtMs).toISOString(),
        path: TAILNET_STREAM_PATH,
        studioPath: TAILNET_STUDIO_PATH,
      })
    },
    mcp: async ({ request, response, device, peerNode }) => {
      const body = await readJsonBody(request, response, MAX_MCP_BODY_BYTES)
      if (body === undefined) return
      // This endpoint is stateless: every POST builds a fresh context, so a
      // connection-scoped declaration has nothing to attach to. Accepting it
      // and discarding it would be the silent fallback the norms forbid — the
      // caller would believe it had declared an identity it did not. Say so
      // instead, and name the channel that does hold state. Answered here
      // rather than in dispatch because the declaration is a NOTIFICATION: over
      // HTTP there is always a response to put the refusal in, over JSON-RPC
      // alone there would not be.
      if (isRecord(body) && body.method === CONNECT_METHOD) {
        writeJson(response, 400, {
          error: {
            code: 'stateless_transport',
            message: `${CONNECT_METHOD} needs a connection to attach to. Open a WebSocket at ${TAILNET_STREAM_PATH} with a ticket from ${TAILNET_WS_TICKET_PATH} and declare it there.`,
          },
        })
        return
      }
      if (Array.isArray(body)) {
        writeJson(
          response,
          400,
          jsonRpcErrorResponse(
            null,
            JSONRPC_INVALID_REQUEST,
            'Batched JSON-RPC is not taken; send one message per POST.',
          ),
        )
        return
      }
      // A JSON-RPC response from the client — revisions before 2026-07-28 let a
      // server send requests, and a client answers them here. This server
      // sends none, so there is nothing to match it to; it is accepted, as the
      // transport says a response the server takes is.
      if (
        isRecord(body) &&
        body.jsonrpc === '2.0' &&
        body.method === undefined &&
        ('result' in body || 'error' in body)
      ) {
        writeAccepted(response)
        return
      }
      // The headers a 2026-07-28 client mirrors from the body, and the version
      // it declares: an intermediary may have routed on the header, so one that
      // disagrees with the body is refused rather than one of them believed.
      const mismatch = headerMismatch(request, body)
      if (mismatch) {
        writeJson(response, 400, jsonRpcErrorResponse(jsonRpcIdOf(body), JSONRPC_HEADER_MISMATCH, mismatch))
        return
      }
      const versionHeader = headerOf(request, 'mcp-protocol-version')?.trim() ?? ''
      const requestedVersion = versionHeader.slice(0, 64)
      if (versionHeader && !isSupportedMcpProtocolVersion(versionHeader)) {
        writeJson(response, 400, {
          jsonrpc: '2.0',
          id: jsonRpcIdOf(body),
          error: {
            code: JSONRPC_INVALID_PARAMS,
            message: unsupportedProtocolVersionMessage(requestedVersion),
            data: { supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS], requested: requestedVersion },
          },
        })
        return
      }
      const sessionId = headerOf(request, 'mcp-session-id')?.trim() ?? ''
      let context: McpConnectionContext
      if (sessionId) {
        const session = mcpSessions.get(sessionId)
        // Unknown, lapsed, or another device's: 404 tells a client of those
        // revisions to initialize again, which is all it needs to do.
        if (!session || session.deviceId !== device.id) {
          writeJson(
            response,
            404,
            jsonRpcErrorResponse(jsonRpcIdOf(body), JSONRPC_SESSION_NOT_FOUND, 'Session not found. Initialize again.'),
          )
          return
        }
        session.lastUsedAt = now()
        context = session.context
      } else {
        context = contextFor(device, peerNode)
        if (isRecord(body) && body.method === 'initialize' && 'id' in body) {
          // At the overall ceiling the client is served without a session,
          // as a stateless client is, rather than taking another's.
          if (pruneSessions(device.id)) {
            const minted = randomBytes(24).toString('base64url')
            mcpSessions.set(minted, { deviceId: device.id, context, lastUsedAt: now() })
            response.setHeader('Mcp-Session-Id', minted)
          }
        }
      }
      // Counted against the device's budget with its streams and Studio
      // sockets: parallel POSTs are no way around it.
      const release = acquireDeviceWork(device.id)
      if (!release) {
        writeJson(response, 429, jsonRpcErrorResponse(jsonRpcIdOf(body), JSONRPC_DEVICE_BUSY, DEVICE_BUSY_MESSAGE))
        return
      }
      let answer: Record<string, unknown> | null
      try {
        answer = await handleMessage(body, context, device, versionHeader || null, jsonRpcIdOf(body))
      } finally {
        release()
      }
      // A notification has no answer; 202 with no body says "accepted".
      if (!answer) writeAccepted(response)
      else writeJsonText(response, 200, encodeDeviceAnswer(answer))
    },
  }

  /** Run one JSON-RPC message; returns the response object, or null for a notification. */
  /**
   * Pairing by approval, both halves.
   *
   * Unauthenticated, and deliberately ahead of the auth gate: a peer asking to
   * be paired has no credential yet, which is the whole point. What stands in
   * for one is the person at this machine, and the peer identity the store
   * records is the one this transport established — `whois` on the socket's own
   * address — never anything the body claimed.
   */
  async function handlePairRequest(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    peerAddress: string,
  ): Promise<void> {
    if (method === 'GET') {
      const query = parseUrl(request.url ?? '').searchParams
      const outcome = options.devices.collectPairRequest(
        query.get('id') ?? '',
        query.get('secret') ?? '',
        await options.peers.identify(peerAddress),
      )
      // Every outcome is a 200: "your request was declined" and "it lapsed" are
      // answers to a well-formed question, not failures of it. The client
      // branches on `status`, which it must do anyway.
      writeJson(response, 200, wireCollectOutcome(outcome))
      return
    }

    const body = await readJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
    if (body === undefined) return
    const peer = await options.peers.identify(peerAddress)
    const outcome = options.devices.requestPairing({
      deviceName: isRecord(body) ? body.deviceName : undefined,
      // Unresolvable stays null and the panel says so, rather than the request
      // being refused: whois is unavailable on any machine without the
      // Tailscale CLI, and that must not make the feature unusable.
      peerNode: peer?.name ?? null,
      peerAddress: peerAddress ?? '',
      // What an approval binds the new device to.
      peer,
      collectHash: isRecord(body) ? body.collectHash : undefined,
      // What the asker asked to be allowed to do. A request, not a grant: it
      // decides what the answering surface opens pre-ticked to, and the person
      // there decides what is actually given.
      requestedScopes: isRecord(body) ? body.scopes : undefined,
    })
    if (!outcome.ok) {
      // 429 for the caps, 400 for a malformed request: a client must be able to
      // tell "ask again later" from "you sent the wrong thing".
      const status = outcome.code === 'invalid_device_name' || outcome.code === 'invalid_collect_hash' ? 400 : 429
      writeJson(response, status, { error: { code: outcome.code, message: outcome.message } })
      return
    }
    // Audited like any other classified mutation, and for the same reason: a
    // stranger asking for access to this machine is a security event whether or
    // not anyone approves it. There is no device yet, so the record carries the
    // name asked for and the peer the transport proved — never a deviceId.
    options.onToolCall?.({
      context: {
        metadata: {
          kind: 'remote-tailnet',
          deviceName: outcome.request.deviceName,
          ...(outcome.request.peerNode ? { peerNode: outcome.request.peerNode } : {}),
        },
      },
      tool: 'tailnet.pair_request',
      args: { deviceName: outcome.request.deviceName, peerAddress: outcome.request.peerAddress },
      durationMs: 0,
    })
    options.onPairRequested?.()
    writeJson(response, 200, {
      requestId: outcome.request.id,
      // Echoed so the asking machine can show the digits beside the ones now on
      // the other screen. It is not a credential; comparing is its whole job.
      comparisonCode: outcome.request.comparisonCode,
      expiresAt: outcome.request.expiresAt,
    })
  }

  /**
   * The collect as a POST (phase 6): the same answer the GET gives, plus the
   * one thing a GET cannot carry — the asker's reverse grant, adopted only
   * when this very collect hands the asker OUR token (the approval a person
   * here gave), and only when its endpoint is the address the asker is
   * calling from. Anything else about the grant is refused silently: the
   * pairing the person approved still completes; the extra half does not.
   */
  async function handlePairCollect(
    request: IncomingMessage,
    response: ServerResponse,
    peerAddress: string,
  ): Promise<void> {
    const body = await readJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
    if (body === undefined) return
    const record = isRecord(body) ? body : {}
    const outcome = options.devices.collectPairRequest(
      typeof record.id === 'string' ? record.id : '',
      typeof record.secret === 'string' ? record.secret : '',
      await options.peers.identify(peerAddress),
    )
    if (outcome.status === 'approved' && outcome.asker && isRecord(record.reverse)) {
      const grant = readReverseGrant(record.reverse, peerAddress)
      if (grant) {
        options.onReverseGrant?.({
          grant,
          askerName: outcome.asker.deviceName,
          peerNode: outcome.asker.peerNode,
        })
      } else {
        options.log?.(
          `tailnet gateway ignored a reverse grant from ${peerAddress || 'an unknown address'}: ` +
            "its endpoint was not the asker's own address or it was malformed.",
        )
      }
    }
    writeJson(response, 200, wireCollectOutcome(outcome))
  }

  async function handleMessage(
    parsed: unknown,
    context: McpConnectionContext,
    device: TailnetDevice,
    protocolHeader: string | null,
    /** The request's id on the HTTP endpoint, so a session's `notifications/cancelled` can find the call. */
    requestId?: string | number | null,
    /** The asking connection's lifetime: a call still running when it ends is cancelled. */
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      return jsonRpcErrorResponse(
        jsonRpcIdOf(parsed),
        JSONRPC_INVALID_REQUEST,
        'Request is not a JSON-RPC 2.0 message.',
      )
    }
    const id = jsonRpcIdOf(parsed)
    const isNotification = id === null && !('id' in parsed)
    const params = isRecord(parsed.params) ? parsed.params : {}
    const declared = declaredProtocolVersion(params, protocolHeader)
    if (declared.kind === 'unsupported') {
      const detail = unsupportedProtocolVersionMessage(declared.value)
      if (isNotification) {
        options.log?.(`tailnet gateway refused ${parsed.method}: ${detail}`)
        return null
      }
      return jsonRpcErrorResponse(id, JSONRPC_INVALID_PARAMS, detail)
    }
    try {
      const outcome = await dispatcher.dispatch(
        parsed.method,
        params,
        context,
        gateFor(device),
        requestId === undefined && signal === undefined
          ? undefined
          : { ...(requestId === undefined ? {} : { requestId }), ...(signal ? { signal } : {}) },
      )
      if (isNotification) return null
      if (outcome.kind === 'no_response') return { jsonrpc: '2.0', id, result: {} }
      if (outcome.kind === 'error') return jsonRpcErrorResponse(id, outcome.code, outcome.errorMessage)
      return { jsonrpc: '2.0', id, result: outcome.value }
    } catch (error) {
      options.log?.(`tailnet tool dispatch threw: ${message(error)}`)
      if (isNotification) return null
      return jsonRpcErrorResponse(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${message(error)}`)
    }
  }

  /** The device's grant, applied to what it may see and what it may run: one decision for both. */
  function gateFor(device: TailnetDevice): McpDispatchGate {
    const principal = tailnetDevicePrincipal(device.scopes)
    const decide = (toolName: string) =>
      authorizeStudioAccess(principal, tailnetToolAccess(toolName, options.isMutation(toolName)))
    return {
      // A local-only tool is refused whatever the grant: it is not something a
      // wider grant unlocks, it is off this transport entirely.
      filterTools: (tools) => tools.filter((tool) => decide(tool.name).ok),
      authorizeToolCall: (toolName) => {
        const decision = decide(toolName)
        if (decision.ok) return null
        if (decision.reason === 'local_only') return toolError('tailnet_local_only', decision.message)
        // A tool's access names no owner and is always found, so the rest is a missing permission.
        if (decision.reason !== 'permission_required')
          return toolError('tailnet_scope_required', `"${toolName}" is not served to this device.`)
        return toolError(
          'tailnet_scope_required',
          `This device is not granted "${decision.permission}", which "${toolName}" requires. Re-pair the device with that scope in Settings.`,
        )
      },
    }
  }

  function contextFor(device: TailnetDevice, peerNode: string | null): McpConnectionContext {
    return {
      metadata: {
        kind: 'remote-tailnet',
        deviceId: device.id,
        deviceName: device.name,
        ...(peerNode ? { peerNode } : {}),
        // The listener proved which paired device this is before dispatch.
        verified: true,
      },
    }
  }

  /**
   * Make room for one more of `deviceId`'s sessions. Each device has its own
   * allowance and gives up its own oldest, so one device opening sessions
   * without end pushes out only its own. The overall ceiling is a backstop
   * that a person's approved devices are not expected to reach.
   */
  function pruneSessions(deviceId: string): boolean {
    const cutoff = now() - MCP_SESSION_IDLE_MS
    for (const [id, session] of mcpSessions) if (session.lastUsedAt < cutoff) mcpSessions.delete(id)
    const own = [...mcpSessions].filter(([, session]) => session.deviceId === deviceId)
    for (const [id] of own.slice(0, Math.max(0, own.length - MAX_MCP_SESSIONS_PER_DEVICE + 1))) mcpSessions.delete(id)
    return mcpSessions.size < MAX_MCP_SESSIONS
  }

  /**
   * Who a request's bearer token belongs to: a paired device by its device
   * token, or an OAuth client's device by an access token its grant issued.
   *
   * An access token is for the MCP endpoint and nothing else — it is issued
   * for that resource (RFC 8707), and every other route here is the paired
   * apps' — and only while the resource it names is still one of this
   * Studio's own. Its device is read live, so a revoked grant stops here.
   */
  function authenticate(
    request: IncomingMessage,
    route: TailnetHttpRoute | null,
    via: TailnetListenerKind,
  ): Authentication {
    const token = bearerOf(request)
    if (!token) return { ok: false, presented: false }
    if (via === 'serve' && !token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
      return {
        ok: false,
        presented: true,
        code: 'oauth_required_here',
        message:
          'Over HTTPS the MCP endpoint takes OAuth sign-ins only. A paired device uses this Studio’s tailnet address.',
      }
    }
    if (looksLikePairingSecret(token)) {
      return { ok: false, presented: true, code: 'pairing_code_not_a_token', message: PAIRING_CODE_AS_BEARER_MESSAGE }
    }
    if (token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
      const check = options.oauth?.store.authenticateAccessToken(token)
      if (!check?.ok) {
        return check?.reason === 'expired'
          ? {
              ok: false,
              presented: true,
              code: 'token_expired',
              message: 'The access token has expired. Refresh it, or sign in again.',
            }
          : { ok: false, presented: true }
      }
      if (route !== 'mcp') {
        return {
          ok: false,
          presented: true,
          code: 'wrong_resource',
          message: `An OAuth access token opens the MCP endpoint (POST ${TAILNET_MCP_PATH}) only.`,
        }
      }
      if (!oauthHttp?.resources().has(check.resource)) {
        return {
          ok: false,
          presented: true,
          code: 'wrong_resource',
          message: 'That access token was issued for an address this Studio no longer answers to. Sign in again.',
        }
      }
      const device = options.devices.listDevices().find((entry) => entry.id === check.deviceId)
      return device ? { ok: true, device } : { ok: false, presented: true }
    }
    const device = options.devices.authenticate(token)
    return device ? { ok: true, device } : { ok: false, presented: true }
  }

  /** The origin a 401 names for discovery: the one the client used when it is ours, else the listener's own. */
  function unauthorizedOrigin(request: IncomingMessage, via: TailnetListenerKind): string | null {
    if (!oauthHttp) return null
    return oauthHttp.originFor(request, via) ?? oauthHttp.primaryOrigin(via)
  }

  /**
   * The second half of authentication: is this device's token being presented
   * from the tailnet node it was issued to? whois on the socket's own address
   * answers, never anything the request says about itself.
   *
   * A refusal is audited as a refused call, with the device whose token it was
   * and the node that presented it: a token turning up on the wrong machine is
   * the event the owner most needs to see, whether or not anything was served.
   *
   * Loopback needs no exception: whois cannot name 127.0.0.1, so a bound device
   * is refused there like anywhere else whois cannot answer. Tests inject a
   * resolver (`peers`) that names the nodes they need.
   */
  async function admitPeer(
    device: TailnetDevice,
    peerAddress: string,
    route: string,
  ): Promise<({ ok: true } & TailnetGatewayPeer) | Extract<TailnetPeerCheck, { ok: false }>> {
    const peer = await options.peers.identify(peerAddress)
    // Read after the await: a device revoked while whois ran is refused here.
    const check = options.devices.verifyPeer(device.id, peer)
    const peerNode = peer?.name ?? null
    if (check.ok) return { ok: true, peerNode, peerAddress }
    options.log?.(
      `tailnet gateway refused device ${device.id} from ${peerNode ?? (peerAddress || 'an unknown address')}: ${check.code}`,
    )
    options.onToolCall?.({
      context: contextFor(device, peerNode),
      tool: TAILNET_PEER_REFUSED_AUDIT_TOOL,
      args: { path: route, peerAddress, ...(peer?.stableNodeId ? { peerNodeId: peer.stableNodeId } : {}) },
      durationMs: 0,
      result: toolError(check.code, check.message),
    })
    return check
  }

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    via: TailnetListenerKind,
  ): Promise<void> {
    const path = pathOf(request.url)
    const route = tailnetUpgradeRouteOf(path)
    // A browser labels every socket with its page's origin. Only a desktop
    // window's Studio socket may carry one, and only the one its ticket names
    // (checked once the ticket is spent, below); everything else refuses any.
    // An empty one is none, as on the HTTP side: React Native says `Origin: `
    // when the phone tells it to say no origin of its own.
    const origin = request.headers.origin ? request.headers.origin : null
    if (origin !== null && (route !== 'studio' || !isDesktopWindowOrigin(origin)))
      return rejectUpgrade(socket, 403, 'origin_not_allowed')
    // No stream opens behind Serve: see the loopback listener's rule above.
    if (via === 'serve') return rejectUpgrade(socket, 404, 'not_served_over_https')
    // A socket transport 3 took away (a chat's lane, the change feed, a
    // board's lane): the build asking is told to update, as on HTTP.
    if (TAILNET_RETIRED_PATHS.has(path))
      return rejectUpgrade(socket, 426, 'client_update_required', TAILNET_CLIENT_UPDATE_MESSAGE)
    if (!route) return rejectUpgrade(socket, 404, 'not_found')
    if ((headerOf(request, 'upgrade') ?? '').toLowerCase() !== 'websocket')
      return rejectUpgrade(socket, 400, 'not_a_websocket_upgrade')
    if ((headerOf(request, 'sec-websocket-version') ?? '') !== '13')
      return rejectUpgrade(socket, 400, 'unsupported_websocket_version')
    const key = headerOf(request, 'sec-websocket-key')
    if (!key) return rejectUpgrade(socket, 400, 'missing_websocket_key')
    // Sixteen bytes in base64 (RFC 6455), nothing else, before the ticket is spent.
    if (!WEBSOCKET_KEY.test(key)) return rejectUpgrade(socket, 400, 'invalid_websocket_key')

    const query = queryOf(request.url)
    const presentedTicket = query.get('ticket')
    const redeemed = redeemTicket(presentedTicket)
    if (!redeemed) return rejectUpgrade(socket, 401, 'unauthorized')
    const { device } = redeemed
    // A ticket asked for a window's origin opens that window's Studio socket
    // and nothing else, and a socket says exactly the origin its ticket names.
    if (redeemed.origin !== origin || (redeemed.origin !== null && route !== 'studio'))
      return rejectUpgrade(socket, 403, 'origin_not_allowed')
    // The ticket was minted behind `admitPeer`, but it rides in a URL; the
    // socket presenting it is held to the device's node all the same.
    const admitted = await admitPeer(device, normalizeAddress(remoteAddressOf(socket)), path)
    if (!admitted.ok) return rejectUpgrade(socket, 401, admitted.code)
    const { peerNode, peerAddress } = admitted
    // What the socket needs, judged as every HTTP route is.
    if (!authorizeStudioAccess(tailnetDevicePrincipal(device.scopes), TAILNET_ROUTE_ACCESS[route]).ok)
      return rejectUpgrade(socket, 403, 'tailnet_scope_required')

    if (route === 'studio') {
      const host = options.studio?.() ?? null
      if (!host) return rejectUpgrade(socket, 503, 'studio_unavailable')
      // A revoke during the awaits above must not open a socket after its
      // listener has fired.
      const currentDevice = options.devices.listDevices().find((entry) => entry.id === device.id)
      if (!currentDevice || !presentedTicket) return rejectUpgrade(socket, 401, 'unauthorized')
      options.devices.recordSeen(currentDevice.id, peerNode)
      openStudioSocket(socket, key, head, currentDevice, presentedTicket, host, { peerNode, peerAddress })
      return
    }

    options.devices.recordSeen(device.id, peerNode)
    admitDeviceSocket(device.id)
    acceptUpgrade(socket, key)

    const session: StreamSession = {
      socket,
      deviceId: device.id,
      opened: ++socketsOpened,
      queued: 0,
      device,
      context: contextFor(device, peerNode),
      ended: new AbortController(),
      waiting: new Set(),
    }
    streams.add(session)
    session.untrack = options.clientTools?.track(session.context, () =>
      sendStream(session, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
    )
    options.onActivity?.({ kind: 'stream', device, open: true, peerNode, peerAddress })
    const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES)
    // Serialize per connection so a client's messages are answered in order.
    let pending = Promise.resolve()

    const consume = (chunk: Buffer): void => {
      // A stream closed here (evicted past its device's budget, over its
      // queue, revoked) reads nothing more, whether or not its client has
      // answered the close: one that ignores it would otherwise go on being
      // served outside every bound.
      if (!streams.has(session)) return
      const decoded = decoder.push(chunk)
      if (decoded.kind === 'error') {
        closeStream(session, decoded.code, decoded.reason)
        return
      }
      for (const frame of decoded.frames) {
        if (frame.kind === 'close') {
          closeStream(session, WEBSOCKET_CLOSE_GOING_AWAY, '')
          return
        }
        if (frame.kind === 'ping') {
          socket.write(encodePongFrame(frame.payload))
          continue
        }
        if (frame.kind !== 'text') continue
        const text = frame.text
        if (session.queued >= MAX_STREAM_QUEUED_MESSAGES) {
          closeStream(session, WEBSOCKET_CLOSE_POLICY, 'Too many requests are waiting for an answer.')
          return
        }
        // Counted against the device until it has really ended, not only until its stream has.
        const release = acquireDeviceWork(session.deviceId)
        if (!release) {
          refuseBusy(session, text)
          continue
        }
        session.queued += 1
        session.waiting.add(release)
        // One message that throws must not skip every message after it.
        pending = pending
          .then(() => {
            session.waiting.delete(release)
            return handleStreamMessage(session, text)
          })
          .catch((error: unknown) => {
            options.log?.(`tailnet stream message failed: ${message(error)}`)
          })
          .finally(() => {
            session.queued -= 1
            release()
          })
      }
    }

    if (head?.length) consume(head)
    socket.on('data', (chunk: Buffer) => consume(chunk))
    // An upgraded socket is half-open: a peer that disconnects makes Node emit
    // `end`, not `close` (the write side is still ours). Both are handled, or a
    // dropped client stays in `streams` for the life of the process and every
    // tool-list notification writes into a socket nobody is reading.
    socket.on('end', () => {
      dropStream(session)
      socket.destroy()
    })
    socket.on('close', () => dropStream(session))
    socket.on('error', () => {
      dropStream(session)
      socket.destroy()
    })
  }

  /**
   * Untrack a stream and announce the close exactly once, whichever of the
   * teardown paths (peer end/close/error, revocation, server stop) runs first —
   * `streams.delete` returning false is what dedupes.
   */
  function dropStream(session: StreamSession): void {
    // What it had waiting is dropped, and let go of the device's budget now
    // rather than when its turn comes; what it is running is cancelled, and
    // counts until it has stopped.
    session.ended.abort()
    for (const release of session.waiting) release()
    session.waiting.clear()
    if (streams.delete(session)) {
      session.untrack?.()
      options.onActivity?.({ kind: 'stream', device: session.device, open: false })
    }
  }

  /**
   * Take one more of a device's requests, or none past its budget: the
   * release, called once the request has ended, or null.
   */
  function acquireDeviceWork(deviceId: string): (() => void) | null {
    const held = deviceWork.get(deviceId) ?? 0
    if (held >= MAX_DEVICE_OUTSTANDING_REQUESTS) return null
    deviceWork.set(deviceId, held + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (deviceWork.get(deviceId) ?? 1) - 1
      if (left > 0) deviceWork.set(deviceId, left)
      else deviceWork.delete(deviceId)
    }
  }

  /** Answer a request over the device's budget as busy, without running or queueing it. */
  function refuseBusy(session: StreamSession, text: string): void {
    let id: unknown = null
    try {
      id = jsonRpcIdOf(JSON.parse(text))
    } catch {
      // Not JSON: nothing to answer, and nothing was run.
    }
    if (typeof id !== 'string' && typeof id !== 'number') return
    sendStream(session, jsonRpcErrorResponse(id, JSONRPC_DEVICE_BUSY, DEVICE_BUSY_MESSAGE))
  }

  async function handleStreamMessage(session: StreamSession, text: string): Promise<void> {
    // A stream that closed while this waited its turn has no one to answer: it is not run.
    if (session.ended.signal.aborted) return
    // Re-check the device on every message, not only at upgrade: authorization
    // on a long-lived socket must follow the store, and the revocation listener
    // is a fast path, not the guarantee.
    const device = options.devices.listDevices().find((candidate) => candidate.id === session.deviceId)
    if (!device) {
      closeStream(session, WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      sendStream(session, jsonRpcErrorResponse(null, JSONRPC_PARSE_ERROR, 'Request is not valid JSON.'))
      return
    }
    try {
      const answer = await handleMessage(parsed, session.context, device, null, undefined, session.ended.signal)
      if (answer) sendStreamText(session, encodeDeviceAnswer(answer))
    } catch (error) {
      // A request that failed past its handler (a result JSON cannot encode)
      // is still answered, so the device is not left waiting on its id; a
      // notification has no id to answer.
      const id = (parsed as { id?: unknown } | null)?.id
      if (typeof id === 'string' || typeof id === 'number') {
        sendStream(session, jsonRpcErrorResponse(id, JSONRPC_INTERNAL_ERROR, 'The request failed.'))
      }
      throw error
    }
  }

  function redeemTicket(ticket: string | null): { device: TailnetDevice; origin: string | null } | null {
    pruneTickets()
    if (!ticket) return null
    const entry = tickets.get(ticket)
    if (!entry) return null
    // Single use: consumed whether or not the device still exists.
    tickets.delete(ticket)
    if (entry.expiresAtMs <= now()) return null
    const device = options.devices.listDevices().find((candidate) => candidate.id === entry.deviceId)
    return device ? { device, origin: entry.origin } : null
  }

  /**
   * Hand an admitted socket to this machine's Studio server, as the device's
   * connection: its hello must present the ticket the socket was opened with,
   * and every request it makes is judged by the device's grant as it stands
   * then (`createTailnetDeviceAuthenticator`). A revoke reaches it through that
   * authenticator, which says `bye` before the socket closes.
   */
  function openStudioSocket(
    socket: Duplex,
    key: string,
    head: Buffer,
    device: TailnetDevice,
    ticket: string,
    host: TailnetStudioHost,
    peer: TailnetGatewayPeer,
  ): void {
    admitDeviceSocket(device.id)
    const webSocket = acceptWebSocket(socket, key, head)
    const entry: StudioSocket = { peer: webSocket, deviceId: device.id, opened: ++socketsOpened }
    studioSockets.add(entry)
    options.onActivity?.({ kind: 'stream', device, open: true, ...peer })
    webSocket.onClose(() => {
      if (studioSockets.delete(entry)) options.onActivity?.({ kind: 'stream', device, open: false })
    })
    host.attach(
      webSocketStream(webSocket),
      createTailnetDeviceAuthenticator({
        devices: options.devices,
        deviceId: device.id,
        ticket,
        peerNode: peer.peerNode,
      }),
      // Its requests count against the device's one budget, as its tool streams' do.
      { acquire: () => acquireDeviceWork(device.id) },
    )
  }

  /**
   * Make room for one more of a device's sockets: past its budget, its oldest
   * goes, a Studio socket or a tool stream alike.
   */
  function admitDeviceSocket(deviceId: string): void {
    const held = [
      ...[...studioSockets]
        .filter((entry) => entry.deviceId === deviceId)
        .map((entry) => ({
          opened: entry.opened,
          close: () => entry.peer.close(WEBSOCKET_CLOSE_GOING_AWAY, 'This device opened a newer connection.'),
        })),
      ...[...streams]
        .filter((entry) => entry.deviceId === deviceId)
        .map((entry) => ({
          opened: entry.opened,
          close: () => closeStream(entry, WEBSOCKET_CLOSE_GOING_AWAY, 'This device opened a newer connection.'),
        })),
    ].sort((a, b) => a.opened - b.opened)
    for (const stale of held.slice(0, Math.max(0, held.length - MAX_SOCKETS_PER_DEVICE + 1))) stale.close()
  }

  function pruneTickets(): void {
    const current = now()
    for (const [ticket, entry] of tickets) if (entry.expiresAtMs <= current) tickets.delete(ticket)
  }

  function closeStreamsFor(deviceId: string): void {
    for (const stream of [...streams]) {
      if (stream.deviceId === deviceId) closeStream(stream, WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
    }
    // The Studio connection hears the revoke from its authenticator and says
    // `bye` first; a socket still open a moment later is closed here.
    for (const studio of [...studioSockets]) {
      if (studio.deviceId !== deviceId) continue
      const timer = setTimeout(() => studio.peer.close(WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.'), 500)
      timer.unref?.()
    }
    for (const [ticket, entry] of tickets) if (entry.deviceId === deviceId) tickets.delete(ticket)
    for (const [id, session] of mcpSessions) if (session.deviceId === deviceId) mcpSessions.delete(id)
  }

  /**
   * Write the RFC 6455 handshake response for an accepted upgrade, and turn on
   * TCP keepalive for the socket's life.
   *
   * Keepalive is the kernel's, so it costs this process no wakeups, and it is
   * what finds a peer that vanished without a close — a laptop that slept, a
   * Wi-Fi change, a re-keyed tunnel. The change feed sends nothing while
   * nothing changes, so without it a dead watcher would sit in `eventStreams`
   * until a later push failed, which may be never.
   */
  function acceptUpgrade(socket: Duplex, key: string): void {
    enableTcpKeepAlive(socket)
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${computeWebSocketAcceptKey(key)}`,
        '',
        '',
      ].join('\r\n'),
    )
  }

  function closeStream(session: StreamSession, code: number, reason: string): void {
    dropStream(session)
    if (session.socket.destroyed) return
    try {
      session.socket.write(encodeCloseFrame(code, reason))
    } catch {
      // The peer is already gone; destroying below is the whole cleanup.
    }
    session.socket.end()
    // A client that never answers the close is not kept half-open.
    const socket = session.socket
    setTimeout(() => socket.destroy(), STREAM_CLOSE_GRACE_MS).unref?.()
  }

  function sendStream(session: StreamSession, payload: Record<string, unknown>): void {
    sendStreamText(session, JSON.stringify(payload))
  }

  function sendStreamText(session: StreamSession, text: string): void {
    if (session.socket.destroyed) return
    // A client that does not read what it asked for is let go, not written to without end.
    if (session.socket.writableLength > MAX_STREAM_UNSENT_BYTES) {
      dropStream(session)
      session.socket.destroy()
      return
    }
    session.socket.write(encodeTextFrame(text))
  }

  /**
   * Read and parse a JSON body, answering the client on failure.
   *
   * Returns `undefined` when it already wrote the response — callers must
   * return immediately on that, and must not treat it as a valid body.
   */
  /** A body that may be empty, which reads as `{}`: a ticket asked for with nothing to say. */
  function readOptionalJsonBody(
    request: IncomingMessage,
    response: ServerResponse,
    maxBytes: number,
  ): Promise<unknown | undefined> {
    return readJsonBody(request, response, maxBytes, { empty: {} })
  }

  async function readJsonBody(
    request: IncomingMessage,
    response: ServerResponse,
    maxBytes: number,
    options: { empty?: unknown } = {},
  ): Promise<unknown | undefined> {
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of request) {
        const buffer = chunk as Buffer
        size += buffer.length
        if (size > maxBytes) {
          // Answer first, then stop reading. Breaking out of `for await`
          // destroys the request stream, so the response has to be on the wire
          // before that happens or the client sees a reset with no reason.
          writeJson(response, 413, {
            error: { code: 'body_too_large', message: `Request body exceeds the ${maxBytes}-byte limit.` },
          })
          // A client that hangs up first never lets the answer finish.
          await new Promise<void>((resolve) => {
            response.once('finish', resolve)
            response.once('close', resolve)
          })
          break
        }
        chunks.push(buffer)
      }
    } catch (error) {
      writeJson(response, 400, { error: { code: 'body_read_failed', message: message(error) } })
      return undefined
    }
    if (response.headersSent) return undefined
    if (size === 0 && options.empty !== undefined) return options.empty
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      writeJson(response, 400, { error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } })
      return undefined
    }
  }

  return {
    start,
    stop,
    isRunning: () => server !== null,
    address: () => {
      const bound = server?.address()
      return bound && typeof bound === 'object' ? { address: bound.address, port: bound.port } : null
    },
    openServeListener,
    closeServeListener,
    serveAddress: () => {
      const bound = serveServer?.address()
      return bound && typeof bound === 'object' ? { address: bound.address, port: bound.port } : null
    },
    notifyToolsListChanged: () => {
      for (const stream of streams) sendStream(stream, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    },
    streamCount: () => streams.size,
  }
}

/** The collect outcome as the asker may see it: never who asked (it knows) nor the store's bookkeeping. */
function wireCollectOutcome(outcome: TailnetCollectOutcome): Record<string, unknown> {
  const { asker: _asker, ...wire } = outcome
  return wire
}

/**
 * Read a reverse grant off a collect body, or null when it must not be kept.
 *
 * The endpoint's host must be the address the collect arrived from. That is
 * the one fact the transport proves about the asker, and it is what stops a
 * peer from handing this machine a credential that dials somewhere else.
 */
function readReverseGrant(value: Record<string, unknown>, peerAddress: string): TailnetReverseGrant | null {
  if (!peerAddress) return null
  const endpoint = typeof value.endpoint === 'string' ? parseTailnetEndpoint(value.endpoint) : null
  if (!endpoint || normalizeAddress(endpoint.host) !== peerAddress) return null
  const deviceToken = typeof value.deviceToken === 'string' ? value.deviceToken.trim() : ''
  const deviceId = typeof value.deviceId === 'string' ? value.deviceId.trim() : ''
  if (!deviceToken || !deviceId) return null
  const machineName = typeof value.machineName === 'string' ? value.machineName.trim().slice(0, 120) : ''
  const deviceName = typeof value.deviceName === 'string' ? value.deviceName.trim().slice(0, 120) : ''
  return {
    endpoint: `${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`,
    machineName: machineName || endpoint.host,
    deviceId,
    deviceName,
    deviceToken,
    scopes: normalizeTailnetScopes(value.scopes),
  }
}

type Authentication =
  { ok: true; device: TailnetDevice } | { ok: false; presented: boolean; code?: string; message?: string }

const OAUTH_ACCESS_TOKEN_PREFIX = 'mcat_'
const MCP_SESSION_IDLE_MS = 60 * 60_000
const MAX_MCP_SESSIONS = 1024
const MAX_MCP_SESSIONS_PER_DEVICE = 16
/** Streamable HTTP's HeaderMismatch (2026-07-28). */
const JSONRPC_HEADER_MISMATCH = -32020
/** The SDKs' "session not found" for a session id the server does not hold. */
const JSONRPC_SESSION_NOT_FOUND = -32001

const UNAUTHORIZED_MESSAGE =
  'A paired device token or an OAuth access token is required. An MCP client that signs in with OAuth finds how ' +
  'from resource_metadata in WWW-Authenticate, and the person at this Studio approves it there. Anything else pairs ' +
  'in Settings → Remote.'

/**
 * Said to a client that sent a pairing code (or the whole pairing link) where
 * a token goes: the code is redeemed once for a device token, never presented.
 */
const PAIRING_CODE_AS_BEARER_MESSAGE =
  'That is a pairing code, not a token. Redeem it once: POST /tailnet/v1/pair with {"pairingToken": "<the code>", ' +
  '"deviceName": "<a name>"} answers with a deviceToken, which is what goes after "Bearer". An MCP client that signs in ' +
  "with OAuth needs no code at all: give it this endpoint's URL, and approve it in Studio when it asks. Do not paste " +
  'a pairing code anywhere else; anyone holding it can pair once.'

function looksLikePairingSecret(token: string): boolean {
  return token.startsWith('mcpair_') || token.startsWith('sprintengine-tailnet:') || token.includes('pairingToken=')
}

/**
 * The challenge every 401 here carries: the realm it always had, and the
 * protected resource metadata an OAuth client discovers sign-in from (RFC
 * 9728 5.1). `error="invalid_token"` when a token was presented and refused,
 * so a client with one knows to refresh or sign in again (RFC 6750 3.1).
 */
function challengeFor(origin: string | null, refusal?: { presented: boolean; message?: string }): string {
  const parts = ['Bearer realm="sprintengine-studio-tailnet"']
  if (origin) parts.push(`resource_metadata="${origin}/.well-known/oauth-protected-resource${TAILNET_MCP_PATH}"`)
  if (refusal?.presented) {
    parts.push('error="invalid_token"')
    // A header value is visible ASCII: the description is the message with
    // anything else dropped (the body carries it whole).
    if (refusal.message)
      parts.push(
        `error_description="${refusal.message
          .replace(/["\\]/gu, "'")
          .replace(/[^\x20-\x7e]+/gu, ' ')
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 200)}"`,
      )
  }
  return parts.join(', ')
}

function writeUnauthorized(
  response: ServerResponse,
  origin: string | null,
  refusal: { presented: boolean; code?: string; message?: string },
): void {
  response.setHeader('WWW-Authenticate', challengeFor(origin, refusal))
  writeJson(response, 401, {
    error: { code: refusal.code ?? 'unauthorized', message: refusal.message ?? UNAUTHORIZED_MESSAGE },
  })
}

/** A valid token presented from the wrong node, or from one whois could not name. */
function writePeerRefused(
  response: ServerResponse,
  origin: string | null,
  refusal: { code: string; message: string },
): void {
  response.setHeader('WWW-Authenticate', challengeFor(origin, { presented: true, message: refusal.message }))
  writeJson(response, 401, { error: { code: refusal.code, message: refusal.message } })
}

/** 202 with no body: a notification (or a client's response) accepted. */
function writeAccepted(response: ServerResponse): void {
  if (response.headersSent || response.writableEnded) return
  response.writeHead(202, { 'Content-Length': 0, 'Cache-Control': 'no-store' })
  response.end()
}

/** The bearer token on a request; the scheme is case-insensitive (RFC 9110 11.1). */
function bearerOf(request: IncomingMessage): string | null {
  const match = /^Bearer[ ]+(\S+)\s*$/iu.exec(headerOf(request, 'authorization') ?? '')
  return match ? match[1]! : null
}

/**
 * The peer of a request: the socket's own address on the tailnet listener;
 * on the loopback listener Tailscale Serve proxies to, the address Serve says
 * connected to it (see the note at the top of this file).
 */
function peerAddressOf(request: IncomingMessage, via: TailnetListenerKind): string {
  return via === 'serve' ? forwardedPeerAddress(request) : normalizeAddress(request.socket.remoteAddress)
}

/**
 * Why a request on the listener behind Tailscale Serve is not served, or
 * null. Serve sets `Tailscale-Funnel-Request` on a request that reached it
 * through Funnel and strips any copy a client sent, so its presence means the
 * internet; Funnel is refused when HTTPS is turned on, and this holds the line
 * if someone turns it on afterwards.
 */
function serveRefusal(request: IncomingMessage): { code: string; message: string } | null {
  if (headerOf(request, 'tailscale-funnel-request') !== null)
    return {
      code: 'funnel_not_allowed',
      message: 'This Studio is not served over Tailscale Funnel. Reach it from your tailnet.',
    }
  if (!forwardedPeerAddress(request))
    return {
      code: 'tailnet_peer_required',
      message: 'Only a machine on this tailnet is served here.',
    }
  return null
}

/** `X-Forwarded-For` as Tailscale Serve sets it: one tailnet address, or nothing usable. */
function forwardedPeerAddress(request: IncomingMessage): string {
  const value = headerOf(request, 'x-forwarded-for') ?? ''
  const address = normalizeAddress(value.split(',').at(-1) ?? '')
  return address && isTailnetAddress(address) ? address : ''
}

/**
 * Why a request's mirrored headers disagree with its body (2026-07-28
 * Streamable HTTP, "Server Validation"), or null. Only headers that are sent
 * are compared: a client of an earlier revision sends none of them, and is
 * served as it always was.
 */
function headerMismatch(request: IncomingMessage, body: unknown): string | null {
  if (!isRecord(body)) return null
  const params = isRecord(body.params) ? body.params : {}
  const method = headerOf(request, 'mcp-method')
  if (method !== null && method !== body.method) return `Header mismatch: Mcp-Method does not match the body's method.`
  const name = headerOf(request, 'mcp-name')
  if (name !== null) {
    const decoded = decodeHeaderValue(name)
    const expected = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : null
    if (decoded === null || decoded !== expected) return `Header mismatch: Mcp-Name does not match the body.`
  }
  const version = headerOf(request, 'mcp-protocol-version')?.trim()
  const meta = isRecord(params._meta) ? params._meta : null
  const declared = meta?.['io.modelcontextprotocol/protocolVersion']
  if (version && typeof declared === 'string' && declared !== version)
    return 'Header mismatch: MCP-Protocol-Version does not match the version the body declares.'
  return null
}

/** A header value, decoded from the `=?base64?…?=` sentinel when it is one; null when that does not decode. */
function decodeHeaderValue(value: string): string | null {
  const match = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/u.exec(value)
  if (!match) return value
  try {
    return Buffer.from(match[1]!, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * A tool's answer as sent to a device: its JSON, or, past
 * `MAX_DEVICE_ANSWER_BYTES`, an error that says so under the same id.
 */
export function encodeDeviceAnswer(answer: Record<string, unknown>): string {
  const text = JSON.stringify(answer)
  if (Buffer.byteLength(text) <= MAX_DEVICE_ANSWER_BYTES) return text
  return JSON.stringify(
    jsonRpcErrorResponse(
      jsonRpcIdOf(answer),
      JSONRPC_INTERNAL_ERROR,
      `The answer is over the ${MAX_DEVICE_ANSWER_BYTES / (1024 * 1024)} MB a device is sent. Ask for less.`,
    ),
  )
}

function writeJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  writeJsonText(response, status, JSON.stringify(payload))
}

function writeJsonText(response: ServerResponse, status: number, body: string): void {
  // The catch-all 500 in the request handler can fire after a route already
  // answered; writing a second status line would throw over the first one.
  if (response.headersSent || response.writableEnded) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Nothing here is cacheable, and a proxy holding a tool result would be a
    // correctness bug before it was a privacy one.
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function rejectUpgrade(socket: Duplex, status: number, code: string, message?: string): void {
  const reason =
    status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : status === 426
            ? 'Upgrade Required'
            : status === 503
              ? 'Service Unavailable'
              : 'Bad Request'
  if (!socket.destroyed) {
    // A sentence for a person goes as the body, as on the HTTP routes.
    const body = message ? JSON.stringify({ error: { code, message } }) : ''
    const typed = body
      ? `Content-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`
      : ''
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nX-Tailnet-Error: ${code}\r\n${typed}\r\n${body}`)
  }
  socket.destroy()
}

/**
 * The peer address of an upgraded connection.
 *
 * Node types the `upgrade` socket as `Duplex` because the server may be TLS,
 * but every socket this plain-HTTP server upgrades is a `net.Socket` and
 * carries `remoteAddress`. Read defensively rather than casting the whole
 * socket: an address we cannot read means an unresolved peer, not a crash.
 */
function remoteAddressOf(socket: Duplex): string {
  const value = (socket as { remoteAddress?: unknown }).remoteAddress
  return typeof value === 'string' ? value : ''
}

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? (value[0] ?? null) : null
}

function pathOf(url: string | undefined): string {
  return parseUrl(url).pathname
}

function queryOf(url: string | undefined): URLSearchParams {
  return parseUrl(url).searchParams
}

/**
 * The route an authenticated HTTP request asks for, as `TAILNET_ROUTE_ACCESS`
 * declares it, or null for one this listener does not serve (answered not
 * found).
 */
export function tailnetDeviceRouteOf(method: string, path: string): TailnetHttpRoute | null {
  if (method === 'GET' && path === TAILNET_IDENTITY_PATH) return 'identity'
  if (method === 'POST' && path === TAILNET_WS_TICKET_PATH) return 'ws-ticket'
  if (method === 'POST' && path === TAILNET_MCP_PATH) return 'mcp'
  return null
}

/** The route a WebSocket upgrade asks for, or null for a path that opens none. */
export function tailnetUpgradeRouteOf(path: string): TailnetUpgradeRoute | null {
  if (path === TAILNET_STREAM_PATH) return 'stream'
  if (path === TAILNET_STUDIO_PATH) return 'studio'
  return null
}

// The base is a placeholder: only the path and query are ever read from it, and
// a request line is always origin-form on this server.
function parseUrl(url: string | undefined): URL {
  try {
    return new URL(url ?? '/', 'http://tailnet.invalid')
  } catch {
    return new URL('/', 'http://tailnet.invalid')
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
