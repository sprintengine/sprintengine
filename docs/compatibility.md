# Wire compatibility

Studio talks to software it does not ship with: another Studio on your tailnet,
the phone app, and the extensions people install into it. Both ends update on
their own schedule, so neither can assume the other is the same build. This
file is the policy for what that obliges you to do when you change something
that crosses the gap.

It is short on purpose. The one thing it must get across: **a wire format is not
a private data structure, and changing one is not a local edit.**

## What is versioned

| Wire                                                                                  | Version                                 | Window                                           | Declared in                                     |
| ------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Tailnet transport — a paired phone or Studio reaching this one                        | `TAILNET_TRANSPORT_VERSION` (integer)   | current only (3)                                 | `src/main/automation/tailnet/tailnet-routes.ts` |
| MCP                                                                                   | dated strings, newest first             | every entry in the list                          | `src/shared/mcp/protocol.ts`                    |
| Module host API — an installed extension built against `@sprintengine/module-sdk`     | `HOST_API_VERSION` (integer)            | `HOST_API_MIN_SUPPORTED` .. current              | `src/shared/modules/host-api.ts`                |
| Studio protocol — a client on Studio's owner socket (`@sprintengine/studio-protocol`) | `STUDIO_PROTOCOL_VERSION` (integer)     | `STUDIO_PROTOCOL_MIN_SUPPORTED` .. current       | `packages/studio-protocol/src/handshake.ts`     |
| Embed `postMessage` — a page framing an embedded conversation (`se.embed`)            | `EMBED_PROTOCOL_VERSION` (integer, `v`) | current only (one version of slack when 2 ships) | `src/renderer/src/web/embed/embedProtocol.ts`   |

One more version number is near these and is **not** a wire window: the
backlog item schema version is a file format, and is not negotiated with a peer.
(`mobileControlWorkspaceSnapshotVersion` was a second; it versioned the mobile
snapshot's `workspaces` detail body and left the wire with it in v4. The
mobile-control wire itself, with `mobileControlProtocolVersion`, went on
2026-11-12: see "The phone's reads are Studio protocol methods" below.)

The tailnet transport carried a capability list beside its version until
transport 3 (2026-11-14). What a paired device may ask of a Studio is now the
Studio protocol's to say, on its welcome; see "Capabilities, not version
arithmetic" below.

Three wires between this app and the Studio server trees it installs on a WSL
distribution or an SSH machine are private and are not in this table: the
bootstrap envelope, the front door's proof preamble (`FRONT_DOOR_PROOF_VERSION`)
and the SSH relay's multiplexer (`MUX_VERSION` in
`resources/wsl-server/relay-mux.mjs`). Both ends are this app's own build: the
tree is installed per app version and checked by digest. An SSH machine can run
another version's server (a newer desktop installed it); its `run/server.json`
says the Studio protocol window it speaks, and the desktop attaches it when that
window meets its own, upgrades an older managed one, and otherwise refuses in
words (`locateServer` in `src/main/environments/ssh/ssh-connect-script.ts`). An
upgrade that does not start falls back to the previous server and is not
retried on its own (`run/update-failed.json`). Bump `MUX_VERSION` whenever a
frame does. A number once on `main` is spent, even before a release, since a
nightly may already carry it: two changes made side by side take one each.

There was a fourth, the conversation backend wire (`BACKEND_WIRE_VERSION`, last
9), which carried a WSL distribution's chats to the desktop's router while a
per-distribution switch sent them there. It went on 2026-11-13 with the router
and the switch (design-wsl-ssh-direct PR 3c): every WSL chat is the
distribution's own Studio's, reached on the Studio protocol like an SSH
machine's. The front door's purposes are now `studio` (the desktop's owner
connection) and `ws` (2026-11-13): a window's socket, which the desktop's
loopback route for that machine carries to the server's own window listener.
The proof says only that the stream came through the front door; the listener
admits it by the ticket it minted, as it admits a local window. A server tree
refuses an unknown purpose in words, and the desktop updates it.

A session's summary, which every Studio pushes with every chat event, carries
three optional clocks a reader must not count on: `lastTurnEndedAt` (when
the agent last finished a turn), `turnStartedAt` (when the turn now running
began) and `waitingSince` (when the chat began waiting on the person, by the
time of the approval or question that stopped it; absent while nothing is
asked). Each is additive, with no bump: a server of the same wire version
built before one existed leaves it out, and the desktop reads that absence
as it did before the member: a "working for" count and the next chat that
needs you (`nextWaitingChat.ts`) both fall back to `updatedAt`. A fourth,
`workingSince` (2026-10-20: when the chat's current stretch of work began,
held through the turns it opens by itself while a background agent or a
monitor works; present only while the summary reads as working), is additive
the same way: a server built before it leaves it out, and the desktop counts
"working for" from its own reading of the turns, as it did before.

The summary also carries `fileActivity`: the files the chat's tool calls are
reading and editing, and the ones they finished with in the last minute, which
the Files tree marks. It is additive in the same way. A server built before it
leaves it out, and the tree reads that as an agent touching nothing: the tree
draws no trail for that chat, and nothing else reads the member.

A conversation search hit carries `from`: who wrote the matching words (the
person, the agent, or Studio). It is additive in the same way. A server built
before it leaves it out, and the palette still shows the match, without the
"You:" or "Agent:" in front of it, ranked after the hits that say.

So is `backgroundTasks`: the shells, monitors and workflows the chat's process
still runs after its turn ended, which a `session_updated` event carries as the
whole list each time it changes. A server built before it leaves both out, and
the desktop reads that as nothing running: a monitor does not keep the chat
working, the composer names nothing it waits on, and that server's own idle
sweep is the one that decides whether its child lives. Stop between turns is the
same `interrupt` the wires already carry: a server built before it answers as
it always did, that the session has no active turn, and the chat says so.

So is `goal`: the goal a Codex chat keeps working toward by itself, which a
`session_updated` event carries when it changes, and as null once there is
none. A server built before it never sends it, and its chats have no goal to
show. A client built before it skips the member, as it skips any it does not
know; the turns Codex starts toward the goal reach it as `turn_started` with no
`user_message` before them, which every client already takes for a turn an
agent carried on with by itself. That event's `follows`, the turn it came
straight after, is read by the desktop's own runtime and by nothing else.

## The support window

The tailnet transport has **no slack** since transport 3 (2026-11-14), which
took away every route a build on 2 drove its chats with: the conversation
lane, the change feed and the canvas lane. Anything else is refused at the
handshake, by a named error that says both what was seen and what is supported.

- Tailnet: `checkTailnetTransportVersion` in `tailnet-routes.ts`, applied in
  `readRemoteIdentity` (`tailnet-remote-client.ts`). A machine outside the window
  is reported unreachable with the reason, and shown as such in the Remote panel.
- A phone or desktop from before transport 3 that still asks for a retired route
  (`/tailnet/v1/conversation`, `/events`, `/canvas`, `/upload`,
  `/conversation-image`, `/conversation-files`, `/conversation-commands`) is
  answered `426 client_update_required` with a sentence telling it to update
  (`TAILNET_RETIRED_PATHS`). An older phone's own reading of `health` already
  says "Update the app".
- Skew between current builds is met inside the Studio protocol's handshake
  (`checkStudioProtocolVersion`, below), which is where every paired client's
  chats, boards and reads now travel.

One version, and not more, because the second version back is one this tree no
longer has to be able to produce, and a window wider than the shapes anyone
tests is a promise that quietly stops being true.

The window is also why the **refusal must name both numbers**. "Unsupported
protocol version" alone cannot tell someone which of their two installs to
update, which makes it a support thread instead of a fix.

## Capabilities, not version arithmetic

Where the question is "can this peer do X", ask the capability list, not the
version integer. A capability list is what the peer says about itself now; a
version is a proxy for it that goes stale in three ways — a feature can be
back-ported to an older version, withdrawn by a build that keeps the version, or
shipped behind a setting.

A Studio says what it serves on its protocol's welcome: the Studio
capabilities (`STUDIO_CAPABILITIES`) and, for chats, the conversation
capabilities `@sprintengine/conversation-protocol` names. A client asks the
welcome (`client.supports`), never the version. A capability a Studio does not
list is one it does not serve, and a client offers nothing that needs it.

This is what lets the version window stay narrow while the wire keeps growing: a
**purely additive** feature ships as a capability with no version bump at all, so
no peer is refused over it.

The tailnet transport's own list (`TAILNET_CAPABILITIES`, on `health`, the
pairing answer and `identity`) went with transport 3 (2026-11-14), and so did
the names it carried for New chat on another machine (`new-chat-worktree`,
`new-chat-effort`, `cli-runtime-catalog`, `new-chat-worktree-name`,
`new-chat-in-worktree`, `new-chat-no-project`, `workspace-extensions`,
`new-chat-skills`, `chat-create-pull-request`): a Studio that serves
`conversation-create` takes `worktree`, `worktreeName`, `inWorktree`, `effort`,
`skills` and `noProject` on `conversation.create`, and `cliRuntimes.list`
answers each CLI's catalog. Every `conversation-` capability a Studio advertises
is one `@sprintengine/conversation-protocol` names, since its welcome lists
them from the package (`studioRpcConversationCapabilities`).

