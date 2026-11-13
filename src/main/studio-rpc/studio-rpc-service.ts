import type { Duplex } from 'node:stream'
import type { ConversationPullRequests } from '../automation/conversation-pull-request-tools'

import { toolError, toolSuccess } from '../../shared/modules/mcp-tools'
import type {
  StudioLocalAppOfferView,
  StudioLocalAppToolReach,
  StudioLocalAppsStatus,
} from '../../shared/studio-local-apps'
import type { StudioWebDevicesDomain } from '../../server/rpc/studio-web-devices'
import type { AppIdentity } from '../../server/platform/app-identity'
import type { StudioAccessDomain } from '../../server/rpc/studio-access'
import type { StudioTailnetDomain } from '../../server/rpc/studio-tailnet'
import { studioPlatform } from '../../server/platform/platform'
import { readStudioEnvironmentId } from '../../server/environment/environment-id'
import type { StudioPaths } from '../../server/platform/studio-paths'
import {
  createTicketAuthenticator,
  framePortStream,
  mintStudioTicket,
  type StudioFramePort,
} from '../../server/rpc/studio-frame-port'
import {
  createStudioWindowListener,
  type StudioWindowListener,
  type StudioDeviceTicketRequest,
  type StudioWindowTicketRequest,
} from '../../server/rpc/studio-window-listener'
import type { StudioWindowTicket } from '../../shared/studio-connection'
import { inProcessStudioTransport } from '../../server/rpc/studio-in-process-port'
import {
  STUDIO_SCOPES,
  type StudioEnvironmentReadiness,
  type StudioRelayedEnvironment,
  type StudioGrant,
} from '../../../packages/studio-protocol/src/public'
import type { StudioTransportFactory } from '../../../packages/client-runtime/src/public'
import {
  createStudioRpcServer,
  type StudioRpcServer,
  type StudioRpcServerOptions,
} from '../../server/rpc/studio-rpc-server'
import type { ClientToolRegistry } from '../../server/tools/client-tool-registry'
import type { StudioFiles } from '../../server/rpc/studio-files'
import type { StudioFileSystem } from '../../server/files/studio-file-system'
import type { StudioGit } from '../../server/git/studio-git-types'
import type { StudioWorktrees } from '../../server/worktrees/studio-worktrees-types'
import type { StudioWorkspaceSync } from '../../server/workspaces/studio-workspace-sync'
import type { StudioExtensions } from '../../server/extensions/extensions-domain'
import type { StudioArtifacts } from '../../server/artifacts/artifacts-domain'
import type { StudioPullRequests } from '../../server/pull-requests/pull-request-domain'
import type { StudioLocalServers } from '../../server/local-servers/local-server-domain'
import type { StudioTerminals } from '../../server/terminals/studio-terminals'
import type { CliRuntimes } from '../cli-runtimes'
import type { StudioAgentSettings } from '../../server/agent-settings/agent-settings-domain'
import type { StudioAgentSetup } from '../../server/agent-setup/agent-setup-domain'
import type { StudioSchedulesDomain } from '../../server/schedules/schedules-domain'
import type { StudioPhoneReads } from '../../server/backlog/backlog-domain'
import type { StudioChatLifecycleDomain } from '../../server/chat-lifecycle/chat-lifecycle-domain'
import type { StudioCanvasDomain } from '../../server/canvas/canvas-domain'
import type { StudioChatStores } from '../../server/chat-stores/chat-stores-domain'
import type { StudioAgentSkills } from '../../server/core/studio-agent-skills'
import type { StudioUpdates } from '../../server/update/studio-updates'
import type { SignIns } from '../../server/machine/machine-sign-in'
import type { EnvironmentAdoption } from '../../server/environment/environment-adoption'
import type { StudioModules } from '../../server/rpc/studio-modules'
import type {
  StudioAuditEntry,
  StudioAuthenticator,
  StudioChatBackend,
  StudioConversationBackend,
  StudioDiscovery,
} from '../../server/rpc/studio-rpc-types'
import type { GatewayAuditStore } from '../automation/gateway-audit'
import { createResyncBackoff } from '../automation/tailnet/tailnet-conversation-stream'
import { createStudioLocalAppStore, type StudioLocalAppStore } from './studio-local-app-store'

