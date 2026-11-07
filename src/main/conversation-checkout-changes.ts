import { createHash } from 'crypto'
import { lstat, readFile, readlink, realpath } from 'fs/promises'
import { join } from 'path'

import {
  CONVERSATION_MAX_CHANGED_FILE_BYTES,
  CONVERSATION_MAX_CHANGED_FILES,
  CONVERSATION_MAX_CHANGES_STEPS,
  type ConversationChangedFileSide,
  type ConversationChangedFileSides,
  type ConversationChangesDiff,
  type ConversationChangesSelection,
  type ConversationCheckoutChanges,
} from '../../packages/conversation-protocol/src/public'
import { diffBranchSelection, listBranchSteps, readFileAtRev } from './branch-steps'
import { runGitCommand } from './git-run'
import { isInsideRepo, toFilesystemPath } from './git-utils'

// A chat's changes for a paired device (`conversation-changes`): what this
// machine's own Diff tab reads when its Changes row is pressed — the branch's
// commits as steps (branch-steps.ts), one step's files, and the two sides of
// one of those files — read here, in the chat's own checkout, and said over
// the conversation lane.
//
// Nothing else of the checkout is readable through it. A device names a step
// and a path; the path must be one the step lists as this machine reads the
// step now, the revisions are worked out here from the step, and a commit is
// one of the branch's own. The working tree's side is read without following
// a link out of the checkout: a link reads as what it points at, the text git
// keeps for one, never as the file it names.
//
// Live: while a device watches a chat, its checkout is read every couple of
// seconds, one git process and a stat of each changed file, and the device is
// told only when that reading moves. A machine whose windows are all in the
// background still answers, since the person reading is on another one. The
// reading stops with the last watch.

/** How often a watched checkout is read again. */
export const CHECKOUT_CHANGES_POLL_MS = 2_000
/** The most changed files whose stat goes into a reading; past it, the status alone moves it. */
const STAMPED_FILES_MAX = 2_000
/** How long a step list read for a request stands for the next. */
const STEPS_FRESH_MS = 2_000

export type ConversationChat = { workspaceId: string; agentId: string }

/** What a device is told of a chat's checkout, whole each time. */
export type ConversationChangesSaid = { changes: ConversationCheckoutChanges | null; revision: string }

export type ConversationChangesAnswer<T> = ({ ok: true } & T) | { ok: false; code?: 'not_found'; message: string }

export type ConversationCheckoutChangesHost = {
  /** Follow how a chat's checkout stands: told now, and whenever it reads differently. Returns what stops it. */
  watch(chat: ConversationChat, listener: (said: ConversationChangesSaid) => void): () => void
  /** One step's files. */
  diff(
    chat: ConversationChat,
    selection: ConversationChangesSelection,
  ): Promise<ConversationChangesAnswer<ConversationChangesDiff>>
  /** Both sides of one file a step lists. */
  file(
    chat: ConversationChat,
    selection: ConversationChangesSelection,
    path: string,
  ): Promise<ConversationChangesAnswer<ConversationChangedFileSides>>
}

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

const NO_CHECKOUT = 'This chat has no checkout on this computer to read.'

/** The repository's top folder, which every path a step lists is relative to; null where the folder is not one. */
async function toplevelOf(folder: string): Promise<string | null> {
  const result = await runGitCommand(folder, ['rev-parse', '--show-toplevel'])
  const top = result.ok ? result.stdout.trim() : ''
  return top || null
}

/**
 * One reading of a checkout that moves whenever anything a Diff tab shows may
 * have: HEAD, the branch and every changed, staged or untracked path (one
 * `git status`), and the size and time of each changed file, which a save to
 * a file already changed moves and the status alone does not. Hashed, since
 * only equality is asked of it. Null when the folder is not a checkout.
 */
async function readingOf(toplevel: string): Promise<string | null> {
  const status = await runGitCommand(toplevel, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  if (!status.ok) return null
  const hash = createHash('sha1').update(status.stdout)
  const paths = changedPathsOf(status.stdout).slice(0, STAMPED_FILES_MAX)
  const stamps = await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await lstat(toFilesystemPath(join(toplevel, path)))
        return `${path}\0${info.size}\0${info.mtimeMs}`
      } catch {
        return `${path}\0gone`
      }
    }),
  )
  for (const stamp of stamps) hash.update(`\0${stamp}`)
  return hash.digest('hex')
}

