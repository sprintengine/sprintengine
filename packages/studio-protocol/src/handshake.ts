// What a client and a Studio say about themselves before anything else.
//
// The rule is the conversation lane's, one level up: features are asked about
// by capability, and the version integer exists only to refuse a peer outright
// when a change could not be additive, naming both numbers when it does. The
// conversation contract's own version and capabilities travel inside the
// welcome unchanged, so a client that speaks only conversations reads exactly
// what it reads from the tailnet lane.

/** The envelope, handshake and method table this package describes. */
export const STUDIO_PROTOCOL_VERSION = 1
/** The oldest version a Studio built from this package still serves. */
export const STUDIO_PROTOCOL_MIN_SUPPORTED = 1

/** Follow, list and drive conversations: the `conversation.*` reads, commands and the session stream. */
export const STUDIO_CONVERSATIONS_CAPABILITY = 'conversations' as const
/** Start a conversation with `conversation.create`. */
export const STUDIO_CONVERSATION_CREATE_CAPABILITY = 'conversation-create' as const
/** A `hello` may carry a one-time pairing code instead of a token, and is answered with the token. */
export const STUDIO_LOCAL_PAIRING_CAPABILITY = 'local-pairing' as const
/**
 * A conversation may be addressed by its folder as well as its workspace
 * (`key.workspaceRoot`): a chat started in a run worktree is kept in that
 * worktree, not in its workspace's folder. Only an owner names a folder.
 */
export const STUDIO_CONVERSATION_FOLDERS_CAPABILITY = 'conversation-folders' as const
/** Drive a chat's live session by its id, as Studio's own chat view does: `session.*` and `uploads.*`. */
export const STUDIO_SESSIONS_CAPABILITY = 'conversation-sessions' as const
/** Read a sent picture back (`conversation.attachment`) and open a proposed plan as a file (`conversation.planDocument`). */
export const STUDIO_CONVERSATION_FILES_CAPABILITY = 'conversation-files' as const
/** Revert a turn's files from its checkpoint, or take a chat back to an earlier message. */
export const STUDIO_CHECKPOINTS_CAPABILITY = 'conversation-checkpoints' as const
/** The `/` command list a chat's CLI reports for a folder: `conversation.commands` and its stream. */
export const STUDIO_COMMANDS_CAPABILITY = 'conversation-commands' as const
/** The conversation providers, their models and whether each has its key: `providers.*`. */
export const STUDIO_PROVIDERS_CAPABILITY = 'providers' as const
/** File search for @-mentions, and the file facts a chat's links and pictures need: `files.*`. */
export const STUDIO_FILES_CAPABILITY = 'files-mention' as const
/**
 * What a client reads before it starts a chat: the workspaces this Studio
 * holds, the CLIs a chat may run, a folder's checkout and a project's skills
 * (`workspaces.list`, `cliRuntimes.list`, `workspaces.checkout`,
 * `workspaces.extensions`).
 */
export const STUDIO_WORKSPACES_CAPABILITY = 'workspaces' as const
/**
 * A client may offer toolsets for Studio's agents (`tools.*`), and is sent a
 * `call` when an agent uses one. A client sends `reply` and `progress` frames
 * only to a Studio that advertises this.
 */
export const STUDIO_CLIENT_TOOLS_CAPABILITY = 'client-tools' as const
/**
 * Files under a workspace's roots, by root and relative path: `files.roots`,
 * `list`, `read`, `write`, `remove`, `stat` with a root, and the `files.watch`
 * stream, by `files:read` and `files:write`. What a client runs the canvas over a Studio's boards with.
 */
export const STUDIO_BOARD_FILES_CAPABILITY = 'files-write' as const
/**
 * The pull requests a Studio's conversations opened: `pullRequests.list`,
 * `refresh` and `noteWork`, and the `pullRequests.changed` stream. `noteWork`
 * is an owner's; the rest are reached by `workspaces:read`.
 */
export const STUDIO_PULL_REQUESTS_CAPABILITY = 'pull-requests' as const
/**
 * `pullRequests.noteToolCall`: a client forwards a tool call one of its own
 * agents made, and the Studio decides whether it opened a pull request. An
 * owner's, beside `pull-requests`.
 */
export const STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY = 'pull-request-tool-calls' as const
/**
 * `pullRequests.link`: an owner records a pull request it opened for one of
 * the Studio's conversations (the desktop's "Create PR" button). An owner's.
 */
