# Changelog

## Unreleased

### Added (Create PR on the chat's Studio)

- **`pullRequests.createState`, `.draft`, `.draftCancel`, `.push` and
  `.create`** (`pull-request-create.ts`, capability `pull-request-create`): a
  chat's Create PR in the chat's own checkout on its Studio, named by the
  chat, never a folder. Each is an owner's, with its reason (the forge, the
  drafting CLI, the push, the creation with this machine's credentials).
  `push` and `create` carry a `commandId` and are answered once per id; a
  created pull request is recorded as the chat's (`recorded`). The checkout
  shapes move into the package (`StudioCreatePullRequestState`,
  `StudioPullRequestCheckoutPin`, `StudioCreatePullRequestOutcome`, …).

### Changed (a fork answers where it is)

- **`conversation.fork` is the conversation host's fork**, as the tailnet
  lane's: the fork joins the chat's workspace as its twin under the name the
  Studio gives it, and the answer is `{ ok: true, address, name }`, its
  `ConversationAddress` and that name (`StudioForkResult`). It moves from the
  chat surface to the keyed methods (`followed.ts`, capability
  `conversations`, scope `conversation:create`); `title` is no longer read.
  The socket now serves `conversation-fork`. A refusal is a response error in
  the runtime's words for the Studio's own window and stable words for anyone
  else.

### Added (artifacts)

- **Where a desktop's Studio publishes its agents' pages is the protocol's**
  (`artifacts.ts`, capability `artifacts`): `artifacts.settings` (Settings ▸
  Artifacts, whether a Cloudflare token is held but never the token),
  `artifacts.setUp` (test or save a host, a mutation under its `commandId`),
  and the set-up question an agent's `artifacts.setup` puts to the person:
  the `artifacts.setupQuestions` stream (every open question, whole, at
  subscribing and on each change) and `artifacts.answerSetupQuestion`. Each is
  an owner's, with its reason (`STUDIO_ARTIFACTS_SETTING_OWNER`,
  `STUDIO_ARTIFACTS_SETUP_OWNER`, `STUDIO_ARTIFACTS_CONSENT_OWNER`). Their
  shapes are in `artifacts-types.ts`.

### Added (canvas boards)

- **A machine's Canvas boards for another device** (`canvas.ts`, capability
  `canvas-boards`): `canvas.list` and `canvas.picture`; the `canvas.board`
  stream, which holds a board open on the machine's canvas service and pushes
  notices only (`opened`, `scene` with its revision, `presence`); `canvas.read`
  and `canvas.files` for the scene and its pictures by id; `canvas.stage` and
  `canvas.commit` (under a `commandId`) to draw; `canvas.takePen`; and the
  `canvas.openRequests` stream for an agent's `canvas.open`. Looking needs
  `workspaces:read`, drawing `workspaces:operate`. Advertised only by a Studio
  given the machine's canvas service.

### Added (a chat's export)

- **`conversation.exportPage`** (capability `conversation-export`, scope
  `conversation:read`): a chat's whole export read where the chat is kept,
  `{ chat, events, attachments, nextOffset }` (`StudioChatExportPage`), paged
  under the client's `exportId` from `offset` 0. Advertised only where the
  chat surface reads exports.

### Removed (a chat's queue is its server's)

- **`scheduledMessages.hold`, `.get`, `.update` and `scheduledMessages.changed`**.
  A window hands a message queued mid-turn to its Studio as every client
  does: `conversation.send` with `queue`, followed on `conversation.queued`.
  It schedules, sends now and deletes one chat's messages with
  `conversation.scheduleSend`, `.sendScheduledNow` and `.cancelScheduled`,
  followed on `conversation.scheduled`; nothing reads or changes every chat's
  at once. `conversation.scheduleSend` carries `untilLimitReset` from the
  conversation contract.

### Added (extensions)

- **What a desktop's Studio is extended with is the protocol's**
  (`extensions.ts`, capability `extensions`): `marketplace.read` and
  `.updateStates`, `cliPlugins.list`, `.availability` and `.launchPreview`,
  `cardFeed.get` with the `cardFeed.changed` stream and `sourcesFeed.get`
  (`providers:read`); `studioPlugin.status` (`files:read`); and an owner's
  `marketplace.verify`, `.install`, `.update`, `.uninstall`, `.resolveGithub`,
  `.installGithub` (`STUDIO_MARKETPLACE_OWNER`) and `extensionScaffold.home`,
  `.target`, `.create` (`STUDIO_SCAFFOLD_OWNER`). The installs are mutations
  under their `commandId`. Their shapes are in `extensions-types.ts`.
