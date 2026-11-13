import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { ConversationEventType } from '../../shared/conversation-runtime'
import { createAutomationService } from '../../main/automation/automation-service'
import { createConversationTools, type ConversationToolsDeps } from '../../main/automation/conversation-tools'
import {
  createConversationChatTools,
  type ConversationChatControl,
} from '../../main/automation/conversation-chat-tools'
import { createSubagentTools } from '../../main/automation/subagent-tools'
import { LAUNCH_NOTICE_ORIGIN } from '../../main/agent-launch-notices'
import { createConversationPullRequestTools } from '../../main/automation/conversation-pull-request-tools'
import { listPluginRegistryEntries } from '../../main/plugin-registry-instance'
import { sharedGhRunner } from '../../main/github/gh'
import { createGhHostTokenResolver } from '../../main/github/host-token'
import {
  createConversationListChangeFilter,
  latestTurnEnd,
  movesWorkspaceList,
} from '../../main/automation/conversation-lifecycle'
import { launchPermissionCeiling } from '../../main/automation/launch-permission-cap'
import { createStudioGatewayTools } from '../../main/automation/studio-gateway-tools'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import { toolSuccess, toolError } from '../../shared/modules/mcp-tools'
import type { StudioListChange, StudioToolReach } from '../../../packages/studio-protocol/src/public'
import { createClientToolRegistry, type ClientToolRegistry } from '../tools/client-tool-registry'
import { createClientToolGateway, type ExpectedShellToolsets } from '../tools/client-tool-gateway'
import { cancelClientCallsAtTurnEnd } from '../tools/client-tool-turns'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { createClientToolsetStore, type ConversationRef } from '../tools/client-toolset-store'
import { createPullRequestTools } from '../pull-requests/pull-request-tools'
import { studioPullRequestCreationDeps } from '../pull-requests/pull-request-creation'
import { createLocalServerTools } from '../local-servers/local-server-tools'
import { studioBridgeScriptPath, type StudioCore } from './studio-core'
import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import { environmentRouteOfRecord } from '../../shared/environment-clients'
import { environmentCommand, environmentPage, launchWhereItLives } from './environment-chat-calls'

// The Studio MCP gateway over a core: the always-on socket agents reach the
// app through, the opt-in tailnet listener, and the conversation lane paired
// devices follow chats on. Composed beside the core rather than inside it,
// because the desktop adds tools that act on what only it has (windows,
// terminals, the browser pane, the canvas worker); a standalone server serves
// the core's own tools alone.

/** The conversation events that change what a paired device's list says: a start, an end, a phase. */
const CONVERSATION_LIST_EVENTS = new Set<ConversationEventType>([
  'session_started',
  'session_closed',
  'user_message',
  'turn_started',
  'turn_completed',
  'turn_failed',
  'approval_requested',
  'approval_resolved',
])

// The module host's contribution type, read off the tool set rather than
// imported from the host, whose file also names Electron's IPC types.
type GatewayToolsOptions = Parameters<typeof createStudioGatewayTools>[0]

export type StudioGatewayOptions = Pick<
  Parameters<typeof createAutomationService>[0],
  'onTailnetEvent' | 'onMeshEvent' | 'hasWindow' | 'tailnetBindAddress'
> & {
  /**
   * The gateway's app tools, given the core's own: the desktop places them
   * among its window and terminal tools, a server serves them as they are. The
   * order is the order agents list them in.
   */
  appTools?: (coreTools: McpToolRegistration[]) => McpToolRegistration[]
  /** Module-contributed tools, from the host kernel; empty until modules load. */
  resolveModuleTools?: GatewayToolsOptions['resolveModuleTools']
  /** Live enablement of a contributing module; resolved per call, never captured. */
  isModuleEnabled?: (moduleId: string) => boolean
  /**
   * The shell's toolsets this server lists from an agent's first `tools/list`
   * (the desktop's own: `browser`, `canvas`). A list that arrives before the
   * shell has offered them waits for them, up to five seconds. A server with
   * no shell of its own names none and never waits.
   */
  expectShellToolsets?: ExpectedShellToolsets
  /**
   * A gateway tool to leave out of every list now: a family the person
   * switched off (the agents' browser) while it is served here rather than
   * offered by the shell. Asked per list, so the switch holds without a restart.
   */
  hideTool?: (name: string) => boolean
  /**
   * Remember which agent started a chat through `conversation.create`, so it is
   * told when the chat's turn ends (agent-launch-notices.ts). The desktop in
   * process links; a server out of process cannot type into a terminal agent
   * and leaves it out.
   */
  linkLaunchedAgent?: ConversationToolsDeps['linkLaunchedAgent']
  /** Drop the notice a sub-agent's end would send, its parent having heard from a `wait`. */
  dismissLaunchNotice?: (childSessionId: string) => void
}