export const STUDIO_PULL_REQUEST_LINK_CAPABILITY = 'pull-request-link' as const
/**
 * `pullRequests.unwatch`: an owner stops a conversation's agent watching one
 * of its pull requests. A Studio that advertises it may also send `watch` on a
 * listed pull request, which says what a watched one waits on. Reached by
 * `conversation:operate`.
 */
export const STUDIO_PULL_REQUEST_WATCH_CAPABILITY = 'pull-request-watch' as const
/**
 * The local servers a Studio's conversations started: `localServers.list`,
 * `run`, `stop` and `remove`, and the `localServers.changed` stream, reached
 * by scope.
 */
export const STUDIO_LOCAL_SERVERS_CAPABILITY = 'local-servers' as const

/**
 * `session.send` takes `files`, the files a message attaches by path, and the
 * `user_message` it becomes carries them. A Studio without it drops the member
 * unread, so a client sends it only where this is advertised.
 */
export const STUDIO_SESSION_FILES_CAPABILITY = 'session-files' as const

/**
 * `conversation.handoff`: hand a chat off to a fresh session of its CLI,
 * pointed at a file of the chat's messages, instead of compacting it.
 * Reached by `conversation:operate`.
 */
export const STUDIO_HANDOFF_CAPABILITY = 'conversation-handoff' as const

/**
 * The rest of what a chat view does to a live session by its id: stop it,
 * suspend it (its process ends, the session keeps its place), act on one of
 * its MCP servers, stop or message an agent it spawned, ask it a side
 * question, read what fills its context window, list sessions, and follow
 * every chat's lifecycle (`conversation.events`).
 */
export const STUDIO_SESSION_CONTROLS_CAPABILITY = 'session-controls' as const

/** `session.terminalHandoff`: a chat carried on by a terminal agent on the Studio's machine. */
export const STUDIO_TERMINAL_HANDOFF_CAPABILITY = 'session-terminal-handoff' as const

/**
 * The terminals on the Studio's machine (`terminals.ts`): `terminal.*` and the
 * `terminal.output`, `terminal.sessions` and `terminal.promptUndelivered`
 * streams. Advertised only where the server holds a terminal runtime.
 */
export const STUDIO_TERMINALS_CAPABILITY = 'terminals' as const

/**
 * `conversation.exportPage`: a chat's whole transcript, with the pictures its
 * messages attached and what its record says of it, in pages, for a client
 * to write out as a file or put on its clipboard. Advertised only where the
 * chat surface reads exports.
 */
export const STUDIO_CHAT_EXPORT_CAPABILITY = 'conversation-export' as const

/** `conversation.threads` and `conversation.search`: a workspace's history and a search of it. */
export const STUDIO_HISTORY_CAPABILITY = 'conversation-history' as const

/** `conversation.approvalRules` and `conversation.revokeApprovalRule`: the rules that answer by themselves. */
export const STUDIO_APPROVAL_RULES_CAPABILITY = 'approval-rules' as const

/** `providers.signIn`, `providers.setSecret` and `providers.clearSecret`: a provider's sign-in and key. */
export const STUDIO_PROVIDER_SETTINGS_CAPABILITY = 'provider-settings' as const

/**
 * `update.status` and `update.start` (`update.ts`), served to every client;
 * and, to a client that lists this in its hello's `client.capabilities`, a
 * connection kept open for them when the two ends' protocol windows do not
 * meet, opened with an `incompatible` frame instead of a `welcome`.
 */
export const STUDIO_UPDATE_SESSION_CAPABILITY = 'update-session' as const

/**
 * This Studio's modules speak to clients: the `module.events` and
 * `module.notifications` streams. Offered where the Studio runs a module kernel.
 */
export const STUDIO_MODULES_CAPABILITY = 'modules' as const

/**
 * The agent CLIs on the Studio's machine: `cliRuntimes.*` (detect, install,
 * update) and `cliVersions.*` (whether each is behind its published version),
 * with their streams. Offered where the Studio holds the CLIs' detection.
 */
export const STUDIO_AGENT_RUNTIMES_CAPABILITY = 'agent-runtimes' as const

/**
 * What every launch reads and what a CLI writes for Studio: `launchSettings.*`,
 * `cliModels.*`, `textGeneration.*` and `commitMessage.*`, with their streams.
 */