// The Studio RPC inside the running app: the owner socket in <userData>/run,
// the paired local apps it admits, and the Settings front door that pairs and
// revokes them. Started with the app and stopped with it; a listener that
// cannot start (another Studio on this profile, a directory someone else owns)
// is reported in Settings and changes nothing else the app does.
//
// Studio's own windows reach the same RPC over a WebSocket on 127.0.0.1 (the
// window listener, `windowTicket`), each connection admitted by a ticket main
// asks for on the window's behalf. That way in does not depend on the owner
// socket: a window connects whether or not the socket started.

const REFUSAL_WINDOW_MS = 60_000
const REFUSALS_PER_WINDOW = 5

export type StudioRpcService = {
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): StudioLocalAppsStatus
  /** Mint a one-time pairing code for an app, named and scoped in Settings. */
  offer(input: unknown): StudioLocalAppOfferView
  cancelOffer(id: unknown): StudioLocalAppsStatus
  /**
   * Revoke an app: its token, its connections, its toolset names and every
   * approval that allows one of its tools. The revocation itself is done when
   * this returns; the approvals are forgotten by the time it settles.
   */
  revoke(id: unknown): Promise<StudioLocalAppsStatus>
  /** Change which agents an app's tools reach. */
  setToolReach(id: unknown, reach: unknown): StudioLocalAppsStatus
  /** This run's owner credential, for the desktop's own client. Never written to disk. */
  ownerToken(): string
  /**
   * A ticket for one connection of one of Studio's windows to the window
   * listener, which starts on the first ask: good once, within thirty seconds,
   * from the window's origin. Nothing longer-lived reaches the window.
   */
  windowTicket(request: StudioWindowTicketRequest): Promise<StudioWindowTicket>
  /** A window has gone (closed, crashed, navigated away): its tickets are void and its connections end. */
  revokeWindow(windowKey: string): void
  /**
   * Serve a socket the desktop that holds this Studio carried here through its
   * front door (`ws`) as a connection to the window listener: what is admitted
   * is what that listener admits, a ticket it minted (`environment.windowTicket`),
   * from the origin and to the host it was minted for.
   */
  acceptWindowStream(stream: Duplex): void
  /**
   * Serve the desktop's shell over a port main holds the other end of, when
   * the server runs in a process of its own (phase 6, 6.3): the shell role,
   * for a ticket good once, as `shellTransport` gives it in process.
   */
  connectShell(port: StudioFramePort): { connectionId: string; ticket: string }
  /**
   * Serve a WSL distribution's front door over a byte stream that already
   * proved it holds the owner token (phase 7): the shell role, as
   * `connectShell` serves the desktop's, for a ticket good once.
   */
  connectShellStream(stream: Duplex): { connectionId: string; ticket: string }
  /**
   * Serve a browser's socket from the web listener (phase 9): a web tab that
   * proved its session cookie at the upgrade, or a client that spent a
   * ticket. The authenticator is the session's or the ticket's; `ownWindow`
   * is true only for an owner's web tab, which is the app's own chat view in a
   * browser and asks what a window asks.
   */
  connectWeb(
    stream: Duplex,
    input: { authenticator: StudioAuthenticator; ownWindow: boolean; knownFoldersOnly?: boolean },
  ): { connectionId: string }
  /**
   * Serve a paired device's socket from the tailnet listener
   * (`/tailnet/v1/studio`): the phone, or another desktop's window. Its
   * authenticator is the device's, whose grant is read from the device store
   * at every request and is never an owner's; it is a client of this server,
   * audited, and the folders it names are held to the ones Studio knows.
   */
  connectDevice(stream: Duplex, authenticator: StudioAuthenticator): { connectionId: string }
  /** The chat surface, from the handlers the app's own IPC serves its windows with. */
  provideChat(chat: StudioChatBackend): void
  /** The web listener's paired browsers, from the front door once it starts (`web-devices`). */
  provideWebDevices(domain: StudioWebDevicesDomain): void
  /** Which agents a paired app's tools reach. */
  toolReachOf(clientId: string): StudioLocalAppToolReach
  /**
   * Connections for the desktop's own shell, in this process: each is served
   * as the shell (it may offer the built-in toolsets) and says hello with a
   * ticket minted for it alone.
   */
  shellTransport(): StudioTransportFactory
}