- **The installed extensions are listed and loaded through the Studio**:
  `module.installed` and `module.rendererEntries` (`modules:read`),
  `module.setAppState` (`settings:write`), `module.reportRegistry`
  (`modules:operate`), and the `module.changed` stream.

### Added (the phone's reads)

- **Backlogs, shares and pull request reads are protocol methods.**
  `backlog.list` with the `backlog.changed` stream (`backlog:read`) and
  `backlog.update` (`backlog:operate`, a mutation under its `commandId`), behind
  `backlog`; `shares.list` (`workspaces:read`) behind `shares`;
  `pullRequests.detail` and `.diff` (`workspaces:operate`) behind
  `pull-request-reads`. New scopes `backlog:read` and `backlog:operate`
  (operate carries read) and `workspaces:operate`.

### Removed

- **The mobile-control wire** (`src/mobile-control.ts` and
  `src/mobile-control-commands.ts`): its snapshot, command envelope, version
  window and validators. Its backlog and pull request shapes live on as
  `StudioBacklog*` (`backlog.ts`) and `StudioPullRequestDetail` /
  `StudioPullRequestDiffPage` (`pull-request-reads.ts`).

### Added (modules)

- **What runs on a Studio is changed through it.** `module.list` (scope
  `modules:read`): every module the Studio holds, whether it is switched on
  and running there, why not, and the methods it declares. `module.setEnabled`,
  `module.install`, `module.setTrust` and `module.uninstall` are an owner's
  (`STUDIO_MODULES_OWNER`: they change what runs on the machine), each a
  mutation under its `commandId`, answering the server's own outcome as the
  result. An uninstall of a module a plugin put in place is refused with the
  plugin's id.
- **A module's host services are protocol methods** (`module-services.ts`,
  under the `modules` capability): `moduleBacklog.location` and
  `moduleUsage.query` (scope `modules:read`), and the Backlog writes
  `moduleBacklog.create`, `.updateStatus`, `.updateTriage`, `.addLink` and
  `.updateModuleMetadata` (scope `modules:operate`, each a mutation under its
  `commandId`). Each call names the calling module; one not running on the
  Studio is refused `module_unavailable`. The service's answer is the result,
  its own refusals (`permission_missing`, `not_found`, …) included.

### Changed (one send shape and one approval union)

- **`session.send` is the conversation contract's `ConversationSendRequest`**,
  addressed to the session, its pictures by their uploads. It now carries
  `composedAt` and `confirmedStale`, which it used to drop, and refuses `queue`
  in words: Studio runs the chat, and a message queued behind its turn waits
  in the view that wrote it. `session.respond`'s `decision` is
  `ConversationApprovalDecision`.
- **Removed** the hand-written copies `StudioMention`, `StudioAttachedFile`,
  `StudioSkillRef` and `StudioSendAttachment`: use the contract's
  `ConversationMentionRef`, `ConversationAttachedFile`, `ConversationSkillRef`
  and `ConversationSendUpload`.

### Changed (grants)

- **The terminals are an owner's only.** Every `terminal.*` method and stream
  declares `owner` (`STUDIO_TERMINALS_OWNER`) and no scope: the app's own
  windows and the owner's credential reach them, and no paired device, local
  app or browser does, an owner's tab included. The scopes and permissions
  `terminal:read` and `terminal:operate` are removed (a stored grant naming
  them has the names dropped), a topic's `scope` may now be `null` as a
  method's may, and `projectTerminalSession` takes no access argument: the
  read-only projection is gone with the read-only grant.
- **Explicit grants instead of owner-only.** Every method and topic reaches a
  client by the scope it names, except five that are an owner's by
  declaration: `session.terminalHandoff`, `providers.signIn`,
  `pullRequests.noteWork`, `pullRequests.noteToolCall` and `pullRequests.link`.
  A definition's `owner` is now the reason (a string), not `true`, and
  `StudioAccess.owner` carries it. New scope and permission `settings:write`
  for `providers.setSecret`, `providers.clearSecret` and
  `conversation.revokeApprovalRule`; a pairing holds it only when given it.
  `files.readImage` may be refused `not_found`. A Studio still refuses a
  client that is not an owner a conversation's folder, a CLI's `command`, and
  any path outside the folders it knows, by its params.
- **`conversation.list` leaves settled chats out**, in the sidebar's order
  (`conversation-lifecycle`, now in the welcome), as the tailnet lane's list
  does: every client reads the one list the desktop draws. A settled chat is
  still read, followed and woken by its key (`conversation.settle` with
  `settled: false`).
- **`conversation.resolveApproval` takes `decision: 'always'`**, a rule that
  outlives the conversation, as the lane takes it
  (`conversation-permanent-approvals`); a Studio holds it to the client's
  ceiling as it holds `conversation`. Its params type no longer leaves the
  decision out.

