import { isEnvironmentId } from '../../../../packages/studio-protocol/src/environment'

// The tailnet listener's route table, in its own module so both the gateway
// server and the remote client can name a path without importing each other.

const TAILNET_ROUTE_PREFIX = '/tailnet/v1'
export const TAILNET_HEALTH_PATH = `${TAILNET_ROUTE_PREFIX}/health`
export const TAILNET_PAIR_PATH = `${TAILNET_ROUTE_PREFIX}/pair`
/**
 * Pairing by approval on the machine being driven: POST asks, GET
 * polls the answer. Unauthenticated like `pair`, because a peer that has not
 * been approved yet has no credential by definition.
 */
export const TAILNET_PAIR_REQUEST_PATH = `${TAILNET_ROUTE_PREFIX}/pair-request`
/**
 * The collect as a POST (pair-from-the-scan-and-stay-paired, phase 6): the
 * same poll `GET pair-request` answers, but with a body, so an approved
 * collect can carry the asker's reverse grant — a device it minted for this
 * machine — in the one exchange the approver already said yes to. GET stays
 * for clients that never offer one.
 */
export const TAILNET_PAIR_COLLECT_PATH = `${TAILNET_ROUTE_PREFIX}/pair-request/collect`
export const TAILNET_IDENTITY_PATH = `${TAILNET_ROUTE_PREFIX}/identity`
export const TAILNET_MCP_PATH = `${TAILNET_ROUTE_PREFIX}/mcp`
export const TAILNET_WS_TICKET_PATH = `${TAILNET_ROUTE_PREFIX}/ws-ticket`
export const TAILNET_STREAM_PATH = `${TAILNET_ROUTE_PREFIX}/stream`
/** One scoped conversation stream, independently resumable by event sequence. */
export const TAILNET_CONVERSATION_PATH = `${TAILNET_ROUTE_PREFIX}/conversation`
/**
 * The change feed (2026-09-05): one idle WebSocket per paired device on which
 * this machine says "the workspace list changed" or "the conversation list
 * changed", so a device re-reads on the change instead of every thirty
 * seconds. Server-to-client only, throttled to one push per kind per second,
 * carrying nothing but the kind — the device reads through the tools it is
 * already scoped for. Not the RPC stream: a watcher is not "connected" the
 * way a device driving this machine is, and must not count as one.
 */
export const TAILNET_EVENTS_PATH = `${TAILNET_ROUTE_PREFIX}/events`
/**
 * The Studio protocol, for a paired device: the one contract every client
 * speaks (`packages/studio-protocol`), over a WebSocket opened with a ticket
 * from `ws-ticket`, attached to the same Studio server this machine's own
 * windows use. What a device may ask is its grant, read again at every
 * request. A desktop window's socket names its origin when it asks for the
 * ticket and carries exactly that origin; every other socket carries none.
 */
export const TAILNET_STUDIO_PATH = `${TAILNET_ROUTE_PREFIX}/studio`
/**
 * The Studio protocol of a machine this desktop holds (a WSL distribution's
 * or an SSH machine's server), for a paired device: `<prefix><environmentId>/studio`.
 * The device proves itself here as on `TAILNET_STUDIO_PATH`, with a ticket
 * from `ws-ticket` that names the environment, and this desktop carries the
 * socket to that machine's own listener, which admits it with the device's
 * grant cut to what a relayed device may hold, never an owner's.
 */
const TAILNET_ENVIRONMENTS_PREFIX = `${TAILNET_ROUTE_PREFIX}/environments/`

/** The path a paired device opens to reach a machine this desktop relays. */
export function tailnetEnvironmentStudioPath(environmentId: string): string {
  return `${TAILNET_ENVIRONMENTS_PREFIX}${environmentId}/studio`
}

