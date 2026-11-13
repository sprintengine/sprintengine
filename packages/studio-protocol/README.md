# Studio protocol

The protocol SprintEngine Studio serves to its clients: the connection
envelope, the handshake, the scopes a client is granted and the table of
methods and streams. It carries the conversation contract from
[`@sprintengine/conversation-protocol`](../conversation-protocol/README.md)
unchanged and re-exports all of it, so a client depends on this one package.
[`@sprintengine/agent-sdk`](../agent-sdk/README.md) is the client library
built on it.

The conversation package stays what it is: the conversation lane on its own,
which Studio also serves to paired devices over the tailnet. This package adds
the connection around it. No Electron, Node or React dependencies; it runs in
Node and in a browser.

## Where it is served

A running Studio listens on an **owner socket**: a Unix domain socket in a
directory only its owner can enter (`<data directory>/run/studio.sock`, the
directory `0700` and the socket `0600`), or a named pipe on Windows whose name
carries a random part minted at each start. The socket's address, and the
protocol window, are in `<data directory>/run/server.json`
(`parseStudioServerDiscovery`), written once it is listening and removed when it
stops. Each frame is one line of JSON.

File permissions are not the whole of the check. Every connection presents a
credential in its first frame, because a Windows pipe's default access is wider
than its owner, and a second check costs nothing.

## The connection

```
client → Studio
  { t: 'hello', protocolVersion, minProtocolVersion?, client: { name, version? }, auth: { token } | { pairingCode } }
  { t: 'req',   id, method, params }
  { t: 'sub',   id, topic, params, cursor?: { afterSeq, generation } }
  { t: 'unsub', id }

Studio → client
  { t: 'welcome', protocolVersion, minProtocolVersion, server, environment, capabilities, conversation, grant, pairing? }
  { t: 'res', id, ok: true, result } | { t: 'res', id, ok: false, error: { code, message, retryAfterMs? } }
  { t: 'frame', sub, frame }                       // a conversation server frame: snapshot, event, synchronized
  { t: 'push', sub, payload }                      // one message of a stream with no cursor
  { t: 'subFailed', sub, code, message, retryable, retryAfterMs?, errorId? }
  { t: 'chunk', frameId, index, total, json }      // a frame over STUDIO_MAX_FRAME_BYTES
  { t: 'bye', code, message, retryAfterMs? }       // Studio is closing the connection
```

A refusal Studio tells in stable words, in place of a cause that could name
its internals, carries `errorId`: an opaque id it logged beside the real
cause, for someone looking into it to quote.

`hello` is the first frame, within `STUDIO_HELLO_TIMEOUT_MS`. It is answered by
`welcome`, or by `bye` and a close: `unauthorized` for a credential Studio does
not hold, `unsupported_protocol_version` with both numbers named
(`checkStudioProtocolVersion`). Validate what a Studio sends with
`parseStudioServerFrame`; a Studio validates what a client sends with
`parseStudioClientFrame` and `parseStudioMethodParams`.

## Pairing and grants

A local app is paired once. The person mints a one-time pairing code in
Studio's Settings, naming the app, the scopes it gets and its permission
ceiling. The app's first `hello` presents `{ pairingCode }`; its `welcome`
carries `pairing.token` — Studio keeps only its hash. The code stays good
until that token is first presented: a welcome lost with its connection is
answered again by presenting the code again, with a fresh token that voids the
lost one. Every later `hello` presents `{ token }`, which spends the code. Revoking the app in Settings ends its open
connections with `bye { code: 'revoked' }`.

The `welcome`'s `grant` is what the connection may do:

- `scopes` — `conversation:read` (list, follow, read), `conversation:operate`
  (every command; implies read) and `conversation:create` (start a chat). Each
  method's scope is in `STUDIO_METHODS`, and what it needs is the permission
  that scope names plus any `extraPermissions` it adds
  (`studioSpecPermissions`, from `STUDIO_PERMISSIONS`): a grant's scopes are
  translated to permissions
  (`STUDIO_SCOPE_PERMISSIONS`) and checked against those on every request,
  as the grant stands then (`authorizeStudioMethod`). An unknown method is
  refused.