### Added

- **The files on a Studio's machine by path** (`file-system.ts`, capability
  `file-system`): `files.listDirectory`, `.readText`, `.exists`,
  `.checkWorkspaceFolder`, `.projectLogo`, `.projectIcon`, `.searchContent`,
  `.cancelContentSearch` and `.defaultWorkspaceParent` under `files:read`;
  `files.writeText`, `.saveDroppedImage`, `.createFile`, `.createDirectory`,
  `.rename`, `.copy`, `.move` and `.trash` under `files:write`, each once per
  command id; and the `files.watchPath` stream. None is an owner's alone. A
  client that is not an owner (or an owner's connection held to known
  folders) names a path only where it really is inside the folders the Studio
  knows, links followed and `..` taken, and writes only inside its
  workspaces' own folders, never renaming, moving or trashing one of them.
  `WorkspaceFolderCheckResult`, `ProjectLogo`, `ContentSearchResult` and
  `FileWatchEvent` move into the package.
- **Git on a Studio's machine** (`git.ts`, capability `git`): 61 methods and
  three streams.
  - `files:read`: `git.status`, `.branches`, `.commitGraph`, the file and hunk
    reads, `.changeSummary`, `.branchSteps`, `.stashList`, `.worktrees`,
    `.changelists`, `.createPatch` and the rest, with `git.checkoutChanged`
    and `git.changelistsChanged`.
  - `files:write`: staging (paths and hunks), `git.commit`,
    `.resolveConflict`, `.stashPush` and the changelist writes.
  - An owner's as well, each with its reason in the table: what moves a
    branch, rewrites history or discards work (`git.revertPaths`, `.reset*`,
    `.switchBranch`, `.rebase`, `.stashDrop`, ...), what reaches a remote
    (`git.push`, `.fetch`, `.pullWithStash`), the agents' worktrees
    (`git.pruneWorktrees`, `.unlockAgentWorktree`), and the GitHub account
    (`github.*`, with `github.cloneProgress`).
  - `versionControl.probeProviders` and `.probeHostGh` under `providers:read`.
  - A ref, branch, tag or commit may not start with `-`. The shapes move into
    the package (`git-types.ts`), with `VERSION_CONTROL_PROVIDER_IDS`.
- **The worktrees a Studio's agents run in** (`worktrees.ts`, capability
  `worktrees`): 14 methods and two streams.
  - An owner's, each with its reason in the table: the pool
    (`worktrees.poolSnapshot`, `.poolSettings`, `.setPoolSettings`,
    `.poolAction`), the installs (`worktrees.installs`, `.cancelInstall`),
    Settings ▸ Worktrees (`worktrees.inventory`, `.removeOther`), the agents'
    worktree steps (`worktrees.create`, `.restore`, `.remove`,
    `.cleanupAgents`), and `worktrees.poolChanged` and
    `worktrees.installChanged`. Removing a worktree gives the reason
    `git.pruneWorktrees` gives (`STUDIO_AGENT_WORKTREES_OWNER`).
  - `settledChats.planDelete` (`conversation:read`) and `settledChats.delete`
    (`conversation:operate`).
  - A branch or base ref may not start with `-`. The shapes move into the
    package (`worktree-types.ts`).
- **`files-mention` is served by every Studio's core.** `files.search`,
  `files.cancelSearch`, `files.stat` by path, `files.readImage` and
  `files.repoRoot` no longer need the chat surface, and the capability leaves
  `STUDIO_CHAT_CAPABILITIES`.
- **`environment.readiness`** (`readiness.ts`, capability
  `environment-readiness`, scope `providers:read`): what the Studio's machine
  has and lacks for its schedules and pull request watches (CLIs installed and
  signed in, `gh`, MCP servers, extensions) and what waits on it, in words. A
  fact the machine cannot tell is `null`.
- **`StudioPullRequestWatch.waiting`**: the words while a watch holds because
  its machine lacks `gh` or a `gh` sign-in.

- **What a follower of one chat reads and does beside its stream, by its
  key** (`followed.ts`), as the tailnet lane served it: the push topics
  `conversation.queued`, `conversation.scheduled`, `conversation.usageLimits`,
  `conversation.subagents` and `conversation.changes`, each carrying the
  lane's own frame of that kind (`ConversationQueuedFrame`, …), and the
  methods `conversation.askSideQuestion`, `conversation.cancelSideQuestion`,
  `conversation.contextBreakdown`, `conversation.searchFiles`,
  `conversation.listCommands`, `conversation.settle`, `conversation.visit`,
  `conversation.changesDiff` and `conversation.changedFile`
  (`STUDIO_FOLLOWED_METHODS`, `STUDIO_FOLLOWED_TOPICS`). Reads need
  `conversation:read`; a side question, a settle and a visit
  `conversation:operate`, and so does a command list's `refresh`.

