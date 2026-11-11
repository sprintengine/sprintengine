import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from 'fs/promises'
import { basename, dirname, join, relative, sep } from 'path'

import {
  CONVERSATION_MAX_CHECKOUT_ENTRIES,
  CONVERSATION_MAX_CHECKOUT_FILE_BYTES,
  CONVERSATION_MAX_CHECKOUT_MOVED_PATHS,
  type ConversationCheckoutEntry,
  type ConversationCheckoutFile,
  type ConversationCheckoutFileChange,
  type ConversationCheckoutFolder,
} from '../../packages/conversation-protocol/src/public'
import type { FileWatchEvent } from '../shared/ipc/filesystem'
import { runGitCommand } from './git-run'
import { isInsideRepo, toFilesystemPath } from './git-utils'
import { getWatchHub, type WatchHub } from './workspace-watch-hub'

// A chat's files for a paired device (`conversation-checkout-files`): what
// this machine's own Files tab shows for the chat — the folder it works in,
// its worktree when it has one — listed, read and watched here, and the few
// changes the Files tab and the editor make, made here, said over the
// conversation lane.
//
// Every path a device names is relative to that folder and stays in it. The
// protocol refuses `..` before anything is read; here the folder a path's
// parent resolves to, links followed, must still be inside the chat's folder,
// so a link inside it cannot carry a read or a write out of it. A link is
// listed as what it points at when that is inside the folder too, and as a
// file that cannot be opened otherwise.
//
// Live: one watch per folder however many devices watch it (the watch hub the
// Files tab here uses), told in coalesced batches, and only while a device
// watches.

export type ConversationChat = { workspaceId: string; agentId: string }

export type ConversationCheckoutFilesAnswer<T> =
  ({ ok: true } & T) | { ok: false; code?: 'not_found' | 'invalid_input'; message: string }

export type ConversationCheckoutFilesHost = {
  /** One folder's entries, `''` the chat's folder itself. */
  list(chat: ConversationChat, path: string): Promise<ConversationCheckoutFilesAnswer<ConversationCheckoutFolder>>
  /** One file's text, or why it cannot be sent. */
  read(chat: ConversationChat, path: string): Promise<ConversationCheckoutFilesAnswer<ConversationCheckoutFile>>
  /** Follow what moves in the chat's folder: `paths` relative to it, or null for "read again what you hold". */
  watch(chat: ConversationChat, listener: (paths: string[] | null) => void): () => void
  /** One change, and where the thing it changed now is. */
  change(
    chat: ConversationChat,
    change: ConversationCheckoutFileChange,
  ): Promise<ConversationCheckoutFilesAnswer<{ path: string }>>
}

/** How long a burst of watch events is gathered before a device is told. */
export const CHECKOUT_FILES_WATCH_BATCH_MS = 250
/** How much of a file is looked at to tell text from bytes. */
const BINARY_SNIFF_BYTES = 8_000

const NO_FOLDER = 'This chat has no folder on this computer to read.'
const OUTSIDE = 'That path leads out of this chat’s folder.'