/** The environment a relayed Studio path names, or null for any other path. */
export function tailnetRelayedEnvironmentOf(path: string): string | null {
  if (!path.startsWith(TAILNET_ENVIRONMENTS_PREFIX) || !path.endsWith('/studio')) return null
  const id = path.slice(TAILNET_ENVIRONMENTS_PREFIX.length, -'/studio'.length)
  return isEnvironmentId(id) ? id : null
}
/**
 * One image from a paired device, staged for a conversation it may operate.
 *
 * A plain streaming POST rather than a JSON-RPC tool: base64 inside an RPC
 * envelope inflates a 5MB photo by a third and buffers all of it at both ends,
 * where a stream to disk buffers none of it.
 */
export const TAILNET_UPLOAD_PATH = `${TAILNET_ROUTE_PREFIX}/upload`
/**
 * The picture one step of a chat made or looked at, as raw bytes:
 * `GET ?workspaceId=&agentId=&toolUseId=`. A plain GET for the same reason the
 * upload is a plain POST — a picture inside a JSON frame is a third larger and
 * buffered whole at both ends — and one a client can cache, since a step's
 * picture never changes. The file is the one the conversation's own record of
 * the step names; nothing in the request is a path.
 */
export const TAILNET_CONVERSATION_IMAGE_PATH = `${TAILNET_ROUTE_PREFIX}/conversation-image`
/**
 * What a paired desktop's composer reads of one chat here, as JSON: the files
 * and folders a mention may name, `GET ?workspaceId=&agentId=&query=`
 * (`conversation-file-search`), and the slash commands the chat's CLI runs,
 * `GET ?workspaceId=&agentId=` (`conversation-commands`). Plain GETs beside
 * the socket rather than frames on it: each is a one-shot read for a picker,
 * asked while no chat need be followed, and the lane's frames stay the
 * phone's.
 */
export const TAILNET_CONVERSATION_FILES_PATH = `${TAILNET_ROUTE_PREFIX}/conversation-files`
export const TAILNET_CONVERSATION_COMMANDS_PATH = `${TAILNET_ROUTE_PREFIX}/conversation-commands`

// OAuth for the MCP endpoint (`tailnet-oauth-http.ts`). Unauthenticated, as
// pairing is: they are how a client without a credential gets one. The
// well-known documents that name them sit at the root, where RFC 8414 and
// RFC 9728 put them.
const TAILNET_OAUTH_PREFIX = `${TAILNET_ROUTE_PREFIX}/oauth`
export const TAILNET_OAUTH_REGISTER_PATH = `${TAILNET_OAUTH_PREFIX}/register`
export const TAILNET_OAUTH_AUTHORIZE_PATH = `${TAILNET_OAUTH_PREFIX}/authorize`
export const TAILNET_OAUTH_WAIT_PATH = `${TAILNET_OAUTH_PREFIX}/authorize/wait`
export const TAILNET_OAUTH_TOKEN_PATH = `${TAILNET_OAUTH_PREFIX}/token`
export const TAILNET_OAUTH_REVOKE_PATH = `${TAILNET_OAUTH_PREFIX}/revoke`

// ── What this transport speaks ───────────────────────────────────────────────
//
// Here rather than in the gateway server for the same reason the paths are:
// the version and the capability list are the wire's own facts, and a client
// (the phone) reads them from `health` before it has any other opinion about
// this machine.

/** Bumped when the wire changes in a way a client must know about. 2 (2026-09-06): the change feed, sliced replay frames, git only for running sessions. */
export const TAILNET_TRANSPORT_VERSION = 2

/**
 * The oldest wire this build will still drive.
 *
 * A window rather than an equality because the two ends of a tailnet are two
 * separate installs that update on their own schedule, and refusing the machine
 * that updated last week is worse than talking to it. One version of slack is
 * what an ordinary "I'll update it this weekend" costs.
 *
 * It can be 1 and not 2 because nothing version 2 changed makes a version 1 peer
 * unreadable: its two new routes are named capabilities a version 1 peer does
 * not advertise, and its one behaviour change (git facts only for running
 * sessions) leaves a version 1 peer answering a superset of what a version 2
 * client expects. Neither is a shape this build would misread. When a bump DOES
 * change the shape of something already shipped, this constant moves up with
 * it. See `docs/compatibility.md`.
 */
export const TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION = 1