/** The paths `git status --porcelain=v2 -z` names, each once: the new name of a rename. */
export function changedPathsOf(stdout: string): string[] {
  const fields = stdout.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.startsWith('1 ')) paths.push(field.split(' ').slice(8).join(' '))
    else if (field.startsWith('2 ')) {
      paths.push(field.split(' ').slice(9).join(' '))
      // A rename's original path is a field of its own.
      index += 1
    } else if (field.startsWith('u ')) paths.push(field.split(' ').slice(10).join(' '))
    else if (field.startsWith('? ')) paths.push(field.slice(2))
  }
  return paths.filter(Boolean)
}

function wireChanges(snapshot: Awaited<ReturnType<typeof listBranchSteps>>): ConversationCheckoutChanges {
  return {
    branch: snapshot.branch,
    baseOid: snapshot.baseOid,
    scope: snapshot.scope,
    steps: snapshot.steps.slice(-CONVERSATION_MAX_CHANGES_STEPS).map((step) => ({
      hash: step.hash,
      shortHash: step.shortHash,
      subject: step.subject,
      authoredAt: Math.max(0, Math.trunc(step.authoredAt)),
      isMerge: step.isMerge,
    })),
    hasUncommitted: snapshot.hasUncommitted,
  }
}

/**
 * The working tree's side of a file: its text, or what a link points at as
 * git keeps it. A path whose folder leads out of the checkout, or one that is
 * not a file, is not there; one past the size the Diff tab draws is too large.
 */
async function readWorktreeSide(toplevel: string, path: string): Promise<ConversationChangedFileSide> {
  const absolute = join(toplevel, path)
  if (!isInsideRepo(toplevel, absolute)) return { kind: 'absent' }
  try {
    const [top, folder] = await Promise.all([
      realpath(toFilesystemPath(toplevel)),
      realpath(toFilesystemPath(join(absolute, '..'))),
    ])
    if (folder !== top && !isInsideRepo(top, folder)) return { kind: 'absent' }
    const info = await lstat(toFilesystemPath(absolute))
    if (info.isSymbolicLink()) return { kind: 'content', content: await readlink(toFilesystemPath(absolute)) }
    if (!info.isFile()) return { kind: 'absent' }
    if (info.size > CONVERSATION_MAX_CHANGED_FILE_BYTES) return { kind: 'too-large' }
    return { kind: 'content', content: await readFile(toFilesystemPath(absolute), 'utf8') }
  } catch {
    return { kind: 'absent' }
  }
}

async function readRevSide(toplevel: string, rev: string, path: string): Promise<ConversationChangedFileSide> {
  const read = await readFileAtRev(toplevel, rev, path)
  return read.kind === 'content' ? { kind: 'content', content: read.content } : { kind: read.kind }
}

