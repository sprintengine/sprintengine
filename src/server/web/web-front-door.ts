import { randomBytes } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { StudioRpcService } from '../../main/studio-rpc/studio-rpc-service'
import type { StudioCore } from '../core/studio-core'
import type { StudioGateway } from '../core/studio-gateway'
import { provideServerChat, type ServerChatHandles } from '../desktop/server-chat'
import { extensionFrameDocuments } from '../extensions/frames/frame-cache'
import { createExtensionFrameRoute } from '../extensions/frames/frame-route'
import { writeFileAtomicSync } from '../platform/atomic-file'
import type { StudioAuthenticator } from '../rpc/studio-rpc-types'
import type { WebDevicesStatus } from '../../shared/web-client'
import { createPreviewService } from './preview-service'
import { createPairRequests } from './web-pair-requests'
import { browseFolders } from './folder-browser'
import { createWebListener, type WebListener } from './web-listener'
import { createWebSessionStore, type WebSessionStore } from './web-sessions'
import { openWebStaticRoot, type WebStaticRoot } from './web-static'
import { createEmbedRoutes } from './embed-routes'
import { createMcpHttpRoutes } from './mcp-http-routes'
import { createEmbedStore, gateEmbedFrames, type EmbedStore } from './embeds'
import { WEB_RUN_FILENAME, readWebRunFile, type WebRunFile } from './web-run-file'
import { serveWebOnTailnet, type WebTailscaleServe } from './web-tailscale-serve'
import { createWebUploads } from './web-uploads'

// The web client's side of a standalone server (phase 9): the web listener,
// the browser sessions it admits, and what a web tab reaches through it. Off
// unless `studio-server serve --web` asks for it, so a server nobody opened a
// browser to answers no HTTP at all.
//
// A web tab is Studio's own renderer in a browser. It reaches the server on
// the Studio protocol (`/ws`) alone, behind its session cookie, as a desktop
// window reaches its own: what only a tab asks (the folder browser, previews)
// is the front door's, provided to the protocol once it starts (`web-tab`).
//
// The run file (`run/web.json`, 0600 in the owner-only `run/`) says where the
// listener is and holds the key `studio-server pair` mints a code with: being
// able to read it is being this server's owner on this machine.

export type WebFrontDoorOptions = {
  port: number
  publicOrigins: readonly string[]
  devOrigin?: string | null
  /** Where `build:web` wrote the bundle. */
  staticDir: string | null
  /** Publish the listener on the tailnet over HTTPS with `tailscale serve`, on this port (R19). */
  tailscaleServe?: { port: number } | null
}

export type WebFrontDoor = {
  listener: WebListener
  sessions: WebSessionStore
  url: string
  stop(): Promise<void>
}

/** The authenticator an embed's socket says hello under: its ticket was the proof, and the embed is read live. */
export function embedAuthenticator(embeds: EmbedStore, embedId: string): StudioAuthenticator {
  const clientId = `embed:${embedId}`
  return {
    authenticate() {
      const grant = embeds.grantFor(embedId)
      return grant ? { ok: true, grant } : { ok: false, message: 'This embed was revoked or has expired.' }
    },
    grantFor: (id) => (id === clientId ? embeds.grantFor(embedId) : null),
    onRevoked: (listener) =>
      embeds.onRevoked((revoked) => {
        if (revoked === embedId) listener(clientId)
      }),
    onGrantChanged: () => () => undefined,
  }
}

/** The authenticator a session's socket says hello under: the cookie was the proof, at the upgrade. */
export function sessionAuthenticator(sessions: WebSessionStore, sessionId: string): StudioAuthenticator {
  const clientId = `web:${sessionId}`
  return {
    authenticate() {
      const grant = sessions.grantFor(sessionId)
      return grant
        ? { ok: true, grant }
        : { ok: false, message: 'This browser’s pairing was removed or has expired. Pair it again.' }
    },
    grantFor: (id) => (id === clientId ? sessions.grantFor(sessionId) : null),
    onRevoked: (listener) =>
      sessions.onRevoked((revoked) => {
        if (revoked === sessionId) listener(clientId)
      }),
    onGrantChanged: () => () => undefined,
    recordSeen: () => sessions.recordSeen(sessionId),
  }
}