/**
 * Additive features a client may rely on; a purely additive feature ships here
 * without a version bump.
 *
 * `upload` was served from 2026-09-05 and advertised from 2026-09-07. Until it
 * was named here the route was undiscoverable, and a phone's only way to find
 * out was to send the file and read the 404 at the end of the transfer — the
 * one failure an upload must not have.
 *
 * Withdrawn 2026-09-29, when terminals stopped crossing the tailnet:
 * `sliced-frames` (a terminal replay or output too large for one frame arrived
 * as several) and `terminal-resume` (a terminal attach could name where its
 * screen stood and be sent only the tail). Both described the terminal stream,
 * which is gone; withdrawing a capability is not a version bump
 * (`docs/compatibility.md`), and a client that asks for the route it named is
 * answered 404.
 *
 * `conversation-models` (owner ruling 2026-09-27): the conversation list names
 * each chat's CLI and the models this machine's picker offers for it, and a
 * device with `conversation:operate` may switch the chat to one of them with
 * the `setModel` command. A client hides its model control for a machine that
 * does not advertise it. The string is the protocol package's
 * `CONVERSATION_MODELS_CAPABILITY`.
 *
 * `conversation-images` (2026-09-29): `GET conversation-image` serves the
 * picture a chat's step made (Codex's `GenerateImage`) or looked at (a file
 * read of a picture), by the step's tool call id, to a device with
 * `conversation:read`. A client that finds it missing says the picture is on
 * the other machine, as it did before the route existed.
 *
 * `conversation-permission-modes` (owner request 2026-09-30): chats run on
 * `manual` and `auto` as well as `none` and `bypass`. The list may name either
 * as a chat's preset, names the presets each chat's provider can run, and
 * `setPermissionPreset` takes all four. A machine without it reads `manual`
 * and `auto` as `none`, so a client offers only the two it knows there. The
 * string is the protocol package's `CONVERSATION_PERMISSION_MODES_CAPABILITY`.
 *
 * The conversation lane's contract became one package every client speaks
 * (owner ruling 2026-10-01), and three of its additions are named here, each
 * a string from the protocol package:
 * - `conversation-hello`: the socket answers `hello` with the conversation
 *   protocol version and the conversation capabilities in this list.
 * - `conversation-plans`: `resolvePlan` answers a plan request, and only one.
 *   A plan answered as `resolveApproval`, as before, is still taken.
 * - `conversation-cli-permission-modes`: the list names the CLI's own mode a
 *   chat runs at its preset and the modes its provider runs, and
 *   `setPermissionPreset` takes a `permissionMode`. A machine without it drops
 *   the member and runs the preset's own mode.
 *
 * `conversation-lifecycle` (owner report 2026-10-05): this desktop is the one
 * owner of whether a chat is settled and of whether its finish has been seen.
 * The list leaves out settled chats, arrives in the order the sidebar draws
 * them (by when the person last wrote to each), and names each chat's
 * `chatTitle`, `lastUserMessageAt`, `lastTurnEndedAt` and `lastVisitedAt`;
 * `conversation.settle` and `conversation.visit` settle a chat and say it was
 * looked at. A client offers no Settle for a machine without it, and reads
 * "finished, unseen" there by its own lights. The string is the protocol
 * package's `CONVERSATION_LIFECYCLE_CAPABILITY`.
 *
 * `conversation-queued-sends` (owner report 2026-10-08): a message queued in
 * a chat while its turn runs is held by this desktop, which sends it when the
 * turn ends, rather than by the machine that typed it, which may be asleep by
 * then. `send` takes `queue`, `cancelQueued` takes one back, and `watchQueued`
 * has the socket say what is held for the chat it follows, in `queued`
 * frames. A client keeps the message itself, as before, for a machine without
 * it. The string is the protocol package's
 * `CONVERSATION_QUEUED_SENDS_CAPABILITY`.
 */