A paired machine's usage, for a desktop's Usage dashboard, is that machine's
Studio's `usage.rows` (2026-11-12, `chat-stores`, `workspaces:read`) on its
`/tailnet/v1/studio`; the `usage.report` gateway tool and the `usage-report`
tailnet capability it replaced are gone. The answer carries a `version` of
its own (1), which moves only for a change an older reader would misread,
beside rows of `[hour, agent, sessionIndex, model, input, output, cacheRead,
cacheWrite, requests, reportedCostUsd, speed?]` and the hashed session ids
they point into; a member added later is optional, and a reader skips a row
it cannot read rather than the answer. A window too large for one answer ends
on an hour and names `nextFrom`, where the next call starts. A machine whose
Studio does not serve it is one to update; one that sends an answer of
another `version` counts nothing from it and says the same. The desktop
asking prices the rows itself, so two machines on different price lists
still agree.

A machine's Canvas boards reach another device on the Studio protocol
(`canvas.*`, capability `canvas-boards`, 2026-11-13); the `canvas` socket and the
`canvas-machine-boards` and `canvas-live-boards` tailnet capabilities it replaced
are gone, and the agents' `canvas.*` tools are no longer served to a device token.
`canvas.list` answers every board on the machine with its project, `here`,
`workspaceId` and `id`; `canvas.picture` draws one by its id or path. A board is
opened by following `canvas.board`, which opens it as a subscriber of the
machine's one canvas service and pushes only notices (opened, a revision, who
holds the pen); the scene is read with `canvas.read` and its pictures by id with
`canvas.files`, so each picture crosses once. A change goes inline up to 768 KB
and otherwise in `canvas.stage` parts first, then `canvas.commit` under a command
id. `canvas.openRequests` tells a device an agent's `canvas.open` in the
workspaces it follows. Looking needs `workspaces:read` (a device's
`workspace:read`); `canvas.commit`, `canvas.stage` and `canvas.takePen` need
`workspaces:operate` (`workspace:operate`). Only a Studio given the machine's
canvas service advertises `canvas-boards` (today the desktop with its server in
process); a client of one that does not says to update or open Studio there.
There is no fallback to the old socket or tools: a machine on an older build
shows its boards to a current desktop or phone once it is updated.

Bump the version instead when the change is not additive: a field that changes
meaning or type, a field that is removed, a response whose shape a peer is
already parsing. Nothing a capability flag can describe should bump the version,
and nothing a capability flag cannot describe should ship without one.

## The module host API

An extension is compiled against `@sprintengine/module-sdk` and runs inside
whatever Studio later loads it, so the contract between them — the `MainHost`
and `RendererHost` members, the services behind the SDK's `get*Service`
helpers, the manifest fields — is a wire in the sense of this file, even though
nothing crosses a network.

- **The version.** `HOST_API_VERSION = 2`, `HOST_API_MIN_SUPPORTED = 2`. Host
  API 2 (2026-11-12) replaced host API 1's IPC channels (`MainHost.registerIpc`,
  `RendererHost.invoke`) with declared methods served over the Studio protocol
  (`registerMethods`, `methods()`, `module.read` / `module.operate`), with no
  shim, so a module built for host API 1 is refused: Settings and the bell say
  to rebuild it against `@sprintengine/module-sdk` 2 and what changes. Both
  are declared once, in `packages/module-sdk/src/host-api.ts`, and re-exported
  for app code by `src/shared/modules/host-api.ts`, so the app, the SDK and the
  `sprintengine-module` CLI cannot disagree about them. The drift guard
  (`npm run test:sdk:drift`) pins the two sides anyway.
- **The declaration.** A third-party manifest must carry
  `"engines": { "hostApi": <n> }`. First-party modules ship with the host they
  run on and may omit it.
- **The window.** A module loads when `HOST_API_MIN_SUPPORTED <= n <=
HOST_API_VERSION`. `checkHostApiCompatibility` is the one check; it is
  applied when modules are planned at startup (`src/main/modules/host-api-gate.ts`),
  when renderer entries are served (`third-party-renderer-entries.ts`), when a
  module's state is shown (`src/shared/modules/resolve.ts`, as
  `incompatible_host_api` rather than "not trusted"), and by the CLI's `sign`,
  `verify` and `pack`. A refusal names both numbers and which side to update —
  the same rule as the integer wires above.
- **Unlike the integer wires, the window is not one version wide by rule.** An
  extension is not a peer that updates alongside the app; raise
  `HOST_API_MIN_SUPPORTED` only when the host genuinely stops providing
  something older modules were promised, and say so in the SDK's
  `CHANGELOG.md`.
- **Capabilities.** `host.supports(name)` answers what the running host
  provides now, from the table in `src/shared/modules/host-api.ts`
  (`hostSupports`). The names are the SDK's `HostCapability` union:
  `conversations`, `conversation-controls`, `conversation-streams`,
  `conversation-requests`, `conversation-permissions`, `chat.open`, `companion-agents`,
  `scheduled-agents`, `secrets`, `github`, `storage`, `mcp-tools`, `skills`,
  `module-assets`, `notifications`, `companion-tools`, `conversation-replies`,
  `text-generation`, `conversation-worktrees`, `chat-runtimes`,
  `scheduled-agent-runs`, `chat.open-options` (a renderer's, answered live
  like `chat.open`), and `electron-main`, which the main host
  answers itself: true in the desktop's own main process, false where a
  module's main half runs in the Studio server out of process.
- **`requires.hostCapabilities`.** An optional manifest field (added with
  `electron-main`, no version bump): a module whose `entry.main` cannot run
  without a capability names it, and a host that lacks it loads the module
  manifest-only (its renderer half still loads). The validator keeps names it
  does not know, since a host that does not know a name does not support it.
  A capability joins the table in the same change that makes it real, and an
  unknown name answers `false`. As on the tailnet, an additive feature ships as
  a capability with no version bump.
- **When to bump.** Removing or changing a host member, a service method or a
  manifest field that a module built for the current version may use. Adding
  an optional member, a service, a capability or a permission is additive.
  `scripts/release/sdk-release-check.mjs` (run by `npm run test:release`) checks
  that the version quoted here matches the source.

## The phone's reads are Studio protocol methods

What the phone reads of a desktop beside its chats, and the little it changes
there, are Studio protocol methods on the desktop's `/tailnet/v1/studio`
(2026-11-12), defined once in `packages/studio-protocol/src/backlog.ts` and
`pull-request-reads.ts`, which the desktop serves and the phone imports:

- `backlog.list` and the `backlog.changed` stream (`backlog` capability,
  `backlog:read`): each project's items and epics, the project named by a token
  (`backlog:<token>`) and never by its folder. `backlog.update`
  (`backlog:operate`, a mutation under its `commandId`) changes one item's
  status or triage. Both scopes are new; a paired device holds them with its
  pairing's `backlog:read` and `backlog:operate`.
- `shares.list` (`shares`, `workspaces:read`): the pages the machine publishes
  on the tailnet.
- `pullRequests.detail` and `pullRequests.diff` (`pull-request-reads`,
  `workspaces:operate`): one pull request read in full, and one file's diff a
  page at a time, read afresh each time.

They replace the mobile-control wire: the `workspace.snapshot` and
`workspace.mobile_command` gateway tools, `mobileControlProtocolVersion` and
its window, and `packages/studio-protocol/src/mobile-control.ts` with its
command validator are gone. The phone hears a backlog move rather than polling
the snapshot. A phone from before this change is refused by the gateway
(`Unknown tool`) and says the desktop could not answer; a current phone meeting
an older desktop is told to update it, by the Studio handshake.

The desktop's own Backlog panel reaches a project's backlog by its folder on the
same capability (2026-11-13): `backlog.location`, and under a `commandId`
`backlog.setRoot`, `.ensureRecords`, `.ensureIds`, `.edit` (one item's change,
named by its `edit.kind`) and `.createEpic`. Each is an owner's, with its reason
in the table: it names a folder on that machine and writes its files. A browser
on the tailnet is held to the folders Studio knows, and a folder on an SSH
machine is refused in words. Same build on both ends: the window's 17 `backlog:*`
IPC channels are gone.

### The conversation contract package

`@sprintengine/conversation-protocol` is the portable package for the
conversation contract: the event layer, the command vocabulary, create
requests, the frames a chat's stream carries, the conversation capability names
and their validators, and pure tool-presentation helpers. The Studio protocol
carries it: its `conversation.*` methods take the package's commands, and a
followed chat streams the package's frames. Its `CONVERSATION_PROTOCOL_VERSION`
(1) rides in the Studio welcome's conversation hello answer
(`parseConversationHelloAnswer`), and moves only for a change a capability
cannot describe.