export const STUDIO_AGENT_SETTINGS_CAPABILITY = 'agent-settings' as const

/**
 * What a Studio's agents are set up with beyond their CLIs: `memory.*`,
 * `memoryActivity.*`, `mcp.sync`, `agentConfig.*`, `builtinSkills.*` and
 * `areaSkills.*`, with their streams. Offered where the Studio holds those
 * services.
 */
export const STUDIO_AGENT_SETUP_CAPABILITY = 'agent-setup' as const

/**
 * `environment.readiness` (`readiness.ts`): what this Studio's machine has and
 * lacks for its schedules and pull request watches, and what waits on it.
 */
export const STUDIO_ENVIRONMENT_READINESS_CAPABILITY = 'environment-readiness' as const

/**
 * `environment.windowTicket` (`environment-access.ts`): a ticket for one
 * connection of a window of the desktop that holds this Studio, asked for by
 * that desktop's shell alone. Served by a Studio a desktop reaches over its
 * front door (a WSL distribution's, an SSH machine's).
 */
export const STUDIO_WINDOW_TICKETS_CAPABILITY = 'window-tickets' as const

/**
 * `environment.deviceTicket` (`environment-access.ts`): a ticket for one
 * connection of a paired device the desktop that holds this Studio relays,
 * never an owner's, asked for by that desktop's shell alone.
 */
export const STUDIO_DEVICE_TICKETS_CAPABILITY = 'device-tickets' as const

/**
 * `environment.relayed` (`environment-access.ts`): the machines this desktop
 * relays its paired devices to (`relay:` routes), which a device reaches at
 * `/tailnet/v1/environments/<environmentId>/studio` on this desktop.
 */
export const STUDIO_RELAYED_ENVIRONMENTS_CAPABILITY = 'relayed-environments' as const

/**
 * `environment.work` (`environment-access.ts`): whether a chat works here and
 * what this Studio does on its own, asked by the desktop that holds it before
 * it stops the server for being idle and for its quit question.
 */
export const STUDIO_ENVIRONMENT_WORK_CAPABILITY = 'environment-work' as const

/**
 * `environment.adopt` (`environment-access.ts`): records the desktop that
 * holds this Studio kept for its chats, kept here from then on, asked by that
 * desktop's shell alone.
 */
export const STUDIO_ENVIRONMENT_ADOPT_CAPABILITY = 'environment-adopt' as const

/**
 * `providers.signInStart`, `.signInPaste`, `.signInWait` and `.signInCancel`
 * (`environment-access.ts`): a CLI's own login on this Studio's machine, with
 * no terminal (decision R34). Served where the machine has no terminal of the
 * person's beside it (a WSL distribution's, an SSH machine's Studio).
 */
export const STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY = 'provider-sign-in-flow' as const

/**
 * What a Studio keeps beside its chats, for every chat at once:
 * `usageLimits.*`, `usageLimitResumes.*`, `usage.report`, `usage.rows`
 * and `conversationImport.*`, with their streams.
 */
export const STUDIO_CHAT_STORES_CAPABILITY = 'chat-stores' as const

/** The backlogs of the projects a Studio holds (`backlog.ts`): `backlog.list`, `.update` and `backlog.changed`. */
export const STUDIO_BACKLOG_CAPABILITY = 'backlog' as const

/** The web pages a Studio's machine publishes on the tailnet (`shares.list`). */
export const STUDIO_SHARES_CAPABILITY = 'shares' as const

/**
 * One pull request read in full, by its URL: its checks, reviews and files
 * (`pullRequests.detail`), and a page of one file's diff (`pullRequests.diff`).
 */
export const STUDIO_PULL_REQUEST_READS_CAPABILITY = 'pull-request-reads' as const

/**
 * A chat's "Create PR" on the Studio that holds the chat
 * (`pull-request-create.ts`): `pullRequests.createState`, `.draft`,
 * `.draftCancel`, `.push` and `.create`, each an owner's.
 */
export const STUDIO_PULL_REQUEST_CREATE_CAPABILITY = 'pull-request-create' as const

/**
 * The skills, design systems and cards a Studio's agents are given:
 * `skillSources.*`, `skills.*`, `skillPlugins.*`, `workspaceSkills.list`,
 * `installedSkills.*`, `agentCapabilities.resolve`, `agentSkills.attach`,
 * `designSystem.*` and `cards.run`, with `skillSources.updated`.
 */