export const TAILNET_CAPABILITIES = [
  'events',
  'upload',
  'conversations',
  'conversation-models',
  'conversation-images',
  'conversation-permission-modes',
  'conversation-hello',
  'conversation-plans',
  'conversation-cli-permission-modes',
  'conversation-lifecycle',
  'conversation-queued-sends',
  // A message may bring skills (2026-10-09): `send` takes `skills`, ids of
  // this machine's skills the chat runs with it. CONVERSATION_SEND_SKILLS_CAPABILITY.
  'conversation-send-skills',
  // A message may steer the turn that is running (2026-10-14): `send` takes
  // `steer`, and a listed chat says whether its provider takes one
  // (`capabilities.steer`). A steer the turn cannot take is held as a queued
  // message is, or refused busy where it carries what a held one cannot.
  // CONVERSATION_STEER_SENDS_CAPABILITY.
  'conversation-steer-sends',
  // The pictures a person sent with a message (2026-10-16): `GET
  // conversation-image` takes `attachment`, the `ref` a `user_message`'s
  // `attachments` entry records, in place of `toolUseId`, and serves the
  // picture this machine kept for that chat. A client without it names the
  // picture instead. CONVERSATION_MESSAGE_IMAGES_CAPABILITY.
  'conversation-message-images',
  // Files of any type with a message (2026-10-17): `upload?kind=file` takes
  // one up to 25 MB, kept in Studio's own store, and the `send` that spends
  // its id attaches it to the message by path (`files` on its
  // `user_message`). A client without it offers pictures only.
  // CONVERSATION_MESSAGE_FILES_CAPABILITY.
  'conversation-message-files',
  // A picture uploaded for a chat is sized for the model on receipt
  // (2026-10-17): this machine shrinks it to the composer's 1568px long edge,
  // so the upload route takes one up to 20MB, where it took 5MB. A client
  // that does not see it keeps its own 5MB check. A server with no image
  // codec does not advertise it. CONVERSATION_IMAGE_DOWNSCALE_CAPABILITY.
  'conversation-image-downscale',
  // One agent a chat spawned may be stopped by itself (2026-10-24):
  // `stopSubagent` names it by the call that spawned it, and a listed chat
  // says whether its provider can (`capabilities.stopSubagent`). This
  // machine's turn Stop spares a chat's agents where they can be stopped one
  // at a time, so a paired machine needs its own Stop for each.
  // CONVERSATION_STOP_SUBAGENT_CAPABILITY.
  'conversation-stop-subagent',
  // The person's words may be passed to one agent a chat spawned (2026-11-07):
  // `messageSubagent` names it as `stopSubagent` does, and the chat's model
  // delivers them. A listed chat says whether its provider can
  // (`capabilities.messageSubagent`); a client draws no box without both.
  // CONVERSATION_AGENT_MESSAGE_CAPABILITY.
  'conversation-agent-message',
  // A chat may be handed off to a fresh session from a paired machine, as its
  // own Handoff does here (2026-10-25): `handoff`, where a listed chat says
  // its provider can (`capabilities.handoff`). CONVERSATION_HANDOFF_CAPABILITY.
  'conversation-handoff',
  // A chat may be taken back to before one of its messages from a paired
  // machine, as Edit from here does here (2026-10-25): `rewind`, where a
  // listed chat says its provider can (`capabilities.rewind`).
  // CONVERSATION_REWIND_CAPABILITY.
  'conversation-rewind',
  // A turn's files may be put back from its checkpoint from a paired machine,
  // as Revert and Undo revert do here (2026-10-25): `revert` lists the files
  // and then acts on exactly those, in this machine's checkout, for a listed
  // chat with `capabilities.checkpoints`. CONVERSATION_CHECKPOINT_REVERT_CAPABILITY.
  'conversation-checkpoint-revert',
  // A chat forked from a paired machine, as Fork from here forks one here
  // (2026-10-25): `fork` names the point and the new chat's id, and the fork
  // joins the chat's workspace on this machine. A listed chat says whether
  // its provider can (`capabilities.fork`). CONVERSATION_FORK_CAPABILITY.
  'conversation-fork',
  // A side question about a chat, as the composer's /btw asks one here
  // (2026-10-25): `askSideQuestion` is answered from the chat's context and
  // added to nothing, `cancelSideQuestion` calls one off, and a listed chat
  // says whether its provider can (`capabilities.sideQuestion`).
  // CONVERSATION_SIDE_QUESTIONS_CAPABILITY.
  'conversation-side-questions',
  // An answered side question is kept in the chat's transcript here, as a
  // `side_question` event between its turns, whichever device asked it
  // (2026-11-11): a paired desktop draws it as a marker that opens it again,
  // and says a question asked of a machine without it is not kept.
  // CONVERSATION_SIDE_QUESTION_RECORDS_CAPABILITY.
  'conversation-side-question-records',
  // What fills a chat's context window, as the ring opens it here
  // (2026-10-25): `getContextBreakdown` asks the chat's live agent, and a
  // listed chat says whether its provider can (`capabilities.contextBreakdown`).
  // CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY.
  'conversation-context-breakdown',
  // A paired desktop's composer reaches a chat's folder here (2026-10-25):
  // `send` takes `mentions`, files and folders by their paths in the chat's
  // folder, resolved here as this machine's own @ chips are; `GET
  // conversation-files` searches that folder for them; and `GET
  // conversation-commands` lists the slash commands the chat's CLI runs
  // there. Both reads are `conversation:read`, and name no path outside the
  // folder. A client that does not see one leaves that part of its composer
  // to its own machine, as before. CONVERSATION_SEND_MENTIONS_CAPABILITY,
  // CONVERSATION_FILE_SEARCH_CAPABILITY, CONVERSATION_COMMANDS_CAPABILITY.
  'conversation-send-mentions',
  'conversation-file-search',
  'conversation-commands',
  // A message may say the mode its turn runs in (2026-10-25): `send` takes
  // `mode`, `ask`, or `plan` where a listed chat says its provider plans
  // (`capabilities.planMode`), as this machine's own chat sends one.
  // CONVERSATION_SEND_MODE_CAPABILITY.
  'conversation-send-mode',
  // A chat's reasoning effort from a paired machine (2026-10-25): a listed
  // chat names the levels its provider runs and the one it runs at, and
  // `setReasoningEffort` changes it on the chat's record, as this machine's
  // effort control does. CONVERSATION_REASONING_EFFORT_CAPABILITY.
  'conversation-reasoning-effort',
  // A live chat's MCP servers from a paired machine (2026-10-25):
  // `mcpServerAction` reconnects one or switches it on or off, where a listed
  // chat names the actions its provider takes (`capabilities.mcpServerActions`).
  // A sign-in stays here: the CLI waits for its callback on this machine.
  // CONVERSATION_MCP_SERVER_ACTIONS_CAPABILITY.
  'conversation-mcp-server-actions',
  // A chat's agent restarted from a paired machine (2026-10-25):
  // `restartSession` ends its process as this machine's own Restart agent
  // session does, and the next message starts it again on the same
  // conversation. CONVERSATION_RESTART_SESSION_CAPABILITY.
  'conversation-restart-session',
  // A message may be scheduled into a chat here for a time (2026-10-25), as
  // this machine's own composer schedules one: `scheduleSend` keeps it among
  // this machine's scheduled messages, which send it then whether or not the
  // machine that scheduled it is awake; `sendScheduledNow` and
  // `cancelScheduled` send one early or delete it; and `watchScheduled` has
  // the socket say what is scheduled for the chat it follows, in `scheduled`
  // frames. A client offers no Schedule for a machine without it.
  // CONVERSATION_SCHEDULED_SENDS_CAPABILITY.
  'conversation-scheduled-sends',
  // This machine's usage limits for a paired machine's chat strip and tray
  // (2026-10-25): `watchUsageLimits` has the socket say, in `usageLimits`
  // frames, every plan's windows as this machine's agents reported them and
  // the notice a limit left on the followed chat's turn; `usageLimitResume`
  // schedules, cancels, dismisses or retries the resume this machine sends it
  // when the limit resets. A client draws neither for a machine without it.
  // CONVERSATION_USAGE_LIMITS_CAPABILITY.
  'conversation-usage-limits',
  // A message held for a turn's end carries what a message sent now does
  // (2026-10-25): a `send` with `queue` takes `uploadIds`, `skills` and
  // `mentions`, and a steer the turn cannot take is held with them. The
  // pictures are copied under this machine's data folder and the files kept
  // where their uploads put them from the moment the message is held, so the
  // machine that queued it may close; `queued` frames name what each held
  // message carries. A client keeps such a message itself for a machine
  // without it. CONVERSATION_QUEUED_ATTACHMENTS_CAPABILITY.
  'conversation-queued-attachments',
  // "Always allow" from a paired machine (2026-10-25): `resolveApproval` takes
  // `decision: 'always'` from a device that may operate the chat, and the rule
  // is saved for the chat's workspace here, among this machine's own, which
  // its Settings (and a paired desktop's, through `approval-rules`) lists and
  // revokes. A client offers the rule only for a machine that advertises it.
  // CONVERSATION_PERMANENT_APPROVALS_CAPABILITY.
  'conversation-permanent-approvals',
  // A quote crosses the wire as its token (2026-11-07): this machine expands
  // one in a message it is sent into what its agent reads, and leaves tokens
  // in what it sends a socket whose client named this in its `hello`, so a
  // paired Studio quotes as this machine's own chat does. Every other client
  // reads a quote as words. CONVERSATION_QUOTE_TOKENS_CAPABILITY.
  'conversation-quote-tokens',
  // The sub-agents of a chat followed from a paired machine (2026-11-07):
  // `watchSubagents` has the socket say, in `subagents` frames, which a chat
  // has and how each stands, as this machine's own panel reads them. Each
  // is a chat of its own, followed by its id. The list still leaves them out,
  // so a client that does not ask is told of none. A client shows only the
  // agents a chat's CLI spawned for a machine without it.
  // CONVERSATION_SUBAGENTS_CAPABILITY.
  'conversation-subagents',
  // A chat's changes read from a paired machine (2026-11-07), as this
  // machine's own Diff tab reads them when its Changes row is pressed:
  // `watchChanges` has the socket say, in `changes` frames, how the chat's
  // checkout stands, `getChangesDiff` lists one step's files and
  // `getChangedFile` reads one of them. Only a file a step lists is readable,
  // at revisions worked out here, and a commit must be one of the branch's.
  // A client keeps the read-only count for a machine without it.
  // CONVERSATION_CHANGES_CAPABILITY.
  'conversation-changes',
  // A phone's New chat as this machine's own (2026-10-05). They name gateway
  // tools' arguments and answers, not the conversation lane, so they carry no
  // `conversation-` prefix and are not the protocol package's to list:
  // `conversation.create` takes `worktree` (a new chat in a worktree of its
  // own, cut as New chat here cuts one) and `effort` (a level of the CLI's,
  // kept on the chat); `cli.runtime.list` answers each CLI with a `catalog`,
  // the model picker's own rows. A client that does not see one leaves the
  // matching control off: an older desktop's handler skips an argument it
  // does not know, so a `worktree` sent there would start the chat in the
  // checkout the person asked to keep clean, with nothing said about it.
  'new-chat-worktree',
  'new-chat-effort',
  'cli-runtime-catalog',
  // A paired desktop's New chat picks its worktree as this machine's own door
  // does (2026-10-09): `conversation.create` takes `worktreeName` (what a
  // `worktree` and its branch are named from, typed into the Worktree field) and `inWorktree`
  // (a worktree the project already has, by the path `workspace.checkout`
  // lists). Its answer names the worktree the chat runs in, an optional
  // member a client that does not read it can ignore. A client that does not
  // see one leaves the matching control off, for the reason `worktree` has
  // one: an older handler skips both arguments and starts the chat elsewhere.
  'new-chat-worktree-name',
  'new-chat-in-worktree',
  // A paired desktop's New chat offers "No project" on this machine
  // (2026-11-05): `conversation.create` takes `noProject` in place of a
  // workspace, and the chat runs in a folder of its own here. An older handler
  // refuses the missing workspace, so a client leaves the row off rather than
  // offer one that fails.
  'new-chat-no-project',
  // A paired desktop's composer offers this machine's skills and MCP servers
  // (2026-10-09): `workspace.extensions` lists a project's skills and, for a
  // CLI, its MCP servers with the connection each last reported; and
  // `conversation.create` takes `skills`, installed into the chat's folder
  // and run with its first message. A client that does not see them refuses
  // a skill chip for this machine rather than send it to a handler that
  // skips the argument.
  'workspace-extensions',
  'new-chat-skills',
  // A paired desktop's Create PR on a chat here (2026-10-18): the
  // `conversation.pull_request_*` tools read whether the chat's checkout is
  // ready, draft the text with this machine's text generation settings, push
  // the branch and open the pull request here, recording it as the chat's.
  // They name the chat, never a folder. A client that does not see it draws
  // no Create PR under this machine's chats, as before.
  'chat-create-pull-request',
  // An outside MCP client may sign in with OAuth (the MCP authorization spec)
  // instead of pairing: discovery from the MCP endpoint's 401.
  'mcp-oauth',
  // This desktop relays its paired devices to the SSH machines it holds
  // (2026-11-13): its Studio lists them (`environment.relayed`), and a device
  // reaches one at `/tailnet/v1/environments/<id>/studio`. A paired desktop
  // that does not see it asks for no list.
  'relayed-environments',
] as const