- **The skills, design systems and cards a Studio's agents are given**
  (`src/agent-skills.ts`), under `agent-skills`: `skillSources.list`,
  `.checkUpdates`, `.add`, `.addLocal`, `.remove`, `.sync` with the
  `skillSources.updated` stream; `skills.scan`, `.readFile`, `.install`,
  `.uninstall`, `.search`, `.popularRepos`, `.ensureUserFolder`;
  `skillPlugins.scanLinked`, `.install`, `.uninstall`, `.listInstalled`;
  `workspaceSkills.list`; `installedSkills.list`, `.remove`;
  `agentCapabilities.resolve`; `agentSkills.attach`; `designSystem.library`,
  `.arrivals`, `.register`, `.forget`, `.read`, `.seed`, `.lint`, `.attach`,
  `.detach`; and `cards.run`. What can be installed and what a workspace's
  agents have is `providers:read`; reading a bundle `files:read`; the source
  list and the design library `settings:write`; installing or removing a skill
  `environment:maintain`; seeding, attaching and detaching a bundle
  `files:write`. A plugin's install and uninstall, a bundle's lint and a card's
  Go are an owner's, each with its reason. Every folder a client that is not
  an owner (or an owner's connection held to known folders) names is held to
  the folders the Studio knows, on the path it resolves to, and so is the
  folder an id stands for: a library entry's (`designSystem.attach`,
  `.forget`) and a local source's (every method naming a `sourceId`). One
  outside them is refused `not_found`. The design library, the source list and
  an update check (`skillSources.checkUpdates`, and each `skillSources.updated` push) show such a client only those. The skill, design system and card shapes
  move here from the desktop app.