export const STUDIO_AGENT_SKILLS_CAPABILITY = 'agent-skills' as const

/**
 * A Studio's scheduled agents (`schedules.ts`): `schedules.*` and the
 * `schedules.changed` stream. Offered where the Studio runs schedules.
 */
export const STUDIO_SCHEDULES_CAPABILITY = 'schedules' as const

/**
 * The files on the Studio's machine by absolute path (`file-system.ts`):
 * `files.listDirectory`, `.readText`, `.writeText`, `.rename`, `.trash` and
 * the rest, with the `files.watchPath` stream. Every Studio's core serves it.
 */
export const STUDIO_FILE_SYSTEM_CAPABILITY = 'file-system' as const

/**
 * A machine's Canvas boards for another client (`canvas.ts`): `canvas.*` and
 * the `canvas.board` and `canvas.openRequests` streams. Offered where the
 * Studio is given the machine's one canvas service.
 */
export const STUDIO_CANVAS_BOARDS_CAPABILITY = 'canvas-boards' as const

/**
 * Git on the Studio's machine (`git.ts`): `git.*`, `github.*` and
 * `versionControl.*`, with the checkout, changelist and clone streams. Every
 * Studio's core serves it.
 */
export const STUDIO_GIT_CAPABILITY = 'git' as const

/**
 * The worktrees Studio's agents run in (`worktrees.ts`): the worktree pool,
 * its dependency installs, Settings ▸ Worktrees' inventory and the agents'
 * worktree steps (`worktrees.*`, with the `worktrees.poolChanged` and
 * `worktrees.installChanged` streams), and deleting settled chats, whose
 * worktrees go back to that pool (`settledChats.*`). Every Studio's core
 * serves it.
 */
export const STUDIO_WORKTREES_CAPABILITY = 'worktrees' as const

/**
 * The desktop's own windows' workspace registry (`workspace-sync.ts`): the
 * mirror each window keeps of the workspaces and windows main records, its
 * changes, the one-time hydration from a window's own copy, the window's
 * backup of it, and the folders a chat without a project runs in. Owner-only:
 * a desktop's Studio serves it to its own windows.
 */
export const STUDIO_WORKSPACE_SYNC_CAPABILITY = 'workspace-sync' as const

/**
 * A chat's record beyond its rest and visit clock (`chat-lifecycle.ts`):
 * `conversation.markUnread`, `.snooze`, `.highlight`, `.setAutoSettle`,
 * `.setAutoCompact`, `.rename`, `.deletePlan`, `.delete` and
 * `.searchChats`. Offered where the Studio keeps its chats' records.
 */
export const STUDIO_CHAT_LIFECYCLE_CAPABILITY = 'chat-lifecycle' as const

/**
 * What a Studio is extended with beyond its modules (`extensions.ts`): the
 * marketplace and installing from it or from GitHub (`marketplace.*`), the
 * agent CLIs' plugin catalogue (`cliPlugins.*`), Studio's own plugin in a
 * workspace (`studioPlugin.status`), building an extension
 * (`extensionScaffold.*`), and the hosted feeds (`cardFeed.*`,
 * `sourcesFeed.get`). Offered where the Studio holds them.
 */
export const STUDIO_EXTENSIONS_CAPABILITY = 'extensions' as const

/**
 * Where a Studio publishes its agents' pages (`artifacts.ts`): Settings ▸
 * Artifacts read and set up (`artifacts.settings`, `artifacts.setUp`), and the
 * question put to the person before an agent's set-up changes anything
 * (`artifacts.setupQuestions`, `artifacts.answerSetupQuestion`). Offered where
 * the Studio publishes them (a desktop's).
 */
export const STUDIO_ARTIFACTS_CAPABILITY = 'artifacts' as const

/**
 * Who may reach this Studio's agents from this machine (`access.ts`): the
 * agents' gateway as it stands (`gateway.status`), the tokens its loopback
 * HTTP endpoint admits (`mcpHttp.*`), and the apps paired with its owner
 * socket (`localApps.*`, with the `localApps.changed` stream). Offered where
 * the Studio runs them, which every Studio does.
 */
export const STUDIO_ACCESS_CAPABILITY = 'access' as const