export type StudioGateway = ReturnType<typeof createStudioGateway>

/** What the client tools registry reads from the RPC that pairs apps, linked once that RPC exists. */
export type ClientToolLinks = {
  /** Which agents a paired app's tools reach. */
  reachOf?: (clientId: string) => StudioToolReach
  /** The client that started a conversation, from its record. */
  startedBy?: (conversation: ConversationRef) => string | null
}

export function createStudioGateway(core: StudioCore, options: StudioGatewayOptions = {}) {
  const { platform, workspaceSyncService, conversations } = core
  // The GitHub CLI's own sign-in for a host, which is what lets a pull request
  // there be read (`pull_request.link`).
  const gitHubHostToken = createGhHostTokenResolver(sharedGhRunner())
  const chats = studioChatControl(core)
  const coreTools = [
    ...createConversationTools({
      // A chat in a workspace an SSH machine holds starts there.
      launch: launchWhereItLives(
        core.environmentClients,
        (workspaceId) => core.workspaceRegistry.getRecord(workspaceId),
        (request) => core.conversationLaunchService.launch(request),
      ),
      resolveAgentPermissionPreset: core.resolveAgentPermissionPreset,
      permissionModesOf: (cli) => listPluginRegistryEntries().find((entry) => entry.id === cli)?.permissionModes ?? [],
      lifecycle: core.conversationLifecycle,
      moveChat: core.conversationMove.move,
      ...(options.linkLaunchedAgent ? { linkLaunchedAgent: options.linkLaunchedAgent } : {}),
    }),
    // One chat's agent sending to, reading, waiting on and stopping another
    // chat here, through the same host a paired device's commands go through.
    ...createConversationChatTools({
      resolveAgentPermissionPreset: core.resolveAgentPermissionPreset,
      chats,
    }),
    // A chat starting a sub-agent of its own, on the same chats and launch.
    ...createSubagentTools({
      launch: (request) => core.conversationLaunchService.launch(request),
      resolveAgentPermissionPreset: core.resolveAgentPermissionPreset,
      isKnownCli: (cli) => listPluginRegistryEntries().some((entry) => entry.id === cli),
      displayNames: (cli, modelId) => {
        const entry = listPluginRegistryEntries().find((candidate) => candidate.id === cli)
        const option = entry?.modelSelection?.options.find((candidate) => candidate.id === modelId)
        // An ACP model id carries its settings in brackets, which are no name.
        return { cli: entry?.displayName ?? cli, model: option?.label ?? modelId?.replace(/\[.*$/u, '') ?? null }
      },
      ...(options.linkLaunchedAgent ? { linkLaunchedAgent: options.linkLaunchedAgent } : {}),
      ...(options.dismissLaunchNotice ? { dismissNotice: options.dismissLaunchNotice } : {}),
      subagents: core.subagents,
      chats: {
        ...chats,
        // A sub-agent runs here, beside the chat that started it.
        session: localSessionOf(core),
        agentsOf: (workspaceId) => {
          const record = core.workspaceRegistry.getRecord(workspaceId)
          // A sub-agent runs beside a chat this core holds; never a copy's.
          return record && !record.remoteOrigin && !record.environment ? record.agents : null
        },
      },
    }),
    // A paired desktop's Create PR on one of this machine's chats: the
    // checkout, git, the forge's CLI and the drafting CLI are here, and so is
    // the record the pull request is kept in.
    ...createConversationPullRequestTools(studioPullRequestCreationDeps(core)),
    ...createPullRequestTools({
      link: (key, input) => core.pullRequests.linkForAgent(key, input),
      watch: (key, input) => core.pullRequests.watchForAgent(key, input),
      unwatch: (key, input) => core.pullRequests.unwatchForAgent(key, input),
      pullRequestsOf: (key) => core.pullRequests.record.forConversation(key),
      // A chat has sessions in the runtime; the agent calling is in one now.
      isChat: (key) => {
        const listed = conversations.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
        return listed.ok && listed.sessions.length > 0
      },
      isSignedInGitHubHost: async (host) => Boolean(await gitHubHostToken(host)),
    }),
    ...createLocalServerTools({ link: (key, input) => core.localServers.linkForAgent(key, input) }),
    // `worktree.lease` and `worktree.release`: a worktree of the agent's own
    // from this core's pool, beside the chats that work in it.
    ...core.worktrees.tools,
  ]

  // The gateway's own tools: what no client may offer under the same family.
  const resolveGatewayTools = createStudioGatewayTools({
    resolveModuleTools: () => options.resolveModuleTools?.() ?? [],
    isModuleEnabled: (moduleId) => options.isModuleEnabled?.(moduleId) ?? false,
    // A module tool runs under its caller's launch cap, so a chat the module
    // starts for a capped agent is no looser than that agent.
    callerPermissionCeiling: (context) => launchPermissionCeiling(context, core.resolveAgentPermissionPreset),
    warn: (details) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'workspace',
        title: 'Studio MCP gateway',
        message: 'Studio MCP gateway',
        details,
      })
    },
    appTools: options.appTools ? options.appTools(coreTools) : coreTools,
  })

  // Client toolsets: offered over the Studio RPC, listed to agents here. The
  // RPC that pairs apps links in each app's reach and who started a chat.
  const clientToolLinks: ClientToolLinks = {}
  let automation: ReturnType<typeof createAutomationService> | null = null
  const clientTools: ClientToolRegistry = createClientToolRegistry({
    store: createClientToolsetStore({
      dataDir: () => platform.paths.dataDir(),
      log: (message) => {
        void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Client tools', message })
      },
    }),
    servedFamilies: () => new Set(resolveGatewayTools().map((tool) => tool.name.split('.')[0])),
    servedTools: () => resolveGatewayTools().map((tool) => tool.name),
    reservedNames: () =>
      new Set((options.resolveModuleTools?.() ?? []).map((contribution) => contribution.moduleId.toLowerCase())),
    reachOf: (clientId) => clientToolLinks.reachOf?.(clientId) ?? 'own',
    startedBy: (conversation) => clientToolLinks.startedBy?.(conversation) ?? null,
    // Offers and withdrawals land in the gateway's one audit, beside the RPC's
    // own records, with the toolset's name and size and nothing a tool was given.
    audit: (entry) =>
      automation?.gatewayAudit().record({
        connection: { kind: 'studio-client', clientId: entry.clientId, clientName: entry.clientName },
        tool: entry.tool,
        durationMs: 0,
        args: { toolset: entry.toolset, tools: entry.tools },
        result: entry.ok
          ? toolSuccess({ ok: true })
          : toolError(entry.code ?? 'refused', 'The Studio RPC request was not carried out.'),
      }),
    // The person hears once when an app first gives agents tools under a name
    // (decisions R82): the pairing tick was the consent, this is the notice.
    onFirstOffer: (entry) =>
      platform.notifier.notify({
        key: `client-tools:${entry.clientId}:${entry.toolset}`,
        title: `${entry.clientName} gave agents ${entry.tools === 1 ? 'a tool' : `${entry.tools} tools`}`,
        body: `Agents can now call its ${entry.title} tools. See them, or revoke the app, in Settings → Local apps.`,
      }),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Client tools', message })
    },
  })

  // Each agent connection's own list of client tools, which only grows.
  const clientGateway = createClientToolGateway({
    registry: clientTools,
    ...(options.expectShellToolsets ? { expectShellToolsets: options.expectShellToolsets } : {}),
  })
  // The order agents have always listed: the shell's toolsets in the slots
  // the browser and canvas tools held, Studio's own tools, then any app's.
  const hideTool = options.hideTool
  const resolveTools = (context?: McpConnectionContext) => [
    ...clientGateway.builtIns(context),
    ...(hideTool ? resolveGatewayTools().filter((tool) => !hideTool(tool.name)) : resolveGatewayTools()),
    ...clientGateway.apps(context),
  ]

  const automationService = createAutomationService({
    resolveUserDataDir: () => platform.paths.dataDir(),
    appVersion: platform.identity.version(),
    resolveBridgeScriptPath: () => studioBridgeScriptPath(platform.paths),
    ...(options.onTailnetEvent ? { onTailnetEvent: options.onTailnetEvent } : {}),
    ...(options.onMeshEvent ? { onMeshEvent: options.onMeshEvent } : {}),
    ...(options.hasWindow ? { hasWindow: options.hasWindow } : {}),
    ...(options.tailnetBindAddress === undefined ? {} : { tailnetBindAddress: options.tailnetBindAddress }),
    // How a paired device draws this machine, on the tailnet's `identity`.
    selfMachine: () => core.selfMachine(),
    // The run lock's holder removes a stale socket; nobody else does. A desktop
    // that could not take the lock still may, as builds before it did: its
    // single-instance lock already rules out a second app on this profile.
    holdsDataDir: () => (core.dataDirLock ? core.dataDirLock.isHeld() : core.role === 'desktop'),
    // The gateway's tool set: core app tools + canonical run tools merged once,
    // module-contributed tools read from the host kernel per request
    // and gated on their owner's live enablement.
    resolveGatewayTools: resolveTools,
    clientTools: {
      ready: () => clientGateway.ready(),
      fallback: (context, name) => clientGateway.fallback(context, name),
      track: (context, notify) => clientGateway.track(context, notify),
    },
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // The change feed: the registry's accepted events become one small push
  // to every client on the protocol (`conversations.changed`), folded to one
  // per list per moment, and a client re-reads only when told to. A patch of
  // the clocks alone, which the workspace list does not carry (a visit stamped
  // every few seconds while a chat is on screen), tells it nothing
  // (`movesWorkspaceList`).
  const listChanges = createListChangePush()
  const workspacesChanged = (): void => listChanges.tell('workspaces')
  const conversationsChanged = (): void => listChanges.tell('conversations')
  workspaceSyncService.subscribeEvents((event) => {
    if (movesWorkspaceList(event)) workspacesChanged()
  })
  // The conversation list reads the desktop's records too (a chat settled,
  // renamed, written to or looked at), so the changes it reads are the same
  // push as a conversation event; `createConversationListChangeFilter` keeps
  // the visits stamped while a chat is on screen from becoming a push each.
  const listChanged = createConversationListChangeFilter({
    turnEndOf: (workspaceId) => {
      const listed = conversations.listSessions({ workspaceId })
      return listed.ok ? latestTurnEnd(listed.sessions, { workspaceId }) : undefined
    },
  })
  workspaceSyncService.subscribeEvents((event) => {
    if (listChanged(event)) conversationsChanged()
  })
  // A conversation's row on another machine shows its phase: running, waiting
  // on a person, done. The events that move it (never a token of a reply)
  // become the same throttled push.
  // The list names each chat's local servers too, and a server starting or
  // stopping moves none of the above: it is a push of its own.
  core.localServers.onChanged(() => conversationsChanged())
  conversations.onEvent((event) => {
    if (CONVERSATION_LIST_EVENTS.has(event.type)) conversationsChanged()
    // An interrupted turn stops what it was waiting on in a client too.
    cancelClientCallsAtTurnEnd(clientTools, event)
  })

  // A desktop that displaced a Studio server from its data directory opens
  // the socket only once that server has exited: closing its listener
  // removes the socket file at the shared path, which would take the
  // desktop's new one with it. Agent launches wait on the same.
  automation = automationService
  return {
    ...automationService,
    /** The client toolsets offered over the Studio RPC. */
    clientTools,
    /**
     * Studio's own tools, core and module, without any a client offers: what
     * a WSL server's agents are offered of this side beside the shell's
     * toolsets (phase 7, 3.7). Not those served to paired devices alone.
     */
    ownTools: (): McpToolRegistration[] => resolveGatewayTools(),
    /**
     * The names of the core's own tools, without any a module contributes:
     * what the module host refuses a module tool name against.
     */
    coreToolNames: (): ReadonlySet<string> => resolveGatewayTools.coreToolNames(),
    /** Hear that the chat or workspace list may read differently now (`conversations.changed`). */
    onListChanged: listChanges.listen,
    /** Link in what the registry reads from the RPC that pairs apps. */
    linkClientTools: (links: ClientToolLinks) => Object.assign(clientToolLinks, links),
    shutdown: async () => {
      listChanges.close()
      // Every call still waiting on a client is answered before the sockets go.
      clientTools.close()
      await automationService.shutdown()
    },
    initialize: async () => {
      await core.whenDataDirFree
      return automationService.initialize()
    },
    whenGatewayReady: async () => {
      await core.whenDataDirFree
      return automationService.whenGatewayReady()
    },
  }
}

/** How long a burst of list changes is folded into one push per list. */
const LIST_CHANGE_FOLD_MS = 250

/** The `conversations.changed` push: one per list per moment, to whoever listens. */
function createListChangePush() {
  type What = StudioListChange['what']
  const listeners = new Set<(change: StudioListChange) => void>()
  const due = new Set<What>()
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    tell(what: What): void {
      if (listeners.size === 0) return
      due.add(what)
      timer ??= setTimeout(() => {
        timer = null
        const told = [...due]
        due.clear()
        for (const changed of told) for (const listener of [...listeners]) listener({ what: changed })
      }, LIST_CHANGE_FOLD_MS)
    },
    listen(listener: (change: StudioListChange) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close(): void {
      if (timer) clearTimeout(timer)
      timer = null
      due.clear()
      listeners.clear()
    },
  }
}

/**
 * This core's chats as one agent drives another (conversation-chat-tools.ts).
 * Its sends are recorded as Studio's, not the person's, so a chat an agent
 * messages keeps its place in the lists ordered by when the person last wrote.
 *
 * A chat another environment holds (an SSH machine's, its record here only
 * that machine's copy) is driven there, as a client of that machine's Studio:
 * the same protocol method a window sends, on the desktop's own client of it
 * (`environmentClients`), never through this core's runtime (orchestrator
 * ruling 1). A machine that cannot be reached is said so in words.
 */
function studioChatControl(core: StudioCore): ConversationChatControl {
  let host: ReturnType<StudioCore['createConversationHost']> | null = null
  const hostOf = () => (host ??= core.createConversationHost({ origin: LAUNCH_NOTICE_ORIGIN }))
  const routeOf = (workspaceId: string): string | null =>
    environmentRouteOfRecord(core.workspaceRegistry.getRecord(workspaceId))
  const localSession = localSessionOf(core)
  const remoteSession = async (route: string, workspaceId: string, agentId: string) => {
    const reached = await core.environmentClients?.clientFor(route)
    if (!reached?.ok) return undefined
    const listed = await reached.client.request('session.list', { workspaceId, agentId }).catch(() => null)
    if (!listed?.ok) return undefined
    return latestSession(listed.sessions)
  }
  return {
    chatAgentsOf: (workspaceId) => {
      const record = core.workspaceRegistry.getRecord(workspaceId)
      if (!record || record.remoteOrigin) return null
      return Object.entries(record.agents)
        .filter(([, agent]) => agent?.runtimeKind === 'conversation')
        .map(([agentId]) => agentId)
    },
    resolveKey: (workspaceId, agentId) => hostOf().resolveKey(workspaceId, agentId),
    chatTitle: (workspaceId) => core.workspaceRegistry.getRecord(workspaceId)?.name,
    session: (workspaceId, agentId) => {
      const route = routeOf(workspaceId)
      return route ? remoteSession(route, workspaceId, agentId) : localSession(workspaceId, agentId)
    },
    permissionOf: (key) => {
      const route = routeOf(key.workspaceId)
      if (!route) return hostOf().permissionOf?.(key) ?? 'manual'
      return remoteSession(route, key.workspaceId, key.agentId).then((session) => session?.permissionPreset ?? 'manual')
    },
    command: async (key, clientId, commandId, command) => {
      const route = routeOf(key.workspaceId)
      if (!route) return hostOf().command(key, clientId, commandId, command)
      return environmentCommand(core.environmentClients, route, key, commandId, command)
    },
    readPage: async (key, page) => {
      const route = routeOf(key.workspaceId)
      if (route) return environmentPage(core.environmentClients, route, key, page)
      if (page.before !== undefined) {
        const read = await core.conversations.readConversationPage(key, page.before, page.turns)
        return read.ok
          ? { ok: true, events: read.page.events, hasMore: read.page.hasMore, before: read.page.beforeCursor }
          : read
      }
      const read = await core.conversations.readConversationSync(key, { turnLimit: page.turns })
      if (!read.ok) return read
      if (read.kind === 'snapshot')
        return { ok: true, events: read.page.events, hasMore: read.page.hasMore, before: read.page.beforeCursor }
      return { ok: true, events: read.events, hasMore: false, before: null }
    },
  }
}

/** This core's own sessions of a chat, newest first: what a sub-agent here is read by. */
function localSessionOf(core: StudioCore) {
  return (workspaceId: string, agentId: string): ConversationSessionSummary | undefined => {
    const listed = core.conversations.listSessions()
    if (!listed.ok) return undefined
    return latestSession(
      listed.sessions.filter((session) => session.workspaceId === workspaceId && session.agentId === agentId),
    )
  }
}

const latestSession = (sessions: readonly ConversationSessionSummary[]): ConversationSessionSummary | undefined =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