- `ceiling` — the loosest permission preset the client's chats may run on. A
  chat it starts, or switches, with a looser preset is lowered to the ceiling,
  and one it starts without a preset is pinned to it. A chat that already runs
  looser than the ceiling can be read, interrupted and stopped, and its
  requests denied, but not sent to or approved; a chat whose session runs
  tools unasked counts as `bypass` for that. Naming `allowedTools` needs a
  `bypass` ceiling, since a tool allowed unasked is as loose as bypass for it,
  and answering a request `conversation` (an allow rule for its kind) needs a
  ceiling of at least `auto`.
- `environment:maintain` — update this Studio (`update.start`): download a
  new version, drain and restart into it; install or update an agent CLI on
  its machine (`cliRuntimes.install`, `.update`, `.updateAll`, and their
  `cliRuntimes.output` and `cliRuntimes.updateAllProgress` streams).
- `settings:write` — change this Studio's settings: set or clear a provider's
  key (`providers.setSecret`, `.clearSecret`), revoke an approval rule, turn
  the CLI version check on or off (`cliVersions.setEnabled`), set the
  model-written titles setting (`textGeneration.setSettings`), switch the
  resume after a usage limit for every chat (`usageLimitResumes.setAuto`),
  and, with `conversation:operate`, open a chat to an app's toolset or close
  it (`tools.grant`).
- `providers:read` also reads the agent CLIs: detect one, its install methods
  and version advisories (`cliRuntimes.detect`, `.installMethods`,
  `cliVersions.advisories` and its `cliVersions.changed` stream, under
  `agent-runtimes`), and the models each reports (`cliModels.discover`,
  `cliModels.changed`, under `agent-settings`). Having the person's CLI write
  a chat's title or a commit message (`textGeneration.chatTitle`,
  `commitMessage.draft` and `.cancel`) is an owner's: it runs a CLI on the
  Studio's machine outside any chat.
- The skills, design systems and cards a Studio's agents are given are under
  `agent-skills`: what can be installed and what a workspace's agents have is
  `providers:read`, reading a design bundle `files:read`, the skill sources and
  the design library `settings:write`, installing or removing a skill
  `environment:maintain`, and seeding, attaching or detaching a bundle
  `files:write`. A plugin's install and uninstall, a bundle's lint and a card's
  Go (`cards.run`) are an owner's.
- `modules:read` — hear what this Studio's modules say: the `module.events`
  and `module.notifications` streams, and call the methods they declare
  `read` (`module.read`), under the `modules` capability. It also reads the
  host's services as a module's window half does, naming the module
  (`moduleBacklog.location`, `moduleUsage.query`). Not an owner's only; a
  pairing holds it when it was given it.
- `modules:operate` — call the methods modules declare `operate`
  (`module.operate`, once per `commandId`), and write the Backlog as a module
  (`moduleBacklog.create`, `.updateStatus`, `.updateTriage`, `.addLink`,
  `.updateModuleMetadata`); carries `modules:read`. The module's own manifest
  permissions (`backlog.write`, `usage:read`) are checked on every call. A
  browser session never holds it.
- No scope changes what runs: `module.setEnabled`, `module.install`,
  `module.setTrust` and `module.uninstall` are an owner's
  (`STUDIO_MODULES_OWNER`), because each installs, trusts, starts or stops an
  extension's code on that machine. `module.list`, what runs there, needs
  `modules:read`.
- `workspaces:operate` — change this Studio's scheduled agents: make,
  change, run now, pause, resume and close one (`schedules.create`,
  `.update`, `.runNow`, `.pause`, `.resume`, `.delete`, under the `schedules`
  capability, each once per `commandId`); carries `workspaces:read`, which
  lists them (`schedules.list` and the `schedules.changed` stream) and reads
  this machine's usage rows for a paired desktop's dashboard (`usage.rows`).
  A paired device holds it with its `workspace:operate` pairing.
