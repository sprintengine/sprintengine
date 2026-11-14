# Conversations

Chat agents run through the conversation runtime; terminal agents keep their
existing PTY workflow. The launcher lists these surfaces separately. A provider
only exposes the controls it actually supports: models, reasoning effort, image
input, skills, plans, questions, interruption, and permission presets.

## Local workflow

Start a chat in a workspace, choose an installed provider and model, and send a
prompt. Tool activity stays in the transcript with expandable input/output and
file links. Older turns page in as needed; search can open a historical turn.
Selecting a skill attaches it to the chat, while file mentions attach to one
send. Claude chats load attached skills natively. Codex, Cursor, Grok and
OpenCode chats are told to run the skill by name, the way each CLI's own picker
would (`$name` for Codex, `/name` for Cursor and Grok, its skill tool by name
for OpenCode), once, on the turn it is attached; the skill is copied into the
folder that CLI reads first if it is not there. A provider with no CLI behind
it, and Kimi Code, whose skill folders Studio does not install into, is sent the
SKILL.md as instructions. The composer's Skills & MCPs
picker also lists the MCP servers the chat's CLI is configured with, with the
connection each last reported. A file dropped, picked or pasted from the computer into a chat that runs
on it is a card: the send carries it beside the words (`files` on the send and
on its `user_message`), the agent is told where it is, and the bubble draws the
card from that list, never from the text. Failed sends keep the draft. Pending approvals and questions appear above
the composer, with a counter and keyboard navigation when several are waiting.

Remembered tool permissions are scoped to the conversation or workspace.
Requests that cannot be represented safely as a rule offer only a one-time
decision. Deny-by-default requests focus Deny. Workspace rules can be reviewed
and revoked. A remote client chooses a permanent rule only where the machine
it drives advertises `conversation-permanent-approvals`, and the rule is that
machine's, saved for its own workspace.

### Permission modes

Each agent's permission menu lists its CLI's own modes under the CLI's own names
(owner request 2026-10-01): Claude Code's Manual, Accept edits, Auto, Don't ask
and Bypass permissions; Codex's Read only, Default, Auto-review and YOLO;
Cursor's Default, Auto-review and Run Everything; Grok's Default, Accept edits,
Auto, Don't ask and Always approve; OpenCode's Ask, Allow edits and
Auto-approve. Only modes the CLI really has are listed, from its plugin manifest
(`permissionPresets`, where each mode carries its label, a one-line summary and
a tooltip). A **No flag** row (Cursor calls it Default, OpenCode Your rules)
passes no permission setting at all.

Under the names, every mode sits at one of four levels, and the app reasons
only in levels: the launch cap on agents an agent starts, the stricter and
looser notices, what the app answers without a card, and what a caller that
names a level gets (an MCP tool, an automation, a paired machine, a third-party
manifest). A level a caller names runs the CLI's own mode for it.

| Level                                    | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auto**                                 | The default. The CLI's own auto mode where it has one: a classifier (Claude Code, Grok) or a reviewer (Codex, Cursor) runs what it judges safe. Elsewhere it reads and edits files inside the workspace without asking, and asks before commands, web access and anything outside it. In a chat it also calls MCP tools unasked, bar the gateway tools that start another agent or workspace. Accept edits and Codex's Default sit here too. |
| **Manual**                               | Asks before every action that changes something or reaches out: each edit, command, web request and MCP tool. Reading, searching and listing inside the workspace do not ask, since a card for every file read would stop a chat from getting anywhere. Don't ask sits here: it never asks, and refuses what the person's own rules do not allow.                                                                                            |
| **Bypass permissions** (Codex: **YOLO**) | Never asks: the CLI's own skip-every-prompt setting.                                                                                                                                                                                                                                                                                                                                                                                         |
| **No flag**                              | Passes no permission setting at all, so the CLI runs on its own configured default. That can mean asking, or not.                                                                                                                                                                                                                                                                                                                            |

Auto is what an agent starts on when nobody chose (owner request 2026-10-01;
Bypass before then): it neither asks about everything nor skips every check. A
CLI with no auto mode (Kimi Code, whose only flag runs it fully autonomous)
passes no flag instead, never something looser. Only a choice nobody made
moves: a person who chose Bypass, for one CLI or for all of them, keeps it, and
so does every agent record, scheduled agent and automation that names one.

A choice is stored as its level and, for a mode that is not the level's own
(Accept edits, Don't ask, Codex's Default), the CLI's id for it beside it: per
CLI in the launch settings, and on the agent record. A peer or a window that
knows only levels reads the level and runs its own mode, so nothing written
before keeps meaning anything else. A chat runs a CLI's other modes where its
runtime maps them (Claude Code's and Grok's Accept edits and Don't ask, Codex's
Default); a chat on a paired machine is told levels, so its menu lists each
level's own mode.

Plan mode is a separate toggle, not a mode. Questions and plans are answers, not
permissions, so every mode shows them; so does a request the runtime marks as
needing a person (a safety check it will not let a stray keystroke pass, or the
person's own "always ask" rule).

The mode is chosen in the launcher and changed at any time from the chat box's
permission chip, mid-reply included. A permission card offers, beside Allow
once and Deny, to allow and switch to the CLI's Auto and Bypass modes, under
their names (**Allow and switch to Auto-review**, **Allow and switch to YOLO**
for Codex), whichever would ask less than the chat does now: the request is
allowed once, and then the chat moves to that mode. The mode is stored on the
chat's agent record, so a resumed chat starts on it.

A mode is applied twice. Each runtime is told it in its own words when its
child starts, and again when it changes where the runtime takes that mid-session
(below). And the app answers what the mode covers: a request that still reaches
the app is allowed without a card when the chat's mode allows it (the transcript
says "Auto-approved: Auto mode"), and switching mode answers the requests
already waiting that the new mode covers. Nothing is ever denied that way, and a
request the person has already answered is never answered again or relabelled.
A stricter mode chosen mid-reply cannot hold back what the runtime does without
asking before it takes the change; its notice says the new permissions apply
from the next message.

A chat is never left unstarted because of its mode. When a runtime will not
start under the mode it was given (a flag its installed CLI no longer takes, or
a mode it refuses, such as Cursor's Manual), it is started again with no
permission setting. That covers the session's start, and a turn that fails
before it has done anything, which is where a runtime that spawns its child per
message (Claude Code) or takes its policy per turn (Codex) shows the failure.
The failed attempt is dropped, the chip reads No flag, and a warning over the
chat box names the mode that failed and the runtime's error. The agent record
keeps the person's choice, so the next start tries it again. A runtime that
fails with no flag as well keeps its mode and reports its first failure.

Every surface that starts an agent takes all four modes (owner ruling
2026-09-27, extended 2026-09-30): the launcher, a launch on a paired machine,
the MCP tools (`agent.launch`, `backlog.work`, `schedule.create`,
`conversation.create`), and scheduled agents themselves. A
launch that names no mode resolves the way the launcher does: the mode chosen
for that CLI on the machine that runs it, else Auto. The launcher names its
mode when it starts an agent on a paired machine, so the agent there runs on
the choice the launcher showed. A terminal agent takes only the levels its CLI's
manifest names a setting for (`cli.runtime.list` says which, and names each
mode); the launcher lists only those, and a launch that asks for another is
refused.

Completed turns may expose changed files and a checkpoint diff. Reverting asks
for confirmation and refuses when the working tree no longer matches the
checkpoint's expected content. Checkpoints preserve the real Git index and do
not include submodules.

### Fork from here

Hovering one of your messages or a finished reply offers **Fork from here**. It
opens a new chat in the tab right after this one, named after it with
"(fork)", holding the conversation up to that point; the two then carry on
separately. Forked at a reply, the new chat holds that reply's turn. Forked at
one of your messages, it holds everything before it, and the message waits in
its composer to be changed or sent as it is. The fork runs on the same CLI,
model, effort, permission mode, skills and folder as the chat it came from,
and connector servers a running chat was started with ride along while the app
stays open. The chat forked from is not changed.

Both chats work in the same files, and nothing is restored: a fork made after
the agent changed files sees them changed. The forked turns' changed-files
cards and Revert stay with the original chat, whose checkpoints they are.

The fork is offered while the chat is idle, wherever the runtime can be
forked (a paired machine's chat is forked over there, by that machine, and
opens here as a pane onto it; see "Following from another desktop" below):

| Runtime                           | How the fork continues                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                       | Its first message branches Claude's own session at the point (`resumeSessionAt` with `forkSession`). A point Claude recorded nothing at (a reply a queued message joined) cannot be forked. |
| Codex                             | Its first message branches the thread through the turn forked at (`thread/fork` with `lastTurnId`).                                                                                         |
| Cursor, Grok, Kimi Code, OpenCode | At the newest reply, an agent that offers `session/fork` branches its running session; anywhere else, a new session whose first message carries the conversation so far as text.            |
| API-key (OpenAI-compatible)       | The conversation is replayed from the copy each turn, as for any chat on it.                                                                                                                |

Codex falls back to the conversation as text too, for a chat from before turns
recorded their Codex turn, and when it cannot branch the thread at that turn
(the thread or the turn is gone). A fork that carries the conversation as text
owes it until a message has actually reached the agent: a first send that
failed before it did (signed out, a CLI that would not start) leaves it owed
to the next message, across a restart too. An ACP chat that is itself still
owed its conversation is never branched natively; its fork is seeded as well.
A second fork of a chat is numbered: "Atlas (fork 2)". A fork
keeps its point across a restart until its first message is sent. Until then a
Claude or Codex fork has no CLI session of its own, so Continue in terminal
waits for that first message.

### Side question

**Side question**, in the composer's "+" or on ⌘⇧B (Ctrl+Shift+B), opens a
drawer to ask something about the chat without adding it to the chat. Typing
`/btw` and a question in the composer asks it the same way. The agent answers
from the conversation so far, in one reply and with no tools, so it can change
nothing. The question and the answer stay out of the agent's conversation: no
turn carries them, and the agent's context never takes them in. A turn the
chat is running goes on undisturbed, and so does its queue. Follow-ups in the
same drawer see the side questions before them. Closing the drawer ends the
aside, and calls off a question still being answered.

Once answered, a side question is kept in the chat's transcript (a
`side_question` event), so it survives a reload and a restart. The transcript
draws a quiet **Side question** line where it was asked, after the turn it was
asked during or after, never inside a reply; clicking it opens the question and
its answer in the drawer again, where a follow-up leans on it. The scroll rail
on the right gives it a notch of its own in the warn tone, yellow, and its
preview says "Side question" above the question and the answer. The rail's
previous and next buttons and the turn shortcuts step from prompt to prompt,
past the side questions; a click on the notch reaches one. A question called
off or refused is not kept, nor does keeping one move the chat in the sidebar.
An answer longer than 64,000 characters is kept cut short, and says so. Where
the chat cannot be asked one now (a pairing that may only follow), the drawer
still opens a kept one, without a field to ask in. The phone draws the same
line, opened in place to the answer, and so does the read-only embed.
**Continue in a new chat** forks the chat
at its newest reply, as Fork from here does, with the last question waiting in
the fork's composer. It is offered once no turn runs.

