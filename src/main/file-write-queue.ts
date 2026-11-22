// One queue of writes per file, for every part of Studio that writes the
// person's files: the editors' saves, an extension's `files.write`, a file
// shown in a chat, Studio's own writes. A write takes its turn after the one
// before it settles, so a write that checks what is on disk first (the bytes
// a save expects) and then writes is one step for every other writer.
//
// A file is one file however it is named: the queue is keyed by its real
// path (the parent's real path and its name for a file not made yet), so a
// link and the file it points at share a turn. Studio's server is the one
// process that writes for every client, so a queue in it orders them all.
//
// Reads do not take a turn: one that lands mid-write may see the new bytes
// over the tail of the old for that moment.

import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const turns = new Map<string, Promise<unknown>>()

/** The key a file's writes queue under: its real path, folded to lower case where names fold. */
export async function fileWriteKey(path: string): Promise<string> {
  const real = await realpath(path).catch(async () => {
    const folder = await realpath(dirname(path)).catch(() => dirname(path))
    return join(folder, basename(path))
  })
  // Case-insensitive file systems (macOS, Windows by default) name one file many ways.
  return process.platform === 'linux' ? real : real.toLowerCase()
}

/** Run `work` in `path`'s turn: after every write to that file asked for before it has settled. */
export async function withFileWriteTurn<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = await fileWriteKey(path)
  const before = turns.get(key) ?? Promise.resolve()
  const turn = before.catch(() => undefined).then(work)
  const settled = turn.catch(() => undefined)
  turns.set(key, settled)
  void settled.then(() => {
    if (turns.get(key) === settled) turns.delete(key)
  })
  return turn
}