/**
 * The browsers paired with this Studio's web listener (`web-devices.ts`):
 * the list and its stream, removing one, and answering one that asks by
 * approval. Offered by a Studio that runs the web listener.
 */
export const STUDIO_WEB_DEVICES_CAPABILITY = 'web-devices' as const

/**
 * Who reaches this machine over the tailnet, and the machines it reaches
 * (`tailnet.ts`): its listener's devices, offers, requests and shared dev
 * servers (`tailnet.*`, with the `tailnet.changed` stream), and pairing with
 * another machine (`mesh.*`, with `mesh.changed`). Offered where the Studio
 * runs the gateway, which every Studio does.
 */
export const STUDIO_TAILNET_CAPABILITY = 'tailnet' as const

/**
 * Every Studio capability this version of the package knows, in the order
 * they shipped. A Studio advertises the ones it serves; a client reads a name
 * it does not know as a feature it does not use.
 */
export const STUDIO_CAPABILITIES = [
  STUDIO_CONVERSATIONS_CAPABILITY,
  STUDIO_CONVERSATION_CREATE_CAPABILITY,
  STUDIO_LOCAL_PAIRING_CAPABILITY,
  STUDIO_CONVERSATION_FOLDERS_CAPABILITY,
  STUDIO_SESSIONS_CAPABILITY,
  STUDIO_CONVERSATION_FILES_CAPABILITY,
  STUDIO_CHECKPOINTS_CAPABILITY,
  STUDIO_COMMANDS_CAPABILITY,
  STUDIO_PROVIDERS_CAPABILITY,
  STUDIO_FILES_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  STUDIO_CLIENT_TOOLS_CAPABILITY,
  STUDIO_BOARD_FILES_CAPABILITY,
  STUDIO_PULL_REQUESTS_CAPABILITY,
  STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY,
  STUDIO_PULL_REQUEST_LINK_CAPABILITY,
  STUDIO_LOCAL_SERVERS_CAPABILITY,
  STUDIO_SESSION_FILES_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_HANDOFF_CAPABILITY,
  STUDIO_SESSION_CONTROLS_CAPABILITY,
  STUDIO_TERMINAL_HANDOFF_CAPABILITY,
  STUDIO_HISTORY_CAPABILITY,
  STUDIO_APPROVAL_RULES_CAPABILITY,
  STUDIO_PROVIDER_SETTINGS_CAPABILITY,
  STUDIO_UPDATE_SESSION_CAPABILITY,
  STUDIO_MODULES_CAPABILITY,
  STUDIO_TERMINALS_CAPABILITY,
  STUDIO_AGENT_RUNTIMES_CAPABILITY,
  STUDIO_AGENT_SETTINGS_CAPABILITY,
  STUDIO_AGENT_SETUP_CAPABILITY,
  STUDIO_ENVIRONMENT_READINESS_CAPABILITY,
  STUDIO_WINDOW_TICKETS_CAPABILITY,
  STUDIO_DEVICE_TICKETS_CAPABILITY,
  STUDIO_RELAYED_ENVIRONMENTS_CAPABILITY,
  STUDIO_ENVIRONMENT_WORK_CAPABILITY,
  STUDIO_ENVIRONMENT_ADOPT_CAPABILITY,
  STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY,
  STUDIO_CHAT_STORES_CAPABILITY,
  STUDIO_AGENT_SKILLS_CAPABILITY,
  STUDIO_SCHEDULES_CAPABILITY,
  STUDIO_FILE_SYSTEM_CAPABILITY,
  STUDIO_BACKLOG_CAPABILITY,
  STUDIO_SHARES_CAPABILITY,
  STUDIO_PULL_REQUEST_READS_CAPABILITY,
  STUDIO_PULL_REQUEST_CREATE_CAPABILITY,
  STUDIO_GIT_CAPABILITY,
  STUDIO_WORKTREES_CAPABILITY,
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_CANVAS_BOARDS_CAPABILITY,
  STUDIO_CHAT_EXPORT_CAPABILITY,
  STUDIO_EXTENSIONS_CAPABILITY,
  STUDIO_ARTIFACTS_CAPABILITY,
  STUDIO_ACCESS_CAPABILITY,
  STUDIO_WORKSPACE_SYNC_CAPABILITY,
  STUDIO_WEB_DEVICES_CAPABILITY,
  STUDIO_TAILNET_CAPABILITY,
] as const

