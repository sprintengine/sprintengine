@AGENTS.md

# SprintEngine Studio

An Electron desktop app that runs coding-agent CLIs side by side in chats,
workspaces and a pool of worktrees. One Studio can drive another on the tailnet
(a *paired machine*), the phone app under `mobile/` drives a desktop the same
way, and a browser can open a desktop's Studio as a web client. Most of the code
here is written by agents, often from inside Studio itself; this file and
`REVIEW.md` are what keep it from regressing.

## What we do not compromise on

People drive agents in Studio all day. These are the things they rely on, and
no change trades them away.

### 1. Open

The code is public and MIT-licensed, and people run it from source. Work as if
everything you write will be read: no real identities, no private ticket
numbers, no running commentary on other products (`AGENTS.md`).

### 2. Fast

A chat streams for hours, and people notice a dropped frame, a spinner that
lies and a label that is out of date. Watch for the usual causes: sending more
than the screen needs over a wire (the phone is often on a mobile network), a
long list rendered in full, a continuously repainting animation pegging the
GPU on a high-refresh display. Consider the performance cost of every change.

### 3. Remote ready

Paired machines and the phone are the product, not an add-on. A chat looks and
behaves the same whichever machine it runs on, and the feature set of remote
control is the feature set of the app (`AGENTS.md`, "Every feature works on
every machine"). A feature is not done until it works over the tailnet.

### 4. Every surface

Studio has five places a change can land, and a feature reaches all of them
that make sense:

- **Desktop**: the Electron app on macOS, Windows and Linux. It is also the
  host the others connect to.
- **Paired machine**: one desktop driving another's chats over the tailnet.
- **Phone**: the Expo / React Native app in `mobile/`, for iOS and Android,
  shipped through the stores on its own schedule, so it is often older than the
  desktop it talks to.
- **Web client**: the renderer served to a browser over a tunnel
  (`src/renderer/src/web`).
- **WSL and SSH machines**: the conversation server in `src/server`, installed
  on the far machine and run from there.

## How to work here

Prefer ambitious ideas, simple systems and software that feels obvious. Do not
keep complexity because it already exists, and do not add machinery because it
looks architecturally impressive. Understand the real constraint, then find the
smallest model that makes the correct behaviour unsurprising.

Measure twice, cut once, and do not build what is not needed yet. Fight scope
creep: honour what was asked, minimally and realistically. The rules in this
file are good defaults rather than laws, and the owner's word overrides any of
them. If one fights the task in front of you, say so plainly and get the
owner's sign-off before breaking it.

You are probably running inside the Studio you are changing, and other agents
are running in it beside you. Do not quit or restart the installed app, and do
not kill a process you found by matching a name or a path: your own agent has
this worktree's path in its command line. Stop only what you started, by the
PID you captured. A dev build keeps its own profile (`CONTRIBUTING.md`); never
point one at the installed app's data.

## Hit every surface

The most common defect in this repository is a change that works on the path
you tested and is missing everywhere else: it works in a local chat, and the
paired chat, the phone or the web client never got it. Before you call a change
done, walk this list and say in the pull request which entries applied and what
you did about each:

- **Local desktop.** The renderer reaches main over IPC: the channel in
  `src/shared/electron-api.ts` and `src/shared/ipc-channel-owners.ts`, the
  bridge in `src/preload/api/`, the handler in `src/main/ipc/`.
- **Paired machine.** Whatever a local chat does over IPC, a paired chat does
  over the tailnet, and nothing carries it there for you. The driving side
  (`agentChat/conversationTransport.ts`, `RemoteConversationPanel.tsx`,
  `src/main/automation/tailnet/tailnet-mesh-service.ts`) asks; the host
  (`tailnet-conversation-host.ts`, `packages/conversation-protocol`) answers.
  A new command or field is added behind a capability in `tailnet-routes.ts`,
  with its permission (`tailnet-permissions.test.ts`), and a
  `tailnet-conversation-*.test.ts` shows it working.
- **Phone.** The phone speaks the same conversation wire through its own code
  (`mobile/src/api/conversationWire.ts`, `tailnetConversations.ts`) and keeps
  its own copy of the mobile-control types
  (`mobile/src/shared/mobile-control/protocol.ts`). A change to either wire
  lands on both sides, and the phone gets the screen for it in the same change
  unless a phone cannot do it, which the pull request then says. An older phone
  must keep working (`docs/compatibility.md`).
- **Web client.** Every channel the renderer uses is classified for a browser
  tab in `src/shared/web-tunnel-access.ts`, and its test fails until a new
  one is. Classify it by what the far side needs, not as desktop-only to make
  the test pass.
- **WSL and SSH machines.** A chat whose agent runs on a far machine goes
  through `src/server`. A change to how a session runs or what it reports has
  to work there too.
- **Entry points.** A behaviour reachable from a chat is usually also
  reachable from the command palette, a keyboard shortcut, a menu, the
  sidebar's row menu or Settings. Fixing one is not fixing the feature.
- **Agents.** What a person can do, an agent usually reaches through the MCP
  tools in `src/main/automation/` (with the gateway tool list fixture and the
  skill that documents it), and schedules run the same paths. That only works
  when the behaviour lives in a service, not in a click handler.
- **Ways back.** If you added a way in, add the way out and a way to see it.
  Snooze needs unsnooze, close needs reopen. A one-way door is a bug.
- **Docs.** Check whether the change makes a line in `AGENTS.md`,
  `CONTRIBUTING.md`, `docs/`, `mobile/docs/` or a `component.md` untrue.

## Where things are

- `src/main`: the main process: agents, worktrees, the tailnet conversation
  host (`src/main/automation/tailnet`), mobile control (`src/main/mobile/control`).
- `src/renderer`: the React UI. `src/preload` is the bridge to it.
- `src/server`: the conversation server, also installed on WSL and SSH machines.
- `packages/`: published packages. `conversation-protocol` is the paired-chat
  wire; its `presentation.ts` is mirrored by the phone.
- `mobile/`: the phone app: its own package, lockfile and gate (`npm run ci`),
  and its own copy of the mobile wire types.
- `design-system/`: tokens and components. Read its `AGENTS.md` before UI work.
- `CONTRIBUTING.md` (gates, commits, pull requests) and `docs/compatibility.md`
  (anything that crosses a wire).

## Done means you watched it work

The fixes that came back from the owner had one thing in common: they were
green and nobody had looked. `npm run verify:app` is the floor, not the proof.

- **Show the evidence.** Put the command you ran and what it printed, or the
  screenshot, in the reply and the pull request. "Should work" is not a result.
- **UI:** run the app from this worktree and look at the changed state in light
  and dark, at the narrowest window, and with whatever sits on or beside it (an
  overlay, the empty state, an error, a long name). Check that the build on
  screen is the one you just made, not an older one or another checkout's.
- **Conversations:** check it in a paired chat (`AGENTS.md`). When it reaches
  the phone, look at it at phone width; `mobile/README.md` covers the verify
  harness.
- **Bug fixes:** reproduce it first, add a test that fails without the fix, then
  find every other place that makes the same mistake (search the callers of the
  helper you changed, and walk "Hit every surface") and fix the class, not only
  the screen in the report.
- **Say what you did not check.** "Only simulated" and "not tried on Windows"
  are honest answers, but they are not a pass.
- **A flaky test is a bug.** Fix it or name it in the pull request; do not
  re-run until it goes green.

## Scope

Build what was asked. A change to default behaviour or to what a screen offers
that nobody asked for goes to the owner first: the menu on the tab strip's +,
the pooled worktrees and the SSH name hardening were all reverted for that. A
hardening, performance or batch pull request changes nothing a person sees.

## Review

Every review of this repository follows `REVIEW.md`, whether it runs on a pull
request, in a review loop or as the last read of your own diff. Read it before
you call a change done. When a reviewer keeps flagging the same kind of mistake,
add a line here or in `REVIEW.md`, or a lint, so the next change does not make it.
