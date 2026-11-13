# Wire compatibility

Studio talks to software it does not ship with: another Studio on your tailnet,
the phone app, and the extensions people install into it. Both ends update on
their own schedule, so neither can assume the other is the same build. This
file is the policy for what that obliges you to do when you change something
that crosses the gap.

It is short on purpose. The one thing it must get across: **a wire format is not
a private data structure, and changing one is not a local edit.**

## What is versioned

| Wire                                                                                  | Version                                 | Window                                               | Declared in                                     |
| ------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Tailnet transport — Studio driving another Studio                                     | `TAILNET_TRANSPORT_VERSION` (integer)   | `TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION` .. current | `src/main/automation/tailnet/tailnet-routes.ts` |
| MCP                                                                                   | dated strings, newest first             | every entry in the list                              | `src/shared/mcp/protocol.ts`                    |
| Module host API — an installed extension built against `@sprintengine/module-sdk`     | `HOST_API_VERSION` (integer)            | `HOST_API_MIN_SUPPORTED` .. current                  | `src/shared/modules/host-api.ts`                |
| Studio protocol — a client on Studio's owner socket (`@sprintengine/studio-protocol`) | `STUDIO_PROTOCOL_VERSION` (integer)     | `STUDIO_PROTOCOL_MIN_SUPPORTED` .. current           | `packages/studio-protocol/src/handshake.ts`     |
| Embed `postMessage` — a page framing an embedded conversation (`se.embed`)            | `EMBED_PROTOCOL_VERSION` (integer, `v`) | current only (one version of slack when 2 ships)     | `src/renderer/src/web/embed/embedProtocol.ts`   |

One more version number is near these and is **not** a wire window: the
backlog item schema version is a file format, and is not negotiated with a peer.
(`mobileControlWorkspaceSnapshotVersion` was a second; it versioned the mobile
snapshot's `workspaces` detail body and left the wire with it in v4. The
mobile-control wire itself, with `mobileControlProtocolVersion`, went on
2026-11-12: see "The phone's reads are Studio protocol methods" below.)

Alongside the tailnet version is `TAILNET_CAPABILITIES` — a list of named,
additive features. It is not a version and does not follow one; see
"Capabilities, not version arithmetic" below.