// Paths, the version and the push to Settings come from the Studio platform
// (src/server/platform), read when used, so the service runs unchanged on the
// Electron platform now and on a standalone server's later. No secret is
// sealed here: a paired app's token is kept only as its hash, which needs no
// cipher, and the owner token is never written down at all.
export type StudioRpcServiceOptions = {
  /** Defaults to the installed platform's: `dataDir` is where `run/` and the paired apps live. */
  paths?: Pick<StudioPaths, 'dataDir'>
  /** Defaults to the installed platform's: the version a welcome and the discovery file name. */
  identity?: AppIdentity
  /**
   * The agents' gateway, for the access family (`gateway.status`, `mcpHttp.*`);
   * with the paired apps this service keeps, it is served as `access`. Absent,
   * the family is not offered.
   */
  gatewayAccess?: Pick<StudioAccessDomain, 'gatewayStatus' | 'mcpHttpStatus' | 'createMcpHttp' | 'revokeMcpHttp'>
  /** The gateway's tailnet listener and the machines it drives, served as `tailnet`. Absent, the family is not offered. */
  tailnet?: StudioTailnetDomain
  /** Where this Studio runs, as its welcome says: `local` unless its server was started in WSL or over SSH. */
  hostKind?: StudioRpcServerOptions['hostKind']
  /** Built on first start: the conversation host it wraps is constructed late in the app's composition. */
  backend: () => StudioConversationBackend
  /** The gateway's audit, so one file records every listener's mutations. */
  audit: () => GatewayAuditStore
  /** The client toolsets the gateway lists to agents, offered over this RPC. */
  tools?: ClientToolRegistry
  /** Files under a workspace's roots, for owners (`files-write`). */
  files?: StudioFiles
  /** The files on this machine by path (`file-system`, `files-mention`). */
  fileSystem?: StudioFileSystem
  /** Git on this machine (`git`). */
  git?: StudioGit
  /** The worktrees its agents run in, and deleting settled chats (`worktrees`). */
  worktrees?: StudioWorktrees
  /** The desktop's own windows' workspace registry (`workspace-sync`). */
  workspaceSync?: StudioWorkspaceSync
  /** The marketplace, the CLI catalogue, the scaffold and the feeds (`extensions`). */
  extensions?: StudioExtensions
  /** Settings ▸ Artifacts and its set-up question (`artifacts`). */
  artifacts?: StudioArtifacts
  /** The pull requests the conversations opened, for owners (`pull-requests`). */
  pullRequests?: StudioPullRequests
  /** A chat's "Create PR" in its checkout here, for owners (`pull-request-create`). */
  pullRequestCreation?: ConversationPullRequests
  /** The local servers the conversations started, for owners (`local-servers`). */
  localServers?: StudioLocalServers
  /** What a client reads before it starts a chat (`workspaces`). */
  discovery?: StudioDiscovery
  /** What this machine has and lacks for its background work (`environment-readiness`). */
  readiness?: () => Promise<StudioEnvironmentReadiness>
  /** The machines this desktop relays its paired devices to (`relayed-environments`). */
  relayedEnvironments?: () => Promise<StudioRelayedEnvironment[]>
  /** A CLI's login on this machine with no terminal (`provider-sign-in-flow`): a server a desktop reaches over its front door. */
  signIns?: () => Promise<SignIns>
  /** Records the desktop that holds this Studio hands over (`environment-adopt`): a server a desktop reaches over its front door. */
  adoption?: EnvironmentAdoption
  /** The terminals on this machine (`terminals`): given only where this process holds the terminal runtime. */
  terminals?: StudioTerminals
  /** The CLIs on this machine (`agent-runtimes`): the core's, which every Studio gives (studio-rpc.ts). */
  runtimes?: CliRuntimes
  /** The launch settings and the CLIs' texts (`agent-settings`). */
  agentSettings?: StudioAgentSettings
  /** What the agents are set up with beyond their CLIs (`agent-setup`): the core's, which every Studio gives. */
  agentSetup?: StudioAgentSetup
  /** What the Studio keeps beside its chats (`chat-stores`). */
  chatStores?: StudioChatStores
  /** The projects' backlogs, the machine's shares and the pull request reads. */
  phoneReads?: StudioPhoneReads
  /** The skills, design systems and cards the agents are given (`agent-skills`): the core's, which every Studio gives. */
  agentSkills?: StudioAgentSkills
  /** The scheduled agents this Studio runs (`schedules`). */
  schedules?: StudioSchedulesDomain
  /** The chats' records beyond their rest (`chat-lifecycle`). */
  chatLifecycle?: StudioChatLifecycleDomain
  /** The machine's boards, for another device (`canvas-boards`): where the canvas service runs in this process. */
  canvas?: StudioCanvasDomain
  /** How this Studio is updated (`update.*`); by hand when not given. */
  updates?: StudioUpdates
  /** What the modules beside this Studio say to clients: `module.events` and `module.notifications`. */
  modules?: StudioModules
  /** Forget the saved approvals that allow a revoked app's tools. */
  forgetToolApprovals?: (toolsets: string[]) => Promise<unknown>
  log?: (message: string) => void
  /** A socket path or pipe name of the caller's choosing (tests). */
  socketPath?: string
  now?: () => number
}

