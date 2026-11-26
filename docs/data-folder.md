# The data folder and its database

Each Studio server keeps its records in its data folder: the desktop's own
server, each WSL distribution's, each SSH machine's, each standalone server and
each profile (`data-<profileId>`) has its own. Only the server that holds the
folder's run lock (`run/studio.lock`) opens it, so there is one writer.

## What is in the database

`<data>/studio.sqlite` (with `studio.sqlite-wal` and `studio.sqlite-shm` beside
it while the server runs) holds the records that moved out of files. Its code is
in `src/server/db/`.

| Since format | Records                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 2            | a launched chat's first message, the "always allow" approval rules, the launch notices, the prompts a person sent each terminal agent |
| 3            | the devices paired with this Studio and the machines it is paired with, browser sessions, embeds, linked local servers, apps' toolsets, file views, extension approvals |
| 4            | chat history: each chat's events and command receipts, the chat list's rows, search, the list of turns a stop may have left open, and tools' details and streamed output |
| 5            | the chat records (the workspace registry: a row per chat, and one for its windows, active chat and revision), the schedules with their runs, scheduled messages, usage-limit resumes |

A paired machine's token is kept sealed by the platform's cipher, as its file
kept it; an old file that still held one in plaintext is not imported, and
that machine is paired again. A device revoked before the upgrade is not in
its file and so not in the database either.

What people or agent CLIs open by path stays a file: pictures (a first
message's are in `conversation-first-messages/`), plans, handoff notes, CLI
configs, skills and plugins. So do settings, secrets, logs, caches that can be
rebuilt, and what is read before the database opens or by another process
(`format.json`, `run/`, the MCP bridge's info files).

The driver is `node:sqlite`, built into Node from 22.13, so no build carries a
native module for it. Queries run on worker threads: one writer and a small
pool of readers, so a slow disk delays writes without holding up the server.

## How it is kept safe

- **WAL, always.** The database runs in write-ahead-logging mode with
  `synchronous = NORMAL`: an app crash loses nothing committed, and a power cut
  can lose the last moments but never leaves half a record. A folder whose file
  system cannot hold a WAL database (a network drive or share) is refused at
  start, saying to pick a data folder on a local disk (`--data-dir`, or
  `SPRINTENGINE_USER_DATA_DIR`).
- **Damage is never read as empty.** A database that is damaged, or is not a
  SQLite file, stops the start with its path and what to do: quit, move the
  file and its `-wal` and `-shm` files out of the folder (or put back a copy),
  and start again.
- **Migrations.** The layout is a numbered list (`src/server/db/migrations.ts`),
  each run in its own transaction at open and recorded, so a start a crash cut
  short carries on after the last one that finished. A database a newer Studio
  migrated is refused rather than written on.
- **One copy.** Before a format step changes the database, Studio copies it to
  `database-copies/studio-before-format-<n>.sqlite` (`VACUUM INTO`), and keeps
  only that latest copy. A step that fails, or that a crash cuts short, is put
  back from it before anything reads the data. The step that makes the database
  (format 2) has nothing to copy: the files it reads are the way back.

## Chat history

Each agent of a chat has one log, named as its transcript was
(`<store>/<chat>/<agent>`, the store being the project's): its events by
sequence number, a merged run of streamed text as one row, and its commands'
receipts, each command one transaction. The chat list's row for each log and
the search index (full text, by trigram, over what people said and agents
replied, whole chats included) are folded from its events and kept beside
them. A chat moved to another project has its rows renamed with its folder.

The first start of format 4 opens at once. A chat's transcript from before
the database is imported the first time the chat is taken up (opened, listed,
searched, sent to), or by a background pass that goes through every chat a few
seconds after start, one at a time. Each transcript is one transaction: a stop
part way leaves nothing of it, and it is imported whole next time. Its numbers
and its generation are kept, so a client that was following the chat before
the upgrade carries on from its cursor. A line a crash tore or that does not
read is skipped and counted. A tool's detail is imported the first time it is
expanded. Pictures, plans and handoff notes stay files in the chat's folder.

## Chat records and schedules

Each chat record is a row of its own (`chats`), in the registry's order, and
the rest of the registry (its revision, its windows, the active chat, the
chats removed) is one row beside them (`chat_registry`). A change writes the
rows it changed in one transaction, as soon as it is made: a settle, a snooze
or a visit is committed before the change is answered, with no write delay,
so a quit a moment later keeps it. The schedules with their runs, the
scheduled messages and the usage-limit resumes are each kept whole as one row
(`store_records`), written as their files were, each change one transaction.

At the first start of format 5 each of those files is imported once. One that
its store's own parser would not read (torn by a crash, hand-edited) is
skipped and counted, never brought in as an empty list, and the file stays as
it was. A registry file skipped that way reads as unreadable, as it did
before, not as a fresh folder. Records the registry's parser drops are counted
as skipped too. The uninstaller's command line (`--remove-integrations`)
reads the chat records' folders from the database, read-only, and from the old
file beside it.

## The first start of a new format

`<data>/format.json` says which format the folder is in
(`src/server/environment/data-format.ts`, and `docs/compatibility.md`). A
server refuses a folder in a newer format than it reads. The first start of a
build that moves a store runs its format step before any store is built: it
makes or migrates the database and imports that store's files, each file once
and in its own transaction, noted in the database's `imports` table. A record
that does not read (a torn line, a hand-edited file) is skipped, counted there
and in the diagnostics log.

The import never changes, moves or deletes the old files. After it, nothing
reads or writes them. They stay until a later release names the folders and
you remove them by hand.

## Going back to an older build

An older build is also what switching a nightly install to the stable channel
can install (the updater allows that one downgrade). A build from before a
format it does not read either refuses the folder (a Studio server) or, for a
desktop from before the database (format 2), runs on the files the upgrade
left behind: it cannot be told otherwise, since it was built before the
database. What it writes to those files is not read when the newer build
returns, because the newer build reads its database. So after such a
downgrade, either stay on the older build, or treat what you did there as
lost when you update again; the steps below are the same either way.

1. Quit Studio (or stop the server).
2. Move `studio.sqlite`, and any `studio.sqlite-wal` and `studio.sqlite-shm`
   beside it, out of the data folder.
3. Edit `format.json` to say the format the older build reads, for example
   `{"format":1,"writtenBy":"rollback"}`.
4. Start the older build. It runs on the files as they were at the upgrade.

What you did after the upgrade is in the database you moved aside. Put it back
(and `format.json` back to the newer format) before you start the newer build
again, and nothing is lost. Started without it, the newer build imports the
old files afresh.
