# Reviewing a change to SprintEngine Studio

You are reviewing a diff to this repository: a pull request, a round of a review
loop, or the last read of your own work. `CLAUDE.md` and `AGENTS.md` say what the
project is and which rules it keeps; this file says what a review here is for.

The job is one question: **will this change break something a person uses?** Read
the diff against the code it lands in and the intent the pull request states.
The checks catch what they can. The bugs that reach the owner are the ones they
cannot see.

## Where this list comes from

It was built from the 87 past agent sessions on this repository and its git and
pull request history since August: about 47 times the owner had to report a bug
or reopen something an agent had called done. Close to half were one mistake: a
change made to a local chat and never carried to the paired machine, the phone
or the web client. In the sessions where that happened, the reviewing agents
never asked whether the remote path carried the change. Every review here asks
it now.

## What failure looks like here

These are the ways changes to this repository have actually broken, most common
first. Check each one the diff touches.

1. **It works locally and not on a paired machine, the phone or the web
   client.** This is the most common bug the owner reports, and the same one
   keeps coming back, because each fix covered the screen in the report and
   not the other surfaces with the same gap. When the diff adds or changes
   anything a chat shows or does, walk "Hit every surface" in `CLAUDE.md` and
   follow the data out:
   - A new or changed IPC channel for a local chat with no matching command or
     field in `packages/conversation-protocol` and the tailnet host
     (`src/main/automation/tailnet/tailnet-conversation-host.ts`), behind a
     capability in `tailnet-routes.ts`, is a finding.
   - So is a driving side that never asks for it
     (`agentChat/conversationTransport.ts`, `RemoteConversationPanel.tsx`,
     `tailnet-mesh-service.ts`, `workspace/remoteBand/`), or a paired row that
     lacks a field a local row has.
   - So is a phone that does not get it: `mobile/src/api/conversationWire.ts`
     and the screen under `mobile/src/features/` for the conversation wire,
     `src/main/mobile/control/` for mobile control. The exception is something
     a phone cannot do, and the pull request has to say so.
   - So is a channel missing from, or misfiled as desktop-only in,
     `src/shared/web-tunnel-access.ts`.
   - So is a `transport.kind` or `machine` branch that turns a feature off, or
     a read from local records only.
   - When the change is to how a session runs or reports, check that
     `src/server` carries it for chats on WSL and SSH machines.
   - When the diff fixes a parity bug, search for the same gap on the other
     surfaces and in the neighbouring commands. Fixing the one in the report
     is how this bug keeps coming back.
2. **A wire changed on one side.** The phone keeps its own copy of the mobile
   wire types (`mobile/src/shared/mobile-control/protocol.ts`), and
   `presentation.ts` is mirrored on the phone byte for byte. Nothing compares
   them automatically. A wire change lands on both sides, additive and behind a
   capability, and an older peer still works (`docs/compatibility.md`). The
   phone ships through the stores, so an older phone talking to a newer desktop
   is the normal case, not an edge case.
3. **Reconnects, replays and stale state.** For a stream, cursor, subscription,
   queue or settle path, ask what happens on reconnect, a duplicate or
   out-of-order event, a failed subscribe, or a message queued hours ago. Stale
   reads of a clock or a cache belong here too. Most fixes to `chat`,
   `conversation`, `tailnet` and `worktrees` were one of these.
4. **A neighbour broke.** Read the callers of what changed, not only the
   changed lines. Sending while sub-agents run cancelled them, and flattening
   sessions duplicated sidebar rows. Shared paths here are send/steer, the
   sidebar's grouping, new chat and the worktree pool. Read the other ways in
   to the same behaviour as well: the command palette, a shortcut, a menu, the
   sidebar's row menu, Settings and the agents' MCP tools. A change to one
   that leaves the rest behind is a finding, and so is a new way in with no
   way back out (snooze without unsnooze).
5. **It only works on macOS.** Paths, quoting, spawning a shell or CLI, the
   environment of an app opened from the Dock, quit and close shortcuts, long
   Windows paths, WSL. If the diff touches any of these, check it for Windows
   and Linux as well.
6. **Odd repositories.** Checkpoint, worktree and git code meets a nested
   `git init`, a split index, a branch shadowed by a tag, a huge tree, a slow
   repository. Check that the diff fails safe on them.
7. **Packaging and release only fail at release.** A new runtime dependency has
   to reach the package (`package.json`'s electron-builder `files` and
   `asarUnpack`). A workflow change has to be correct when it runs for real:
   an empty secret, a renamed repository, a tag that has to match the package.
8. **The UI was never looked at.** A user-visible change with no screenshot, or
   none at the narrowest window, in the other theme or over the thing beside
   it, is a finding. The design-system rules in `AGENTS.md` (no status dots,
   tokens only, generated files rebuilt, not edited) count as well.
9. **It does more than it was asked.** A change of default behaviour, a new
   step before something people already use, or a "hardening" that refuses
   what worked yesterday needs the owner's word. Three reverts came from this.
10. **A doc now lies.** A line in `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`,
    `docs/` or a `component.md` that the diff has made untrue.

## What a finding needs

- **A file and a line, and the path to the failure.** "A paired chat never
  shows when it was last written to, because the tailnet row built at
  `<file>:<line>` leaves the time out" is a finding. "This might not work remotely" is a guess. Show the code, not a
  conclusion drawn from a name.
- **The class, not one instance.** When the mistake is a pattern, search for its
  other instances and list them in the same finding, so the author fixes all of
  them in one round.
- **A tag.**
  - **Important**: a person will hit it in the case the change is for, or it
    breaks a neighbour, a wire or a platform.
  - **Nit**: real but minor. Report at most three, and none in a later round.
  - **Pre-existing**: real, but the diff did not introduce it. Say so, so it
    does not read as the author's fault.

## What not to report

- Style, formatting, naming or comment taste. Prettier, oxlint and the design
  lints already run in `npm run verify:app`.
- Something the gate already catches, such as a type error, a lint or a
  failing test.
- Hypothetical futures, extra configurability, or defensive code for a case
  the intent does not have.
- These paths, unless the diff edits them by hand: `package-lock.json`,
  `mobile/package-lock.json`, `design-system/catalog/index.html`,
  `design-system/foundations/tokens.css` (all built; flag a hand edit instead),
  `docs/images/` and other binary assets.

## Rounds

- The first round reads the whole diff. Later rounds read only what changed
  since, and the findings still open.
- Do not repeat a finding that has been answered. When the author has
  disagreed with evidence, weigh the evidence; do not restate the claim.
- After three rounds with an Important finding still open, stop finding
  things. Say the approach may be wrong and why, and leave the call to the
  owner.

## The summary

Start with a count: "2 Important, 1 Nit, 0 Pre-existing." When there is nothing
to fix, say so plainly: "Nothing to fix." Then say what you checked that is not
in the findings:

- **Every surface, by name:** paired machine, phone, web client, WSL and SSH
  machines. For each, say that the change reaches it, that it does not apply,
  or that you could not tell. A review that does not answer this is not done.
- Which platforms you considered.
- Whether the pull request's evidence (output, screenshots) covers what it
  claims. Missing evidence for a user-visible change is worth a sentence
  even when the code looks right.