- No scope reaches the terminals (`terminal.*`, under the `terminals`
  capability). A terminal is a shell on this machine, so every terminal
  method and stream is an owner's: the app's own windows and the owner's
  credential only. A paired device, a local app or a browser, an owner's tab
  included, is refused them whatever it holds, and a browser is not offered
  `terminals` or `session-terminal-handoff`. An owner's connection other than
  the app's own window is sent sessions without the prompts a person wrote or
  a launch's MCP settings.
- `owner` — the connection is Studio's own, with every scope and no ceiling.
  A few methods and topics are an owner's only, whatever scopes another grant
  holds, and are refused `owner_required`; each says why in its table entry's
  `owner`: `session.terminalHandoff` and `providers.signIn` (a terminal on
  Studio's own screen), `pullRequests.noteWork`, `.noteToolCall` and `.link`
  (what Studio's own agents report), `terminal.takeUndeliveredPrompts` and the
  `terminal.promptUndelivered` topic (words a person wrote for an agent), and
  `terminal.configure` (the machine's idle policy), and the launch settings
  (`launchSettings.get`, `.update`, `.migrate` and the `launchSettings.changed`
  topic: they name the program each CLI and MCP server runs on the machine and
  hold the MCP servers' keys), and what writes the programs and hooks the
  agent CLIs run (`mcp.sync`, `agentConfig.adopt`, `memoryActivity.install`
  and `.uninstall`). Everything else reaches a client by its scope.
  A client that is not an owner never names a conversation's folder or a
  CLI's `command` (in `cliRuntimes` or a detection's or install's `runtime`),
  and names files and folders (a stat, a picture, a search, a file attached to
  a send, a `/` list's folder, an agent's plan file, a commit message's
  checkout) only inside the folders Studio knows. A
  client asks whether its grant reaches a method with
  `studioGrantAllows(grant, method)` (`STUDIO_METHOD_ACCESS` holds the table)
  rather than reading `grant.owner`.

## Methods

Every method and topic is defined once, in one table that builds both ends
(`contract.ts`). A family's type map (`StudioChatMethodMap`, …) says what each
method takes, what it answers and the refusals of its own it may answer with
beyond the common ones (`StudioCommonErrorCode`); a topic's says what each
message carries (`StudioTopicPayload`). `STUDIO_METHODS` and `STUDIO_TOPICS`
hold each one's scope and the validator its params are read by
(`parseStudioMethodParams`, `parseStudioTopicParams`), typed over the map's
keys: a method without a scope or a validator does not compile. A server
answers through a `StudioHandlers` map, a handler per method typed by its
contract, so a missing handler, a wrong result or an undeclared refusal does
not compile either. A client calls through `StudioRequest`, or the call per
method `createStudioRpcClient` builds from the same table.

| Method                             | Scope    | Takes                                           | Answers                                          |
| ---------------------------------- | -------- | ----------------------------------------------- | ------------------------------------------------ |
| `server.info`                      | any      | —                                               | the welcome, without its pairing                 |
| `server.ping`                      | any      | —                                               | `{ at }`, at once: the line is alive             |
| `conversation.list`                | read     | —                                               | `{ conversations: ConversationThread[] }`        |
| `conversation.create`              | create   | `ConversationCreateRequest` + `commandId`       | `{ conversation }`                               |
| `conversation.send`                | operate  | `key`, `commandId`, the lane's `send` members   | `{ notice? }`, when the turn ends                |
| `conversation.interrupt`           | operate  | `key`, `commandId`                              | `{}`                                             |
| `conversation.resolveApproval`     | operate  | `key`, `commandId`, `requestId`, `decision`     | `{}`                                             |
| `conversation.answerQuestion`      | operate  | `key`, `commandId`, `requestId`, `answers`      | `{}`                                             |
| `conversation.resolvePlan`         | operate  | `key`, `commandId`, `requestId`, `decision`     | `{}`                                             |
| `conversation.setPermissionPreset` | operate  | `key`, `commandId`, `preset`, `permissionMode?` | `{ permissionPreset, permissionMode?, notice? }` |
| `conversation.setModel`            | operate  | `key`, `commandId`, `modelId`                   | `{ modelId, notice? }`                           |
| `conversation.cancelQueued`        | operate  | `key`, `commandId`, `queuedId`                  | `{}`                                             |
| `conversation.stopSubagent`        | operate  | `key`, `commandId`, `toolUseId`                 | `{}`                                             |
| `conversation.messageSubagent`     | operate  | `key`, `commandId`, `toolUseId`, `message`      | `{}`                                             | Passes the person's words to one agent, through the chat's model. |
| `conversation.setReasoningEffort`  | operate  | `key`, `commandId`, `effort?`                   | `{ notice? }`                                    |
| `conversation.mcpServerAction`     | operate  | `key`, `commandId`, `serverId`, `action`        | `{}`                                             |
| `conversation.restartSession`      | operate  | `key`, `commandId`                              | `{ notice? }`                                    |
| `conversation.scheduleSend`        | operate  | `key`, `commandId`, `message`, `sendAt`         | `{}`, once it is kept                            |
| `conversation.sendScheduledNow`    | operate  | `key`, `commandId`, `scheduledId`               | `{}`                                             |
| `conversation.cancelScheduled`     | operate  | `key`, `commandId`, `scheduledId`               | `{}`                                             |
| `conversation.usageLimitResume`    | operate  | `key`, `commandId`, `action`, `always?`         | `{}`                                             |
| `conversation.stop`                | operate  | `key`, `commandId`                              | `{}`                                             |
| `conversation.fork`                | create   | `key`, `commandId`, `newAgentId`, the point     | `{ ok: true, address, name }`                    |
| `conversation.loadEarlier`         | read     | `key`, `beforeCursor`, `turnLimit?`             | `{ page }`                                       |
| `conversation.toolDetail`          | read     | `key`, `toolUseId`                              | `{ detail }`                                     |
| `conversation.event`               | read     | `key`, `seq`, `id`                              | `{ event }`                                      |
| `conversation.turnDiff`            | read     | `key`, `turnSeq`, `path?`                       | `{ diff, patch?, … }`                            |
| `update.status`                    | any      | —                                               | `StudioUpdateStatus`: how it is updated          |
| `update.start`                     | maintain | `commandId`, `targetVersion?`                   | `{ accepted, method: 'self', targetVersion }`    |

`conversation.fork` (`conversation-fork`) forks a chat at a reply
(`side: 'assistant'`, `turnId`) or before one of the person's messages
(`side: 'user'`, `turnSeq`), as the tailnet lane's `fork` does: the fork joins
the chat's workspace as its twin, named by the Studio beside the workspace's
other chats, and is answered with where it is (`address`, a
`ConversationAddress`: this Studio's environment id, the chat, `newAgentId`)
and its `name`. A client opens it by that address. A Studio that withholds
`conversation-fork` is one from before the answer said where; a client does
not ask it to fork.

A key is `{ workspaceId, agentId }`. An owner may add `workspaceRoot`, the
folder the conversation is kept in when that is not its workspace's (a chat
started in a run worktree), where the Studio serves `conversation-folders`.

A command's params are the conversation lane's command plus its `key` and
`commandId`, read by the lane's own validator (`parseStudioCommand`), so a
command means the same thing on this socket as on the tailnet. Every mutation
carries a `commandId`, recorded as a durable receipt before the work starts: a
retry with the same id, on the same connection or after a reconnect or a
restart of the app, is answered with the first attempt's result and never
carried out twice. A create's `commandId` is kept on the chat it made, so a
retried create finds that chat. Command ids are namespaced per client by
Studio, so one client can neither collide with nor answer from another's. An
id names one command: sent again with different params, or for another method,
it is refused `command_id_conflict` rather than answered with the first
command's result.

## The chat surface

What a chat view needs beside the conversation lane, so any client can show
and drive a chat as Studio's own windows do (`chat.ts`). Each reaches a client
by its scope; `session.terminalHandoff` and `providers.signIn` are an owner's.

| Method                                                                  | Scope             | What                                                                                    |
| ----------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `session.start`                                                         | operate           | start a provider session for a chat                                                     |
| `session.send`, `.interrupt`, `.respond`, `.setPermission`, `.setModel` | operate           | drive a live session by its id, with all a composer sends; answered with its outcome    |
| `uploads.begin`, `.append`, `.discard`                                  | operate           | stage a picture in pieces of `STUDIO_UPLOAD_CHUNK_BYTES`; a send names it by `uploadId` |
| `conversation.revert`, `.rewind`                                        | operate           | a turn's files from its checkpoint; back to an earlier message                          |
| `conversation.attachment`, `.planDocument`, `.commands`                 | read              | a sent picture; a proposed plan as a file; the `/` command list a CLI reports           |
| `providers.list`, `.models`, `.secretStatus`                            | `providers:read`  | the providers a chat can run, their models, whether each has its key                    |
| `files.search`, `.cancelSearch`, `.stat`, `.readImage`, `.repoRoot`     | `files:read`      | @-mention search and the file facts a chat's links and pictures need                    |
| `workspaces.list`                                                       | `workspaces:read` | the workspaces this Studio holds                                                        |

A session method's result is the runtime's own outcome, a refusal by the
runtime included: `{ ok: true, session, notice? } | { ok: false, message,
event? }`, inside a successful response. The response's error is for the
request itself. The same holds for the other methods whose outcome has an `ok`
of its own.

Staged pictures are the client's, counted against the connection that staged
them, and expire unsent after ten minutes (a minute once that connection has
closed and no other has taken them up); `uploads.discard` gives back what will
not be sent. `files.stat` and `files.readImage`, and the rest of the files by
path (`file-system`), read only inside a workspace's folder or Studio's own
stores of sent pictures and plans, and refuse a path that is not the plain
spelling of where it really is; an owner's connection not held to known
folders (Studio's own window) reads any path, as the window always could.

`{ t: 'sub', id, topic: 'conversation.commands' }` hears every command list a
CLI reports from then on, one `push` frame each, nothing replayed.

## Following a conversation

`{ t: 'sub', id, topic: 'conversation.session', params: { key, turnLimit? }, cursor? }`
follows one conversation exactly as the conversation lane does: a `snapshot`
(or, for a `cursor` the log can vouch for, only the events after it), one
`synchronized` fence, then live `event`s, each wrapped as `{ t: 'frame', sub,
frame }`. Keep the fence's `seq` and `generation` and the `seq` of every event
after it: they are the cursor to resume from after a reconnect. A cursor the
log cannot vouch for is answered with a `snapshot` carrying `reset: true`.
Sequence numbers increase with gaps; a gap is never a reason to resubscribe.

A client that stops reading has text deltas merged while it catches up, and
is then sent `bye { code: 'resync_required', retryAfterMs }`. Wait that long,
reconnect, and resubscribe with your cursors. Requests beyond the
per-connection bound are answered `busy` with a `retryAfterMs`, and the
connection stays open.

## Versioning

`STUDIO_PROTOCOL_VERSION` is 1, with one version of slack
(`STUDIO_PROTOCOL_MIN_SUPPORTED`), refused at the handshake by an error naming
both numbers. Features are asked about by capability (`studioPeerSupports`),
never by version: `conversations`, `conversation-create`, `local-pairing`,
and with the chat surface `conversation-folders`, `conversation-sessions`,
`conversation-files`, `conversation-checkpoints`, `conversation-commands`,
`providers`, `workspaces`, `session-files` (it lets
`session.send` attach files by path), `conversation-handoff`,
`session-controls`, `session-terminal-handoff`, `conversation-history`,
`approval-rules` and `provider-settings` (`STUDIO_CHAT_CAPABILITIES`);
`files-mention`, `file-system`, `git` and `worktrees` from every Studio's core. The
conversation contract's own version and capabilities travel in
`welcome.conversation`, unchanged. The policy is the repository's
`docs/compatibility.md`.

A client outside the window is closed with `bye unsupported_protocol_version`,
unless its hello lists `update-session` and it authenticates with a token: then
it is sent an `incompatible` frame in place of the welcome (who the Studio is,
which side is behind, and its `update.status`), and the connection serves the
two update methods only. `studioCompatibility` reads `compatible`,
`client-outdated`, `server-outdated` or `unknown` from any window a client has
heard. The frame, the update methods and the hello never change shape: members
are only added, optional (`update.ts`).