export type TailnetCapability = (typeof TAILNET_CAPABILITIES)[number]

/**
 * Does this peer offer a feature, according to what it said in the handshake?
 *
 * The question to ask before using anything the transport did not always have.
 * A version comparison would answer it too, but only by encoding "events landed
 * in 2" in every caller, which is the fact that goes stale: a capability may be
 * withdrawn by a build that keeps the version, and back-porting one to an older
 * version is exactly the move the capability list exists to allow.
 *
 * A peer that advertises no list at all (anything before the field shipped)
 * therefore has no capabilities, not all of them — this answers "may I RELY on
 * X", and silence is not a promise. It is not the same question as "should I
 * stop trying X", where silence means only that we do not know; the change-feed
 * gate in `tailnet-mesh-service.ts` keeps the two apart.
 */
export function tailnetPeerSupports(
  capabilities: readonly string[] | null | undefined,
  capability: TailnetCapability,
): boolean {
  return capabilities?.includes(capability) ?? false
}

/** A handshake refused for speaking a wire this build does not. */
export type TailnetTransportRefusal = {
  code: 'unsupported_transport_version'
  message: string
}

/** `1–2`, collapsing to `2` on its own once the window narrows to one version. */
function supportedTransportVersions(): string {
  return [...new Set<number>([TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION, TAILNET_TRANSPORT_VERSION])].join('–')
}