- **What a Studio's agents are set up with** (`src/agent-setup.ts`), under
  `agent-setup`: `memory.resolveRoot`, `.index`, `.readPreview`;
  `memoryActivity.install`, `.uninstall`, `.startWatching`, `.status`,
  `.synapses`, `.isInstalled` with the `memoryActivity.events`,
  `.statusChanged` and `.synapsesChanged` streams; `mcp.sync`;
  `agentConfig.detect`, `.adopt`; `builtinSkills.list`, `.status`;
  `areaSkills.get`, `.setEnabled`, `.dismiss` and `areaSkills.changed`.
  Reading a project's knowledge and what a skill would install is
  `files:read`, about a `workspaceFolder` held to the folders the Studio knows
  for any client that is not an owner; what can run is `providers:read`;
  switching an area skill is `settings:write`. What writes the programs and
  hooks the agent CLIs run (`mcp.sync`, `agentConfig.adopt`, the activity
  hook's install and uninstall) is an owner's. The memory, MCP sync, adopted
  configuration and built-in skill shapes move here from the desktop app.

- **What a Studio keeps beside its chats** (`src/chat-stores.ts`, capability
  `chat-stores`). `usageLimits.get` and `usageLimits.changed`;
  `usageLimitResumes.get`, `.update`, `.setAuto` and
  `usageLimitResumes.changed`; `scheduledMessages.get`, `.update`, `.hold` and
  `scheduledMessages.changed`; `usage.report`; `conversationImport.scan` and
  `.import`. The report and the import are an owner's. The shapes
  (`UsageLimitsState`, `UsageLimitResumeState`, `ScheduledMessagesState`,
  `UsageReport`, `ConversationImportScanResult` and the rest) move here from
  the desktop app, which re-exports them under the same names.

- **Agent CLIs and launch settings on the protocol** (`src/agent-settings.ts`).
  `agent-runtimes`: `cliRuntimes.detect`, `.installMethods`, `.install`,
  `.update`, `.updateAll` with the `cliRuntimes.output` (per CLI and machine)
  and `cliRuntimes.updateAllProgress` streams, and `cliVersions.advisories`,
  `.setEnabled` with the `cliVersions.changed` stream. `agent-settings`:
  `cliModels.discover` and `cliModels.changed`, `launchSettings.get`,
  `.update`, `.migrate` and `launchSettings.changed` (an owner's: they name
  the programs the machine runs and hold MCP keys), `textGeneration.setSettings`,
  `textGeneration.chatTitle`, `commitMessage.draft` and `.cancel`. The shapes
  (`CliDetectResult`, `AgentLaunchSettings`, `CliModelDiscoveryResult`,
  `TextGenerationResult` and the rest) move here from the desktop app, which
  re-exports them under the same names. A CLI's `command` stays an owner's to
  name, now in a `runtime` member too; a commit message's checkout is held to
  the folders the Studio knows for any other client.

- **An incompatible client keeps a way to recover.** `update-session`: a
  client that lists it in its hello and authenticates with a token is sent an
  `incompatible` frame in place of the welcome when the two protocol windows
  do not meet, and the connection serves `update.status` and `update.start`
  only. `update.status` (any grant) says how the Studio is updated (`self`,
  `bootstrap` or `manual`) and where an update stands; `update.start` (scope
  `environment:maintain`, new) asks a desktop to update itself. New error
  codes `unsupported_protocol_version` and `update_unavailable`.
  `studioCompatibility` and `StudioCompatibility` name how a client stands with
  a Studio; `parseStudioUpdateStatus` reads a status forward-compatibly. The
  frame, the two methods and the hello are frozen: members are only added.

- **The mobile-control wire** (`src/mobile-control.ts`, with its command
  validator in `src/mobile-control-commands.ts`): the snapshot the phone reads
  and the commands it sends over the tailnet gateway, moved here from the
  desktop app so the desktop and the phone import one definition. Not part of
  the package entry: imported by path.

- **Modules speak on the protocol.** The `module.events` push topic carries
  what a Studio's modules emit (`StudioModuleEvent`: the stamped
  `sourceModuleId`, the module's `topic`, a JSON `payload`, `emittedAt`), all
  modules' or one's (`{ moduleId }`); `module.notifications` carries their bell
  rows (`StudioModuleNotification`), the rows the server keeps first, then each
  new one. Both need the new `modules:read` scope (permission `module:read`),
  which is not held to an owner's connection, and are offered under the
  `modules` capability. They replace the desktop's `modules:events`,
  `modules:notifications` and `modules:notifications:recent` IPC channels.

- **A module's declared methods.** `module.read` (scope `modules:read`) and
  `module.operate` (new scope `modules:operate`, permission `module:operate`,
  which carries `module:read`; a mutation with a `commandId`, audited, its
  first answer kept for a retry) call a method a module declared, by
  `{ moduleId, method, params? }`. The result is the module's own answer,
  `StudioModuleAnswer` (`{ ok: true, result }` or its `{ ok: false, code,
message }`); new error codes `module_unavailable` (the module does not run
  there) and `module_method_unknown` (no such method under that entry), and a
  module's own params validator answers `invalid_params`. Method names follow
  `isStudioModuleMethodName`. Both are offered under `modules`, and replace the
  desktop's `modules:bridge:invoke` IPC channel (host API 2 of the module SDK).
  A retry is carried out again only when the first call was refused before
  the module's handler took it; a handler that failed is answered as it
  failed, since it may already have sent to a chat. The handler is handed the
  id namespaced by the client, to pass on to a chat, whose receipt answers a
  retry after the server restarts.

### Changed (contract)

- **One table builds both ends.** `contract.ts` defines a method as a contract
  (params, result, and its own refusals beyond `StudioCommonErrorCode`) and a
  table entry (scope and validator). `STUDIO_METHODS` and `STUDIO_TOPICS` now
  carry each method's and topic's validator (`params`), so a method with no
  scope or validator does not compile. A server answers through
  `StudioHandlers`, which needs a handler per method answering that method's
  result; a client calls through `StudioRequest` or the per-method client
  `createStudioRpcClient` builds. Topics carry their payload types
  (`StudioTopicPayload`, `StudioPushTopic`).
- **Results are the protocol's own shapes.** `session.*` answer
  `ConversationSessionActionResult` / `ConversationStartSessionResult`;
  `conversation.toolDetail` a `ConversationToolDetail`; `conversation.turnDiff`
  a `ConversationCheckpointDiff`; `conversation.commands` a
  `ConversationCommandCatalog`; `providers.*` `StudioProviderListResult`,
  `StudioProviderModelsResult` and `StudioSecretStatusResult`;
  `files.search` a `StudioFileSearchResult`; `files.stat` a `StudioPathStat` or,
  by root, a `StudioFileStat`. These are the shapes Studio already sent.
- **`session.send` reads `mentions` at the edge** with
  `parseConversationMentions`, the rule the runtime applied below: a malformed
  mention, or more than 50, is now refused `invalid_params`, where it was
  answered `ok: true` with `{ ok: false, message }` inside the result, and a
  mention's unknown members are dropped before the command is fingerprinted.
- `parseStudioCommand` takes the params as an object (`parseStudioMethodParams`
  checks that first).
- A command method's params are the lane's command of that kind
  (`conversation.send` takes `skills`, `mentions`, `steer`, `composedAt`, …
  as the lane does).
- `STUDIO_ERROR_CODES` names the launch's refusals the server already sent
  (`unknown_workspace`, `workspace_folder_missing`, `no_cli_selected`,
  `cli_not_conversational`, `unknown_skill`, `conversation_start_failed`).

### Removed

- `parseStudioChatParams`, `parseStudioToolsParams`, `parseStudioFilesParams`,
  `parseStudioFilesWatchParams`, `parseStudioPullRequestsParams`,
  `parseStudioLocalServersParams` and the `isStudio…Method` guards: read params
  with `parseStudioMethodParams` / `parseStudioTopicParams`, and test a name
  with `isStudioMethod` / `isStudioTopic`.
- `StudioSessionSummary`, `StudioSessionOutcome`, `StudioOutcome`,
  `StudioRevertOutcome` and `StudioCheckpointFile`, replaced by the contract's
  own types named above.

### Added

- **The rest of the window's conversation IPC** (`chat.ts`, owners only for
  now): `session.list`, `session.stop`, `session.suspend`,
  `session.mcpServerAction`, `session.stopSubagent`, `session.messageSubagent`,
  `session.askSideQuestion`, `session.cancelSideQuestion` and
  `session.contextBreakdown`, and the `conversation.events` push topic
  (`session-controls`); `session.terminalHandoff`
  (`session-terminal-handoff`); `conversation.threads`, `conversation.search`
  and `conversation.cancelSearch` (`conversation-history`);
  `conversation.approvalRules` and `conversation.revokeApprovalRule`
  (`approval-rules`); `providers.signIn`, `providers.setSecret` and
  `providers.clearSecret` (`provider-settings`). Their result types are the
  conversation contract's (`ConversationListSessionsResult`,
  `ConversationContextBreakdownResult`, `ConversationThreadsResult`,
  `ConversationApprovalRulesResult`, `ConversationProviderSignInResult`, …).