Until transport 3 (2026-11-14) the package also described a socket of its own
on the tailnet, the direct conversation lane (`/tailnet/v1/conversation`), with
routes beside it for pictures, uploads and the composer's reads, and a change
feed (`/tailnet/v1/events`). Every client moved to the Studio protocol (the
phone's chats, then a paired desktop's) and they are gone; each answers `426
client_update_required` (see "The support window"). A conversation capability
now says what a Studio's protocol serves for chats, on its welcome; the methods
and topics each one gates are in `packages/studio-protocol/src/followed.ts`
(`FOLLOWED_NEEDS` in `studio-rpc-server.ts` says which a Studio leaves out).

A member a listed chat or an event gained after `0.1.0` (a chat's `host`,
`pullRequests`, `localServers`, `backgroundWork`, `workingSince`, `highlight`,
`autoSettle`, `autoCompact`, a step's pictures, a message's `attachments` and
`files`) is optional: a client skips one it does not read, and reads its
absence as a Studio that does not send it. `environmentId` on the tailnet's
`identity` (2026-11-11) is the answering Studio's environment id, the
`welcome.environment.id` its Studio protocol gives, which a paired desktop and
the phone keep on the pairing; a value that cannot be an id (`isEnvironmentId`)
is read as none.

Chat links are data that outlives a build: they sit in transcripts, notes and
clipboards. Since 2026-11-12 a client writes
`sprintengine://chat/<environmentId>/<chatId>[?agent=<agentId>]`, one grammar in
`packages/studio-protocol/src/chat-link.ts` that the desktop and the phone both
read, with ids of `[A-Za-z0-9_-]{1,128}`, the environment id and chat address
alphabet (the package's test pins the two together). A link an older build
wrote, `sprintengine://chat/<chatId>`, is still read, as a chat in no named
environment, which the client looks for among every environment it lists: one
opens, several are named (the phone offers them), none is said. Nothing writes
that form any more. An older build reading a new link refuses it as a path it
does not know, and opens nothing.

Breaking frame changes require a new negotiated capability or a Studio
protocol version, not merely a package version change. Presentation-only fixes
use a package patch. Both ESM and CommonJS tarball consumers and Node16
declarations are checked by `npm run test:conversation-protocol:pack` as part
of `verify:app`.

The phone app imports this package from the repository's source, as the desktop
does, so the two build against the same files and nothing is copied or pinned.
What stays is the version skew between a phone and a desktop that update
separately: a wire change still follows the capability rules above, since an
installed phone keeps the contract it was built with. Publishing is a separate
release step.

### The Studio protocol

`@sprintengine/studio-protocol` is what Studio serves on its owner socket (a
Unix socket in `<userData>/run/`, or a named pipe on Windows) to the
applications on this machine a person has paired with it, and is the protocol
`@sprintengine/agent-sdk` speaks. The tailnet listener serves the same
protocol to a paired device at `/tailnet/v1/studio`: a WebSocket opened with a
ticket from `POST /tailnet/v1/ws-ticket` (good once, for thirty seconds, for
the device whose token bought it), whose `hello` presents that ticket. The
device's grant is its pairing's scopes as they stand at each request
(`conversation:operate` carries `conversation:create`, either `workspace`
scope carries `workspaces:read`), never an owner's; a removed pairing closes
the connection. The socket carries no `Origin`, except a desktop window's,
which names its origin when it asks for the ticket and carries exactly that
one. A ticket answer from a Studio that serves the endpoint says so with
`studioPath`; a device that finds it missing is talking to an older Studio.
A paired device reaches only that desktop's own Studio: an SSH machine or a
WSL distribution the desktop holds is reached from that desktop alone. The
path that carried a device's socket on to such a machine
(`/tailnet/v1/environments/<environmentId>/studio`, 2026-11-13) was removed
on 2026-11-14: it is not found, and `ws-ticket` ignores an `environmentId`
and answers a ticket for this desktop's own path. It is a connection envelope — `hello` /
`welcome`, requests answered by id, subscriptions keyed by id — around the
conversation contract, which it depends on and re-exports rather than copies:
a stream's frames are the conversation lane's own server frames, and a
command's params are read by the lane's own validator. The phone's pinned
files are not touched by it.

`STUDIO_PROTOCOL_VERSION` is 1, with the same one-version window as the
integer wires above; `checkStudioProtocolVersion` refuses a peer outside it at
the handshake, naming both numbers, and the server answers that refusal as
`bye { code: 'unsupported_protocol_version' }`, or, to a client that asked to
be kept, with an `incompatible` frame and the update methods (below). Features are capabilities
(`conversations`, `conversation-create`, `local-pairing`, and the chat
surface's in `STUDIO_CHAT_CAPABILITIES`) advertised in the `welcome`, a Studio
leaving out any it does not serve; the conversation contract's own `protocolVersion` and capabilities
travel inside it, in `welcome.conversation`, unchanged. A client reads what a
chat may offer off the welcome alone (`negotiateChatCapabilities` in
`@sprintengine/client-runtime`): a control is offered where the Studio serves
the method behind it and the grant reaches that method, never by
`grant.owner`, and a chat on the client's own machine is read the same way as
any other. A new method or topic
is a capability, not a bump; so is a new server frame type (`push` was one),
since a client skips a frame type it does not know. Client tools are one such
capability within version 1: `client-tools` adds the `tools.*` methods and
stream, the server frames `call` and `cancel`, and the client frames `reply`
and `progress`. A Studio sends `call` only to a connection that offered a
toolset, and the SDK sends `reply` only to a Studio that advertised the
capability, so neither end is handed a frame type it does not know.
`welcome.bootId`, the run of the server, is an optional member with no
capability: a client meeting a server before it reads every reconnect as a
new boot, so it sends again only a mutation whose receipts are durable
(`receipts` in `STUDIO_METHODS`), refusing the others `unknown_outcome`; a
client before it ignores it and resends as it always did.
`workspaces` is what a client reads before it starts a chat:
`workspaces.list`, `cliRuntimes.list`, `workspaces.checkout` and
`workspaces.extensions`, answered by the gateway tools of the same purpose
(`workspace.list`, `cli.runtime.list`, `workspace.checkout`,
`workspace.extensions`), so the two read one thing; it is served beside the
conversation contract, not only with the chat surface. `conversation.create`
takes New chat's own options beside the contract's request (`newChat`,
`worktree`, `worktreeName`, `inWorktree`, `effort`, and `noProject` in place of
`workspaceId`), held to the same rules the gateway's tool holds them to; a
Studio from before them refuses them as `invalid_params`.
`conversation-handoff` (2026-10-21) adds the owner-only
`conversation.handoff`, a chat handed off to a fresh session instead of
compacted, answered with the path of the file its messages were saved to.
`files-write` adds the owner-only `files.*` by root, which the canvas uses
over a Studio's boards. The `store` root kind (2026-10-16), the project's
store in the person's home where a Studio keeps the captures, recordings and
transcripts older builds kept in `<project>/.sprintengine/`, is additive under
it with no capability of its own: `files.roots` answers `store: true` where it
is served, a Studio built before it leaves the member out and refuses the kind
as `invalid_params`, and a client asks for it only where it is listed. An old
client's read of `.sprintengine/…` under the `workspace` root that the folder
no longer has is answered from the store, so a path it learned from an older
Studio still finds its file. `pull-requests` adds the owner-only `pullRequests.*`
methods and stream, and `pull-request-tool-calls` the one method a client that
runs its own agents forwards their tool calls with, `pullRequests.noteToolCall`,
and `pull-request-link` `pullRequests.link`, which records a pull request an
owner opened for a conversation (refused as `claimed` when another
conversation opened it first). `pull-request-watch` (2026-10-11) adds
`pullRequests.unwatch`, an owner stopping an agent's watch on one of its pull
requests, and says a listed pull request may carry `watch` (what a watched one
waits on, an optional member): a client that does not read it shows the pull
request as before, and a client offers Stop watching only to a Studio that
advertises the capability. A `waitingOn` word a client does not know reads as
plain watching. `pull-request-create` (2026-11-13) adds a chat's Create PR on
the Studio that holds the chat, each step an owner's with its reason:
`pullRequests.createState` (`conversation`; the checkout's readiness, `gitRoot`
null, `state` null where the chat has no checkout there),
`pullRequests.draft` and `.draftCancel` (`conversation`, the client's
`draftId`; drafted with that Studio's own text generation settings,
`text_generation_off` said as it is), `pullRequests.push` and
`pullRequests.create` (`conversation`, `commandId`, an optional `pin`; each
answered once per command id, and a created pull request recorded as the
chat's there, `recorded` saying whether that landed). The desktop's window
asks them only of a Studio that advertises the capability; a Studio from
before answers no state, and the button stays hidden. `local-servers` adds the owner-only
`localServers.*` methods and stream: the local servers a Studio's agents
linked, as the Studio checks them, and running one's command again, stopping
that run, or forgetting the link (`run` and `stop` refused as `conflict` when
it is already running, or when the Studio did not start the run). `session-files`
adds `files` to `session.send`, a message's files attached by path: a Studio
without it reads `session.send` with a validator that keeps only the members
it knows, so it would drop the files without a word and send the words as if
nothing were attached — which is why a client sends `files` only to a Studio
that advertises it, and the desktop's own window refuses such a send in words
otherwise. `session.send` also takes `composedAt` and `confirmedStale`, the
conversation contract's request as every transport carries it, with no
capability of their own: a Studio from before reads the send without them and
sends it as it always did, as a desktop does that never asks about a message
written long ago; and it refuses `queue`, which no client sends it. `session-controls`, `session-terminal-handoff`,
`conversation-history`, `approval-rules` and `provider-settings` (2026-11-12)
add, owners only for now, the rest of what the window's conversation IPC did
(that IPC is gone; the window reaches its chats only this way):
`session.list`, `session.stop`, `session.suspend`, `session.mcpServerAction`,
`session.stopSubagent`, `session.messageSubagent`, `session.askSideQuestion`,
`session.cancelSideQuestion`, `session.contextBreakdown` and the
`conversation.events` stream (every chat's lifecycle, each event without its
payload); `session.terminalHandoff`, advertised only by a Studio that opens
terminals; `conversation.threads`, `conversation.search` (every hit at once,
no partial batches) and `conversation.cancelSearch`;
`conversation.approvalRules` and `conversation.revokeApprovalRule`; and
`providers.signIn`, `providers.setSecret` and `providers.clearSecret`. A
client calls each only on a Studio that advertises its capability.
`conversation-export` (2026-11-13) adds `conversation.exportPage` (`key`,
`exportId`, `offset`; `conversation:read`): a chat's whole export, read where
the chat is kept (what its record says of it, its transcript and the pictures
its messages attached) and answered in pages of about 4 MB, the events and
then the pictures, `nextOffset` null on the last. The first page reads the
chat and holds it for that client and export id for five minutes from its
last page; a later page of one no longer held is `not_found`. The desktop's
window reads a chat this way and hands it to its shell to write
(`chat-export:save`); a Studio from before does not advertise the capability,
and a window does not ask it. What a
follower of one chat reads and does beside its stream, by the chat's key, as
the tailnet lane served it (2026-11-12, `followed.ts`): the per-chat push
topics `conversation.queued`, `.scheduled`, `.usageLimits`, `.subagents` and
`.changes`, each the lane's own frame of that kind, and the methods
`conversation.askSideQuestion`, `.cancelSideQuestion`, `.contextBreakdown`,
`.searchFiles`, `.listCommands`, `.settle`, `.visit`, `.changesDiff` and
`.changedFile`, each under the `conversations` capability and offered by the
conversation capability the lane names it by, which the welcome's
`conversation.capabilities` lists. They are additive: an older Studio answers
`unknown_method` and `unknown_topic`, and lists none of those conversation
capabilities. `modules`
adds the `module.events` and `module.notifications` streams, what a Studio's
modules say to clients, under the `modules:read` scope a grant holds
explicitly (a pairing made before it never gains it); a module event's payload
is JSON. It also adds `module.read` and `module.operate`, a module's declared
methods (host API 2), under `modules:read` and the new `modules:operate`
(which carries it); an operate is a mutation with a `commandId`, and a
module's answer, its own refusals included, is the result. A Studio without a module kernel leaves the capability out, and a
client subscribes only where it is advertised. Explicit grants
(2026-11-12) replace "owners only" on everything above and on the chat
surface, the conversation commands, `files.*` by root, `tools.grant*` and
`pullRequests.list/refresh/unwatch`: each reaches a client by its scope.
`session.terminalHandoff`, `providers.signIn` and the three `pullRequests`
reports of Studio's own agents stay an owner's, each with its reason in the
method table. A paired device's reach (2026-11-12) is pinned whole by
`tailnet-device-reach.test.ts`: `localServers.*` and its stream (they start
and stop programs on the Studio's machine) and `textGeneration.chatTitle` and
`commitMessage.*` (a CLI run outside any chat) are an owner's;
`tools.catalog` and `tools.grants` need `tools:offer`, and `tools.grant` also
`settings:write`, none of which a device holds. `settings:write` is a new scope, so an older Studio
drops it from a grant it does not know, and keeps its owner-only rule on the
methods that need it. A client asks `studioGrantAllows`, never `grant.owner`.
`terminals` (2026-11-12) adds the terminals on the Studio's machine:
`terminal.list`, `terminal.status`, `terminal.open`, `terminal.resume`,
`terminal.write`, `terminal.ack`, `terminal.resize`, `terminal.setVisible`,
`terminal.suspend`, `terminal.close`, `terminal.setReapExempt`, and the
owner-only `terminal.takeUndeliveredPrompts` and `terminal.configure`; and the
streams `terminal.output` (one session's `replay`, `data`, `exit` and
`error`, for the pane that opened or showed it), `terminal.sessions` (deltas;
ask `terminal.list` after subscribing) and the owner-only
`terminal.promptUndelivered`. Every one is an owner's: the app's own windows
and the owner's credential reach them, and no paired device, local app or
browser does, an owner's tab included (a browser is not offered `terminals`
or `session-terminal-handoff`). The scopes `terminal:read` and
`terminal:operate` that first held them are gone; a stored grant that names
them has the names dropped as unknown. `terminal.open`, `terminal.resume`
and `terminal.close` are commands (`commandId`, no read timeout); a
`terminal.write` carries its pane's `writer` and a `seq`, so one sent again
after a reconnect is dropped, and at most `STUDIO_TERMINAL_MAX_WRITE_UNITS`
units, a longer paste going in numbered pieces. An owner's connection other than
the app's own window is never sent a session's `lastPrompt` or its launch
record's MCP settings. The
desktop's own window reaches its terminals only this way: the window IPC for
them is gone. A hello's `client.kind` and `client.instanceId` are
optional hints a Studio that does not know them ignores.
`agent-runtimes` and `agent-settings` (2026-11-12) add the agent CLIs and the
launch settings. `agent-runtimes` is `cliRuntimes.detect`, `.installMethods`,
`.install`, `.update` and `.updateAll` with the streams `cliRuntimes.output`
(one CLI on one machine) and `cliRuntimes.updateAllProgress`, and
`cliVersions.advisories` and `.setEnabled` with `cliVersions.changed`. Every
Studio advertises it: the desktop in process or in a process of its own, and a
server on a WSL or SSH machine, about the CLIs on that machine. The first builds
with it advertised it only in process, and a window that meets one says the
Studio is older. `agent-settings` is
`cliModels.discover` with `cliModels.changed`, `launchSettings.get`,
`.update` and `.migrate` with `launchSettings.changed`, which are an owner's,
`textGeneration.setSettings` and `.chatTitle`, and `commitMessage.draft` and
`.cancel`. Installing or updating a CLI is `environment:maintain`; reading what
can run is `providers:read`; a title or a commit message is
`conversation:operate`. A client that is not an owner never names a CLI's
`command` (in `cliRuntimes` or `runtime`), and names a commit message's
checkout only inside the folders the Studio knows. The desktop's own windows,
Settings included, reach all of them only this way: their window IPC is gone.
`agent-setup` (2026-11-12) adds what a Studio's agents are set up with beyond
their CLIs: `memory.*` and `memoryActivity.*` (the project knowledge graph and
the activity agents leave in it, with the `memoryActivity.events`,
`.statusChanged` and `.synapsesChanged` streams), `mcp.sync`,
`agentConfig.detect` and `.adopt`, `builtinSkills.list` and `.status`, and
`areaSkills.*` with `areaSkills.changed`. A workspace is named by its folder
(`workspaceFolder`), held to the folders the Studio knows for any client that
is not an owner, and one on an SSH machine is refused in words for now.
`mcp.sync`, `agentConfig.adopt` and the activity hook's install and uninstall
are an owner's: they write what the agent CLIs run. Every Studio advertises
`agent-setup` too, about its own machine; the first builds with it did so only
in process. `agent-skills` (2026-11-12) adds the skills, design systems and
cards a Studio's agents are given: `skillSources.*` with
`skillSources.updated`, `skills.*`, `skillPlugins.*`, `workspaceSkills.list`,
`installedSkills.*`, `agentCapabilities.resolve`, `agentSkills.attach`,
`designSystem.*` and `cards.run`. Every folder a client that is not an owner
(or an owner's connection held to known folders) names, by its path or by an
id that stands for it (a workspace, a local source, a bundle, a library
entry's registered folder, a card's workspace), is held to the folders the
Studio knows, on the path it resolves to, and the design library, the
source list and an update check, asked or pushed, show such a client only
those. A plugin's
install and uninstall, a bundle's lint (it runs the bundle's own script) and a
card's Go are an owner's. A Studio without the desktop's shell beside it (on a
WSL or SSH machine) answers a card's `install.module` and an installed skill's
removal to the Trash in words. A window that meets a Studio without
`agent-skills` says the Studio is older. The desktop's own windows reach all
of them only this way: their window IPC is gone.
`environment-readiness` (2026-11-12) adds `environment.readiness`, under
`providers:read`: what the Studio's machine has and lacks for the work it
runs on its own (its CLIs, installed and signed in where it can tell, `gh`, MCP
servers, extensions) and each schedule or pull request watch waiting on
something it lacks, with the reason in words. A fact the machine cannot tell
is `null`, and nothing waits on one. A pull request's `watch` gains an
optional `waiting` (the words) while a read fails for want of `gh` there; an
older client reads past it. Additive: an older Studio answers `unknown_method`
and leaves the capability out.
`window-tickets` (2026-11-13) adds `environment.windowTicket` (`{ windowKey, origin }`
→ `{ token, path }`): a ticket for one connection of a window of the desktop that
holds this Studio, minted by its window listener (good once, for thirty seconds,
from that origin, to `Host: 127.0.0.1`). It is the first method held to the
desktop's own shell connection (`shell` in the table, beside `owner`): an
owner's web tab and a paired app are refused `owner_required`, and no device
reaches it. Served by a WSL distribution's or an SSH machine's Studio, which a
desktop reaches over its front door. `environment.revokeWindow` (`{ windowKey }`, also
the shell's) ends a window document's connections there and voids its unspent
tickets when the document goes; the desktop names each document afresh.
`device-tickets` (`environment.deviceTicket`, the window listener's `/device` path) and
`relayed-environments` (`environment.relayed`, the `relay:<pairing>.<environmentId>`
route kind), both of 2026-11-13, were removed on 2026-11-14: a paired device no longer
reaches an SSH machine or a WSL distribution through the desktop that holds it. A
Studio no longer advertises either capability and answers both methods
`unknown_method`; a client that checks the capability first, as every one did, lists
no such machine. `parseEnvironmentRoute` reads a `relay:` string as no route.
`environment-work` (2026-11-13) adds `environment.work` (`{}` → `{ working, schedules,
watches, messages, resumes }`, the shell's): whether a chat works on this Studio and what it
does on its own, which a desktop asks over its owner connection to a WSL distribution's
server before stopping it for being idle and for its quit question. It replaced the backend
wire's `backend.machine`, which went with `BACKEND_WIRE_VERSION` 9. A server without it is
read as having nothing to say. Served by a WSL distribution's or an SSH machine's Studio.
`environment-launch-tokens` (2026-11-14) adds `environment.launchTokens`
(`{ tokens: [{ digest, identity | null }], replace? }` → `{ held }`, the shell's): the SHA-256
of each launch token the desktop issued to a WSL terminal agent, with the workspace and agent
it proves, or `null` once revoked. The gateway of that distribution's Studio then takes the
agent's identity from the token its MCP bridge presents. `replace` drops every token not
named again (a reconnect). The token itself never crosses. Served by a WSL distribution's
Studio only; a desktop whose distribution lacks it launches terminal agents whose bridges
prove nothing there.
`environment-terminal-host` (2026-11-14) adds `environment.launchFiles` (`{ write?: [{ path,
b64 }], remove?: [name] }` → `{ paths }`) and `environment.terminalProcesses` (`{ op:
'snapshot', keys }` → `{ verdicts }`, `{ op: 'kill', cliSessionId, key }` → `{ killed }`,
`{ op: 'endAll' }` → `{ killed }`), both the shell's: a WSL terminal's startup files written
into a private launch directory inside the distribution, and the processes its sessions
leave read and ended there. `environment.pluginCopy` (`{ enabledSkills: [id] }` →
`{ pluginDirs, skillPluginDirs, statusLineScriptPath }`, the shell's) builds the app's Claude
plugin copy a WSL terminal's agent loads from that Studio's own resources, under its data
directory, and says where it is (all empty when its build shipped no plugin). Served by a WSL
distribution's Studio only. The envelope's `wsl`
gained `profile`, and the `ready` frame's `frontDoor` gained `sessionDir` and `pidDir`
(private to the desktop and the server it starts, one build).
`environment-machine` (2026-11-14) adds `environment.git` (`{ cwd, args, timeoutMs, env?,
stdinB64? }` → `{ code, stdout, stderr, timedOut, spawnFailed?, truncated? }`) and
`environment.home` (`{}` → `{ home, env }`), both the shell's: git in a folder of a WSL
distribution, and its home and config-home variables, asked of its own Studio by the desktop
that holds it. Served by a WSL distribution's Studio only. The desktop also follows a git
directory there with the owner's `files.watchPath` (`includeIgnored`).
The welcome's `environment` gained an optional `driveMountRoot` (2026-11-13): a
WSL distribution's Studio says where it mounts the Windows drives (`/mnt/` unless
its wsl.conf says otherwise, null when it mounts none), so a client on Windows
spells a drive path for it (`C:\code` is `/mnt/c/code` there). Additive: a
client that does not read it takes the default root, and a Studio before it
leaves it out.
`environment-adopt` (2026-11-13) adds `environment.adopt` (`{ commandId, migrationId,
records: [{ kind, id, digest, body }] }` → `{ held, conflicts }`, the shell's): the records a
desktop kept for a machine's chats, kept by that machine's Studio from then on. The kinds are
`workspace`, `schedule`, `scheduled-message`, `usage-limit-resume` and `pull-request`, each
going into its own store through that store's own way in. `digest` is the sha-256 of the body
as canonical JSON (keys sorted, no spaces). It is safe to repeat: a ledger,
`environment-adoptions.json` (0600), says what was kept under which digest. A record kept
under the same digest is held again and nothing is written; one already here under another,
or by another way in, is left as it is and reported in `conflicts`. The answer comes once the
stores and the ledger are written. What a hand-over is about to keep goes in the ledger first,
as pending, so one repeated after a crash between a store's write and the ledger's is held,
not reported as already here. A held message that carries pictures or files is reported,
not kept: those are not handed over yet. Served by a WSL distribution's or an SSH machine's
Studio, which a desktop reaches over its front door.
On 2026-11-13 the same capability gained two kinds, after `workspace`: `chat` (a chat the
desktop ran itself in that machine's folders, a WSL distribution's through `wsl.exe`:
`{ workspaceId, agentId, workspaceRoot, files }`, each file `{ place, path, sha256, bytes,
parts }`, written where that Studio's runtime reads it, a file already there with other bytes
kept as it is and reported) and `approval-rule` (a saved approval, kept as given). A chat's
files go in parts of at most 4 MB (`MAX_ADOPTED_PART_BYTES`): a call may name no records when
it stages parts, which are kept under `environment-adoptions/parts/<migrationId>/` for the
records that follow. No capability was added: only a WSL distribution is handed chats, and its
Studio is always the desktop's own build.
`provider-sign-in-flow` (2026-11-13) adds `providers.signInStart`, `.signInPaste`,
`.signInWait` and `.signInCancel`, each under a `commandId`: a CLI's own login on
that machine with no terminal (decision R34), named by provider, never by a
command line. They are an owner's (`settings:write`), and no device reaches them.
Served where the desktop holds the machine's Studio over its front door. They
replace the backend wire's `backend.sign-in`. Additive: an older Studio answers
`unknown_method` and leaves both capabilities out.
`chat-stores` (2026-11-12) is what a Studio keeps beside its chats, for every
chat at once: `usageLimits.get` with `usageLimits.changed`,
`usageLimitResumes.get`, `.update` (one chat's notice) and `.setAuto` (the
setting) with `usageLimitResumes.changed`, `usage.report`, `usage.rows` (a machine's own
rows for a paired desktop's dashboard, `workspaces:read`), and
`conversationImport.scan` and `.import`. Each stream pushes its store whole and replays nothing: a client
reads the state when it subscribes and again when its connection returns. The
limits are `providers:read`; reading the resumes is `conversation:read`,
changing them `conversation:operate`, and the
resume setting `settings:write`. The usage report and the import are an
owner's (they read the agents' own logs and session files on the machine).
`schedules` (2026-11-12) is a Studio's scheduled agents, which every server
runs in its own store: `schedules.list` and the `schedules.changed` stream
(the list whole, nothing replayed) on `workspaces:read`, and
`schedules.create`, `.update`, `.pause`, `.resume`, `.runNow` and `.delete` on
`workspaces:operate`, a new scope that carries `workspaces:read` and that a
paired device holds with its `workspace:operate` pairing. Each change carries
a `commandId` and is answered from its receipt on a retry. A row is the
schedule's record with `nextRunAt`, `waiting` (why the machine cannot run it
now, in words) and `scheduleWords`; a create takes `once` as epoch ms. The
phone and a paired desktop reach a machine's schedules only this way: the
`scheduled-agents` and `scheduled-agents-edit` tailnet capabilities, and the
devices' use of the `schedule.*` gateway tools, are gone (agents keep the
tools, which follow the same rules).
`schedules.markSeen`, `.pauseAll` (`until`, or null for until resumed) and
`.resumeAll` (2026-11-13) join them on `workspaces:operate`: a failed run looked
at, and every schedule paused or resumed at once. A draft may name, in place of
`workspaceId`, a folder (`workspaceRoot`) and its machine on that computer
(`hostId`, `local` or `wsl:<distro>`), which only an owner may; and its `skills`
and `mcpServers` may carry `{ id, name }`, the name kept for the editor's chips.
The desktop's own windows reach their machine's schedules only this way: the
13 `scheduled-agents:*` IPC channels are gone. Additive for a client: an older
Studio answers the new methods `unknown_method`.
`chat-lifecycle` (2026-11-13) is a chat's record beyond its rest, by the
chat's `workspaceId`: `conversation.markUnread`, `.snooze` (`until`, or null
to wake), `.highlight` (`starred`, `color`), `.setAutoSettle`,
`.setAutoCompact`, `.rename` and `.delete` on `conversation:operate`, each
with a `commandId` and answered once per id; `conversation.deletePlan` and
`conversation.searchChats` (`{ query }`, 2 to 200 characters, the machine's
palette search) on `conversation:read`. A chat at work, a settled chat
snoozed, a chat with nothing finished marked unread and a delete the plan
refuses are `conflict`; a chat the Studio has no record of is `not_found`.
`conversation.revokeApprovalRule` moved from `settings:write` to
`conversation:operate` the same day: revoking only makes the chats ask again.
The phone and a paired desktop reach these only this way; a device token is
refused the agents' `conversation.settle`, `.visit`, `.mark_unread`,
`.snooze`, `.highlight` and `.auto_settle` gateway tools.
A CLI's API key is a provider's key under the CLI's manifest id, read and set
with `providers.secretStatus`, `.setSecret` and `.clearSecret`. The desktop's
windows reach all of these only this way: their window IPC is gone.
`file-system` (2026-11-12) is the files on a Studio's machine by path:
`files.listDirectory`, `.readText`, `.exists`, `.checkWorkspaceFolder`,
`.projectLogo`, `.projectIcon`, `.searchContent`, `.cancelContentSearch` and
`.defaultWorkspaceParent` under `files:read`, the writes (`files.writeText`,
`.saveDroppedImage`, `.createFile`, `.createDirectory`, `.rename`, `.copy`,
`.move`, `.trash`) under `files:write`, and the `files.watchPath` stream. Every
Studio's core serves it, with `files-mention` (`files.search`, `files.stat` by
path, `files.readImage`, `files.repoRoot`), which no longer waits for the chat
surface. A client that is not an owner names a path only where it really is
inside the folders the Studio knows, and writes only inside its workspaces'
folders. A Studio with no Trash on its machine refuses `files.trash` in words.
Additive: an older Studio leaves the capability out, and the desktop's window
says the Studio does not serve its files. The desktop's windows reach the
files only this way: their window IPC is gone.
`git` (2026-11-13) is git on a Studio's machine, by the repository's folder:
the reads under `files:read` with the `git.checkoutChanged` and
`git.changelistsChanged` streams; staging, commits, resolved conflicts,
stashing and changelists under `files:write`. What moves a branch, rewrites
history or discards work, reaches a remote, touches the agents' worktrees, or
uses the GitHub account Studio holds (`github.*`) is an owner's as well. The
machine's version-control CLIs are `versionControl.*` under `providers:read`.
A client that is not an owner names a repository only inside the folders the
Studio knows. Additive: an older Studio leaves `git` out. The desktop's windows
reach git only this way, but for saving a patch through the system's save
dialog, which stays the shell's.
`worktrees` (2026-11-13) is the worktrees a Studio's agents run in: the
worktree pool (`worktrees.poolSnapshot`, `.poolSettings`,
`.setPoolSettings`, `.poolAction`), its dependency installs
(`worktrees.installs`, `.cancelInstall`), Settings ▸ Worktrees' inventory
(`worktrees.inventory`, `.removeOther`) and the agents' worktree steps
(`worktrees.create`, `.restore`, `.remove`, `.cleanupAgents`), with the
`worktrees.poolChanged` and `worktrees.installChanged` streams. All of them
are an owner's, with the reason in the table. Deleting settled chats
(`settledChats.planDelete` under `conversation:read`, `settledChats.delete`
under `conversation:operate`) reaches what a paired device's Delete on a chat
reaches. A folder on an SSH machine is refused in words. Additive: an older
Studio leaves `worktrees` out. The desktop's windows reach the pool and
settled-chat deletion only this way: their window IPC is gone.
`workspace-sync` (2026-11-13) is the desktop's own windows' workspace
registry: `workspaceSync.snapshot`, `.eventsAfter` and the
`workspaceSync.events` stream (every recorded change, sequenced; the window
that made it hears it too and takes it once by its sequence), `.dispatch`
(one change from a named window), `.lifecycle` (Settle, Un-settle, Snooze or
Wake on the reading the window made it on), `.setSettledChatsSettings` and
`.setModuleRunStates` (what only a desktop window knows; a browser's is
answered and not applied), the one-time hydration (`workspaceRegistry.*`),
the window's backup of its own copy (`workspaceBackup.*`) and the folders of
chats without a project (`projectlessChats.*`). Each is an owner's, with the
reason in the table; a browser on the tailnet makes a workspace only inside
the folders Studio knows. The registry's records cross as the desktop defines
them (`src/shared/workspace-sync.ts`), checked by main's registry. Mark unread
from a window is the chat's `conversation.markUnread`. The window's 14
`workspace-sync:*`, `workspace-registry:*`, `workspace-backup:*` and
`chats:projectless-*` IPC channels are gone; a desktop's window and its own
Studio are one build.
`extensions` (2026-11-13) is what a desktop's Studio is extended with beyond
its modules: the marketplace's registry and each installed entry against it
(`marketplace.read`, `.updateStates`), the agent CLIs' plugin catalogue
(`cliPlugins.list`, `.availability`, `.launchPreview`) and the hosted feeds
(`cardFeed.get` with the `cardFeed.changed` stream, `sourcesFeed.get`), all
under `providers:read`; Studio's own plugin in a workspace
(`studioPlugin.status`) under `files:read`, in a folder the Studio knows for a
client that is not an owner. Reviewing an entry or a GitHub repository,
installing, updating and removing it (`marketplace.verify`, `.install`,
`.update`, `.uninstall`, `.resolveGithub`, `.installGithub`) and making an
extension project (`extensionScaffold.*`) are an owner's, with the reason in
the table: they fetch code to run on the machine, approve it, or write outside
the folders the Studio knows. A review's one-time approval is spent by the
install it approves, and checked by the Studio as strictly as before. The
`modules` capability gains `module.installed` and `module.rendererEntries`
(`modules:read`), `module.setAppState` (`settings:write`),
`module.reportRegistry` (an owner's: the Studio's own window reports it) and the `module.changed` stream.
Additive: a Studio without a desktop around it (a WSL or SSH server) leaves
`extensions` out. The desktop's windows reach all of these only this way:
their window IPC is gone, but for showing an extension's folder in the file
manager, which stays the shell's.
`artifacts` (2026-11-13) is where a desktop's Studio publishes its agents'
pages: Settings ▸ Artifacts (`artifacts.settings`), setting the host up
(`artifacts.setUp`, a mutation under its `commandId`), and the question an
agent's `artifacts.setup` tool puts to the person (the
`artifacts.setupQuestions` stream, every open question whole at subscribing
and on each change, answered with `artifacts.answerSetupQuestion`). Every one
is an owner's, with its reason in the table: the setting names the host and
account and whether a token is held, a set-up signs in with this machine's
credentials and seals the token it is given with the Studio's own cipher, and
a yes is the person's at this machine. The token is never in an answer.
Additive: a WSL or SSH server leaves `artifacts` out. The desktop's windows
reach these only this way: their window IPC is gone. The agents'
`artifacts.*` tools are the server's own in both modes, over the same
service; the shell is asked only for a page's picture and, with no window
showing, a native question.

`access` (2026-11-13) is who may reach a Studio's agents from its machine: the
gateway's status (`gateway.status`), the tokens its loopback HTTP endpoint
admits (`mcpHttp.status`, `.create`, `.revoke`), and the apps paired with its
owner socket (`localApps.status`, `.offer`, `.cancelOffer`, `.revoke`,
`.setReach`, and the `localApps.changed` stream, whole at subscribing and on
each change). Every one is an owner's. A method or stream may now say `window`
(its reason, always with `owner`): the server serves it only to a connection
the window listener admitted with a ticket main minted for one of its windows,
and refuses it `owner_required` to every other, an owner's web tab, a script
holding the owner's credential and the shell included. Minting an HTTP token
and all of local app pairing say it, so a stolen browser session or a paired
app cannot mint the next way in. A web tab still lists and revokes the HTTP
clients; before, its tunnel could also mint a token, and now Settings there
says a new one is made in the desktop app, or on the server's machine with
`studio-server mcp-token --name <client>` (which posts the run file's key to
the web listener's `/mcp-http/mint`, as `studio-server pair` does to
`/pair/mint`; same build on both ends). Same build on both ends: the
window's 4 `automation:*` and 6 `studio-local-apps:*` IPC channels are gone.

`web-devices` (2026-11-13) is the browsers paired with a Studio's web listener,
offered only by a Studio that runs one, once its front door has started:
`webDevices.status`, `.revoke`, `.approve` (with the six digits the asking
browser shows), `.decline`, and the `webDevices.changed` stream, whole at
subscribing and on each change, the asking browser's own row marked `current`.
Each is an owner's, an owner's web tab included. Nothing answers a credential:
there is no method for a pairing link, so a tab no longer makes one; another
browser is paired by approval, or with `studio-server pair` on the machine.
Same build on both ends: a web tab's 7 `web:devices:*` tunnel channels are gone,
and so are its 3 `web:embeds:*` channels, which nothing called (embeds are made
with `studio-server embed`).

`tailnet` (2026-11-13) is who reaches a Studio over the tailnet, and the
machines it drives: its listener (`tailnet.status`, `.liveState`,
`.setEnabled`, `.setHttps`, `.offerPairing`, `.cancelPairing`,
`.approvePairRequest`, `.denyPairRequest`, `.revokeDevice`,
`.updateDeviceScopes`, `.forgetMachine`, `.resetMcpRegistrations`, `.peers`,
`.shares`, `.share`, `.unshare`, and the `tailnet.changed` stream) and
pairing with another machine (`mesh.connections`, `.liveState`, `.pair`,
`.requestPairing`, `.cancelPairing`, `.forget`, and the `mesh.changed`
stream). Every one is an owner's; the mutations carry a `commandId`. What
lets someone in or answers a code says `window`: turning the listener or
HTTPS on, offering or approving a pairing, widening a device, sharing a dev
server, the peer sweep, and pairing with another machine, its live state and
its stream (which carry the code read out to the person there). The rest, a
web tab included, read or narrow: status, live connections and their stream,
withdrawing an offer, declining, revoking, forgetting, MCP registrations, the
shares and unsharing, the machines this one drives. Both streams deliver the
state as it stands on subscribing (an event of kind `current`) and then each
change, so a client that reconnects is current again. An approval from a
window is the only one that may let an MCP client's OAuth sign-in in, as the
IPC-only approval was. The agents' local-socket `tailnet.*` tools are
unchanged. Same build on both ends: the window's 17 `tailnet:*` IPC channels,
the 6 `mesh:*` pairing channels and the `mesh:event` push are gone;
`remote:open-requested` stays, the shell's push that opens the Remote
popover.

`execution-hosts` (2026-11-14) is the machines a desktop's computer offers:
itself and, on Windows, its WSL distributions, each with how its Studio
server stands (`hosts.list`, with `refresh` and `all`, and the
`hosts.changed` stream, which carries nothing: the client lists again).
Offered by a desktop's Studio only; a WSL distribution's or an SSH machine's
Studio is one of those machines and offers none. Both are an owner's, and no
paired device reaches them, nor a distribution's chats, which are reached
from the desktop alone. New chat's folder picker asks a
distribution's own Studio where it keeps projects
(`files.defaultWorkspaceParent`) instead. Same build on both ends: the
window's `hosts:list`, `hosts:home` and `hosts:changed` channels are gone,
and with them the last channel the window routed to its server.
Every method names its scope in `STUDIO_METHODS`,
typed over the method map so a method without one does not compile.

#### Reaching a Studio outside the window

A paired desktop, a server inside WSL or on an SSH machine runs on its own
and can outlive several releases of the client that reaches it, so a refusal
at the handshake cannot be the end of the conversation. `update-session`
(2026-11-12) keeps one: a client that lists it in its hello's
`client.capabilities`, and authenticates with a token, is answered with an
`incompatible` frame in place of the `welcome` when the two windows do not
meet. The frame says who the Studio is (`server`, `environment`, its
`protocolVersion` and `minProtocolVersion`), which side is behind
(`compatibility`: `client-outdated` or `server-outdated`, from the client's
side), why in words naming both numbers, and how the Studio is updated
(`update`, the `update.status` answer). The connection then serves only
`update.status` and `update.start`; anything else is refused
`unsupported_protocol_version`, a subscription not retryable. A client that
does not list the capability is closed with `bye` as before, and a pairing
code is never spent on a client that could not use the token.
`studioCompatibility` reads the same four states (`compatible`,
`client-outdated`, `server-outdated`, `unknown`) from any window a client has
heard: a welcome, this frame, a discovery file.

`update.status` (no scope: any authenticated client may learn how to recover)
answers `method`: `self` for a desktop, which updates itself through its app
updater; `bootstrap` for a server a desktop installed (inside WSL, or over
SSH), which that desktop replaces when it next connects; `manual` for one
started by hand. `manual` carries the words for the last two. `update.start`
(a mutation with a `commandId`, scope `environment:maintain`; the same
`commandId` asked again, even after the restart, is answered as it was) asks a `self`
Studio to check, download, drain its running turns and restart into the new
version; it is answered before the restart, and the client reads the outcome
from the next welcome's version or `lastFailure`. A desktop installs what its
update channel offers, so a `targetVersion` it does not offer is refused, and
so is an installation that needs an administrator, which Windows asks for at
that PC. A Studio that does not update itself refuses it `update_unavailable`
with its words. Owners hold
`environment:maintain`; a paired app only when Settings gave it; a browser on
the tailnet never.

A server's data directory says the format its files are in
(`<data>/format.json`, `{ format, writtenBy }`; `src/server/environment/
data-format.ts`). A server refuses to start on data in a newer format than it
reads ("this data was written by Studio X; update this server"), so a server
rolled back to an older tree never rewrites what a newer one wrote. A format
changes only through a step in that file, which copies the files it touches
aside first and is undone if it fails or is interrupted. Format 1 is the
layout every build before the marker wrote; the first store change an older
server cannot read adds format 2.

**The `incompatible` frame, `update.status`, `update.start`, their params,
results and codes never change shape**, since they are what two ends that
disagree on everything else still speak; and neither does the `hello`. Members
are only ever added, optional; a client reads an update `method` it does not
know as `manual`, a `state` as `idle` and an environment's `hostKind` as
`other`, and cuts words and versions to their bounds instead of refusing the
frame. `packages/studio-protocol/test/update.test.ts`
pins them. The SDK's `openStudioUpdateSession` is the client side.

The pack check (`npm run test:studio-packages:pack`) installs the packed
tarball beside the conversation protocol's and checks both module systems and
Node16 declarations.

### The embed's `postMessage` wire

A page that frames Studio's embedded conversation view
(`/embed/conversation/<id>`) talks to the frame by `postMessage`, and the two
update separately: the frame is served by whichever Studio the embed points
at, the page by whoever wrote it. Every message carries an integer `v`, now 1.

- The frame posts `ready` (with the embed's id), `resize` (its content
  height), `link` (a link the person clicked, for the page to open), `state`
  (how many turns, and whether one is running) and `error` (a code). It posts
  only to the embed's registered origins, never `'*'`.
- The page may post `theme` (`light`, `dark` or `system`), `token` (the
  embed's token, for a page that keeps it out of the frame's address) and
  `scrollTo` (a turn). The frame accepts a message only from its parent and
  from a registered origin; it ignores a `type` it does not know and answers
  a `v` it does not know with `error { code: 'unsupported_version' }`.
- No message makes the frame send, answer or navigate. A new message type is
  additive and needs no bump; a change to an existing message's meaning bumps
  `v`, and the frame then accepts the old and the new for one version.

## Changing a wire format

If your change alters anything that crosses either wire, do all of this:

1. **Decide which it is.** Additive → a new capability on the Studio welcome
   (`STUDIO_CAPABILITIES`, or a conversation capability the package names), no
   version bump. Otherwise → a version bump.
2. **If you bump**, move the current version and the minimum together so the
   window stays one version wide, and leave the code that reads the previous
   shape in place for that one release. A bump that also drops the old reader
   refuses every peer that has not updated yet, which is what the window exists
   to prevent.
3. **Check every enforcement site.** They must agree, or a peer is accepted by
   one and refused by another. Today:
   `git grep -n 'protocolVersion' -- src | grep -v test` and
   `git grep -n 'transportVersion' -- src`. Note that the sites include the
   validators for records read back off **this machine's own disk** — a check
   pinned to the current version alone unpairs every device paired before the
   bump, silently, on the first restart after it.
4. **Test the edge, not the middle.** A peer inside the window is accepted, one
   outside it is refused, and the refusal names both versions. The existing
   examples are in `src/main/automation/tailnet-transport-version.test.ts`,
   `src/main/automation/tailnet/tailnet-retired-routes.test.ts` and
   `src/server/rpc/studio-rpc.test.ts` (the Studio protocol's window).
5. **Update the phone's use of it in the same change.** The phone imports the
   protocol package itself (see "The phone's reads are Studio protocol
   methods" above), so a shape change reaches its typecheck; what it does with a new
   member is still yours to write. The window is the grace period a bump needs,
   not permission to skip the other side.
6. **Update this file**, if what you changed is the policy rather than an
   instance of it.

## Bumps that have happened

### Tailnet transport 3 — the lanes leave the tailnet (2026-11-14)

**Breaking, deliberately, with no window.** Every client follows and drives
chats, boards and its reads on the Studio protocol at `/tailnet/v1/studio`: the
phone's chats (2026-11-13), its boards, and a paired desktop's chats. What a
build on transport 2 used instead went: the conversation lane
(`/tailnet/v1/conversation`), the change feed (`/tailnet/v1/events`), the canvas
lane (`/tailnet/v1/canvas`), and the `upload`, `conversation-image`,
`conversation-files` and `conversation-commands` routes, with the capability
list `health`, `identity` and `pair` carried. A window would have kept routes
nothing current reads, so the minimum moved with the version:

- An older phone reads `transportVersion: 3` on `health` and says "Update the
  app" on the desktop's row, and a route it still asks for answers `426
client_update_required` with the sentence.
- An older paired desktop's identity read refuses transport 3 by name; a
  current desktop refuses one on 2 the same way, naming both versions.
- The phone keeps no version window of its own: it shows the version, and
  meets skew in the Studio handshake.

### 4 — the members nothing produces leave the wire (2026-09-16)

**Breaking, deliberately, and for the same reason as 3.** Taking the Sprint Engine
off the wire left members no desktop could produce: the `workspaces` collection
(always `[]`, with its `switchboard` / `watchtower` kinds, nine workspace
capabilities, detail shapes and the `desktopWorkspaces` snapshot collection), the
`roadmaps` rider, the always-`undefined` `statePath`, and the `python_tool_failed`
error code. All of it is deleted. `mobileControlProtocolVersion` moved 3 -> 4 and
the window moved with it, to `[3, 4]`. The package published `4.0.0`.

Removing `desktopWorkspaces` from the collection list is what makes this a bump
rather than a quiet tidy: a v3 phone that asked for it would now be refused with
`invalid_payload`.

As with 3, pre-release: no users and no paired devices. The phone's mirror moved
in the same coordinated change, with both sha256 pins set to the same new hash.
Step 2's one-release grace reader was skipped for the same reason as in 3; the
window is still one version wide and still enforced, and nothing reads v3.

The phone's project list and switcher were built from `workspaces` joined with
`backlog`. With `workspaces` always empty they were already built from `backlog`
alone, so the phone's projects are unchanged; only the dead join went.

The member-by-member list was in the protocol package's `CHANGELOG.md`, removed
with the package; `git show 84500b7f2:packages/mobile-control-protocol/CHANGELOG.md`
still has it.

### 3 — the Sprint Engine leaves the wire (2026-09-16)

**Breaking, and deliberately so.** `sprintEngines` was a required member of the
snapshot; the nine sprint commands, the eight sprint capabilities, their relay
scopes, the role catalogue and the `sprintengine` workspace kind were all wire
vocabulary. All of it is deleted. `mobileControlProtocolVersion` moved 2 -> 3 and
the window moved with it, to `[2, 3]`. The package published `3.0.0`.

**Why it could not be additive.** The Sprint Engine moved out of the
desktop into a signed module, and the desktop stopped being able to serve any of
it. It kept emitting `sprintEngines: []` anyway, and the phone kept demanding
the key, because removing a required member is not additive: a desktop that
dropped it while the phone still required it would fail EVERY snapshot read on
the phone with `invalid_payload`, taking backlog and automations down with the
runs. Emitting an empty array forever was the right answer while a paired phone
existed. It also meant the wire carried a large vocabulary — a whole run type
tree, nine commands, eight capabilities — that nothing on either side could
produce or act on.

**What made it possible.** Pre-release: no users, no published consumers, no
paired devices to protect. Both halves — this package and the phone's mirror of
it — moved in one coordinated change, with both sha256 pins set to the new shared
hash in that same change.

**Where this departs from step 2 below.** Step 2 says a bump leaves the code that
reads the previous shape in place for one release, so the window is a grace
period rather than an outage. That was skipped on purpose here: there is no
deployed peer to grant grace to, and a retained v2 reader would have been a copy
of exactly the vocabulary the change exists to delete. The window itself is still
one version wide and still enforced; nothing reads v2.

The member-by-member list was in the protocol package's `CHANGELOG.md`, removed
with the package; `git show 84500b7f2:packages/mobile-control-protocol/CHANGELOG.md`
still has it.

## Withdrawals that did not bump

### Terminals leave the tailnet (2026-09-29)

**Not a bump, and the tailnet transport stays at 2.** Owner ruling: nothing
about a terminal crosses the tailnet any more; what a paired device reads,
drives and starts is a conversation. Everything that went is one of the shapes
this file already says a peer must tolerate, so no peer on version 1 or 2 is
refused over it:

- **Two capabilities withdrawn**, `sliced-frames` and `terminal-resume`. Both
  described the terminal stream. A capability is what a peer asks before relying
  on a feature, and a build that stops advertising one is read as not having it
  — the case "withdrawn by a build that keeps the version" above.
- **The route**, `/tailnet/v1/terminal`. An upgrade there is answered 404, which
  is what a peer from before the route existed answered.
- **Five tools off the tailnet**, `terminal.list`, `terminal.create`,
  `agent.launch`, `backlog.work` and `automation.run`. All five still exist and
  are served on the local socket, to the agents and MCP clients on this machine;
  a paired device's `tools/list` no longer names them, and a call to one is
  refused as `tailnet_local_only`, the refusal the `tailnet.*` family already
  had. `tools/list` is read on every connection and never pinned, so a shorter
  list is a shape every peer already reads.
- **A change-feed kind**, `terminals`. No `changed` frame names it, and the
  `hello` frame's `revisions` map no longer has its key. That map is keyed by
  the lists this machine announces and has grown a key before (`conversations`)
  without a bump; a key a build does not announce is absent, the same as it was
  before the key existed.
- **Two scopes**, `terminal:observe` and `terminal:control`, retired the way the
  Horizon scopes were: `normalizeTailnetScopes` drops a scope outside the
  vocabulary, so a device stored with them loads with the rest of its grant, a
  pair request naming them is read without them, and a peer reading a grant
  list sees a shorter list, which a grant list always could be.
- **The upload route** keeps its path, its `upload` capability and its
  conversation shape. Its terminal branch — a file written into a session's
  folder — is gone, and the `kind=conversation` older phones send is accepted
  and no longer needed.

The phone's side of this is its own change: it stops asking for terminals.
Nothing in `src/main/mobile/control/protocol.ts` changed, so the mobile-control
version stays at 4.

### Automations leave the phone (2026-09-29)

**Not a bump, and the mobile-control version stays at 4, window `[3, 4]`.**
Owner ruling: the phone does not show or drive automations any more. What
left `src/main/mobile/control/protocol.ts`:

- **The snapshot member** `automations`, with its types
  (`MobileControlAutomationSnapshot`, `MobileControlAutomationRunSummary`,
  `MobileControlAutomationRunStatus`) and the producer's caps
  (`automationsPerProjectMax`, `automationRecentRunsMax`,
  `automationRunTextMaxChars`). The member was optional and already absent
  whenever a desktop had no automations to show, so a snapshot without it is
  one every v3 and v4 phone reads. That is why this is not the case "a field
  that is removed" in the bump rule above: nothing about whether it may be
  absent changed.
- **The collection** `automations` from `mobileSnapshotCollections`. This is
  the part that would have been a bump — it is what made v4 one — because
  phones built before this ask for `['backlog', 'automations']` on every read,
  and `workspace.snapshot` refuses a name it does not know. So the name is kept
  as a retired collection (`retiredMobileSnapshotCollections`): accepted in
  `include`, and answered with nothing, the way the upload route still accepts
  the `kind` older phones send.
- **The command** `automations.control`, with `AutomationsControlCommand`,
  `MobileControlAutomationAction` and the `task_not_ready` error code only it
  produced. A command is advertised in the snapshot's `commands` strings, and
  the tailnet never advertised this one: the gateway's `workspace.mobile_command`
  allowlist is `backlog.update` alone, so since the hosted relay went
  (2026-09-27) no transport served it. A phone that sends it is refused
  `command_not_supported` by the gateway, as before.

The phone's mirror drops the same members in its own companion change. On the
desktop, automations are unchanged, and `automation.run` stays a local-socket
tool.

## What never changes without a bump

- The meaning of an existing field.
- The type of an existing field.
- Whether an existing field may be absent.
- The shape of anything under `health` on the tailnet transport, which is read by
  peers that have never paired with us and may be several releases behind.