/**
 * Check a peer's advertised transport version, returning null when it is one we
 * speak and a refusal when it is not.
 *
 * The whole point is that this fires at the handshake. Until it did, a peer on
 * an incompatible wire was accepted and then failed somewhere downstream on a
 * payload shape — a tool answering in a form this build could not read, a frame
 * with a field that moved — which is the expensive kind of failure: it surfaces
 * far from its cause and reads as a bug in whatever tool happened to be called.
 *
 * The refusal names both versions because that is the whole diagnosis. "Cannot
 * connect" sends someone to the network; "that machine speaks 4, this one
 * speaks 1–2" tells them which of the two installs to update.
 */
export function checkTailnetTransportVersion(seen: unknown): TailnetTransportRefusal | null {
  if (
    Number.isInteger(seen) &&
    (seen as number) >= TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION &&
    (seen as number) <= TAILNET_TRANSPORT_VERSION
  ) {
    return null
  }
  // A peer that states nothing readable gets its own sentence: "speaks version
  // undefined" would read as a bug here rather than as a fact about that machine.
  const seenClause = Number.isInteger(seen)
    ? `That machine speaks transport version ${seen as number}`
    : 'That machine did not state a transport version this build could read'
  return {
    code: 'unsupported_transport_version',
    message: `${seenClause}; this build speaks ${supportedTransportVersions()}. Update whichever of the two is older.`,
  }
}