type Timers = {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: Timers = {
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The relative path as this computer spells it. The protocol has already refused `..`. */
function local(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).join(sep)
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function said(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return 'Something by that name is already there.'
  if (code === 'ENOENT') return 'That file or folder is not there any more.'
  if (code === 'EACCES' || code === 'EPERM') return 'This computer does not allow that change there.'
  if (code === 'ENOTEMPTY') return 'That folder is not empty.'
  return error instanceof Error ? error.message : String(error)
}

/** Whether `path` is `root` or inside it. */
function within(root: string, path: string): boolean {
  return path === root || isInsideRepo(root, path)
}

export function createConversationCheckoutFiles(deps: {
  /** The folder a chat works in on this computer; null where it has none here. */
  checkoutOf(chat: ConversationChat): string | null
  /**
   * Moves a file or folder to this computer's Trash. Absent where the process
   * has no desktop to own a Trash (a server on its own), where a delete is
   * refused in words rather than made for good.
   */
  trashItem?: (path: string) => Promise<void>
  watchHub?: WatchHub
  batchMs?: number
  timers?: Timers
}): ConversationCheckoutFilesHost {
  const timers = deps.timers ?? realTimers
  const batchMs = deps.batchMs ?? CHECKOUT_FILES_WATCH_BATCH_MS
  const hub = (): WatchHub => deps.watchHub ?? getWatchHub()

  /** The chat's folder as links resolve it, or null where it has none here. */
  const rootOf = async (chat: ConversationChat): Promise<string | null> => {
    const folder = deps.checkoutOf(chat)
    if (!folder) return null
    try {
      return await realpath(toFilesystemPath(folder))
    } catch {
      return null
    }
  }

  /**
   * Where a relative path is on this disk, its parent folder resolved through
   * any link and checked to be inside the chat's folder; null when it leads out.
   * The last segment is left as it is, so a link there is the link, not its target.
   */
  const placeOf = async (root: string, path: string): Promise<string | null> => {
    const relativePath = local(path)
    if (!relativePath) return root
    const parent = dirname(join(root, relativePath))
    let resolvedParent: string
    try {
      resolvedParent = await realpath(parent)
    } catch (error) {
      // A parent that is not there yet is checked as far as it is.
      if (!isMissing(error)) throw error
      resolvedParent = parent
    }
    if (!within(root, resolvedParent)) return null
    return join(resolvedParent, basename(relativePath))
  }

  /** Git's word on which of a folder's entries it ignores, by name. */
  const ignoredNames = async (folder: string, names: string[]): Promise<Set<string>> => {
    if (names.length === 0) return new Set()
    const answer = await runGitCommand(folder, ['check-ignore', '-z', '--stdin'], undefined, {
      stdin: `${names.join('\0')}\0`,
    })
    // Exit status 1 is "none of them"; a folder outside any repository answers 128.
    return new Set(answer.stdout.split('\0').filter(Boolean))
  }

  const entryOf = async (
    root: string,
    folder: string,
    entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean },
  ): Promise<ConversationCheckoutEntry | null> => {
    if (entry.isDirectory()) return { name: entry.name, kind: 'folder' }
    if (entry.isFile()) return { name: entry.name, kind: 'file' }
    if (!entry.isSymbolicLink()) return null
    // A link is what it points at, when that is inside the chat's folder.
    try {
      const target = await realpath(join(folder, entry.name))
      if (within(root, target) && (await stat(target)).isDirectory()) return { name: entry.name, kind: 'folder' }
    } catch {
      // A broken link is a name with nothing behind it: listed as a file that cannot open.
    }
    return { name: entry.name, kind: 'file' }
  }

  type Watched = {
    listeners: Set<(paths: string[] | null) => void>
    close: () => void
    pending: Set<string>
    overflow: boolean
    timer: unknown
  }
  const watched = new Map<string, Watched>()

  const flush = (entry: Watched): void => {
    entry.timer = null
    const paths =
      entry.overflow || entry.pending.size > CONVERSATION_MAX_CHECKOUT_MOVED_PATHS ? null : [...entry.pending]
    entry.pending.clear()
    entry.overflow = false
    for (const listener of entry.listeners) listener(paths)
  }

  const heard = (entry: Watched, event: FileWatchEvent): void => {
    const paths = event.overflow ? null : event.paths?.length ? event.paths : event.path ? [event.path] : null
    if (!paths) entry.overflow = true
    else for (const path of paths) entry.pending.add(path.split(/[\\/]/u).filter(Boolean).join('/'))
    if (entry.timer === null) entry.timer = timers.setTimeout(() => flush(entry), batchMs)
  }

  return {
    async list(chat, path) {
      const root = await rootOf(chat)
      if (!root) return { ok: false, code: 'not_found', message: NO_FOLDER }
      const place = await placeOf(root, path)
      if (!place) return { ok: false, code: 'not_found', message: OUTSIDE }
      let folder: string
      try {
        folder = await realpath(place)
      } catch {
        return { ok: false, code: 'not_found', message: 'That folder is not there any more.' }
      }
      if (!within(root, folder)) return { ok: false, code: 'not_found', message: OUTSIDE }
      let dirents
      try {
        dirents = await readdir(folder, { withFileTypes: true })
      } catch (error) {
        return { ok: false, code: isMissing(error) ? 'not_found' : undefined, message: said(error) }
      }
      const truncated = dirents.length > CONVERSATION_MAX_CHECKOUT_ENTRIES
      const read = await Promise.all(
        dirents.slice(0, CONVERSATION_MAX_CHECKOUT_ENTRIES).map((dirent) => entryOf(root, folder, dirent)),
      )
      const entries = read.filter((entry): entry is ConversationCheckoutEntry => entry !== null)
      const ignored = await ignoredNames(
        folder,
        entries.map((entry) => entry.name),
      ).catch(() => new Set<string>())
      return {
        ok: true,
        root: { name: basename(root) || root, path: root },
        entries: entries.map((entry) => (ignored.has(entry.name) ? { ...entry, ignored: true as const } : entry)),
        truncated,
      }
    },

    async read(chat, path) {
      const root = await rootOf(chat)
      if (!root) return { ok: false, code: 'not_found', message: NO_FOLDER }
      const place = await placeOf(root, path)
      if (!place) return { ok: false, code: 'not_found', message: OUTSIDE }
      try {
        // A link is read as what it points at only where that is inside the folder.
        const target = await realpath(place)
        if (!within(root, target)) return { ok: false, code: 'not_found', message: OUTSIDE }
        const info = await stat(target)
        if (!info.isFile()) return { ok: false, code: 'not_found', message: 'That is not a file.' }
        if (info.size > CONVERSATION_MAX_CHECKOUT_FILE_BYTES) return { ok: true, kind: 'too-large', size: info.size }
        const handle = await open(target, 'r')
        try {
          const sniff = Buffer.alloc(Math.min(info.size, BINARY_SNIFF_BYTES))
          await handle.read(sniff, 0, sniff.length, 0)
          if (sniff.includes(0)) return { ok: true, kind: 'binary' }
        } finally {
          await handle.close()
        }
        return { ok: true, kind: 'text', content: await readFile(target, 'utf8') }
      } catch (error) {
        return { ok: false, code: isMissing(error) ? 'not_found' : undefined, message: said(error) }
      }
    },

    watch(chat, listener) {
      let stopped = false
      let entry: Watched | null = null
      let watchedRoot: string | null = null
      void rootOf(chat).then((root) => {
        if (stopped || !root) return
        watchedRoot = root
        const found = watched.get(root)
        if (found) {
          found.listeners.add(listener)
          entry = found
          return
        }
        const fresh: Watched = {
          listeners: new Set([listener]),
          close: () => {},
          pending: new Set(),
          overflow: false,
          timer: null,
        }
        try {
          const subscription = hub().subscribe(root, (event) => heard(fresh, event))
          fresh.close = () => subscription.close()
        } catch {
          // A folder that cannot be watched still reads, and a refresh still works.
        }
        watched.set(root, fresh)
        entry = fresh
      })
      return () => {
        stopped = true
        if (!entry || !watchedRoot) return
        entry.listeners.delete(listener)
        if (entry.listeners.size > 0) return
        if (entry.timer !== null) timers.clearTimeout(entry.timer)
        entry.close()
        watched.delete(watchedRoot)
      }
    },

    async change(chat, change) {
      const root = await rootOf(chat)
      if (!root) return { ok: false, code: 'not_found', message: NO_FOLDER }
      const place = await placeOf(root, change.path)
      if (!place || place === root) return { ok: false, code: 'not_found', message: OUTSIDE }
      const wire = (absolute: string) => relative(root, absolute).split(sep).join('/')
      try {
        switch (change.kind) {
          case 'write': {
            // A save writes through a link only to a file inside the folder.
            let target = place
            try {
              target = await realpath(place)
            } catch (error) {
              if (!isMissing(error)) throw error
            }
            if (!within(root, target)) return { ok: false, code: 'not_found', message: OUTSIDE }
            await writeFile(target, change.content, 'utf8')
            return { ok: true, path: wire(place) }
          }
          case 'createFile':
            await writeFile(place, '', { encoding: 'utf8', flag: 'wx' })
            return { ok: true, path: wire(place) }
          case 'createFolder':
            await mkdir(place)
            return { ok: true, path: wire(place) }
          case 'rename': {
            const to = await placeOf(root, change.to)
            if (!to || to === root) return { ok: false, code: 'not_found', message: OUTSIDE }
            if (to === place) return { ok: true, path: wire(place) }
            if (within(place, to))
              return { ok: false, code: 'invalid_input', message: 'A folder cannot move into itself.' }
            const taken = await lstat(to).then(
              () => true,
              () => false,
            )
            if (taken) return { ok: false, message: `Something named “${basename(to)}” is already there.` }
            await rename(place, to)
            return { ok: true, path: wire(to) }
          }
          case 'delete': {
            if (!deps.trashItem)
              return {
                ok: false,
                message: 'This machine runs Studio without a desktop, so it has no Trash to move that to.',
              }
            await lstat(place)
            await deps.trashItem(place)
            return { ok: true, path: '' }
          }
        }
      } catch (error) {
        return { ok: false, code: isMissing(error) ? 'not_found' : undefined, message: said(error) }
      }
    },
  }
}