/**
 * The capabilities a Studio serves only with the chat surface beside the
 * conversation lane, in `STUDIO_CAPABILITIES` order. A Studio that has no chat
 * surface (a test double, a future headless build without one) leaves them out.
 */
export const STUDIO_CHAT_CAPABILITIES = [
  STUDIO_CONVERSATION_FOLDERS_CAPABILITY,
  STUDIO_SESSIONS_CAPABILITY,
  STUDIO_CONVERSATION_FILES_CAPABILITY,
  STUDIO_CHECKPOINTS_CAPABILITY,
  STUDIO_COMMANDS_CAPABILITY,
  STUDIO_PROVIDERS_CAPABILITY,
  STUDIO_SESSION_FILES_CAPABILITY,
  STUDIO_HANDOFF_CAPABILITY,
  STUDIO_SESSION_CONTROLS_CAPABILITY,
  STUDIO_TERMINAL_HANDOFF_CAPABILITY,
  STUDIO_HISTORY_CAPABILITY,
  STUDIO_APPROVAL_RULES_CAPABILITY,
  STUDIO_PROVIDER_SETTINGS_CAPABILITY,
  STUDIO_CHAT_EXPORT_CAPABILITY,
] as const

export type StudioCapability = (typeof STUDIO_CAPABILITIES)[number]

/** Whether a peer serves a capability. A peer that listed none serves none. */
export function studioPeerSupports(
  capabilities: readonly string[] | null | undefined,
  capability: StudioCapability,
): boolean {
  return Array.isArray(capabilities) && capabilities.includes(capability)
}

/**
 * How a client stands with a Studio, from the client's side:
 *
 *   - `compatible`: each serves the other's version.
 *   - `client-outdated`: the Studio needs a newer protocol than the client
 *     speaks. The client is updated.
 *   - `server-outdated`: the Studio speaks only versions older than the
 *     client still serves. The Studio is updated.
 *   - `unknown`: the client has not heard the Studio's versions.
 */
export type StudioCompatibility = 'compatible' | 'client-outdated' | 'server-outdated' | 'unknown'

/** The protocol versions one end speaks: the newest, and the oldest it still serves. */
export type StudioProtocolWindow = { protocolVersion: number; minProtocolVersion: number }

/** This build's window. */
export const STUDIO_PROTOCOL_WINDOW: StudioProtocolWindow = Object.freeze({
  protocolVersion: STUDIO_PROTOCOL_VERSION,
  minProtocolVersion: STUDIO_PROTOCOL_MIN_SUPPORTED,
})

/**
 * How `client` stands with `server`, by their windows; `unknown` for a
 * server that has not said. Each must serve the other's newest version or
 * something above its oldest: the one rule `checkStudioProtocolVersion`
 * applies at the handshake.
 */
export function studioCompatibility(
  server: StudioProtocolWindow | null | undefined,
  client: StudioProtocolWindow = STUDIO_PROTOCOL_WINDOW,
): StudioCompatibility {
  if (!server) return 'unknown'
  if (server.protocolVersion < client.minProtocolVersion) return 'server-outdated'
  if (server.minProtocolVersion > client.protocolVersion) return 'client-outdated'
  return 'compatible'
}

/**
 * Whether two ends can talk: each must serve the other's version. Both then
 * speak the lower of the two current versions. The refusal names both numbers
 * and which side to update.
 */
export function checkStudioProtocolVersion(
  peerVersion: number,
  peerMinVersion: number = peerVersion,
): { ok: true; version: number } | { ok: false; message: string } {
  // The peer as the server, this end as the client: `server-outdated` is the peer behind.
  switch (studioCompatibility({ protocolVersion: peerVersion, minProtocolVersion: peerMinVersion })) {
    case 'server-outdated':
      return {
        ok: false,
        message: `The other end speaks Studio protocol ${peerVersion}, and this one needs ${STUDIO_PROTOCOL_MIN_SUPPORTED} or newer. Update the other end.`,
      }
    case 'client-outdated':
      return {
        ok: false,
        message: `The other end needs Studio protocol ${peerMinVersion} or newer, and this one speaks ${STUDIO_PROTOCOL_VERSION}. Update this end.`,
      }
    default:
      return { ok: true, version: Math.min(peerVersion, STUDIO_PROTOCOL_VERSION) }
  }
}
