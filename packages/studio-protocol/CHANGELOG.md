# Changelog

## Unreleased

### Changed (grants)

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

### Added

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