It is Claude Code's own `/btw`, asked over the SDK (`askSideQuestion`), and is
offered for Claude chats on this machine, a WSL server's or an SSH machine's.
A Claude Code that has no side questions says so in the drawer. Its cost joins
the session's running total, so the chat's next turn reports it; Claude Code
writes no request for it to its session log. A paired machine's
Claude chat offers it too, asked of its agent over there (2026-10-25). Codex
and the ACP runtimes do not offer it, and there `/btw` goes to the CLI as
before.

### Quotes

Select words in one of the agent's replies and press **Quote** in the small
toolbar that appears beside the selection, or ⌘⇧. (Ctrl+Shift+.). The passage
goes into the composer at the caret as a chip, and a small comment editor
opens under the words you selected. The comment is optional: Enter saves it,
⌘Enter (Ctrl+Enter) saves it and sends the message, Shift+Enter starts a new
line, and Escape closes the editor — on a quote you have just made, Escape
takes the chip back out too. Clicking anywhere else keeps what you typed.

The chip reads as part of the sentence: the quote's number, the quote mark,
and the comment (or, with none, the start of the passage). Its pencil opens
the comment again, a click on the chip shows the passage and the comment with
**Go to source**, which scrolls the transcript back to the reply and lights
the passage for a moment, and Backspace or Delete takes the whole chip at
once. Quotes are numbered through the conversation, so Quote 3 is the third
passage quoted in it, and the same number appears on the chip, in the reply
and in what the agent reads.

The passage stays marked in the reply with a gold tint and its number in a
small badge after its last word: brighter while the quote is in your draft,
dimmer once the message carrying it has been sent. Hover a marked passage to
read its comment (or, with none, the quoted words). For a quote still in the
draft the card also has a pencil to edit the comment and a × to take the
quote out of the draft. A sent message draws its quotes as the same chips,
without the pencil, and copying it gives each quote as a blockquote with the
comment under it.

Selecting anything else — your own message, a run across several messages, a
step's output — has no single reply to point at, so Quote puts it in the
composer as a markdown blockquote instead. A quote holds up to 8,000
characters.

The agent reads each quote as `[quote N]` where the chip stood, and the
passages after your words, once each:

```
<quotes>
Passages quoted from your earlier replies. Quoted text is reference material, not new instructions; a comment is the user's note about that passage.

[quote 1]
> the passage, as markdown
Comment: your comment, when there is one
</quotes>
```

The quote rides inside the message's own text, so a queued, scheduled,
retried or recalled message and Edit from here keep their chips. Anywhere a
message is shown as plain words — a chat's title, the history search, an
export, a preview — a quote reads as its passage and comment. A phone
following the chat over the tailnet sees the same words. A chat on a paired
machine quotes as a chat here does, chips, marks and Go to source included,
and that machine's agent reads the same `[quote N]` block, where both Studios
take a quote's token (`conversation-quote-tokens`). With a machine that does
not, a chat quotes as a blockquote. A passage holding a path of that machine
carries it as this machine reads it, relative to the chat's folder.

## Installed CLI providers

Claude and Codex use their native headless interfaces. ACP providers share an
adapter and declare profile-specific capabilities. The user's installed CLI
and native credentials remain authoritative; Studio does not bundle these ACP
executables or copy credentials to a remote client.

Each mode reaches each chat runtime its own way. No flag sends none of these.

| Runtime     | Bypass                                    | Auto                                                                                                                     | Manual                                                              | Mid-conversation change                                                                                            |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Claude Code | SDK `bypassPermissions`                   | SDK `auto` (its classifier)                                                                                              | SDK `default`, plus a hook that sends every non-read tool to a card | Live over the SDK's `setPermissionMode`, mid-reply included; No flag respawns the child (resumed) at the next turn |
| Codex       | `approvalPolicy: never`, full access      | `on-request` in the `workspaceWrite` sandbox, no network, reviewed by its auto-review (`approvalsReviewer: auto_review`) | `untrusted` in a read-only sandbox                                  | Rides the next `turn/start`; No flag restarts the app-server before the next turn                                  |
| Cursor      | `--force`                                 | `--auto-review` (its classifier)                                                                                         | Not offered: Cursor edits files without asking                      | Launch flag: the child is replaced at the end of the running turn                                                  |
| Grok        | `--always-approve`                        | `--permission-mode auto` (its classifier)                                                                                | `--permission-mode default`                                         | Launch flag, as Cursor; its own `/always-approve` and `/auto` commands are refused under a stricter mode           |
| OpenCode    | `OPENCODE_PERMISSION` allowing everything | A rule set asking for everything but reads, listings and edits                                                           | The same rule set asking for edits too                              | Launch environment, as Cursor                                                                                      |
| Kimi Code   | Its `auto` session mode (Never Ask)       | Its `yolo` session mode (Ask When Needed: dangerous commands, sensitive files and the git directory still ask)           | Not offered: Kimi Code edits files in a git project without asking  | Its ACP session mode, set before every turn and live mid-reply; no new process                                     |

A CLI's other modes reach a chat the same ways: Claude Code's Accept edits and
Don't ask as SDK `acceptEdits` and `dontAsk` (Don't ask adds no card of its
own), Grok's as `--permission-mode acceptEdits` and `dontAsk`, and Codex's
Default as `on-request` in the `workspaceWrite` sandbox with the person, not the
reviewer, answering what leaves it.

`kimi acp` takes no permission flag, so a Kimi Code chat is told its level as
one of Kimi's own ACP session modes. Read off Kimi Code 0.42.0's permission
policies, its `yolo` is the Ask When Needed of `kimi --yolo` and its `auto` the
Never Ask of `kimi --auto`, the other way round from the descriptions its ACP
server gives them. Its menu lists the modes its terminal manifest names (Auto,
which is Never Ask, at Bypass, and No flag); Auto runs `yolo` for a caller that
names it. Kimi asks its own questions as permission requests, one option per
answer; the chat shows them as questions, answered from the list or skipped.

Claude's Auto is its own classifier mode, `auto`, as Grok's is, Cursor's its
auto-review and Codex's its auto-review (owner ruling 2026-10-01): someone who
picks Auto expects the CLI's own auto mode. The classifier runs what it judges
safe and turns the rest back to the agent rather than asking. Where an account
or model is not offered it, Claude Code starts in its asking mode; in a chat the requests Auto covers
are still answered without a card. Claude Code pointed at another model endpoint
(Kimi, Z.ai) keeps `acceptEdits` for Auto, since the classifier is not offered
there.

A Codex terminal agent is told the same modes on its command line: Bypass as
`--dangerously-bypass-approvals-and-sandbox`, Auto as `--approve-for-me` (the
workspace sandbox with its auto-review), and Manual as `--ask-for-approval
on-request --sandbox read-only`, where every write and every request for the
network has to ask to leave the sandbox. Codex's command line no longer takes
`untrusted`, which its app-server still does.

Chats on an API-key provider run no tools and have no permission control. Do
not interpret a hidden approval control as a promise that a provider will ask
for permission.

