# Reviewing a change to SprintEngine Studio

One question: **will this break something a person uses?** Do not report style,
anything `npm run verify:app` catches, or hypothetical futures.

## What to check, most common first

1. **It works locally only.** Walk "Hit every surface" in `CLAUDE.md`. A
   finding: a local IPC change with no protocol, host and capability
   counterpart; a paired row missing a field a local row has; a phone that was
   not updated; a `transport.kind` or `machine` branch that turns a feature
   off; a read of local records only. When the diff fixes a parity bug, look
   for the same gap on the other surfaces.
2. **A wire changed on one side.** The phone's copies
   (`mobile/src/shared/mobile-control/protocol.ts`, `presentation.ts`) are not
   compared automatically. Changes are additive, behind a capability, and an
   older phone still works; that is the normal case, not an edge.
3. **Reconnects and stale state.** A reconnect, a duplicate or out-of-order
   event, a failed subscribe, a message queued hours ago, a stale clock or
   cache.
4. **A neighbour broke.** Read the callers. Shared paths: send and steer, the
   sidebar's grouping, new chat, the worktree pool, and the other ways in to
   the same behaviour.
5. **It only works on macOS.** Paths, quoting, spawning a shell, the
   environment of an app opened from the Dock, shortcuts, long Windows paths,
   WSL.
6. **Odd repositories.** A nested `git init`, a split index, a branch shadowed
   by a tag, a huge or slow tree.
7. **It fails only at release.** A runtime dependency missing from
   electron-builder's `files` or `asarUnpack`; a workflow that is wrong when it
   runs for real.
8. **The UI was never looked at.** No screenshot, or none in the other theme
   or at the narrowest window. The design-system rules in `AGENTS.md`.
9. **It does more than asked.** A changed default or a new step needs the
   owner's word.
10. **A doc now lies.**

## Findings

A file and line, the path to the failure, and every other instance of the same
mistake. Tag each **Important**, **Nit** (at most three, first round only) or
**Pre-existing**. Skip lockfiles and generated files unless edited by hand.

## Rounds

Later rounds read only what changed and the findings still open. Do not repeat
an answered finding. After three rounds with an Important still open, question
the approach and leave the call to the owner.

## Summary

Start with a count, or "Nothing to fix." Then, for the paired machine, the
phone and WSL/SSH: the change reaches it, it does not apply, or you could not
tell. Name missing evidence for a user-visible change.