export async function startWebFrontDoor(input: {
  core: StudioCore
  gateway: StudioGateway
  rpc: StudioRpcService
  environmentId: string
  version: string
  options: WebFrontDoorOptions
  log?: (message: string) => void
}): Promise<WebFrontDoor> {
  const { core, gateway, rpc } = input
  const dataDir = core.platform.paths.dataDir()
  const sessions = createWebSessionStore({
    database: core.database,
    environmentId: input.environmentId,
    log: input.log,
  })

  let domains: ServerChatHandles | null = null
  domains = provideServerChat({
    core,
    gateway,
    studioRpc: rpc,
    // No terminals on the web (ruling a): a chat is not handed to one.
    terminalHandoff: async () => ({ ok: false, message: 'Terminals are not available in a browser.' }),
  })

  // Previews: an agent's dev server on an origin of its own, per session.
  let listenerPort: number | null = null
  const previews = createPreviewService({
    ownPorts: () => (listenerPort === null ? [] : [listenerPort]),
    studioOrigins: () => (listenerPort === null ? [] : listener.origins()),
    log: input.log,
  })
  // What only a web tab asks: the folder browser and previews, each as the
  // asking browser, whose grant names its session (`web:<session id>`). Both
  // show this machine, so a browser paired over the tailnet is told so in
  // words (R77: previews are not granted to tailnet pairings by default).
  const sessionOfClient = (clientId: string): string | null =>
    clientId.startsWith('web:') ? clientId.slice('web:'.length) : null
  const onLoopback = (clientId: string): boolean => sessions.get(sessionOfClient(clientId) ?? '')?.route === 'loopback'
  const previewsChanged = new Set<() => void>()
  const stopPreviewPushes = previews.onChanged(() => {
    for (const listener of [...previewsChanged]) listener()
  })
  rpc.provideWebTab({
    browse: async (clientId, request) =>
      onLoopback(clientId)
        ? browseFolders(request)
        : { ok: false, message: 'Folders are browsed from a browser on the machine Studio runs on.' },
    ports: async (clientId) => (onLoopback(clientId) ? previews.list() : { ports: [] }),
    open: async (clientId, request) => {
      const sessionId = sessionOfClient(clientId)
      if (!sessionId || !onLoopback(clientId))
        return { ok: false, message: 'Previews open in a browser on the machine Studio runs on.' }
      return previews.open({ port: request.port, sessionId, typed: request.typed === true, name: request.host })
    },
    close: async (clientId, previewId) => {
      const sessionId = sessionOfClient(clientId)
      return sessionId ? previews.close(previewId, sessionId) : false
    },
    previews: (clientId) => {
      const sessionId = sessionOfClient(clientId)
      return sessionId ? previews.previewsOf(sessionId) : []
    },
    onPreviewsChanged(listener) {
      previewsChanged.add(listener)
      return () => {
        previewsChanged.delete(listener)
      }
    },
  })
  // A removed browser's previews close with it.
  const stopPreviewRevocations = sessions.onRevoked((sessionId) => void previews.closeSession(sessionId))
  // A removed browser's uploads go with it.
  const uploads = createWebUploads({ dataDir })
  const stopUploadRevocations = sessions.onRevoked((sessionId) => uploads.forgetSession(sessionId))

  // Devices: the browsers paired here, and the ones asking by approval.
  const pairRequests = createPairRequests({ sessions })
  const devicesStatus = (current?: string): WebDevicesStatus => {
    return {
      devices: sessions.list().map((session) => ({
        id: session.id,
        name: session.name,
        route: session.route,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        current: session.id === current,
      })),
      requests: pairRequests.pending(),
      origins: listener.origins(),
    }
  }
  // Settings ▸ Browsers, over the Studio protocol (`webDevices.*`): every
  // owner connection follows its changes; a browser's own row is marked by
  // its grant (`web:<session id>`). A pairing link, a credential in the
  // answer, is not served to a tab: a new browser asks by approval, or is
  // paired with `studio-server pair` on this machine.
  const devicesChanged = new Set<() => void>()
  const announceDevices = () => {
    for (const listener of [...devicesChanged]) listener()
  }
  const stopRequestPushes = pairRequests.onChanged(announceDevices)
  const stopRevokePushes = sessions.onChanged(announceDevices)
  rpc.provideWebDevices({
    status: (clientId) => devicesStatus(clientId.startsWith('web:') ? clientId.slice('web:'.length) : undefined),
    revoke: (id) => sessions.revoke(id),
    approve: (requestId, code) => pairRequests.approve(requestId, code),
    decline: (requestId) => pairRequests.decline(requestId),
    onChanged(listener) {
      devicesChanged.add(listener)
      return () => {
        devicesChanged.delete(listener)
      }
    },
  })

  // Embeds: one conversation, read-only, framed by the pages their owner
  // named. Made, listed and revoked by `studio-server embed` (`embed-routes.ts`).
  const embeds = createEmbedStore({ database: core.database, log: input.log })
  const stopEmbedRevocations = embeds.onRevoked((embedId) => listener.closeEmbedSockets(embedId))
  // A session or an embed that runs out is pruned when its store is next
  // read, and the prune is what closes its sockets with 4401. A tab's tunnel
  // reads no store per frame, so the stores are read once a minute: what ran
  // out is closed within a minute of it, whether anything else asks or not.
  const expiry = setInterval(() => {
    sessions.list()
    embeds.list()
  }, 60_000)
  expiry.unref()

  const mintKey = randomBytes(32).toString('base64url')
  let staticRoot: WebStaticRoot | null = null
  const listener = createWebListener({
    sessions,
    staticRoot: (staticRoot =
      input.options.staticDir && existsSync(input.options.staticDir)
        ? openWebStaticRoot(input.options.staticDir)
        : null),
    port: input.options.port,
    publicOrigins: input.options.publicOrigins,
    devOrigin: input.options.devOrigin ?? null,
    mintKey,
    pairRequests,
    uploads,
    version: input.version,
    studio: {
      connect(stream, who) {
        if ('session' in who) {
          rpc.connectWeb(stream, {
            authenticator: sessionAuthenticator(sessions, who.session.id),
            ownWindow: who.session.owner,
          })
          return
        }
        if (who.ticket.kind === 'session') {
          rpc.connectWeb(stream, {
            authenticator: sessionAuthenticator(sessions, who.ticket.sessionId),
            ownWindow: false,
            // A browser on the tailnet searches only the folders Studio knows.
            knownFoldersOnly: sessions.get(who.ticket.sessionId)?.route !== 'loopback',
          })
          return
        }
        const embed = embeds.get(who.ticket.embedId)
        if (!embed) {
          stream.destroy()
          return
        }
        // Read-only by its grant, and held to its one conversation by the gate.
        rpc.connectWeb(gateEmbedFrames(stream, embed.conversation), {
          authenticator: embedAuthenticator(embeds, embed.embedId),
          ownWindow: false,
        })
      },
    },
    extraRoutes: [
      createEmbedRoutes({
        embeds,
        sessions,
        staticRoot: () => staticRoot,
        pageHeaders: (origin, frameAncestors) => listener.pageHeaders(origin, frameAncestors),
        mintKey,
      }),
      // `studio-server mcp-token`: a token to the agents' loopback endpoint, made on the machine.
      createMcpHttpRoutes({ mintKey, create: (name) => gateway.createMcpHttpClient(name) }),
      // An extension's frame document, built for this tab over the Studio protocol (`extension.frame`).
      createExtensionFrameRoute(extensionFrameDocuments),
    ],
    log: input.log,
  })
  const { port } = await listener.start()
  listenerPort = port
  const url = `http://127.0.0.1:${port}`

  let tailnet: WebTailscaleServe | null = null
  if (input.options.tailscaleServe) {
    try {
      tailnet = await serveWebOnTailnet({
        localPort: port,
        servePort: input.options.tailscaleServe.port,
        runDir: join(dataDir, 'run'),
        log: input.log,
      })
    } catch (error) {
      await listener.stop().catch(() => undefined)
      throw error
    }
    listener.addTailscaleServeOrigin(tailnet.origin)
  }

  const runFile = join(dataDir, 'run', WEB_RUN_FILENAME)
  const body: WebRunFile = { pid: process.pid, port, url, origins: listener.origins(), mintKey }
  writeFileAtomicSync(runFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, exactMode: true })

  return {
    listener,
    sessions,
    url,
    async stop() {
      clearInterval(expiry)
      stopPreviewPushes()
      stopPreviewRevocations()
      stopUploadRevocations()
      stopEmbedRevocations()
      stopRequestPushes()
      stopRevokePushes()
      await tailnet?.stop().catch(() => undefined)
      await previews.stop()
      await listener.stop()
      await domains?.conversationCommands.dispose().catch(() => undefined)
      domains = null
      // Only this run's file: another server may have written its own since.
      if (readWebRunFile(dataDir)?.pid === process.pid) {
        try {
          unlinkSync(runFile)
        } catch {
          // Already gone.
        }
      }
    },
  }
}