- **What a grant reaches, from the table** (`methods.ts`):
  `STUDIO_METHOD_ACCESS` and `STUDIO_TOPIC_ACCESS` (each method's and topic's
  permissions, and whether it is an owner's only), and `studioGrantAllows` /
  `studioGrantAllowsTopic`, the server's grant check for a client deciding
  whether to offer a control, so no client reads `grant.owner`. A request can
  still be refused by a rule on its params (a folder only an owner may name, a
  file's bytes) or for a capability the Studio does not advertise.
- **Environments** (`environment.ts`): one way to name a Studio and a chat in
  it. `EnvironmentDescriptor` (a `welcome` under the client's name for the
  machine, `environmentDescriptorOf`); `EnvironmentRoute` (`local`,
  `wsl:<distro>`, `ssh:<machine>`, `tailnet:<connection>`) with
  `formatEnvironmentRoute`, `parseEnvironmentRoute` and
  `orderEnvironmentRoutes` (this machine, WSL, tailnet, then SSH); and
  `ChatAddress` `{ environmentId, chatId }` with `formatChatAddress` and
  `parseChatAddress`. Types and helpers only: nothing on the wire changes.
- **Chat links** (`chat-link.ts`): the one `sprintengine://` grammar every
  client reads and writes. `parseStudioLink` reads the sign-in callback and
  `sprintengine://chat/<environmentId>/<chatId>[?agent=<agentId>]` as a
  `ChatLink` `{ environmentId, chatId, agentId }`, and a link from before links
  named an environment, `sprintengine://chat/<chatId>`, with `environmentId`
  null; `parseChatLink` takes chat links only; `chatLinkFor(address, agentId?)`
  writes the two-segment form, or null for an id a link cannot carry
  (`isLinkId`, the same alphabet as `isEnvironmentId`). `STUDIO_LINK_SCHEME`
  and `STUDIO_LINK_SCHEMES` name the scheme. No imports, so a client can build
  the file on its own.
- The socket does not advertise `conversation-changes`: its conversation topic
  carries no `changes` frames.
- **The person's words for one agent** (`conversation-agent-message`, in
  `welcome.conversation`, owners): `conversation.messageSubagent` passes them to
  one agent a chat spawned, through that chat's model.

- The socket does not advertise `conversation-subagents`: its conversation
  topic carries no `subagents` frames, and a window on it reads a chat's
  sub-agents from the records.
- **Permissions** (`permissions.ts`): `STUDIO_PERMISSIONS`, the closed set of
  what a remote caller may do; every method and topic needs the permission its
  `scope` names plus any `extraPermissions` it adds (`studioSpecPermissions`),
  so none can need less than its scope; `STUDIO_SCOPE_PERMISSIONS`, what each
  scope a grant holds carries; and `authorizeStudioMethod`,
  `authorizeStudioTopic` and `authorizeStudioAccess`, the one decision (deny
  by default: an unknown method, then an owner's, then the first permission
  missing). Nothing on the wire changes: a grant is still sent as scopes, and
  a refusal is still `owner_required` or `scope_required` naming the scope
  (or, for a permission a method adds, that permission:
  `studioRefusedGrantName`).
- `subagent` among `STUDIO_RESERVED_TOOLSET_NAMES`: `subagent.start`,
  `subagent.status` and `subagent.cancel`, with which a chat runs a sub-agent
  of its own, which a Studio serves.
- `visual` among `STUDIO_RESERVED_TOOLSET_NAMES`: `visual.preview`, which
  draws an agent's ```visual block as the chat will and answers with a
  picture, its height and its console, which a Studio's shell offers.
- `plugin` among `STUDIO_RESERVED_TOOLSET_NAMES`: `plugin.search`, which
  finds a plugin in the sources a Studio lists, and `plugin.offer`, which
  shows one in the calling agent's chat to install, which a Studio's shell
  offers.
- `extension` among `STUDIO_RESERVED_TOOLSET_NAMES`: `extension.create`,
  which makes a SprintEngine Studio extension project, and `extension.guide`,
  the guide to building one, which a Studio's shell offers.
- **A chat's effort, its MCP servers and its agent's restart**
  (`conversation-reasoning-effort`, `conversation-mcp-server-actions` and
  `conversation-restart-session`, in `welcome.conversation`, owners):
  `conversation.setReasoningEffort` sets the level the chat runs at from its
  next turn (`effort?`, none for the provider's default);
  `conversation.mcpServerAction` reconnects one of a live chat's MCP servers
  or switches it on or off (`serverId`, `action`: `reconnect`, `enable` or
  `disable`); `conversation.restartSession` ends the chat's agent process,
  keeping its place for the next message. Their params are read by the
  conversation lane's own validator, and they reach the same host. A Studio
  built before them does not advertise them and refuses the methods as
  unknown.
- **A usage limit's resume** (owners): `conversation.usageLimitResume`
  (`action`: `schedule`, `cancel`, `dismiss` or `retry`; `always` beside
  `schedule`) acts on the notice a usage limit left on a chat's turn, as the
  conversation lane's `usageLimitResume` does, read by its own validator and
  carried to the same host. The socket does not advertise
  `conversation-usage-limits`: its conversation topic carries no `usageLimits`
  frames. A Studio built before it refuses the method as unknown.

- **A message scheduled for a time** (owners): `conversation.scheduleSend`
  (`message`, `sendAt`) has the desktop keep a message and send it into the
  chat then, and `conversation.sendScheduledNow` and
  `conversation.cancelScheduled` (`scheduledId`) send one it keeps at once or
  delete it: the conversation lane's `scheduleSend`, `sendScheduledNow` and
  `cancelScheduled`, read by its own validator and carried to the same host.
  The socket does not advertise `conversation-scheduled-sends`: its
  conversation topic carries no `scheduled` frames, as it carries no `queued`
  ones. A Studio built before them refuses the methods as unknown.

- **One agent stopped by itself** (`conversation-stop-subagent`, in
  `welcome.conversation`, owners): `conversation.stopSubagent` stops one agent a
  conversation spawned, named by the call that spawned it (`toolUseId`), and
  leaves the conversation, its turn and its other agents running. Its params
  are read by the conversation lane's own validator, and it reaches the same
  host. A Studio built before it does not advertise it and refuses the method
  as unknown.

- **Handoff** (`conversation-handoff`, owners): `conversation.handoff` hands a
  chat off to a fresh session of its CLI instead of compacting it. The chat's
  messages, without its tool calls, are saved to a file on the machine its
  agent runs on, and the answer names that file (`{ ok: true, path }`); the
  next message sent to the chat points the new session at it. A Studio built
  before it does not advertise it and refuses the method as unknown, so a
  client offers Handoff only where it is listed.

- **The project's store as a file root** (`files-write`, owners): a
  `StudioFileRoot` may be `{ kind: 'store', workspaceId }`, the folder in the
  person's home where Studio keeps a project's browser captures, recordings
  and chat transcripts, which older builds kept in the project's
  `.sprintengine/`. `files.roots` answers `store: true` where it is served; a
  Studio built before it leaves the member out and refuses the kind, so a
  client asks for it only where it is listed. A read of the workspace root's
  `.sprintengine/…` that the folder no longer has is answered from the store,
  so a client that learned such a path from an older Studio still finds the
  file.

- **A steered send** (`conversation-steer-sends`, in `welcome.conversation`):
  `conversation.send` may say `steer: true`, read by the conversation lane's
  own validator, and the message goes into the turn the conversation is
  running where its provider takes one. A turn that cannot take it has the
  Studio hold the message for the turn's end, answered with a `notice`.

- **Pull request watches** (`pull-request-watch`, owners): `pullRequests.unwatch`
  stops a conversation's watch on one of its pull requests, and a listed
  `StudioPullRequest` may carry `watch` (`StudioPullRequestWatch`: when it
  began, what it waits on, whether it is approved and set to merge on its
  own, its base and how many checks failed) while the conversation's agent has
  the Studio watching it.

- **`conversation.cancelQueued`** (operate, an owner's only), the
  conversation lane's `cancelQueued` command as a method: it takes back a
  message the desktop holds for a chat's turn to end, by its `queuedId`. The
  socket does not advertise `conversation-queued-sends`, since its
  conversation topic carries no `queued` frames, so it names no held message
  to an app; the method is here so the socket carries every command kind the
  lane defines.
- **Client tools** (`client-tools`): `tools.offer`, `withdraw`, `focus`,
  `catalog`, `grants` and `grant`, the `tools.catalog` stream, the `call` /
  `cancel` server frames and `reply` / `progress` client frames, the
  `tools:offer` scope, `STUDIO_TOOL_LIMITS` and the validators
  (`parseStudioToolsetOffer`, `parseStudioToolResult`, …).
- **Files by root** (`files-write`, owners): `files.roots`, `list`, `read`,
  `write`, `remove`, `stat` with a `root`, the `files.watch` stream, the
  `files:write` scope, and `uploads.begin { purpose: 'file' }`.
- `hello.client.kind` and `hello.client.instanceId`; the `reserved_name`,
  `name_taken` and `not_offered` codes.
- `worktree` among `STUDIO_RESERVED_TOOLSET_NAMES`: the worktree pool's
  `worktree.lease` and `worktree.release`, which a Studio's shell offers.
- `artifacts` among `STUDIO_RESERVED_TOOLSET_NAMES`: `artifacts.publish`,
  `list`, `search`, `get`, `update` and `delete`, which publish an agent's
  HTML pages to the site set on Settings ▸ Artifacts, and which a Studio's
  shell offers.

- **The chat surface** (`chat.ts`): `session.*`, `uploads.*` (with
  `uploads.discard`), the
  conversation's `revert`, `rewind`, `fork`, `attachment`, `planDocument` and
  `commands` with its `conversation.commands` stream, `providers.*`, `files.*`
  and `workspaces.list`; their param validators (`parseStudioChatParams`) and
  limits; the scopes `providers:read`, `files:read` and `workspaces:read`; and
  the capabilities in `STUDIO_CHAT_CAPABILITIES`. Every chat method is an
  owner's only (`StudioMethodSpec.owner`, refused `owner_required`).
- **Folder keys.** A conversation key may carry `workspaceRoot`, an owner's
  only, behind `conversation-folders` (`key.ts`).
- **Files attached by path** (`session-files`): `session.send` takes `files`,
  a list of at most `STUDIO_MAX_FILES_PER_SEND` `{ path }` (`StudioAttachedFile`),
  and the `user_message` the send becomes carries them as `files`. Additive: a
  Studio without the capability drops the member unread, so a client sends it
  only where the capability is advertised.
- **Push streams.** `{ t: 'push', sub, payload }` for a stream with no cursor.
- **`server.ping`**, answered at once, for a client's liveness check.
- **Error ids.** A refusal's error and a `subFailed` frame may carry `errorId`.
- **`command_id_conflict`**, for a command id reused for a different command.

## 0.1.0

The first version: what Studio serves on its owner socket.

### Added

- **The envelope.** `hello` / `welcome` / `bye`, requests answered under their
  id (`res`), streams keyed by subscription (`sub`, `frame`, `subFailed`,
  `unsub`) and chunking for frames over `STUDIO_MAX_FRAME_BYTES`, with their
  validators for both ends (`parseStudioClientFrame`,
  `parseStudioServerFrame`) and a chunk assembler for clients.
- **The handshake.** `STUDIO_PROTOCOL_VERSION` (1) and its window,
  `checkStudioProtocolVersion`, and the Studio capabilities `conversations`,
  `conversation-create` and `local-pairing`. The conversation contract's
  `hello` answer is nested in the `welcome` unchanged.
- **Scopes and grants.** `conversation:read`, `conversation:operate` and
  `conversation:create`, and a grant's permission `ceiling`.
- **The method table.** `STUDIO_METHODS` and `STUDIO_TOPICS`, each naming its
  scope, for the `server` and `conversation` namespaces; params validated by
  `parseStudioMethodParams`, a command's through the conversation lane's own
  validator.
- **Discovery.** The `server.json` a running Studio writes beside its socket.
- **The conversation contract**, re-exported from
  `@sprintengine/conversation-protocol`, which this package depends on.