Three wires between this app and the Studio server trees it installs on a WSL
distribution or an SSH machine are private and are not in this table: the
bootstrap envelope, the front door's proof preamble (`FRONT_DOOR_PROOF_VERSION`)
and the conversation backend wire (`BACKEND_WIRE_VERSION`), and the SSH
relay's multiplexer (`MUX_VERSION` in `resources/wsl-server/relay-mux.mjs`).
Both ends are this app's own build: the tree is installed per app version and
checked by digest. An SSH machine can run another version's server (a newer
desktop installed it); its `run/server.json` says the Studio protocol window
it speaks, and the desktop attaches it when that window meets its own and the
backend wire is the same, upgrades an older managed one, and otherwise refuses
in words (`locateServer` in `src/main/environments/ssh/ssh-connect-script.ts`).
An upgrade that does not start falls back to the previous server and is not
retried on its own (`run/update-failed.json`). Bump
`BACKEND_WIRE_VERSION` whenever a forwarded member's arguments or answer
change, and `MUX_VERSION` whenever a frame does. A number once on `main` is
spent, even before a release, since a nightly may already carry it: two changes
made side by side take one each. The backend wire went from 2 to 3 when
`sendTurn` took `origin` (a message Studio sends a chat itself), and to 4 when
it took `files` (a message's files attached by path), both on 2026-10-07. It
went to 5 when `sendTurn` took `composedAt` and `confirmedStale` and could
answer `stale` (2026-10-20), and to 6 when it gained `handoffConversation`, a
chat handed off to a fresh session, and `sendTurn`'s `origin` the reason
`auto-compact` (2026-10-21), and to 7 when it gained `messageSubagent`, and
`sendTurn` `subagentMessage` and the `origin` reason `agent-message` (2026-11-07),
and to 8 when `backend.sign-in` left it for the Studio protocol's `providers.signIn*`
(2026-11-13). The front door gained a third purpose, `ws` (2026-11-13): a window's
socket, which main's loopback route for that machine carries to the server's own
window listener. The proof says only that the stream came through the front door;
the listener admits it by the ticket it minted, as it admits a local window. An
older server tree refuses the purpose in words, and the desktop updates it.

A session's summary, which that wire pushes with every chat event, carries
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

The tailnet transport accepts **one version of slack**: the current version and the
one before it. Anything outside is refused at the handshake, by a named error
that says both what was seen and what is supported.

- Tailnet: `checkTailnetTransportVersion` in `tailnet-routes.ts`, applied in
  `readRemoteIdentity` (`tailnet-remote-client.ts`). A machine outside the window
  is reported unreachable with the reason, and shown as such in the Remote panel.

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

The tailnet transport advertises `capabilities` on `health`, on the pairing
response and on `identity`; `tailnetPeerSupports` is the accessor. A peer that
advertises no list has no capabilities, not all of them — but note that a peer
which published **no list** (null) is a different fact from one that published an
**empty list**, and only the second is a denial. The capability list shipped a
day after the first feature it describes, so silence there means "unknown".

This is what lets the version window stay narrow while the wire keeps growing: a
**purely additive** feature ships as a capability with no version bump at all, so
no peer is refused over it.

A capability can name an addition to a gateway tool as well as to a route or a
frame. The phone's New chat calls `conversation.create` and `cli.runtime.list`,
and three capabilities (2026-10-05) say what those take and answer:
`new-chat-worktree` (`conversation.create` takes `worktree`), `new-chat-effort`
(it takes `effort`) and `cli-runtime-catalog` (`cli.runtime.list` answers each
CLI with a `catalog`, the model picker's own rows). An argument needs its
capability more than a route does: a handler skips an argument it does not
know rather than refusing it, so a `worktree` sent to a desktop without the
capability starts the chat in the checkout and says nothing. The answer to a
`worktree` create may carry `dependencyInstall` (2026-10-07): the new
worktree's project installs its dependencies first, the chat and its session
already exist, and the first message goes once the install ends. It is an
optional member with no capability: a client that does not read it sees the
chat start a little later, and an older desktop never sends it. A paired
desktop's New chat added two more (2026-10-09): `new-chat-worktree-name`
(`conversation.create` takes `worktreeName`, what a `worktree` and its
branch are named from) and `new-chat-in-worktree` (it takes `inWorktree`, a worktree the
project already has, by the path `workspace.checkout` lists). Its answer then
names the `worktree` the chat runs in, an optional member like
`dependencyInstall`. The desktop asking refuses a worktree a machine does not
advertise rather than sending it, for the reason above. These names carry
no `conversation-` prefix, which is kept for the conversation lane's own
vocabulary: every `conversation-` capability this machine advertises must be
one `@sprintengine/conversation-protocol` names
(`conversation-protocol.test.ts`).

A desktop's New chat offers "No project" on a machine advertising
`new-chat-no-project`: `conversation.create` then takes `noProject` in place of
`workspaceId`, and the chat runs in a folder of its own there. It takes no worktree,
as there is no checkout to cut one from. An older machine refuses a call with no
workspace, so a desktop leaves the row off and refuses the launch in words.

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

### Direct conversation lane

`@sprintengine/conversation-protocol` is a separate portable package for the
additive `conversations` tailnet capability. It owns the direct conversation
WebSocket frames, their client validator and pure tool-presentation helpers,
and since `0.2.0` the whole conversation contract: the event layer, the
command vocabulary, create requests, the `hello` handshake and the capability
names.

The lane has its own `CONVERSATION_PROTOCOL_VERSION`, answered by `hello` on a
desktop that advertises `conversation-hello`, with the same one-version window
rule as the integer wires above (`checkConversationProtocolVersion` names both
numbers). It is 1, and like them it moves only for a change a capability
cannot describe. `0.2.0` added three capabilities and no version:
`conversation-hello`, `conversation-plans` (`resolvePlan`) and
`conversation-cli-permission-modes` (a `permissionMode` beside the preset).
Each degrades on a desktop without it to something that desktop already does:
`hello` and `resolvePlan` are refused under their ids, and an unknown
`permissionMode` member is dropped, so the preset's own mode runs. A desktop
following another machine's chat reads the listed `permissionMode` and
`capabilities.permissionModes`, and sends a `permissionMode`, only where that
machine advertises the capability (2026-10-25); it refuses one in words for a
machine that does not, rather than let it be dropped there and the person be
told one mode while the agent ran on another.

An `answerQuestion`'s answers are keyed by each question's whole text, which
is how the CLI reads them back. The first version capped a key at 200
characters, so a long question's answer was refused as `invalid_frame`. Since
2026-10-16 a desktop accepts a key as long as an answer (20,000 characters),
with the frame's total still the message limit. Only the validator widened:
a client sends the same frame to either desktop, and an older one goes on
refusing a long question as it always did. The first version's reader in
`index.ts` is unchanged, since phones built against it are still in use; the
wider rule is in `clientFrames.ts`, the server half.

The initial `0.1.0` contract requires the `conversations` capability. Additive
optional fields preserve that contract. Model switching is one such addition: its own
`conversation-models` capability, a `models` catalog on a listed thread, the
`setModel` command, the `unsupported_model` code and a `notice` on an accepted
command. A client hides its model control for a desktop that does not
advertise it, and such a desktop refuses the command as `unsupported_command`.
The pictures a chat's steps show are another: the `conversation-images`
capability names a plain `GET /tailnet/v1/conversation-image` beside the socket
rather than a frame, so it changes neither the frame contract nor this package.
A client that does not see it says the picture is on the other machine, and an
older desktop answers the route 404. The pictures a person sent with a message
are the `conversation-message-images` capability (2026-10-16), on the same
route: `attachment`, the `ref` an entry of a `user_message`'s `attachments`
records, in place of `toolUseId`. Those entries (`{ id, mediaType, name?,
byteLength, ref }`) were on the wire before it, an optional member with no
capability; the capability only says the bytes can be fetched. A client that
does not see it names the picture, and an older desktop answers the request
400, since it names no `toolUseId`. Files of any type with a message are the
`conversation-message-files` capability (2026-10-17): the upload route takes
`kind=file`, and the `uploadIds` a `send` already carried name that upload as
they name a picture's, so neither the route's path nor any frame changed. The
message records it in `files` (`{ path }`), a member `user_message` carried
before for files dropped on the desktop. A client that does not see it offers
pictures only; an older desktop refuses a file `415 invalid_media_type`, as it
always did. A file is kept as it came: `conversation-image-downscale`
applies to pictures only. A desktop that shrinks an uploaded picture for the
model on receipt advertises `conversation-image-downscale`
(2026-10-17): its `POST /tailnet/v1/upload` takes up to 20 MB as the bytes
arrive, where it took 5 MB, and keeps at most 5 MB, sized to its composer's
1568px long edge. Nothing in the request or the answer changed shape. A client
that does not see it holds its upload to 5 MB, as before, and an older desktop
refuses a larger one `413 too_large`, as it always did. Only a desktop has the
image codec, so a standalone Studio server leaves it out, and the Studio RPC,
whose own uploads are kept as they came, never lists it. The machine each chat runs on (`host`),
its pull requests (`pullRequests`) and the desktop's own kind and colour
(`machine` on `identity`) are optional members with no capability: an older
phone ignores them, and a phone reads their absence as a desktop that does not
send them (`docs/conversations.md`, "Machines and pull requests in the list").
`environmentId` on `identity` (2026-11-11) is another: the answering Studio's
environment id, the `welcome.environment.id` its Studio protocol gives, which a
paired desktop keeps on the pairing (`MeshConnection.environmentId`). A build
from before it leaves it out, and the pairing keeps whatever id it last heard,
or none; a value that cannot be an id (`isEnvironmentId`) is read as none. A
phone keeps it on its pairing too (`MobileSession.environmentId`, 2026-11-12),
since chat links name it.

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
A listed chat's `localServers` (2026-10-25: `{ id, url, title, port, state }`,
the servers its agents linked, as the desktop last checked them, never the
command or folder that starts one) is another, listed only for a chat that has
some; a server starting or stopping is a change-feed push of its own. A
desktop following another machine's chat draws them read-only, and opens one
only where its address reaches it.
A listed chat's `backgroundWork` (2026-10-17: `{ agents, monitors }`, the
background agents still running and the monitors that will wake its agent) is
another, beside a `phase` left as the turn's own: the desktop's sidebar counts
such a chat as working, but a phone of that date holds a plain send while the
listed phase says `running`, so the phase could not carry it. An older phone
ignores the member and shows the chat as finished, as before; a phone that
reads it shows the chat working without holding sends.
`workingSince` (2026-10-20) is another, beside `turnStartedAt`: when the
chat's stretch of work began, the person's message that began it, held
through the turns the chat opens by itself while its `backgroundWork` goes on,
which is the number the desktop's own sidebar counts "working for" from. It
is listed whenever the desktop counts the chat as working, background work
included. A client that does not read it counts from `turnStartedAt`, as
before, and restarts with each turn the chat opens by itself; a client that
reads it falls back to `turnStartedAt` for a desktop that does not send it.
So are `scheduledAgentId` (the schedule whose run started the chat, which
the desktop marks with the schedule's clock) and `snoozedUntil` (when a chat
the person snoozed on the desktop wakes, listed only while that is ahead): a
client that reads them draws the clock, and leaves a sleeping chat unmarked
by "finished, unseen" until it wakes, as the desktop's own row does; an older
client ignores both.
The context a chat has spent (`contextWindow` and `contextUsed` on a
`usage_updated` event) is the same kind of member: a phone that does not read
them shows no context ring, and one that does draws none for a desktop that
does not send them. The files a message attached by path (`files` on a
`user_message`, each `{ path }`, a path on the desktop's disk) are the same
kind of member: the message's `text` is the person's words alone, an older
phone shows those and nothing more, and a phone that reads the member can
name the files (it cannot open them). The phone's commands do not send
`files`, so nothing it sends changed. The pictures a step returned
(`images` on a `tool_output`, 2026-10-09: paths on the desktop that ran it, at
most eight, a browser screenshot most often) are the same kind of member: the
bytes were never on the wire and still are not, an older phone shows the
step's words as before, and a reader that knows the member can say the step
returned pictures but cannot fetch them, since `conversation-image` serves a
step's picture by the step's input and not by this list. What every wire
sends of an event is a projection of it (2026-11-11,
`src/server/conversation-stream-shaping.ts`), and no member a reader needs
went: a `tool_output` carries its text once, as `preview` (every reader,
every phone build among them, reads `preview` before `output`), and a
`tool_started` input carries its file-change bodies cut to their heads,
marked `inputTruncated`, which every reader already knew from inputs too
large to store. Both read the whole step with `getToolDetail` when it is
opened and draw a cut change only from that; a phone or desktop from before
reads it the same way (the phone on opening, the desktop behind "Show full
output") but draws the cut change until then. An event larger than one
frame crosses cut to fit and marked `wireClipped`, read whole with the
lane's `getEvent` (or the Studio protocol's `conversation.event`); no
capability names the frame, since only a desktop that knows it ever sends a
cut event. A reader from before draws the cut text as it came, without
saying it was cut. An MCP step's own
title and its server's name (`displayTitle` and `serverName` on a
`tool_started`, 2026-10-13: plain text, at most 120 characters each) are the
same kind of member: a reader that does not know them titles the step from
its wire name, as every reader did before. So is `origin` on a `user_message`
payload (`ConversationMessageOrigin`, 2026-10-07), which marks a message the
desktop sent a chat itself — a launched agent's notice, a resume after a usage limit —
as Studio's: a reader that does not know it shows the message as the person's,
as every reader did before, and a message without one is the person's. Its
`reason` gained `pull-request-watch` (2026-10-11), a wake about a pull request
the chat's agent asked the desktop to watch; a reader that does not know a
reason still reads the message as Studio's, without one.
A quote of an earlier reply (2026-11-02) rides inside a `user_message`'s
`text` on the desktop, as a Markdown link with a scheme of its own
(`src/shared/chat-quotes.ts`). By default it does not cross the wire: the
conversation stream turns each one into its words — the passage as a
blockquote, then `Comment: …` — before it rewrites host paths (`quotesForWire`
in `tailnet-conversation-stream.ts`), so `text` means the person's words alone
and a phone or a paired Studio of any release shows the quote as words. A held
or scheduled message's `text`, in `queued` and `scheduled` frames, reads the
same way.
A quote crosses as its token only under the `conversation-quote-tokens`
capability (2026-11-07), which has to be said from both ends, because each
end's mistake is a different one. The desktop advertises it, saying that it
expands a token in a message it is sent into what its agent reads
(`expandQuotesForAgent`, on every path a send takes), so a client makes one
only where it is listed; a machine that does not list it would hand its agent
the address. The client names it in `clientCapabilities` on its `hello` (a new
optional member, read for that socket alone), so a desktop keeps the token only
for a client that will draw it; a client that said nothing would show the
address. The `hello` goes ahead of the `subscribe`, whose replay it shapes, and
nobody waits on its answer: a desktop without the member drops it, and one from
before `conversation-hello` refuses the frame. Tokens that do leave have the
words they carry rewritten as the frame around them is (`mapQuoteWords`),
because a path percent-encoded inside an address is out of the rewrite's reach.
A paired Studio asks by capability at both ends: it writes a blockquote for a
machine without it, and turns any token that still reaches its send (a paste, a
stashed prompt) into words there. The phone asks the same way: it names the
capability in a `hello` ahead of each subscription only where the desktop lists
both it and `conversation-hello`, writes tokens only there, and writes the
blockquote and comment everywhere else. A paired Studio's copy of a
chat keeps the words it was first sent, so a quote from before this reads as a
blockquote. No version moves. The Studio protocol's socket lists
`conversation-quote-tokens` in `welcome.conversation` (2026-11-13): it expands a
token on every send as the lane does, and sends every client a chat as it is
kept, tokens included, so a client on it makes one where the welcome lists it.
A chat's rest and read state are the `conversation-lifecycle` capability: a
desktop that advertises it leaves the chats it has settled out of the list, sends it in its sidebar's order, names
each chat's `chatTitle`, `lastUserMessageAt`, `lastTurnEndedAt` and
`lastVisitedAt`; `workspace.list` items carry `settledAt` beside it, with no
capability of their own. The members are optional, so no peer is refused over
any of it: a client offers no Settle for a desktop that does not advertise it
(`docs/conversations.md`, "Rest, order and read state in the list"). Settling
and visiting were the `conversation.settle` and `conversation.visit` gateway
tools on a device token; since 2026-11-13 a device reaches them only on the
Studio protocol (below), and the tools are an agent's.
The leaving out and the order are the capability's promise, so they hold only
where it is advertised. The Studio RPC advertises it (2026-11-12): its
`conversation.list` leaves settled chats out in the sidebar's order, as the
lane's does, and `conversation.settle` (`settled: false` brings a chat back;
`conflict` while an agent in it works) and `conversation.visit` (no command
id, not audited) write the same record, on `conversation:operate`, each by
the chat's `workspaceId` (2026-11-13; before that by a conversation key,
whose `agentId` a device's call never used). Before
that it did not advertise it, and listed every chat most recently moved
first.
Mark unread (2026-10-07) was a gateway tool beside them,
`conversation.mark_unread`, advertised as `chat-mark-unread`; since 2026-11-13
a device marks a chat unread with the Studio's `conversation.markUnread`
(`chat-lifecycle`), the capability is gone, and the tool is an agent's. It
deliberately amends one rule: `lastVisitedAt` had only ever moved forward, and
this tool moves it back, to just before the chat's latest finish. That is not
a bump, because nothing a peer parses changed: the member keeps its type, may
be absent exactly as before, and still means the clock every device reads
"finished, unseen" against. A client from before the tool sees an earlier
visit time and nothing else; the phone of that date takes the later of the
listed clock and its own readings, so at worst it keeps showing the chat as
read. On the desktop the rewind travels as `lastVisitedAt` with a newer
`visitRewoundAt`, the only patch that may lower the clock, so a lagging
window's visit still cannot. A phone that offers Mark unread must stop keeping its own later visit readings over
an earlier listed one. Each listed chat names that stamp as `visitRewoundAt`
beside `lastVisitedAt`, an optional member with no capability of its own: a
phone drops only the readings it took before the stamp, so a chat marked
unread while the phone was closed reads unread there, and an older phone
ignores the member.
A queued message is the `conversation-queued-sends` capability (2026-10-08):
a `send` that says `queue` is held by the desktop and sent when the chat's
turn ends, `cancelQueued` takes one back, and a client that asks with a
`watchQueued` request is sent `queued` frames saying what is held for the
chat it follows. All of it is additive: a desktop without the capability
drops `queue` and refuses a send made mid-turn `busy`, as it always did, and
answers the new command and request under their ids; a desktop sends `queued`
frames only to a client that asked, so a phone that never asks never sees
one. A client asks whenever the desktop has not said it lacks the
capability, since an older desktop's refusal is harmless. The Studio RPC
advertises it (2026-11-12): `conversation.send` takes `queue`,
`conversation.cancelQueued` needs `conversation:operate`, and the per-chat
topic `conversation.queued` pushes the lane's `queued` frame, now and on each
change, on `conversation:read`.
A steered message is the `conversation-steer-sends` capability (2026-10-14):
a `send` that says `steer: true` goes into the turn the chat is running, where
its provider takes one, and each listed chat says whether it does as
`capabilities.steer`, an optional boolean. With no turn running the send is an
ordinary one; a turn that cannot take it has the desktop hold the message as a
`queue` send is held, answered at once with a `notice`, or, for a message with
`uploadIds`, `skills` or `mentions` on a desktop without
`conversation-queued-attachments`, refused `busy` as a mid-turn send always was, and run as the next turn when sent again once the
turn is over. One that reached the chat is answered as taken, its turn's end
in the `notice`, even when that turn then fails. `steer` is never beside `queue`. All of it is
additive: a desktop without the capability drops `steer`, so the send is
refused `busy` mid-turn as before, and a client sends it only where it is
advertised. The Studio RPC advertises it too: its `conversation.send` reads
the lane's own validator and reaches the same host.
One agent stopped by itself is the `conversation-stop-subagent` capability
(2026-10-24): a `stopSubagent` command names an agent a chat spawned by the
call that spawned it (`toolUseId`, as its `subagent_status` events carry it),
and stops that agent alone, leaving the chat, its turn and its other agents
running, between turns too. Each listed chat says whether its provider can as
`capabilities.stopSubagent`, an optional boolean. It matters more than its
size: the same release has a chat's turn Stop spare the agents a Claude chat
runs, so a client that offers no agent's Stop leaves a runaway agent no way to
be stopped short of settling the chat. All of it is additive: a desktop
without the capability refuses the kind as `unsupported_command`, and a client
sends it only where it is advertised (a desktop following another machine's
chat refuses it there in words first). The Studio RPC advertises it too: its
`conversation.stopSubagent` method, an owner's for now, reads the lane's own
validator and reaches the same host.
The person's words for one agent are the `conversation-agent-message`
capability (2026-11-07): a `messageSubagent` command names an agent as
`stopSubagent` does and carries `message`. No harness delivers to an agent
directly, and a user message aimed at one reaches its parent, so the desktop
asks the chat's own model to use its messaging tool, addressed by the agent's
task id: steered into a running turn, or as a turn of its own. It costs that
model a turn. The `user_message` it records has the `origin` reason
`agent-message` and a `subagentMessage` (`toolUseId`, `text`), which is what a
lane shows; a reader that knows neither draws Studio's notice, as it would any.
Each listed chat says whether its provider can as `capabilities.messageSubagent`,
an optional boolean, and a `subagent_status` may say `canContinue: false`. All of
it is additive: a desktop without the capability refuses the kind as
`unsupported_command`, and a client sends it only where it is advertised (a
desktop following another machine's chat refuses it there in words first). A
client draws an agent's box only with both, and otherwise no box at all, only a
way to the parent (owner ruling 2026-11-07). The Studio RPC advertises it too:
its `conversation.messageSubagent` method, an owner's for now, reads the lane's
own validator and reaches the same host. `BACKEND_WIRE_VERSION` went to 7 for it.
A chat handed off from a paired device is the `conversation-handoff`
capability (2026-10-25): a `handoff` command, carrying nothing but its command
id, hands the chat off to a fresh session as the desktop's own Handoff does,
the file of its messages written on the desktop and its path kept there. Each
listed chat says whether its provider can as `capabilities.handoff`, an
optional boolean. The desktop answers a repeat of the same command id with
the first answer, and keeps no refusal, so a press refused mid-turn may go
once the turn is over. All of it is additive: a desktop without the
capability refuses the kind as `unsupported_command`, and a desktop following
another machine's chat refuses it there in words first. The Studio RPC
advertises it too, through the `conversation.handoff` method it already had.
Edit from here and Revert from a paired device are the `conversation-rewind`
and `conversation-checkpoint-revert` capabilities (2026-10-25). A `rewind`
command takes a chat back to before the user message at `turnSeq`, as the
desktop's own Edit from here does, and each listed chat says whether its
provider can as `capabilities.rewind`, an optional boolean. A `revert`
command puts a turn's files back from its checkpoint in the desktop's own
checkout (`undo` for the last revert's undo): without `confirmed` it only
lists the files, and `confirmed` it acts on exactly the `files` that list
named, refusing when they moved. Its answer rides on the `commandResult` as
`data`, a new optional member under the full contract that an older client
drops: the files (paths relative to the desktop's checkout), whether they
were reverted, the ignored new files it `kept`, or `changed`. The desktop
answers a repeat of a rewind or a confirmed revert under the same command id
with the first answer, and keeps no refusal. All of it is additive: a
desktop without either capability refuses the kind as
`unsupported_command`, and a desktop following another machine's chat
refuses it there in words first. The Studio RPC advertises both too: its
`conversation.rewind` and `conversation.revert` methods, an owner's, reach
the same runtime.
A chat forked, asked a side question, or asked what fills its window from a
paired device is three capabilities (2026-10-25), each additive.
`conversation-fork`: a `fork` command names the new chat's id (`newAgentId`,
the client's, so it can follow the fork once answered) and the point
(`side: 'assistant'` with `turnId`, or `side: 'user'` with `turnSeq`), and the
desktop forks the chat as its own Fork from here does, writing the fork's
agent record into the chat's workspace; the same command id sent again is
answered as the first was, a refusal is not kept, and an id the workspace
holds is refused. `conversation-side-questions`: `askSideQuestion` (`requestId`,
the client's `questionId`, `question`, optional `history`) is answered by a
`result` whose `data` is `{ answer }`, needs `conversation:operate`, and
`cancelSideQuestion` (`requestId`, `questionId`) calls one off; one still out
when the socket closes is called off. `conversation-context-breakdown`:
`getContextBreakdown` (`requestId`) is answered by a `result` whose `data` is
`{ breakdown, stale? }`, read from the chat's live session only. Each listed
chat says whether its provider can as `capabilities.fork`,
`capabilities.sideQuestion` and `capabilities.contextBreakdown`, optional
booleans. A desktop without them refuses `fork` as `unsupported_command` and
the three frames as `invalid_frame` under their request ids, and a desktop
following another machine's chat refuses each there in words first. The
Studio RPC advertises the last two (2026-11-12): `conversation.askSideQuestion`
(`key`, `commandId`, the client's `questionId`, `question`, optional
`history`; `conversation:operate`, answered once per command id),
`conversation.cancelSideQuestion` (`questionId`, the asker's own only) and
`conversation.contextBreakdown` (`key`, `conversation:read`). It advertises
`conversation-fork` too (2026-11-13): `conversation.fork` (`key`, `commandId`,
`newAgentId`, the point; `conversation:create`) is the same host's fork,
joined to the chat's records, and answers `{ ok: true, address, name }`, the
fork's `ConversationAddress` and the name the desktop gave it. A Studio from
before withheld `conversation-fork` and answered `{ ok: true }`, leaving the
record to the window that asked; a newer client does not ask it to fork, and
refuses an answer without an address rather than open a fork that may not be
there. An older client's `title` is not read, and the record it writes after
the answer is the one the desktop wrote already.
An answered side question is kept in the chat's transcript as a
`side_question` event (2026-11-11; `ConversationSideQuestionPayload`:
`question`, `answer`, `requestId`, and `truncated` where the answer was cut at
`CONVERSATION_SIDE_QUESTION_MAX_ANSWER` characters), between turns and with no
`turnId`. A new event type needs no capability to cross the wire: a client
that does not know one skips it, as it skips `turn_retrying` and
`context_handed_off`, and draws the chat without the marker. What
`conversation-side-question-records` adds is the desktop's word that it keeps
them, which a paired desktop reads to say, in its side question drawer, that a
machine without it keeps nothing. No frame changed, and `askSideQuestion`
answers as before. The Studio RPC advertises it beside
`conversation-side-questions` (2026-11-12), and its conversation topic carries
the event. The
module SDK's `ModuleConversationEventType` and the phone read the event too.
A paired desktop's composer reaches a chat's folder through three
capabilities (2026-10-25). `conversation-send-mentions`: a `send` may name
`mentions`, files and folders of the chat's folder by their paths relative to
it (`{ path, kind: 'file' | 'folder', line?, endLine? }`, at most 50), which
the desktop resolves as its own composer's chips are; an absolute path, a
drive or a `..` segment is a bad frame, and `mentions` is never beside
`queue`. `conversation-file-search`: `GET /tailnet/v1/conversation-files`
with `workspaceId`, `agentId` and `query` (200 characters at most) answers
`{ entries: [{ path, kind }], truncated }`, at most 50 matches, each relative
to the chat's folder, on `conversation:read`. `conversation-commands`: `GET
/tailnet/v1/conversation-commands` with `workspaceId` and `agentId` answers
`{ cli, commands, fetchedAt, error? }`, the chat CLI's own commands without
Studio's, on `conversation:read`; `refresh=1` asks the CLI again and needs
`conversation:operate`. The two reads search and list only a folder on that
computer (an SSH workspace's list is the one its sessions published, never a
probe). All of it is additive: a desktop without them drops `mentions` and
answers the routes 404, and a client sends or asks only where they are
advertised (a desktop following another machine's chat refuses each there in
words first). A paired desktop's files attached by path ride the existing
`conversation-message-files` upload, which a desktop now sends as well as the
phone. The Studio RPC advertises all three: its `conversation.send` reads the
lane's own validator, and `conversation.searchFiles` (`key`, `query`, `limit?`)
and `conversation.listCommands` (`key`, `refresh?`, which needs
`conversation:operate` as well) answer the routes' bodies, naming the chat,
never a folder (2026-11-12).
The mode a turn runs in is the `conversation-send-mode` capability
(2026-10-25): a `send` may say `mode`, `ask`, or `plan` where the listed chat's
`capabilities.planMode` says its provider plans, and the desktop runs the turn
in it as its own chat sends one; `default` is read as none. `mode` is never
beside `queue`, and a steer in a mode of its own that the running turn cannot
take is refused `busy` rather than held, since a held message goes in the
default mode. All of it is additive, but a desktop without the capability
drops the member and runs the turn in the default mode, where an `ask` may
change files, so a client sends one only where it is advertised (a desktop
following another machine's chat refuses one there in words first, and lists
`planMode` from that machine only where it is). The Studio RPC advertises it
too: its `conversation.send` reads the lane's own validator and reaches the
same host.
A chat's reasoning effort is the `conversation-reasoning-effort` capability
(2026-10-25): each listed chat names the levels its provider runs as
`capabilities.reasoningEfforts` (an optional string array, empty for a
provider that runs none) and the level its record keeps as `reasoningEffort`
(absent for the provider's own default), and a `setReasoningEffort` command
(`effort`, or none for the default) writes the chat's record, as the
desktop's own effort control does, for every turn after to run at whichever
device sends it. It is answered with a `notice` while a session is live, and
needs none. All of it is additive: a desktop without the capability refuses
the kind as `unsupported_command` and lists neither member, and a client
sends it only where it is advertised (a desktop following another machine's
chat refuses it there in words first, and offers no effort control). The
Studio RPC advertises it too: its `conversation.setReasoningEffort` method, an
owner's for now, reads the lane's own validator and reaches the same host.
A live chat's MCP servers are the `conversation-mcp-server-actions` capability
(2026-10-25): an `mcpServerAction` command names a server as the chat's CLI
does (`serverId`) and an `action`, `reconnect`, `enable` or `disable`, and the
desktop carries it out as the chat's own server rows do, through its runtime.
Each listed chat names the actions its provider takes as
`capabilities.mcpServerActions`, an optional array. It never resumes a chat at
rest. A sign-in is not among the actions: the CLI waits for the sign-in's
callback on the desktop itself, so one begun from another device could not be
finished there, and the validator refuses it. All of it is additive: a
desktop without the capability refuses the kind as `unsupported_command`, and
a client sends it only where it is advertised (a desktop following another
machine's chat refuses it there in words first). The Studio RPC advertises
it too: its `conversation.mcpServerAction` method, an owner's for now, reads
the lane's own validator and reaches the same host.
Restarting a chat's agent is the `conversation-restart-session` capability
(2026-10-25): a `restartSession` command has the desktop end the agent's
process as its own Restart agent session does, suspending the session so it
keeps its resume cursor and the next message starts the agent again on the
same conversation. It is refused while the agent works (a turn, a request it
waits on, a background agent or monitor), and a chat with no agent running is
answered with a `notice` and left as it is, never resumed for it. The desktop
keeps the answer under the device's command id, so one sent again after a
dropped link is answered as the first was rather than ending the session a
message has started since. All of it is additive: a desktop without the
capability refuses the kind as `unsupported_command`, and a desktop following
another machine's chat refuses it there in words first, saying to restart it
on that machine. The Studio RPC advertises it too: its
`conversation.restartSession` method, an owner's for now, reads the lane's own
validator and reaches the same host.
A message scheduled for a time is the `conversation-scheduled-sends`
capability (2026-10-25): `scheduleSend` (`message`, `sendAt` in epoch ms on the
desktop's clock) has the desktop keep it among its own scheduled messages and
send it then, as one scheduled in its own composer, answered once it is kept;
`sendScheduledNow` and `cancelScheduled` (`scheduledId`) send one at once (a
refused one again) or delete it; and `{ type: 'watchScheduled', requestId }`
has the desktop send a `scheduled` frame (`ConversationScheduledFrame`: the
chat's `key` and its scheduled `messages`, soonest first, whole each time) now
and whenever they change. A message held for a turn's end is in its `queued`
frame, never in this one. The same `scheduleSend` offered again under its id
is kept once, across a restart too (its command joins the `sources` the held
messages keep), and a repeated Send now or Delete is answered as the first
was. All of it is additive: a desktop without the capability refuses the
three kinds as `unsupported_command` and `watchScheduled` as `invalid_frame`,
and a client sends them only where it is advertised (a desktop following
another machine's chat refuses them there in words first). The Studio RPC
carries the three as owners' methods (`conversation.scheduleSend`,
`conversation.sendScheduledNow`, `conversation.cancelScheduled`), and
advertises the capability (2026-11-12): the per-chat topic
`conversation.scheduled` pushes the lane's `scheduled` frame. A `scheduleSend`
may name `untilLimitReset` (2026-11-13), the provider whose limit the message
waits on: the desktop asks that limit again when `sendAt` comes and moves the
message to a later reset if one stands, and its `scheduled` frame says it
back. An older desktop's validator drops the member and keeps the message for
`sendAt`. A Studio window holds and schedules its own chats' messages the
same way (`scheduledMessages.hold`, `.get`, `.update` and
`scheduledMessages.changed`, every chat's messages at once, are gone).
A desktop's usage limits are the `conversation-usage-limits` capability
(2026-10-25): `{ type: 'watchUsageLimits', requestId }` has it send a
`usageLimits` frame (`ConversationUsageLimitsFrame`: the chat's `key`, the
`notice` a usage limit left on that chat's turn or null, `autoResume`, and
`limits`, each plan's windows as its agents reported them, without billing)
now and whenever any of it changes; and `usageLimitResume` (`action`:
`schedule`, `cancel`, `dismiss` or `retry`; `always` beside `schedule`
switches the desktop's resume on for every chat a limit stops) acts on the
notice as the desktop's own tray row does. A repeat under the same id is
answered as the first was. All of it is additive: a desktop without the
capability refuses the kind as `unsupported_command` and the request as
`invalid_frame`, and a client asks only where it is advertised. A provider
or a plan name a client does not know passes the validator, for a newer
desktop to add one; the desktop client leaves such a plan out. The Studio
RPC carries the command as `conversation.usageLimitResume` and advertises the
capability (2026-11-12): the per-chat topic `conversation.usageLimits` pushes
the lane's `usageLimits` frame. The phone asks with `watchUsageLimits` after each fence
where the capability is listed, and reads `limits` alone for its chat page's
Usage row; it sends no `usageLimitResume`.
A held message that carries more than words is the
`conversation-queued-attachments` capability (2026-10-25): a `send` with
`queue` may carry `uploadIds` (pictures and files), `skills` and `mentions`,
and a steer the running turn cannot take is held with them rather than
refused `busy`. The desktop makes them its own when it holds the message: a
picture is copied under its data folder (`held-message-pictures`), since an
upload's staged copy goes within the hour, and a file stays where its upload
put it, its folder kept through the week's pruning while the message waits.
The scheduled messages' file keeps them with the message (`carried`, an
optional member a build before it does not write; its records still load),
and they are let go once the message has gone: the pictures' copies always,
the files only when it was deleted rather than sent. A repeat of the same
command is the same message, held once, without its spent uploads. Each
`queued` frame's message may name what it carries (`images` and `files` by
name, `skills`, `mentions`), optional members an older client ignores. `mode`
and `steer` beside `queue` are still refused. All of it is additive: a
desktop without the capability refuses a queued send carrying any of the
three as `invalid_frame`, so a client hands such a message over only where
the capability is advertised (a desktop following another machine's chat
keeps it in its own pane otherwise, as before). The phone's pinned files are
unchanged. The Studio RPC does not advertise it yet: its `conversation.send`
refuses `uploadIds` until one upload path every client uses carries them.
An approval answered with a rule that outlives the conversation is the
`conversation-permanent-approvals` capability (2026-10-25): `resolveApproval`
takes `decision: 'always'` from a device with `conversation:operate`, and the
desktop saves the rule for the chat's workspace among its own, as its own
"Always allow … in this workspace" does, where its Settings (and a paired
desktop's, through its Studio's `approval-rules`) list and revoke it. It is additive: the
first version's validator, and so every desktop without the capability and
the phone's pinned copy, refuses the decision as `unsafe_remote_decision`, as
it always did, and a client offers the rule only where it is advertised. The
Studio RPC advertises it (2026-11-12): `conversation.resolveApproval` takes
the decision from a client whose ceiling allows a rule for the rest of the
conversation (`auto` or looser), and refuses it `ceiling_exceeded` below.
A chat's sub-agents are the `conversation-subagents` capability (2026-11-07):
`{ type: 'watchSubagents', requestId }` has the desktop send a `subagents`
frame (`ConversationSubagentsFrame`: the followed chat's `key` and its
`subagents`, oldest first, the newest `CONVERSATION_MAX_SUBAGENTS` of them,
whole each time) now and whenever one starts, moves or ends. A row
(`ConversationSubagent`) names the chat a sub-agent is (`workspaceId`,
`agentId`, `title`, `providerId`, `modelId`, `sessionId`, its preset and
`capabilities`), as a listed chat names itself, beside what is its own:
`readOnly`, `status`, `task`, `startedAt`, `endedAt` and `error`. The status
is the desktop's own reading (`subagentStatusOf`), so a client does not work it
out again. A sub-agent is a chat like any other on the wire: `subscribe` follows
it by those ids on a socket of its own, and `resolveApproval` and
`answerQuestion` there answer what it asks. That was always so, since
`subscribe` never read the list; what a device lacked was the ids. The `list`
still leaves sub-agents out, on purpose: it is what a paired sidebar and a phone
draw as chats, and neither should draw one. That is why the rows are a request
of their own and not a member of the list, and why they are no part of
`ConversationThread`. The watch is `conversation:read`, and an answer
`conversation:operate`, as for any chat. All of it is additive: a desktop without
the capability answers the request `invalid_frame` under its id, which nobody
waits on, and a client asks only where it is advertised, or where the machine
has not said; its chat then shows the agents its CLI spawned, as before. A
desktop sends `subagents` frames only to a client that asked. The phone asks
after each fence where the capability is listed, and opens each row as a chat
on a socket of its own; elsewhere it lists the agents the CLI spawned, as it
always did. One row a client cannot read is dropped
alone. The Studio RPC advertises it (2026-11-12): the per-chat topic
`conversation.subagents` pushes the lane's `subagents` frame.
A chat's changes are the `conversation-changes` capability (2026-11-07): what
the desktop's own Diff tab shows when its Changes row is pressed, read in the
chat's checkout there. `{ type: 'watchChanges', requestId }` has the desktop
send a `changes` frame (`ConversationChangesFrame`: the chat's `key`, its
checkout as `changes` — branch, base, scope, its commits ahead of the default
branch oldest first, at most `CONVERSATION_MAX_CHANGES_STEPS`, and whether
anything is uncommitted — or null where it has no repository, and a
`revision`) now and whenever the checkout reads differently, an edit to a file
already changed included, until `{ type: 'watchChanges', requestId, stop: true }`,
another `subscribe`, or the socket closing. The desktop reads the checkout every
couple of seconds while a watch stands, and not at all otherwise.
`getChangesDiff` names a step (`span`, `uncommitted`, or a `commit` by its
hash) and is answered with its files and line counts; `getChangedFile` names a
step and a path and is answered with the file's two sides
(`ConversationChangedFileSides`: each its text, `absent`, or `too-large` past
`CONVERSATION_MAX_CHANGED_FILE_BYTES`). Nothing else of the checkout is
readable through it, which is why a client names no revision or folder: the
path must be one the step lists as the desktop reads it then, the revisions are
worked out there from the step, a commit must be one of the branch's own, a
path is relative with no `..`, and a link in the working tree reads as what it
points at, never as the file it names. All of it is `conversation:read`, as the
transcript is; it writes nothing, so nothing here needs `conversation:operate`.
It is additive: a desktop without it refuses each request `invalid_frame` under
its id, and a client asks only where it is advertised, so a paired Changes row
stays the read-only count it was. A desktop sends `changes` frames only to a
client that asked, so a phone, which does not, sees exactly what it saw. The
Studio RPC advertises it (2026-11-12): the per-chat topic
`conversation.changes` pushes the lane's `changes` frame, and
`conversation.changesDiff` and `conversation.changedFile` answer the two
reads, on `conversation:read`.
A `send` may say when it was written, `composedAt` (epoch ms, the client's
clock), and that the person confirmed one written long ago, `confirmedStale`
(2026-10-20). A desktop that reads them records `composedAt` on the
`user_message` and refuses a send written more than
`CONVERSATION_STALE_SEND_MS` (30 minutes) ago with the new `stale` code,
recording nothing and keeping no receipt, unless `confirmedStale` is set; a
`queue` send it would hold is refused the same way, since a held message goes
the moment the chat is free. A repeat of a send that already went is still
answered from its receipt, however old. No capability: a desktop built before
the members drops both (the first version's validator strips unknown members)
and sends as it always did, so a client sends `composedAt` with every message
and keeps its own rule for what it no longer sends without asking (the phone
stops at ten minutes after an absence, `mobile/src/features/conversations/queuedSends.ts`).
An older client never sends either, and its sends are never stale. `stale` is
an error code a client from before it reads as any refusal with a message;
the code joined the pinned `ConversationWireErrorCode` union, so both copies
and both pins moved with it.
A desktop also remembers, across a restart, the commands its held messages
came in on, while each is held and for the 500 most recent after it has gone,
so the same `queue` command offered again (its answer lost, or the desktop
restarted) is answered as held and never held or sent a second time
(`scheduled-messages.json` keeps `sources` on a message and a top-level
`heldSources`; a file without them reads as before).
Create PR on a paired machine's chat is `chat-create-pull-request`
(2026-10-18), gateway tools without the `conversation-` prefix: `conversation.pull_request_state`
(`conversation:read`) and `conversation.pull_request_draft`, `_draft_cancel`,
`_push` and `_create` (`conversation:operate`). Each names the chat by
`workspaceId` and `agentId`, never a folder; the machine reads the chat's
checkout from its own record, drafts with its own text generation settings,
and records a pull request it creates as the chat's, so its next list carries
it. All of it is additive: a client offers Create PR under a machine's chats
only where it is advertised, and an older machine answers the tools "Unknown
tool". The Studio RPC does not advertise it, having no method for them.
A paired desktop's row menu on a machine's chat (2026-10-21) writes Star,
Highlight color, Snooze and Wake now, and Auto-settle to that machine's
record of the chat. Each listed chat names what they write as two optional
members of `ConversationThread`, `highlight` (`{ starred, color? }`, the
colour one of `CONVERSATION_HIGHLIGHT_COLORS`) and `autoSettle: true`, with
no capability of their own; `parseConversationServerFrame` keeps a
`highlight` it can read, a known colour and a boolean star, and `autoSettle`
only when it is `true`, and an older client ignores them. A listed chat says
whether it compacts by itself as `autoCompact`, an optional boolean, and a
listed pull request says while it is watched as `watch`, an optional member
of `ConversationWirePullRequest` kept when it can be read. The writes were
gateway tools listed to paired devices under the `chat-row-menu`,
`chat-rename`, `chat-auto-compact`, `chat-delete`, `chat-search` and
`approval-rules` tailnet capabilities; since 2026-11-13 they are the Studio's
`chat-lifecycle` methods (below) and its `approval-rules`, those six tailnet
capabilities are gone, and so are the tools a device alone used
(`conversation.rename`, `.auto_compact`, `.delete_plan`, `.delete`,
`.search`, `.approval_rules` and `.approval_rule_revoke`). Stop watching was
`chat-unwatch-pull-request` (`conversation.pull_request_unwatch`); since
2026-11-13 it is the Studio's `pullRequests.unwatch` (`pull-request-watch`),
and that capability and tool are gone. A desktop's window asks each paired
machine's Studio itself, on its own connection (`pairedStudio.ts`), and reads
which of them a machine takes off that welcome (`chat-lifecycle`,
`pull-request-watch`); the list no longer says (`rowMenu`, `markUnread`,
`manage` and `lifecycle` are gone from it). A machine on an older build offers
none of them, and is asked to update.
Breaking frame changes require a new
negotiated capability or the tailnet version-window process above, not merely
a package version change. Presentation-only fixes use a package patch.
Both ESM and CommonJS tarball consumers and Node16 declarations are checked by
`npm run test:conversation-protocol:pack` as part of `verify:app`.

The phone app imports this package from the repository's source, as the desktop
does, so the two build against the same files and nothing is copied or pinned.
What stays is the version skew between a phone and a desktop that update
separately: a wire change still follows the capability and version-window rules
above, since an installed phone keeps the contract it was built with.
Publishing is a separate release step.

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
`studioPath`; a device that finds it missing is talking to an older Studio. It is a connection envelope — `hello` /
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
desktop reaches over its front door.
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
`module.reportRegistry` (`modules:operate`) and the `module.changed` stream.
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

1. **Decide which it is.** Additive → a new entry in `TAILNET_CAPABILITIES` (or,
   for the phone, a new command in the snapshot's advertised `commands`, which
   the phone reads as plain strings), no version bump. Otherwise → a version bump.
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
   examples are in `src/main/automation/tailnet-peers.test.ts`,
   `src/main/automation/tailnet-mesh-reachability.test.ts`,
   `src/main/mobile/control/command-validation.test.ts` and
   `src/main/mobile/control/protocol.test.ts`.
5. **Update the phone's use of it in the same change.** The phone imports the
   protocol package itself (see "The phone's reads are Studio protocol
   methods" above), so a shape change reaches its typecheck; what it does with a new
   member is still yours to write. The window is the grace period a bump needs,
   not permission to skip the other side.
6. **Update this file**, if what you changed is the policy rather than an
   instance of it.

## Bumps that have happened

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