export function createConversationCheckoutChanges(deps: {
  /** The folder a chat works in on this computer; null where it has none here. */
  checkoutOf(chat: ConversationChat): string | null
  pollMs?: number
  timers?: Timers
}): ConversationCheckoutChangesHost {
  const pollMs = deps.pollMs ?? CHECKOUT_CHANGES_POLL_MS
  const timers = deps.timers ?? realTimers
  const toplevels = new Map<string, Promise<string | null>>()
  const toplevel = (folder: string): Promise<string | null> => {
    let found = toplevels.get(folder)
    if (!found) {
      found = toplevelOf(folder)
      toplevels.set(folder, found)
      // A folder that becomes a repository later is asked again.
      void found.then((top) => {
        if (!top) toplevels.delete(folder)
      })
    }
    return found
  }
  const rootOf = async (chat: ConversationChat): Promise<string | null> => {
    const folder = deps.checkoutOf(chat)
    return folder ? toplevel(folder) : null
  }

  // A step list read for a request stands for the next few, so reading a
  // file's two sides does not list the branch again each time.
  const stepLists = new Map<string, { at: number; steps: Promise<Awaited<ReturnType<typeof listBranchSteps>>> }>()
  const stepsOf = (top: string) => {
    const held = stepLists.get(top)
    if (held && Date.now() - held.at < STEPS_FRESH_MS) return held.steps
    const steps = listBranchSteps(top)
    stepLists.set(top, { at: Date.now(), steps })
    return steps
  }
  // A commit a device may name is one of the branch's own.
  const allowed = async (top: string, selection: ConversationChangesSelection): Promise<boolean> =>
    selection.kind !== 'commit' || (await stepsOf(top)).steps.some((step) => step.hash === selection.hash)

  // One reading per checkout, however many devices watch it.
  type Watched = {
    listeners: Set<(said: ConversationChangesSaid) => void>
    last: ConversationChangesSaid | null
    reading: string | null
    timer: unknown
    stopped: boolean
  }
  const watched = new Map<string, Watched>()

  const readNow = async (top: string | null, entry: Watched): Promise<void> => {
    const reading = top ? await readingOf(top) : null
    if (entry.stopped) return
    if (entry.last && reading === entry.reading) return
    entry.reading = reading
    const changes = top && reading ? wireChanges(await stepsOfFresh(top)) : null
    if (entry.stopped) return
    const said = { changes, revision: reading ?? 'none' }
    entry.last = said
    for (const listener of entry.listeners) listener(said)
  }
  const stepsOfFresh = (top: string) => {
    stepLists.delete(top)
    return stepsOf(top)
  }

  return {
    watch(chat, listener) {
      let stopped = false
      let entry: Watched | null = null
      let watchedKey: string | null = null
      void rootOf(chat).then((top) => {
        if (stopped) return
        watchedKey = top ?? `none:${chat.workspaceId}:${chat.agentId}`
        const found = watched.get(watchedKey)
        if (found) {
          found.listeners.add(listener)
          entry = found
          if (found.last) listener(found.last)
          return
        }
        const fresh: Watched = {
          listeners: new Set([listener]),
          last: null,
          reading: null,
          timer: null,
          stopped: false,
        }
        watched.set(watchedKey, fresh)
        entry = fresh
        const tick = () => {
          void readNow(top, fresh)
            .catch(() => undefined)
            .finally(() => {
              if (!fresh.stopped && top) fresh.timer = timers.setTimeout(tick, pollMs)
            })
        }
        tick()
      })
      return () => {
        stopped = true
        if (!entry || !watchedKey) return
        entry.listeners.delete(listener)
        if (entry.listeners.size > 0) return
        entry.stopped = true
        if (entry.timer !== null) timers.clearTimeout(entry.timer)
        watched.delete(watchedKey)
      }
    },

    async diff(chat, selection) {
      const top = await rootOf(chat)
      if (!top) return { ok: false, code: 'not_found', message: NO_CHECKOUT }
      if (!(await allowed(top, selection)))
        return { ok: false, code: 'not_found', message: 'That commit is not one of this branch’s.' }
      const diff = await diffBranchSelection(top, selection)
      return {
        ok: true,
        files: diff.files.slice(0, CONVERSATION_MAX_CHANGED_FILES).map((file) => ({
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        })),
        additions: diff.additions,
        deletions: diff.deletions,
      }
    },

    async file(chat, selection, path) {
      const top = await rootOf(chat)
      if (!top) return { ok: false, code: 'not_found', message: NO_CHECKOUT }
      if (!(await allowed(top, selection)))
        return { ok: false, code: 'not_found', message: 'That commit is not one of this branch’s.' }
      // Only a file the step lists, as it reads now.
      const listed = (await diffBranchSelection(top, selection)).files.find((file) => file.path === path)
      if (!listed) return { ok: false, code: 'not_found', message: 'That file is not among these changes.' }
      // The revisions the Diff tab reads a step between (branchSteps.ts,
      // `revsForSelection`), worked out here rather than taken from the device.
      const from =
        selection.kind === 'commit'
          ? `${selection.hash}^`
          : selection.kind === 'uncommitted'
            ? 'HEAD'
            : ((await stepsOf(top)).baseOid ?? 'HEAD')
      const to = selection.kind === 'commit' ? selection.hash : null
      const original: ConversationChangedFileSide =
        listed.status === 'new' ? { kind: 'absent' } : await readRevSide(top, from, listed.oldPath ?? listed.path)
      const modified: ConversationChangedFileSide =
        listed.status === 'deleted'
          ? { kind: 'absent' }
          : to
            ? await readRevSide(top, to, listed.path)
            : await readWorktreeSide(top, listed.path)
      return { ok: true, original, modified }
    },
  }
}