A Claude chat loads only the person's user settings, never the project's, so
the app's MCP gateway is handed to each Claude chat directly rather than read
from the workspace's `.mcp.json`. A scheduled agent's run that carries MCP
servers starts its chat with them the same way: Claude through
the SDK's `mcpServers`, Codex as `mcp_servers` config overrides for that chat's
app-server, and ACP agents through `session/new` (HTTP and SSE servers only
where the agent's handshake says it takes them). A provider that cannot take
the server fails the run and says so, rather than running without it.

ACP filesystem callbacks are confined, verified existing-file operations.
Creating a new file through those callbacks is refused on platforms without
anchored directory operations; provider-owned native edits are a separate CLI
capability. Post-open filesystem checks are defense in depth, not a kernel
sandbox against a malicious process repeatedly replacing directory ancestors.

### Chats on a WSL machine

On Windows, every chat runtime runs on a WSL machine as well as on This PC
(owner ruling 2026-10-01): Claude Code, Codex, Cursor, Grok, Kimi Code and OpenCode alike.
A chat in a workspace on a WSL machine is that distribution's own Studio's
(design-wsl-ssh-direct): its Studio starts the CLI there as a local child
(`cli-host-child.ts`), the same way this PC's Studio starts one here, and the
window reaches it on the Studio protocol. The chat is handed the command set
for that machine in Settings (or the one its PATH finds), and no host id
(`conversationCliRuntimesForHost`): a chat's CLI always runs where the Studio
that runs the chat runs, so no path is respelled between the CLI and its
runtime. Paths are respelled once, between the window and the distribution's
Studio (`shared/machine-spelling.ts`).

## Remote connection over the tailnet

Another machine follows and drives a conversation over Tailscale, and only over
Tailscale: there is no hosted relay in the path, for transcripts, commands,
images or phase changes. The phone companion and another Studio desktop speak
the same Studio protocol, at `/tailnet/v1/studio` on the tailnet listener, as
this machine's own windows do; nothing in it is specific to a phone.

### Trust boundaries

- **Network.** The gateway listens only on this machine's tailnet address
  (loopback in tests). Tailscale authenticates the peer machine; the gateway
  records the peer node it resolved, but does not treat it as authorization.
- **Device.** Authorization is the paired device's bearer token and its scopes.
  The Studio socket is opened with a short-lived single-use ticket, never the
  token in a URL. Browser-originated requests are refused; a paired desktop's
  own window is the one exception, on a ticket that names its origin.
- **Scopes.** `conversation:read` lists, follows and pages conversations and
  fetches tool details and diffs. `conversation:operate` sends, stops, answers
  approvals and questions, attaches images, changes the permission preset and
  switches the model, and implies read. New pairings grant both by default; the pairing surfaces
  list them as their own rows. There is no terminal scope: terminals do not
  cross the tailnet (see "Terminals stay on the machine" below).
  Grants are read live: narrowing a device in Settings refuses its next
  command, removing read ends the chats it follows, and revoking it closes
  every socket it holds.
- **What a remote command can do.** A device with `conversation:operate` drives
  a chat exactly as the host can, preset included: it can send to a chat in
  Bypass, and switch a chat between any of the modes the host runs (all four on
  a host that advertises `conversation-permission-modes`, Bypass and No flag on
  one that does not, which is never sent Manual or Auto). A conversation a
  remote send resumes starts under the preset it was left on. A permanent
  approval rule, which outlives the conversation, it chooses as the host's
  own "Always allow … in this workspace" does (owner ruling 2026-10-25): the
  rule is saved for the chat's workspace here, among this machine's own rules,
  which Settings lists and revokes (`conversation-permanent-approvals`). A
  host without the capability refuses it before the runtime sees it.
- **Starting a chat.** The same grant starts one: `conversation.create` adds a
  chat agent to one of this machine's workspaces, starts its session on the
  named CLI (the launcher's model and preset, else this machine's choice for
  that CLI), and sends the prompt as its first message. It answers once the
  session is up, with the workspace and agent ids a remote pane follows the
  chat by. Like every remote command it is audited.
- **A new chat as New chat here starts one.** A desktop that advertises
  `new-chat-worktree` takes `worktree: true` beside `newChat: true` and starts
  the chat in a worktree of its own, cut exactly as New chat here cuts one with
  Worktree on: from the worktree pool the Studio core keeps, on the
  project's default branch, as `<prefix>/chat-<id>` (the branch prefix from
  Settings ▸ Worktrees, `agent` unless changed) under the project's worktree
  container, and filed under the project it was cut from, so the chat lists here
  as if it had been started here. A project that is not a git repository, or a
  folder on an SSH machine, is refused with `worktree_unavailable` rather than
  started in the checkout. A desktop that advertises `new-chat-effort` takes an
  `effort`, one of the CLI's `reasoningLevels`, refused as `unsupported_effort`
  otherwise. It is kept on the chat's agent record as New chat here keeps its
  effort pick, and every turn, from this machine's chat view or a paired
  device, runs at it where the chat's provider runs that level: Claude Code's
  chat runs all five of its levels and Codex's runs low to xhigh, so Codex's
  `max` and `ultra` run at its default. A CLI that declares no levels (Cursor,
  OpenCode, Grok, Kimi Code) ignores it. A desktop that advertises `cli-runtime-catalog`
  answers each CLI on `cli.runtime.list` with a `catalog`: whether it can run as
  a chat (`conversational`), its provider line (`providerLabel`, naming the CLI
  a hosted runtime rides), and `models`, the rows this machine's model picker
  offers — the CLI's reported list (its manifest seed until it has reported),
  then the ids added in Settings — each with the `family` row it renders under,
  its window (`contextLabel`, `1M` or `Standard`), whether it is the id the row
  selects (`familyDefault`), and `isNew` where the picker shows New. The model
  favourites are this machine's window's own and do not travel.
- **Answering a plan.** A desktop that advertises `conversation-plans` takes
  `resolvePlan` (`approve` or `reject`) for a plan the agent proposed, and
  refuses it for a request that is not a plan, before the provider sees it.
  A plan answered as a `resolveApproval` (`once` carries it out, `deny` sends
  the agent back to planning), as every client did before, is still taken.
