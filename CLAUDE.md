@AGENTS.md

# SprintEngine Studio

An Electron desktop app that runs coding-agent CLIs side by side in chats,
workspaces and a pool of worktrees. One Studio can drive another on the tailnet
(a *paired machine*), and the phone app under `mobile/` drives a desktop the
same way. Most of the code here is written by agents; this file and
`REVIEW.md` are what keep it from regressing.

## Where things are

- `src/main` — the main process: agents, worktrees, the tailnet conversation
  host (`src/main/automation/tailnet`), mobile control (`src/main/mobile/control`).
- `src/renderer` — the React UI. `src/preload` is the bridge to it.
- `src/server` — the conversation server, also installed on WSL and SSH machines.
- `packages/` — published packages. `conversation-protocol` is the paired-chat
  wire; its `presentation.ts` is mirrored by the phone.
- `mobile/` — the phone app: its own package, lockfile and gate (`npm run ci`),
  and its own copy of the mobile wire types.
- `design-system/` — tokens and components. Read its `AGENTS.md` before UI work.
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
  helper you changed) and fix the class, not only the screen in the report.
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