/** The grant the desktop's own shell holds: the owner's, under the app's name. */
function shellGrant(): StudioGrant {
  return { clientId: 'owner', name: 'SprintEngine Studio', owner: true, scopes: [...STUDIO_SCOPES], ceiling: 'bypass' }
}

export function createStudioRpcService(options: StudioRpcServiceOptions): StudioRpcService {
  const dataDir = () => (options.paths ?? studioPlatform().paths).dataDir()
  const version = () => (options.identity ?? studioPlatform().identity).version()
  // Every change to the paired apps, with fresh status: the `localApps.changed` stream.
  const appListeners = new Set<(status: StudioLocalAppsStatus) => void>()
  const now = options.now ?? Date.now
  let store: StudioLocalAppStore | null = null
  // Built on first need (a window connecting, or the socket starting) and kept
  // for the run: its router holds the receipts and uploads every way in shares.
  let server: StudioRpcServer | null = null
  let chat: StudioChatBackend | null = null
  let webDevices: StudioWebDevicesDomain | null = null
  let lastError: string | null = null
  let starting: Promise<void> | null = null
  let windows: StudioWindowListener | null = null

  /** A listener's ticket as the desktop that holds this Studio is told it: the path, never this machine's port. */
  function grantOf(minted: StudioWindowTicket): { token: string; path: string } {
    const url = new URL(minted.url)
    return { token: minted.token, path: `${url.pathname}${url.search}` }
  }

  function windowListener(): StudioWindowListener {
    windows ??= createStudioWindowListener({
      // A device the desktop that holds this Studio relays: a client of this
      // server, audited, held to the folders it knows, never an owner.
      attachDevice: (stream, deviceAuthenticator) =>
        hub().attach(stream, {
          authenticator: deviceAuthenticator,
          ownWindow: false,
          audited: true,
          knownFoldersOnly: true,
        }),
      attach: (stream, windowAuthenticator, windowKey) =>
        hub().attach(stream, {
          authenticator: windowAuthenticator,
          windowKey,
          // The window is the app's own chat view: shown conversations as its
          // IPC shows them, and its actions are not a client's to audit.
          ownWindow: true,
        }),
      now,
      log: options.log,
    })
    return windows
  }

  const appStore = (): StudioLocalAppStore => {
    if (!store) {
      store = createStudioLocalAppStore({ resolveUserDataDir: dataDir, log: options.log })
      store.onChanged(() => announce())
      // What an app offers, and whether it is connected, shows on its row.
      options.tools?.subscribe(() => announceSoon())
    }
    return store
  }

  function status(): StudioLocalAppsStatus {
    const connected = new Set(
      (server?.connections() ?? []).map((connection) => connection.clientId()).filter((id) => id !== null),
    )
    return {
      running: server?.isRunning() ?? false,
      socketPath: server?.socketPath() ?? null,
      lastError,
      apps: appStore()
        .list()
        .map((app) => ({
          ...app,
          connected: connected.has(app.id),
          toolsets: options.tools?.toolsetsOf(app.id) ?? [],
        })),
      offers: appStore().offers(),
    }
  }
  let announcing = false
  /** A burst of offers and withdrawals is one push to Settings. */
  function announceSoon(): void {
    if (announcing) return
    announcing = true
    setImmediate(() => {
      announcing = false
      announce()
    })
  }
  function announce(): void {
    if (appListeners.size === 0) return
    let current: StudioLocalAppsStatus
    try {
      current = status()
    } catch (error) {
      options.log?.(`Local apps push failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const listener of [...appListeners]) {
      try {
        listener(current)
      } catch (error) {
        options.log?.(`Local apps push failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  function authenticator(apps: StudioLocalAppStore): StudioAuthenticator {
    return {
      authenticate(auth) {
        if ('pairingCode' in auth) {
          const redeemed = apps.redeem(auth.pairingCode)
          return redeemed.ok
            ? { ok: true, grant: redeemed.grant, pairingToken: redeemed.token }
            : { ok: false, message: redeemed.message }
        }
        const grant = apps.authenticate(auth.token)
        return grant
          ? { ok: true, grant }
          : {
              ok: false,
              message: 'This app is not paired with Studio, or its pairing was revoked. Pair it again in Settings.',
            }
      },
      grantFor: (clientId) => apps.grantFor(clientId),
      onRevoked: (listener) => apps.onRevoked(listener),
      // A grant is fixed at pairing; it changes only by revocation.
      onGrantChanged: () => () => undefined,
      recordSeen: (clientId) => apps.recordSeen(clientId),
    }
  }

  // One record per mutation and per refusal at the door, into the gateway's
  // own audit: the app is the connection, the conversation and command id the
  // targets. A message's text never reaches it.
  // Refused credentials are kept, but not without bound: a process looping on a
  // bad token would otherwise rotate the 2 MB log and push out the records it
  // exists for. A few per minute are written; the rest are counted, and the
  // count rides on the next one written.
  const refusals = { windowStart: Number.NEGATIVE_INFINITY, written: 0, suppressed: 0 }
  function admitRefusal(): number | null {
    const at = now()
    if (at - refusals.windowStart >= REFUSAL_WINDOW_MS) {
      refusals.windowStart = at
      refusals.written = 0
    }
    if (refusals.written >= REFUSALS_PER_WINDOW) {
      refusals.suppressed++
      return null
    }
    refusals.written++
    const suppressed = refusals.suppressed
    refusals.suppressed = 0
    return suppressed
  }

  function audit(entry: StudioAuditEntry & { suppressed?: number }): void {
    if (entry.tool === 'studio.auth_refused') {
      const suppressed = admitRefusal()
      if (suppressed === null) return
      if (suppressed > 0) entry = { ...entry, suppressed }
    }
    options.audit().record({
      connection: {
        kind: 'studio-client',
        ...(entry.clientId ? { clientId: entry.clientId } : {}),
        clientName: entry.clientName,
      },
      tool: entry.tool,
      durationMs: entry.durationMs,
      args: {
        ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
        ...(entry.commandId ? { id: entry.commandId } : {}),
        ...(entry.suppressed ? { suppressed: entry.suppressed } : {}),
        ...(entry.toolset ? { toolset: entry.toolset } : {}),
        ...(entry.tools !== undefined ? { tools: entry.tools } : {}),
        ...(entry.moduleId ? { moduleId: entry.moduleId } : {}),
        ...(entry.moduleMethod ? { method: entry.moduleMethod } : {}),
      },
      result: entry.ok
        ? toolSuccess({ ok: true })
        : toolError(entry.code ?? 'refused', 'The Studio RPC request was not carried out.'),
    })
  }

  // Pairing and revoking are the serving Studio's. One whose socket did not
  // start (another Studio serves this profile) would write the same store
  // under it, and its codes could never be redeemed here.
  function assertServing(): void {
    if (!server?.isRunning())
      throw new Error('This Studio is not serving the local app socket, so it cannot pair or revoke apps.')
  }

  // The access family: the gateway's half as the caller gives it, and the
  // paired apps, which this service keeps.
  function accessDomain(gateway: NonNullable<StudioRpcServiceOptions['gatewayAccess']>): StudioAccessDomain {
    return {
      gatewayStatus: () => gateway.gatewayStatus(),
      mcpHttpStatus: () => gateway.mcpHttpStatus(),
      createMcpHttp: (name) => gateway.createMcpHttp(name),
      revokeMcpHttp: (id) => gateway.revokeMcpHttp(id),
      localApps: {
        status,
        offer: (input) => api.offer(input),
        cancelOffer: (id) => api.cancelOffer(id),
        revoke: (id) => api.revoke(id),
        setReach: (id, reach) => api.setToolReach(id, reach),
        onChanged(listener) {
          appListeners.add(listener)
          return () => {
            appListeners.delete(listener)
          }
        },
      },
    }
  }

  function hub(): StudioRpcServer {
    if (server) return server
    const directory = dataDir()
    server = createStudioRpcServer({
      dataDir: directory,
      version: version(),
      environmentId: readStudioEnvironmentId(directory),
      ...(options.hostKind ? { hostKind: options.hostKind } : {}),
      backend: options.backend(),
      chat: () => chat,
      webDevices: () => webDevices,
      authenticator: authenticator(appStore()),
      audit,
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.files ? { files: options.files } : {}),
      ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
      ...(options.git ? { git: options.git } : {}),
      ...(options.worktrees ? { worktrees: options.worktrees } : {}),
      ...(options.workspaceSync ? { workspaceSync: options.workspaceSync } : {}),
      ...(options.extensions ? { extensions: options.extensions } : {}),
      ...(options.artifacts ? { artifacts: options.artifacts } : {}),
      ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
      ...(options.pullRequestCreation ? { pullRequestCreation: options.pullRequestCreation } : {}),
      ...(options.localServers ? { localServers: options.localServers } : {}),
      ...(options.discovery ? { discovery: options.discovery } : {}),
      ...(options.readiness ? { readiness: options.readiness } : {}),
      ...(options.relayedEnvironments ? { relayedEnvironments: options.relayedEnvironments } : {}),
      ...(options.signIns ? { signIns: options.signIns } : {}),
      ...(options.adoption ? { adoption: options.adoption } : {}),
      // The desktop that holds a WSL or SSH machine's Studio connects its
      // windows to this one's listener through its front door (`ws`), asking
      // for each connection's ticket here, over its own shell connection.
      ...(options.hostKind === 'wsl' || options.hostKind === 'ssh'
        ? {
            environmentAccess: {
              windowTicket: async (request: StudioWindowTicketRequest) =>
                grantOf(await windowListener().ticket(request)),
              revokeWindow: (windowKey: string) => windows?.revokeWindow(windowKey),
              deviceTicket: async (request: StudioDeviceTicketRequest) =>
                grantOf(await windowListener().deviceTicket(request)),
            },
          }
        : {}),
      ...(options.terminals ? { terminals: options.terminals } : {}),
      ...(options.runtimes ? { runtimes: options.runtimes } : {}),
      ...(options.agentSettings ? { agentSettings: options.agentSettings } : {}),
      ...(options.agentSetup ? { agentSetup: options.agentSetup } : {}),
      ...(options.chatStores ? { chatStores: options.chatStores } : {}),
      ...(options.phoneReads ? { phoneReads: options.phoneReads } : {}),
      ...(options.agentSkills ? { agentSkills: options.agentSkills } : {}),
      ...(options.schedules ? { schedules: options.schedules } : {}),
      ...(options.chatLifecycle ? { chatLifecycle: options.chatLifecycle } : {}),
      ...(options.canvas ? { canvas: options.canvas } : {}),
      ...(options.updates ? { updates: options.updates } : {}),
      ...(options.modules ? { modules: options.modules } : {}),
      ...(options.gatewayAccess ? { access: accessDomain(options.gatewayAccess) } : {}),
      ...(options.tailnet ? { tailnet: options.tailnet } : {}),
      resyncRetryAfterMs: createResyncBackoff(),
      onConnectionsChanged: () => announce(),
      ...(options.socketPath ? { socketPath: options.socketPath } : {}),
      log: options.log,
    })
    return server
  }

  async function startNow(): Promise<void> {
    try {
      await hub().start()
      lastError = null
    } catch (error) {
      lastError = `The local app socket did not start: ${error instanceof Error ? error.message : String(error)}`
      options.log?.(lastError)
    }
    announce()
  }

  const api: StudioRpcService = {
    start() {
      if (server?.isRunning()) return Promise.resolve()
      starting ??= startNow().finally(() => {
        starting = null
      })
      return starting
    },
    async stop() {
      await starting
      await server?.stop()
      await windows?.stop()
    },
    getStatus: status,
    // Pairing and revoking are recorded too: they decide who may connect.
    offer(input) {
      assertServing()
      const { offer, code } = appStore().offer(input)
      audit({ clientId: null, clientName: offer.name, tool: 'studio.settings.pairing_code', ok: true, durationMs: 0 })
      return { offer, code, status: status() }
    },
    cancelOffer(id) {
      if (typeof id === 'string') appStore().cancelOffer(id)
      return status()
    },
    // The revocation is carried out before this returns, and a Studio that is
    // not serving refuses at once; only the approvals are forgotten after.
    revoke(id) {
      assertServing()
      if (typeof id !== 'string') return Promise.resolve(status())
      const clientName =
        appStore()
          .list()
          .find((app) => app.id === id)?.name ?? id
      // Read before the revocation, which releases them.
      const held = options.tools?.toolsetsOf(id).map((toolset) => toolset.name) ?? []
      let revoked = false
      try {
        revoked = appStore().revoke(id)
      } catch (error) {
        audit({
          clientId: id,
          clientName,
          tool: 'studio.settings.revoke',
          ok: false,
          code: 'write_failed',
          durationMs: 0,
        })
        throw error
      }
      if (revoked) audit({ clientId: id, clientName, tool: 'studio.settings.revoke', ok: true, durationMs: 0 })
      // Its names are released, and the approvals that allowed its tools go
      // with them: a later app that takes a name inherits no "always allow".
      const released = [...new Set([...held, ...(options.tools?.forgetClient(id) ?? [])])]
      return (async () => {
        if (released.length)
          try {
            await options.forgetToolApprovals?.(released)
          } catch (error) {
            options.log?.(
              `The approvals for a revoked app's tools could not be forgotten: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        return status()
      })()
    },
    setToolReach(id, reach) {
      assertServing()
      if (typeof id !== 'string' || (reach !== 'own' && reach !== 'all')) return status()
      if (appStore().setToolReach(id, reach)) options.tools?.refresh()
      return status()
    },
    ownerToken: () => appStore().ownerToken(),
    windowTicket: (request) => windowListener().ticket(request),
    revokeWindow(windowKey) {
      windows?.revokeWindow(windowKey)
    },
    acceptWindowStream(stream) {
      windowListener().accept(stream)
    },
    connectShell(port) {
      const ticket = mintStudioTicket()
      const connection = hub().attach(framePortStream(port), {
        authenticator: createTicketAuthenticator(ticket, { grant: shellGrant }),
        ownWindow: false,
        shell: true,
      })
      return { connectionId: connection.connectionId, ticket }
    },
    connectShellStream(stream) {
      const ticket = mintStudioTicket()
      const connection = hub().attach(stream, {
        authenticator: createTicketAuthenticator(ticket, { grant: shellGrant }),
        ownWindow: false,
        shell: true,
      })
      return { connectionId: connection.connectionId, ticket }
    },
    connectWeb(stream, input) {
      // A browser is a client of this server, whatever view it draws: audited.
      const connection = hub().attach(stream, {
        authenticator: input.authenticator,
        ownWindow: input.ownWindow,
        audited: true,
        browser: true,
        ...(input.knownFoldersOnly ? { knownFoldersOnly: true } : {}),
      })
      return { connectionId: connection.connectionId }
    },
    connectDevice(stream, authenticator) {
      const connection = hub().attach(stream, {
        authenticator,
        ownWindow: false,
        audited: true,
        knownFoldersOnly: true,
      })
      return { connectionId: connection.connectionId }
    },
    provideChat(next) {
      chat = next
    },
    provideWebDevices(next) {
      webDevices = next
    },
    toolReachOf: (clientId) => appStore().toolReachOf(clientId),
    shellTransport() {
      return async () => {
        const ticket = mintStudioTicket()
        return inProcessStudioTransport(
          (stream) => {
            hub().attach(stream, {
              authenticator: createTicketAuthenticator(ticket, { grant: shellGrant }),
              ownWindow: false,
              shell: true,
            })
          },
          () => ({ token: ticket }),
        )()
      }
    },
  }
  return api
}