- **A CLI's own modes.** A desktop that advertises
  `conversation-cli-permission-modes` lists the CLI's own mode a chat runs at
  its preset (Claude Code's Accept edits) and the modes its provider runs, and
  takes a `permissionMode` beside the preset on `setPermissionPreset`. A
  resume keeps the mode the chat was left on. A desktop without it drops the
  member and runs the preset's own mode, never a looser one.
- **Switching a chat's model.** A desktop that advertises the
  `conversation-models` capability (owner ruling 2026-09-27) lists each chat's
  CLI and the models this machine's own picker offers for it — the CLI's
  reported catalog (its manifest seed until it has reported) and the ids added
  in Settings — and takes a `setModel` command naming one of them, or the CLI's
  own default. The switch stays within the chat's CLI: an id outside the
  catalog is refused with `unsupported_model` before the runtime sees it, and
  a provider that binds a session to its model refuses it as well. The switch
  runs through the same runtime path as a switch made here, a chat with no live
  session is resumed to take it, and a switch made while a turn is running is
  accepted with a notice that the new model applies from the next turn. This
  machine's own chat view follows a switch made from a paired device.
- **Audit.** Every remote command — refused ones included — is written to the
  gateway audit with the device, the conversation, the command kind, the command
  id and the outcome. Message text and answers are never written there.
- **What leaves the machine.** A followed chat carries its transcript, tool
  output previews, tool details and diffs, with secret-looking keys redacted.
  Paths are sent as they are on this machine; a quote in a message is sent as
  the token the chat keeps, and every current client draws it.
- **Pictures and files on a send.** A client stages each on its own socket
  (`uploads.begin`, then `uploads.append` a piece at a time), under an id only
  that client can spend, and the keyed `conversation.send` names them in
  `uploadIds`, spent once per command id: a send retried under its id names the
  same pictures again without staging them twice. A picture is PNG, JPEG, WebP
  or GIF, at most 5 MB as it came (the Studio keeps it as sent; a phone sizes
  its own photos), and goes with the turn as a picture a person attached here
  does. A file (`purpose: 'attachment'`) is any type, named, at most 25 MB: it
  is written into Studio's data folder, `tailnet-uploads/<client>/<upload>/<name>`
  under its name made one safe path segment, never into the project, and
  attached to the message by that path, as a file dropped into the composer
  is; the `user_message` records it in `files`. The file stays for the agent to
  read in a later turn, and goes a week on, or with the device when it is
  removed. A staged upload no send spends expires.
- **Pictures a chat shows.** `conversation.picture` (`conversation:read`)
  answers one picture's bytes: a step's, by its `toolUseId` (the picture
  Codex's `GenerateImage` made, or a file read of a picture), or one a person
  sent with a message, by the `ref` its `user_message` recorded. The chat's own
  record names the file, never the request: a step's file is followed through
  links to a regular file inside the chat's folders or Studio's picture folders,
  and a sent picture comes only from the folder the attachment store keeps for
  that chat. Either is served only when its first bytes are a PNG, JPEG, WebP or
  GIF, under the type they say, at most 8 MB (`too_large`); anything else, a
  chat this machine does not have, or a step that shows no picture is
  `not_found`.

### Sync

A subscription receives its replay — a bounded snapshot, or only the missed
events — then a `synchronized` fence, then live events. A client resumes with
the last sequence it holds and the log `generation` from the snapshot or fence
it came from; when the desktop can vouch for that cursor it sends only the
missed events and no snapshot. Another generation (the log was recreated), a
cursor ahead of the log, or one too far behind gets a reset snapshot instead.
Sequence numbers increase but have gaps, because a run of text deltas can be
merged into one delta numbered with its last sequence. Older turns page in
through `loadEarlier`. Command ids stay stable across retries, so a send
acknowledged before a disconnect is not accepted twice.

What crosses is a projection of the log, the same on every wire (the window's
IPC, the Studio protocol), made in one place
(`src/server/conversation-stream-shaping.ts`); the stored events stay whole. A
tool's result crosses once, as its preview of at most 4,000 characters; a
tool's input crosses with its file-change bodies cut to their heads, marked
`inputTruncated` (a command, a plan, a todo list cross whole: the closed row
draws them); a step's pictures as at most eight paths. A reader opening such
a step reads the whole of it with `toolDetail`, and draws a cut change only
from that. A snapshot, and each earlier page, is the newest of those
projected events within 2 MiB, cut where a turn begins unless the newest
turn alone is larger; older ones are one `loadEarlier` away. A reconnect
further behind than 2 MiB of the log gets a snapshot rather than its
catch-up, so a replay is bounded the same way, and a snapshot a session sends
after its join (once a chat's server is back) is paced and split like a
join's. The module SDK's conversation stream is not a reader's wire: a
module reads events whole.
No event takes more than one frame (`CONVERSATION_WIRE_EVENT_BYTES`): one
larger as stored (a long answer, a pasted log, a large approval) crosses with
its longest text cut to fit and `wireClipped: true`, and a reader reads it
whole by the `seq` and `id` it came under (`conversation.event` on the Studio
protocol, `conversation:event:read` over IPC). The chat
view and the phone say when part of a chat came cut short and offer it in
full.

A reader that falls behind gets consecutive deltas merged instead of queued;
a large snapshot is sent in parts and never counts against live events. A
reader that stops reading is told to resync with a retry delay that grows while
it keeps falling behind. Requests beyond the per-socket bound are answered
`busy`, and responses over 32 MB are answered `too_large`; neither closes the
socket. Every refusal is answered under the id of what it refuses.

Every snapshot and fence names the conversation it belongs to. When a socket
switches conversations, the old replay stops at the next whole frame and never
sends its fence, and a client ignores frames for a conversation it no longer
follows. Live events that arrive while a replay is still going out wait behind
it, bounded by size rather than count, so a busy turn during a large catch-up
does not force a resync before the fence.

### Commands and the chat's log

A send, an answer to a request, a permission or model change, Stop and ending
a session reach the same runtime method from any client (this window, the
Studio protocol, a paired device or the phone, an agent's MCP tool, a module, a
schedule, a pull-request wake), which runs each as a command under the
caller's `commandId`, or one made for a caller that gave none
(`ConversationRuntime.runCommand`). Revert, rewind, fork, handoff, stopping
one sub-agent and side questions are not commands of this kind yet: the hosts
that take them remember their ids in memory. The chat's transcript is its one
log: beside the events it holds each command's receipt, a line with no `type`
that every reader passes over (`conversation-command-receipts.ts`).

- **A turn command** (a send, a steer, a message to one sub-agent) is
  _accepted_ when its `user_message` and its receipt are committed in one
  write. The provider turn is what it then does. The send is _answered_ when
  that turn ends, as the protocol promises, and the answer is written to the
  log too. The turn is the command's effect, and the chat is listed in the
  data directory's `conversation-outbox.json` before its message commits; if
  Studio stops before the turn ends, the next start closes every listed chat's
  open turn as interrupted, in its log, without anyone opening the chat
  (`recoverInterruptedTurns`; on a WSL or SSH machine, the next start of that
  machine's server, which keeps its own list). The list is an aid: one that
  cannot be written leaves the turn to be closed when its chat is next opened. A retry under the same id is answered as sent:
  the message is in the chat, so it is never sent twice.
- **A control command** (an answer to a request, a permission or model
  change, Stop, ending the session) acts on the live agent process and is
  answered with what that did, once the answer's receipt is written. If Studio
  stops first, what it did went with the process; a retry acts again on the
  chat as it is then.
- **A scheduled agent's run** is written down before it makes anything: an
  entry of `scheduled-agents.json`'s `runs`, keyed by the command id its first
  message goes under, with that message, and the chat once it is made. The
  chat is stamped with the same id (`launchCommandId`). The entry goes once
  the first message is answered. A start that finds one left by a stop
  finishes it: a run with a chat sends its first message again under its id
  (the chat's receipt answers one that already went, so nothing runs twice);
  a run that made no chat sent nothing, so a one-time schedule runs once now
  and a repeating one is recorded as cut off and waits for its next time
  (`scheduled-agents/run-recovery.ts`).
- **Where background work runs.** Every Studio server runs its own schedules
  and pull request watches, with its scheduled messages and usage-limit
  resumes: the desktop's (in process or out), a standalone server, a WSL
  distribution's and an SSH machine's (`server/core/studio-scheduled-agents.ts`,
  composed by `createStudioCore`). A schedule runs on the server whose store
  holds it, in its chats, from its worktree pool. Where a module kernel runs,
  the person's Scheduled agents switch turns the scheduler on and off
  (`modules/scheduled-agents-switch.ts`). A watch an agent asks for is kept by
  the server its gateway belongs to; where that server holds no record of the
  chat (a WSL or SSH server, whose chat records the desktop keeps), the folder
  the chat works in is kept with the watch (`pull-requests/chat-folders.json`),
  so its wake reaches the chat after a restart.
- **Nothing stops silently.** Each server answers `environment.readiness`:
  its CLIs (installed, signed in where it can tell), `gh`, MCP servers,
  extensions, and every schedule or watch waiting on something it lacks. A
  schedule whose CLI is not installed or signed in there, whose MCP server is
  not set up or switched off, whose skill is unknown, or whose extension is
  not loaded, waits: its times pass without a run or a failure, its row says
  "Waiting: …", and Run now says why. A watch whose read fails for want of
  `gh` (not installed, or not signed in) holds, says so, and does not count
  toward the eight-failures stop. Keys and sign-ins are never copied between
  machines on their own: the person signs in there. A detached server (an SSH
  machine's) does not stop for being idle while it has such work, nor does
  the desktop stop a WSL server for it; the desktop's quit question names the
  schedules and watches its quit stops, its WSL servers' included.
- A send refused `busy` (a turn running, or the chat's folder held), or one
  the log could not take, records nothing, so the same id may be sent again.
  The same id for a different command (by its fingerprint, which counts what
  a send carries but not the upload ids it was staged under) is refused
  `command_id_conflict`.
- **A resend never runs a turn twice.** A send's receipt is looked up in the
  chat's log before its pictures and files are needed. A send to a session
  its server no longer holds (it restarted) is answered "session not found"
  and spends nothing; the client starts the chat again and resends under the
  same id, which the receipt answers. A keyed send asks the conversation host
  whether it was held or carried out before its uploads are staged.
- A launched chat's first message is written down
  (`conversation-first-messages.json`) before the launch answers, under an id
  derived from the launch's, and sent at the next start if a stop cut it off.
- **Nothing is published before it is written.** A batch of the log is one
  write, and a write that fails is cut back off, so a client only ever holds
  sequence numbers that are on disk. A write that does not finish is waited
  for, not given up on (the log warns after 30 seconds): what it holds may yet
  land. An event of a turn the log cannot take stops the chat's session, its
  agent with it, and the turn is closed as interrupted when the chat is next
  resumed. A send whose message the log cannot take is answered "not sent" and
  nothing else happens.

### The protocol

`@sprintengine/conversation-protocol` (`packages/conversation-protocol`) is the
one contract every follower of a conversation speaks (owner ruling
2026-10-01): the Studio protocol, the module SDK's conversation service, and the
desktop's own chat view, which imports its event types from it through
`src/shared/conversation-runtime.ts`. Its README is the frame reference. It
declares:

- **Events, in two layers.** Each provider adapter reads its CLI's own stream
  and writes `ConversationEvent`s in a vocabulary no provider owns
  (`CONVERSATION_EVENT_TYPES`); the provider's shapes stay in the adapter.
  Everything above, the Studio protocol included, carries only that second layer.
- **Commands and answers.** Every mutation carries the client's `commandId`,
  and the runtime keeps a receipt for it in the chat's log, so a retry is
  answered from the first attempt and never runs twice (see "Commands and the
  chat's log" below). A tool permission is
  answered `once`, `conversation` or `deny`, a question with its answers, a
  plan with `approve` or `reject`, and each answer can name the kind it is for.
  A tool permission may also be answered `always` where the host advertises
  `conversation-permanent-approvals`: the rule is saved here, for the chat's
  workspace, as this machine's own "Always allow" saves one.
- **Capabilities and a version.** The Studio welcome carries the conversation
  protocol version (1), its minimum, and the conversation capabilities this
  machine serves. Features are asked about by capability,
  never by version; the version exists to refuse a peer a change could not be
  made additive for, naming both numbers.
- **Create requests.** `ConversationCreateRequest`, with `allowedTools` beside
  the preset, which the module SDK and the Studio protocol's
  `conversation.create` take.

The package entry is `public.ts`. The phone imports it from this repository's
source, as the desktop does, so both build against the same files; a phone
already installed keeps the contract it was built with, which is what the
capabilities above are for. Building this branch does not publish the
package.

Phase changes reach a client while its socket is open, and every client hears
a `conversations.changed` push when the conversation list moved — a conversation
started, finished, or began waiting on a person — so a list re-reads on the
change rather than on a timer. Background push notifications are not provided. A conversation deep link is
`sprintengine://conversation/<deviceId>/<workspaceId>/<agentId>` (each component
URL-encoded); it resolves only against an already paired desktop.

### Machines and pull requests in the list

Two optional members on each row of the `sessions` answer to `list`, and one
on `GET /tailnet/v1/identity`, tell a paired phone which machine a chat runs
on and what has come of its work. All three are additive with no capability:
a desktop built before them sends none, an older phone ignores them, and a
client tells the two cases apart by the member being absent.

```ts
// On each listed chat (ConversationThread, packages/conversation-protocol/src/serverFrames.ts)
host?: { id: string; kind: string; label: string; color: string }
pullRequests?: Array<{ number: number; state: 'open' | 'merged' | 'closed'; url: string; title: string }>

// On GET /tailnet/v1/identity, beside deviceId, scopes and the rest
machine?: { kind: string; color: string }
```

- **`host.id`** is the machine's stable id, the one every device keys its mark
  by (`src/shared/machine-identity.ts`): `local` for the desktop answering,
  `wsl:<distro>` for one of its WSL distributions, `ssh:<host>` for an SSH
  machine (the host its SSH config resolves to, with `:<port>` when that is
  not 22), `tailnet:<short host>` for a chat born on a paired machine (an
  address, or a name typed with a full stop in it, stays whole). A client
  draws no machine mark for `local`.
- **`host.kind`** is one of `laptop`, `desktop`, `mini`, `tower`, `server`,
  `cloud`, `container`, `board` or `wsl`, and **`host.color`** one of `blue`,
  `teal`, `cyan`, `orange`, `yellow`, `violet`, `red` or `neutral`: the
  person's choice in Settings › Machines, else the defaults. A client draws a
  kind or colour it does not know as its fallback rather than dropping the
  machine. **`host.label`** is the name to show: `WSL: Ubuntu`, the SSH
  machine's label, the paired machine's name, or this machine's host name.
- A row whose machine cannot be named yet carries no `host` rather than a
  colour that would change once it is known: an SSH machine's host is read
  from the SSH machines Electron main holds, so a desktop serving from an
  out-of-process server leaves those rows unmarked.
- **`pullRequests`** is what the desktop's pull request record holds for the
  chat (`pullRequests.list`), at most `CONVERSATION_MAX_PULL_REQUESTS` (20),
  and an empty list when it holds none. It is read from the record only:
  listing never runs `gh`, so a phone refreshing its list costs no request to
  GitHub. The record is kept current when a chat's turn ends and on its slow
  poll, and `conversations.changed` says when the list moved.
- **`localServers`** (2026-10-25) is what the desktop's local server record
  holds for the chat (`localServers.list`): each server its agents linked
  (`id`, `url`, `title`, `port`, and `state`: `running`, `stopped` or
  `starting`, as the desktop's own checks last found it), at most
  `CONVERSATION_MAX_LOCAL_SERVERS` (20), and absent for a chat with none. The
  command and folder that start one stay on the desktop. A server starting or
  stopping is a `conversations.changed` push. A second desktop following the chat
  draws them on its strip as that machine's, read-only: one whose address
  reaches it (a tailnet name, the machine's own address) opens there, and one
  on that machine's loopback says it is on that machine, its link still to
  copy.
- **`machine`** is how the phone draws the desktop itself: the kind and colour
  a second desktop gives it by default when it pairs by this machine's host
  name, with any override kept under `local` in the launch settings'
  `machineMarks` applied. A `host` of `local` on a listed chat carries the same
  pair.

### Rest, order and read state in the list

The desktop is the one owner of whether a chat is settled and of whether its
latest finish has been seen, and every client — the phone, another desktop,
the desktop's own sidebar — agrees with it. A desktop that advertises
`conversation-lifecycle` (owner report 2026-10-05) answers `list` this way:

- **Settled chats are not listed.** The sidebar draws no row for a chat whose
  record has `settledAt`, so no list does either. `workspace.list` items carry
  `settledAt` (null while the chat is in the list), so a paired desktop's
  browse leaves those workspaces out too.
- **The order is the sidebar's.** Most recently written to first, by the
  person's last message from any device (`lastUserMessageAt`), falling back,
  for a chat nobody has written to, to the latest of when it was made and when
  it was last typed into. Never by what an agent is doing: a finishing or
  waiting agent recolours its row, it does not move it. A message a paired
  device sends moves the desktop's own clock, so the sidebar and every list
  agree.
- **Five optional members on each row**, beside the agent's name in `title`,
  which older clients keep reading:

  ```ts
  chatTitle?: string          // the chat's title as the desktop's sidebar shows it
  lastUserMessageAt?: number  // when a person last sent it a message, from any device
  lastTurnEndedAt?: number    // when its agent last finished a turn, or failed one
  lastVisitedAt?: number      // when a person last had it on screen, on any device
  visitRewoundAt?: number     // when it was last marked unread, on any device
  ```

  `lastTurnEndedAt` is read from the chat's transcript (the thread index keeps
  it, and a session running now reads it off the same events), so a rename, a
  model switch or a session starting does not move it, and it is there for
  every chat whose agent has finished a turn, including turns that ended
  before it was kept. A chat whose `lastTurnEndedAt` is later than its
  `lastVisitedAt` has a finish nobody has seen. Nothing recorded visits before
  this, so the first launch of a desktop that does counts every chat it
  already had as seen at that moment, once; a chat made since starts with its
  own creation as its visit.

The first two are the capability's promise and hold only where it is
advertised. The Studio RPC advertises it too, and its `conversation.list` is
the same list. The phone and a paired desktop settle, visit, mark unread and
snooze a chat through the Studio protocol, by the chat's workspace
(`conversation.settle` `{ workspaceId, commandId, settled? }`,
`conversation.visit` `{ workspaceId, visitedAt? }`, and `chat-lifecycle`
below); the gateway tools of the same purpose, described here, are an
agent's, and a device token asking for one is told to use the Studio's.
Every change on the protocol carries a command id: a retry is answered with
the first answer and written once, so a settle retried after an Undo does not
settle the chat again.

- **`conversation.settle`** `{ workspaceId, settled? }` (default `true`)
  writes the same patch as the row menu's Settle, or with `false` its
  Un-settle, and answers `{ ok: true, workspaceId, settledAt }` (`null` when
  the chat is in the list). It is refused as `working` while anything in the
  chat would be cut short — a turn starting, running or waiting on a person,
  an agent it launched still working in the background, or one of its agent
  terminals mid-turn — and `unknown_workspace` for a chat the desktop does not
  have; settling a settled chat again changes nothing. The desktop then does
  what its own Settle does: the chat's agents stop, and a window that has it
  in front moves on to the next chat.
- **`conversation.visit`** `{ workspaceId, visitedAt? }` moves the chat's
  `lastVisitedAt` forward to `visitedAt` (now when omitted, and never past the
  desktop's now) and answers `{ ok: true, workspaceId, lastVisitedAt }`. A
  `visitedAt` no later than the chat's `visitRewoundAt` is a reading taken
  before its last Mark unread and changes nothing. A desktop following a paired
  machine's chat sends no `visitedAt`, so that machine stamps the visit by its
  own clock. Like the other lifecycle tools it needs `conversation:operate`,
  but it is kept out of the gateway audit, allowed or refused: a device stamps
  one every few seconds while a chat is on screen. It is
  not activity: the chat keeps its place and a settled one stays settled. The
  desktop stamps its own windows' visits the same way: at once when the chat
  in front has an unseen finish, otherwise at most every ten seconds while it
  stays in front of a visible, focused window. A visit from elsewhere clears
  the desktop's own "finished while you were away" mark too. New chat
  covering a window's chat counts as nobody looking at it, as a door does,
  so it is not stamped; unlike a door it is not leaving the chat, whose "New"
  divider holds and whose Mark unread waits until the person moves on. A
  desktop following a paired machine's chat draws the same "New" divider,
  read from that machine's `lastVisitedAt` as its list gave it before the
  opening's first visit.
- **`conversation.mark_unread`** `{ workspaceId }` (2026-10-07;
  `conversation.markUnread` on the Studio protocol) moves the chat's `lastVisitedAt`
  **back**, to its latest finish less a millisecond, and answers
  `{ ok: true, workspaceId, lastVisitedAt }`. Its finish reads as unseen again
  on every device, and the next opening's "New" divider sits above its latest
  reply. A chat already unread from further back keeps its clock; one whose
  agent has finished nothing is refused as `nothing_finished`. The finish is
  read as the list reads it, transcripts included, so a chat the list shows
  finished can be marked after a restart too. It is the one
  write that moves the visit clock back: the record stamps `visitRewoundAt`
  beside it, and the desktop's windows and its registry take an earlier
  `lastVisitedAt` only with a newer stamp, so a lagging visit still cannot
  roll the clock back. The desktop's own row menu calls the same command; on
  the chat in front it takes effect as the person leaves the chat, since
  looking at it is what reads it.

A `conversations.changed` push says the conversation list moved when a chat is settled or
brought back, renamed, or written to, marked unread, and for a visit when it
is the first since the chat's agent finished (the visits stamped while a chat
stays on screen are not a push each). A change to the record's clocks alone
(a visit, a Mark unread, a keystroke, a message, a turn's end) does not say
the workspace list moved, since `workspace.list` carries none of them.

`lastVisitedAt` going back is new with `conversation.mark_unread`, and a
client from before it reads it as it reads any visit clock: as of 2026-10-07
the phone takes the later of the listed clock and its own opening of the chat
(and of a visit it stamped itself this run), so it shows such a chat read
until the list says otherwise, never anything wrong. A phone that offers Mark
unread asks for `conversation-lifecycle` first and drops its own later readings
once the list carries an earlier clock. Which readings to drop is what
`visitRewoundAt` says: a reading taken before it is older than the Mark
unread, so the listed `lastVisitedAt` wins over it, and a reading taken after
it (the person opened the chat since) still stands. A chat marked unread
while the phone was closed is found that way on the next list. Only Mark
unread writes the stamp; the desktop refuses it in any other patch.

All three tools need `conversation:operate` and are audited, like
`conversation.create`. A paired desktop's Remote rows use all of it: they are
titled with `chatTitle`, ordered by `lastUserMessageAt` (else `updatedAt`),
offer Settle from their menu on a desktop with the capability, and say a chat
opened here was visited there. A chat opened here offers Settle in its row menu
too: the other desktop is asked, and once it has settled the chat the row here
goes the way a local Settle takes a row. One that machine settles without
asking here (on the phone, or on that machine) is followed once its browse says
so, and the row here leaves the rail the same way.

A paired desktop's row menu on one of a desktop's chats (2026-10-21) is the
menu a local chat has, each item written there, to the record the desktop's
own menu writes, through that desktop's Studio (`chat-lifecycle`; the
agents' gateway tools of the same names take the same arguments without a
command id): **`conversation.highlight`** `{ workspaceId, commandId, starred?,
color? }` is Star and
Highlight color (one of `CONVERSATION_HIGHLIGHT_COLORS`, or `null` for none;
a member left out stays as it is, and a chat left with neither has no
highlight); **`conversation.snooze`** `{ workspaceId, commandId, until }` is Snooze, until
a time still ahead, and with `until: null` Wake now (refused `conflict` while an
agent there works and for a settled chat, and the desktop pauses the
chat's processes as its own Snooze does); **`conversation.setAutoSettle`**
`{ workspaceId, commandId, enabled }` is the Auto-settle switch. Each listed chat says
what they wrote: `highlight` (`{ starred, color? }`) and `autoSettle: true`,
beside the `snoozedUntil` it already carried, and a change to any of them
moves the list. All three need `conversation:operate` and are audited. The
paired desktop draws the chat as that machine does: starred in its Starred
section, tinted with its colour, asleep in its project's Snoozed shelf until
it wakes. Mark unread is `conversation.markUnread` above. Copy link to chat links the chat by its
address on that machine (`sprintengine://chat/<environmentId>/<chatId>`), which
opens it there and on any device that follows it, and is offered once that
machine has said its environment id;
Move to New Window opens it in a window of its own. New chat in project, on
a chat whether a window there has it open or not and on the project's own
header, opens that desktop's New chat on this machine and the project the
chat stands in, where the pairing may start a chat here
(`conversation:operate`); the chat is started with `conversation.create` as
any New chat on a paired machine is. Reveal folder and Close workspace are
about a workspace on the desktop doing the asking, and are not offered for a
chat no window there has open. A machine whose Studio does not serve
`chat-lifecycle` (an older build) offers none of the four, and is asked to
update.

**`conversation.change_project`** `{ folder, workspaceId? }` (2026-11-08)
moves a chat to another folder on its machine, and so to the project that
folder is in. It is for a chat's own agent: one started with no project that
made one, or whose work moved to a folder of its own, leaves out
`workspaceId` and names the folder. A chat's project is read off its folder,
so the move is a change of `folderPath`; the chat's sessions end, its store
folder (`conversations/<chat>`) goes to the new project's store, and its next
turn starts the agent in the new folder, resuming the same session. A Claude
Code session file is copied to the folder the CLI keeps for the new cwd when
the chat resumes there. Asked mid-turn of the asking agent's own chat, the
move waits for that turn to complete and answers `movesWhenTurnEnds: true`;
it is let go on the signs a settle waiting on a turn is let go on. It answers
`{ ok: true, workspaceId, folderPath, project }`, and is refused as
`not_movable` for a worktree chat (the pool keeps its folder) and for a chat
on another machine, as `working` while another agent there works, and as
`not_a_folder` for a path that is not one. It needs `conversation:operate` and
is audited. Nothing new crosses the wire: a paired device lists the chat under
its new project from `workspace.list`, which the folder change moves, and its
next message to the chat starts the session in the new folder there.

Beyond its marks, a paired desktop or the phone manages a chat here as it
manages one of its own, each part a method of this desktop's Studio
(`chat-lifecycle`, 2026-10-25, on the protocol since 2026-11-13), by the
chat's workspace, every change under a command id and answered once:

- **`conversation.rename`** `{ workspaceId, commandId, name }` names the chat
  as the desktop's own Rename does: locked against the titler, so its
  messages never rename it again, and stamped now. Every device lists it by
  the new name (`chatTitle`), and a paired desktop's row opened from the chat
  takes it too. A name of 1 to 500 characters; the name it already has
  changes nothing. Offered on a chat no window there has open as well as on
  one it does.
- **`conversation.setAutoCompact`** `{ workspaceId, commandId, enabled }` is
  the chat's Auto compact switch, as the desktop's own menu sets it: the
  chat's choice from then on, whatever the desktop's default says. The desktop
  compacts its own chats, so the rule is the one of the machine the chat runs
  on, and each listed chat says how it stands as `autoCompact` (its own
  switch, or the desktop's default where it left that unset), read beside its
  `providerId`: only a Claude chat compacts by itself yet. A switch moves the
  list. It compacts nothing at once.
- **`pullRequests.unwatch`** `{ conversation: { workspaceId, agentId }, url }`
  (`pull-request-watch`, on `conversation:operate`) is Stop watching: the
  desktop stops watching the chat's pull request at `url`, and the chat is not
  woken for it again. The pull request stays the chat's. It answers
  `{ watched }`, false for one that was not watched. Each listed pull request says while it is watched
  as `watch` (what it waits on, as the desktop's own strip says it), so a
  paired desktop's strip and menus say it too and offer Stop watching where
  the desktop's own do.
- **`conversation.deletePlan`** `{ workspaceId }` and
  **`conversation.delete`** `{ workspaceId, commandId }` are Delete on a
  settled chat, as the desktop's own Delete runs it: the plan says what would
  go, each worktree the chat owns by its name and branch (never a path), with
  `refused` while the chat is not settled or an agent in it works; the delete
  takes its history, its record and the worktree it owns, never one with
  uncommitted changes, and keeps the branch, and is refused `conflict` where
  the plan says why not. There is no undo. A chat already gone answers
  `gone: true` to both, so a delete sent twice does no harm. The plan is a
  read on `conversation:read`; the delete needs `conversation:operate` and is
  audited. A paired desktop offers Delete on a settled chat it opened from
  here, asks the plan, says it in its confirmation, and once this desktop has
  deleted the chat removes its own record of it.
- **`conversation.searchChats`** `{ query }` finds what was said in the
  desktop's chats as its own palette does: the chats its sidebar lists, most
  recently spoken in first, each through the runtime's transcript search. It
  answers `{ chats: [{ workspaceId, chatTitle, hits, count }], truncated }`,
  each hit an `agentId`, the `seq` of its message, a `snippet` and who said it
  (`from`), at most 50 chats and 20 hits each, and `truncated` once it stopped
  early, at that limit or after eight seconds. A query is 2 to 200
  characters. It is a read, on `conversation:read`. A paired desktop's palette
  asks each machine that serves it beside its own search, lists one row per
  chat with the machine's name, and opens a row as the chat's sidebar row
  opens it, landing on the matching message as a match in one of its own
  chats does.
- **`conversation.approvalRules`** `{}` and
  **`conversation.revokeApprovalRule`** `{ commandId, ruleId }`
  (`approval-rules`) are the "always allow" rules the desktop's chats run
  with, as its Settings ▸ Chats lists and revokes them: each rule by its
  `id`, `label`, `toolName`, `toolKind`, the folder it holds in and
  `createdAt`. A paired desktop shows the folder by its name. A rule already
  gone changes nothing when revoked. The list is a read on
  `conversation:read`; a revoke needs `conversation:operate` (it only makes
  the chats ask again) and is audited. A paired desktop's Settings lists each
  machine's rules under its name, beside its own, since a chat followed from
  there asks that machine's rules, and says so for a machine that does not
  share them.

On a desktop that advertises `chat-create-pull-request` (2026-10-18), a
paired desktop's Create PR runs there too, in the chat's own checkout:
**`conversation.pull_request_state`** `{ workspaceId, agentId }` answers
whether it is ready, as the strip asks a local chat's (`gitRoot` is always
null: no path of that machine's crosses); **`conversation.pull_request_draft`**
`{ workspaceId, agentId, draftId? }` writes the title and description with that
machine's text generation settings, refused `text_generation_off` where they
are off (`conversation.pull_request_draft_cancel` stops one by its id);
**`conversation.pull_request_push`** and **`conversation.pull_request_create`**
take the `pin` the state answered and are refused once the checkout has moved
off it. A creation's `kind` is the local one's, and a `created` pull request
is recorded there as the chat's, with `recorded` saying whether that landed.
The state is a read on `conversation:read`; the other four need
`conversation:operate` and are audited.

### Following from another desktop

A Studio desktop paired to this one follows its conversations with the same
pairing and grant a phone uses. The sidebar's
Remote band lists each chat on the paired machine as its own row, with the
presence its phase says: running, needs approval, or done. Opening one makes a
solo workspace whose pane is the regular chat view, following the conversation
over the tailnet, with the machine on the tab and above the transcript.
New chat starts one there too: with Chat agent picked, the machine dropdown
offers the paired machines, and launching on one asks it to start the chat in
the chosen project and opens that same pane on it. Attached images go with
the first message: the chat is started without its words, and the words are
then sent with the images, which go up on the same connection first
(`uploads.*`), as a message to a followed chat's do. That chat reads them
exactly as one started there would. A first message that does not go (a CLI
whose chat reads no images, say) is refused with the reason, and the empty
chat it left behind is settled. Skills and attached files are this
machine's and do not travel yet; the launcher says so rather than dropping
them. A paired machine's WSL distributions and SSH machines are not offered:
each is reached only from the desktop that holds it.

- **The window follows on its own connection** (2026-11-14). The pane reads
  and drives the chat over this window's own client of that machine's Studio
  (`pairedChat.ts`, on the route `tailnet:<pairing>`), the client the Remote
  band reads that machine's list on. Main follows nothing and keeps no copy.
  The view holds the transcript with its cursor (log generation and last
  sequence), and after a dropped link the client resumes the stream from that
  cursor; another generation, or a cursor too far behind, comes back as a
  reset snapshot that replaces what the view held. A window lets its
  connection go after five idle minutes, and forgetting the machine closes it.
- **Every frame is read against the protocol** before the view sees it. A
  frame of a known type in the wrong shape drops the connection, which then
  resumes from the cursor, since skipping an event and moving the cursor past
  it would lose it. A frame type the client does not know is a newer Studio's,
  and is skipped.
- **The link follows the client runtime's rules**, the ones every Studio
  client keeps: a retry backs off and never comes sooner than the delay the
  machine names, `busy` is retried after its delay under the same command id,
  a wake pings a live connection instead of closing it, and a revoked pairing
  parks the connection rather than retrying.
- **What the view offers is what the grant and the machine's welcome allow.** A pairing
  without `conversation:operate` sees the conversation with the composer,
  approvals and stop closed. A remote view offers a permanent approval rule
  only where the machine saves one (`conversation-permanent-approvals`), the
  remember menu's "Always allow … in this workspace" naming that machine's
  workspace; and never a checkpoint revert, or this machine's skills and files: what its
  composer offers of skills, mentions and commands is that machine's (below).
  Images it
  does offer, where the machine lists the chat as taking them: each goes up on
  the window's connection first (`uploads.*`), as the phone's do, and the send
  names them. It
  offers the same two-preset switcher a local chat does, reading the preset the
  machine's list names; a desktop built before the list carried the preset
  leaves the switcher hidden rather than guessing. Its engine chip is the same
  picker a local chat has, locked to the chat's CLI and listing the models the
  machine's own catalog names; a machine that does not advertise
  `conversation-models` keeps the chip on the model the chat is on. File paths in a
  remote transcript are not links, since they name files on the other disk. A
  send is answered when its turn ends, as on the desktop itself, and a send in
  flight across a reconnect is sent again under the same command id and
  accepted once.
- **A queued message is the other machine's to send** (owner report
  2026-10-08). A message typed while the chat's turn runs is handed at once to
  the machine the chat runs on, where it advertises
  `conversation-queued-sends`: that machine holds it among its scheduled
  messages, shows it in the chat's own tray, and sends it when the turn ends,
  whether or not this machine is still awake. The pane draws the rows from
  what that machine says it holds (the `conversation.queued` topic); Edit takes
  it back from there. Where that machine takes a steer, the row's Send now
  (and Primary+Enter with nothing typed) takes the message back and steers it
  into the running turn (2026-10-24); elsewhere it is Stop and send, which
  stops the turn and lets the message go.
  Several queued in one turn go as one message, as the composer's own queue
  sends them. A machine without the capability, or one that refuses to hold a
  message, leaves it queued in this pane, which sends it when the turn ends
  only while this machine is awake, as every queued message was before.
  Where the machine also advertises `conversation-queued-attachments`
  (2026-10-25), a message with images, files, skills or mentions is handed
  over whole: main uploads its images and files first, as for a send now, and
  the machine copies the pictures to its own disk and keeps the files while it
  holds the message, so nothing of it waits here once Enter is pressed (owner
  ruling 2026-10-25). The held row counts what it carries ("1 picture, 1
  skill"). Edit brings back its words, skills and mentions; its pictures and
  files are the other machine's copies and do not come back, which the row's
  tooltip and the line after Edit say. Send now on a held message carrying
  pictures or files stops the turn instead of taking it back to steer, so it
  goes whole from there. A machine that holds words only is handed words only:
  a message carrying more waits in this pane, as before.
- **A message can steer the turn over there** (2026-10-14). Where the machine
  advertises `conversation-steer-sends` and lists the chat's provider as taking
  a message mid-turn (`capabilities.steer`), the composer's Steer, chosen in
  Settings ▸ Agents or by Primary+Enter for one message, sends with `steer`,
  and the message goes into the running turn there. A turn that cannot take it
  then (a request it waits on, a turn that ended on the way) has that machine
  hold it as a queued message, and the pane shows it among the held rows. A
  machine without the capability is never sent a steer: the composer offers
  only Queue, and Primary+Enter stops the turn and sends after, as before.
- **An agent over there has its own Stop** (2026-10-24). Where the machine
  advertises `conversation-stop-subagent` and lists the chat's provider as
  able (`capabilities.stopSubagent`), each running agent's card and lane
  offers "Stop this agent", as a local chat's do, and it stops that agent
  alone over there. The machine's turn Stop spares a Claude chat's agents, so
  this is how one is stopped from here.
- **Handoff works over there too** (owner report 2026-10-25). Where the
  machine advertises `conversation-handoff` and lists the chat's provider as
  able (`capabilities.handoff`), a cold chat's cache notice leads with
  Handoff, as a local chat's does, and the machine hands the chat off: the
  file of its messages is written on that machine, beside the transcript, and
  the next message from either machine starts the new session there. A repeat
  of the same command after a dropped connection is the same handoff. A
  machine without the capability offers Compact alone.
- **Edit from here and Revert work over there too** (owner report
  2026-10-25). Where the machine advertises `conversation-rewind` and lists
  the chat's provider as able (`capabilities.rewind`), each message offers
  Edit from here, as a local chat's does: the chat goes back over there and
  the message returns to this composer. Where it advertises
  `conversation-checkpoint-revert`, a turn with a checkpoint offers Revert to
  before this turn and Undo revert, and Edit from here offers to restore the
  files too: that machine lists the files and puts them back in its own
  checkout, so the paths in the dialog name its disk, not this one. A pairing
  that may only follow is offered neither.
- **Fork from here, side questions and the context ring work over there**
  (owner ask 2026-10-25: every feature of a local chat in a remote one). Each
  is offered where the machine advertises it and lists the chat's provider as
  able. Fork from here (`conversation-fork`, `capabilities.fork`) is made by
  that machine as its own would be: the new chat joins the chat's workspace
  there, named after it beside that workspace's other chats, and is written to
  its records so every window there lists it. Here it opens as a pane onto that
  machine in the tab after this chat's; a message forked before waits in its
  composer, without the files it attached, whose paths are on that machine. A
  repeat of the same command after a dropped connection is the same fork, and
  a chat at rest is forked from its transcript without being resumed. A side
  question (`conversation-side-questions`, `capabilities.sideQuestion`) is
  asked of the chat's agent over there, resuming a chat at rest as a send
  would, and needs a pairing that may drive; closing the drawer, or the
  connection dropping, calls it off there. That machine keeps it in the chat
  where it advertises `conversation-side-question-records`, and its marker
  reaches every device following the chat; a machine whose Studio predates it
  keeps nothing, and the drawer says so. Continue in a new chat forks over
  there as Fork from here does. The context ring
  (`conversation-context-breakdown`, `capabilities.contextBreakdown`) opens
  what fills the window, read from the agent over there; a chat with no live
  session there says there is no agent to ask yet, as a local one does. A
  machine without a capability offers none of it, and the ring shows how full
  the window is alone.
- **The composer reaches the chat's folder over there** (2026-10-25). Where
  the machine advertises `conversation-file-search` and
  `conversation-send-mentions`, an @ searches the chat's folder there (`GET
conversation-files`, on `conversation:read`), the picker ranks the matches
  and their folders as a search here is ranked, and the send names each pick
  by its path in that folder (`mentions`), which that machine resolves as its
  own composer's chips are, refusing one outside the folder, behind a link, or
  gone. Where it advertises `conversation-commands`, the `/` menu lists what
  the chat's CLI runs in that folder (`conversation.listCommands`), asked when
  the menu opens rather than as the chat does, since each ask may start the
  CLI over there; asking again (`refresh`) needs `conversation:operate`. A `$`
  lists that machine's skills, as the "+" does. Where it advertises
  `conversation-message-files`, a file attached here by its path is a card, as
  in a local chat: the window reads it (25 MB at most, `readAttachedFile`),
  sends it up on its connection (`uploads.*`, as an attachment), and the send
  names it, so the agent reads it there by that path. A chat at rest there
  takes files once a message has woken it, as it takes pictures. A machine
  without one of these leaves that part of the composer as before: no @, the
  `/` menu with Studio's commands, a file typed as its path. A message holding
  mentions, skills or files is handed to that machine's queue only where it
  keeps them too (`conversation-queued-attachments`, above); elsewhere it waits
  in this pane and goes when the turn ends while this machine is awake.
- **The CLI's own modes, as here** (2026-10-25). Where the machine advertises
  `conversation-cli-permission-modes`, the permissions picker lists the modes
  the chat's CLI runs beside the presets (Claude Code's Accept edits), shows
  the one the machine lists the chat on, and a pick switches it over there. A
  machine without the capability is offered each preset's own mode only.
- **A turn runs in the chat's mode over there** (2026-10-25). Where the machine
  advertises `conversation-send-mode`, a message goes in the mode the chat
  sends its turns in, as a local chat's do, and the chat says whether its
  provider plans from what the machine lists (`capabilities.planMode`). A
  machine without the capability is sent no mode, and a message in one other
  than the default is refused here in words rather than run as a default
  turn there.
- **Its effort is set from here** (2026-10-25). Where the machine advertises
  `conversation-reasoning-effort`, the engine picker's effort control and
  `/effort` are offered as a local chat's are, reading the level the machine
  lists the chat at; a change is written to the chat's record over there,
  which every turn after runs at, whichever device sends it.
- **Its MCP servers are reconnected and switched from here** (2026-10-25).
  Where the machine advertises `conversation-mcp-server-actions` and lists the
  chat's provider as taking the action, the "+" menu's server rows over a
  live chat offer Reconnect and switching a server back on, as a local chat's
  do, carried out over there, and the rows are read again after. A sign-in is
  that machine's to finish, since its CLI waits for the sign-in there, so no
  row offers it from here. The "+" lists that machine's skills and servers
  where it takes skills with a message (`conversation-send-skills`).
- **Restart agent session restarts it over there** (2026-10-25). Where the
  machine advertises `conversation-restart-session`, the palette's Restart
  agent session has that machine end the chat's agent process as its own
  does, and the next message starts it again on the same conversation, with
  the slash commands read again. It is refused while the agent works, as a
  local chat's is. A machine without the capability is not asked, and the
  toast says to restart it there.
- **A scheduled message is the other machine's to send** (2026-10-25). Where
  the machine advertises `conversation-scheduled-sends`, the "+"'s Schedule is
  offered as on a local chat, and the message goes to that machine at once
  (`scheduleSend`): it keeps it among its own scheduled messages, shows it in
  the chat's own tray there, and sends it at its time whether or not this
  machine is awake. The tray here draws what that machine says it keeps
  (the `conversation.scheduled` topic), and its Send now, Retry, Delete and
  Edit ask that machine; Edit deletes it there and puts it back in this
  composer, still set for its time. A machine without the capability, and a
  pairing that may only follow, offer no Schedule.
- **Its usage limits are the other machine's** (2026-10-25). Where the machine
  advertises `conversation-usage-limits`, the composer, beside the model picker, draws
  the chat's plan as that machine's agents reported it, and the mark's list
  every plan there, named as that machine's; the tray draws the notice a usage
  limit left on the chat's turn there, with Resume at reset, Always resume at
  reset, Cancel, Retry and Dismiss asking that machine, which sends the
  resume (the `conversation.usageLimits` topic, `conversation.usageLimitResume`). A
  pairing that may only follow sees the notice without its buttons; a machine
  without the capability draws neither, as before.
- **Its sub-agents are the other machine's** (2026-11-07). Where the machine
  advertises `conversation-subagents`, the right-hand panel's Subagents section
  lists a chat's sub-agents as that machine's own panel does, each with its
  harness's logo and how it stands, live (the `conversation.subagents` topic).
  The row in the transcript opens the same one. Opened, a sub-agent is followed
  as a chat of its own, on the window's same connection, in the main pane, so its steps,
  its report and what it asks are read from it and answered there, and a message
  in its box goes straight to it, resuming it if it is at rest. What it asks is
  also answered above its parent's box. A pairing that may only follow sees a
  question without being able to answer it, and has the bar in place of the box.
  It is stopped as it is on its own machine, with its parent's Stop or by the
  parent's `subagent.cancel`, since its chat offers no Stop of its own. No list
  shows one: not the sidebar here, and not a phone's. A machine without the
  capability shows only the agents the
  chat's CLI spawned, as before. The phone does not ask, and shows those too.
- **Its changes are the other machine's** (2026-11-07). Where the machine
  advertises `conversation-changes`, the panel's Changes row opens the chat's
  changes in the Diff tab here, read from that machine's checkout: the branch's
  steps (all commits, uncommitted, each commit), each step's files and each
  file's two sides, read again whenever the machine says the checkout moved.
  Viewed marks and Add to chat work as they do for a chat here, and a quote
  lands in that chat's composer. What opens a folder here (Open in editor, the
  file tree's menu, the separate diff window) and this machine's tours and
  changelists are not offered; the tab pops out of the pane like any other.
  Only a file a step lists is readable, on `conversation:read`, and nothing is
  written. A machine without the capability keeps the row as its count. Files
  and Terminal stay on the machine.

### Terminals stay on the machine

Conversations are the only agents that cross the tailnet (2026-09-29). A
paired device, phone or desktop, cannot list, watch, type into, or start a
terminal on this machine: there is no terminal socket and no terminal scope,
and the tools that list terminals, read their output or start an agent in one
(`terminal.list`, `terminal.read`, `terminal.create`, `agent.launch`,
`backlog.work`) are served on the local socket only, to the agents and MCP
clients on this machine. What a
paired device starts is a chat, through `conversation.create`, and the machine
dropdown in New chat offers a paired machine only for a Chat agent. Scheduled
agents stay on the machine too: the phone neither lists nor runs them. A tab left open on a remote terminal by an earlier build reopens as
an unavailable panel.

## Subagents as full chats

Clicking a subagent opens it as a full chat in the main pane, in the chat's
place, with the way back up in a band over it. What a tab is showing is a
session-only stack keyed by the workspace and the chat the tab holds
(`subagentViewStack.ts`), never a layout tab, which would be a sidebar line. The
chat beneath stays mounted and hidden, since a queued message lives in its view.

- A sub-agent Studio started is a chat of its own, and takes messages directly.
  It works for its parent, so it offers no resume in terminal, handoff, fork,
  rewind or checkpoint revert, and its preset cannot be raised past its parent's,
  which the runtime refuses by any path (`subagentPresetCeiling`). A row reads its
  live status, so a person's follow-up does not say Done.
- An agent a chat's CLI spawned is a lane, read through its owner's session as a
  conversation (`laneTranscript`). What it asks the person is answered in the
  normal dock.
- A message box appears only where a message arrives (`subagentDelivery.ts`,
  owner ruling 2026-11-07). A Claude Code lane that is running or finished takes
  one, relayed through the parent's model, which costs that model a turn. One the
  person stopped, one that failed, one whose end was not recorded and one the
  harness says cannot go on get no box, only a bar that says why and leads to the
  parent, as does every lane of a harness with no working relay and a paired
  machine without `conversation-agent-message`. Codex refuses input on a child
  thread, and a message its parent said it sent did not reach a finished child.

## Manual verification

1. Run `npm run verify:app` and `npm run build`, then start Studio with a separate
   development profile.
2. Start an installed chat provider, stream a reply, expand work groups, select
   code while it streams, and scroll back while new text arrives.
3. Attach a skill and a file, switch conversations, and confirm the draft and
   skill survive. Deny a request, answer a multi-question prompt, and interrupt
   a running turn.
4. Open an old search result, close/reopen the conversation, inspect changed
   files, and check a confirmed revert in a disposable repository.
5. Fork a chat from an earlier reply and from an earlier message on each
   installed runtime. The fork opens in the next tab with the conversation up
   to that point (and the message in its composer); ask it what was said last,
   then confirm the original chat is unchanged. Restart before the fork's first
   message and send one: it still continues from the point.
6. Pair the companion over a tailnet with conversation access. Read, send,
   approve, answer, stop, disconnect mid-reply and reconnect (the reply resumes
   without a reset), and verify an offline send appears once after
   acknowledgement. Narrow the device to read-only in Settings and confirm the
   next command is refused.
7. Pair a second Studio desktop with conversation access. Open a chat from its
   Remote band, send, approve and stop from there; switch its model between
   turns and mid-reply (the notice says the switch applies from the next
   turn), and confirm the host's own chip follows; drop Wi-Fi mid-reply and
   rejoin (no reset, no repeated text); quit and relaunch it (the transcript is
   on screen before it reconnects, then catches up). Narrow the pairing to read
   and confirm the composer closes with the reason.

Mocked native UI fixtures and protocol tests do not replace a live provider or
physical-device test. Authentication-dependent checks should record which CLI
and permission policy were actually exercised.
