import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  STUDIO_FILE_VIEW_MAX_BYTES,
  type StudioFileViewConflict,
  type StudioFileViewRead,
  type StudioFileViewWritten,
} from '../../../packages/studio-protocol/src/public'
import { writeFileAtomically } from '../../main/config-file-write'
import { expandHomePath } from '../../main/home-path'
import { writeFileAtomic } from '../platform/atomic-file'

// The files a chat's agent showed the person in the chat (`file.view`), and
// their reads and saves (`fileViews.*` on the Studio protocol).
//
// Who may write what. The agent's tool only opens a view: it resolves the
// paths it was given, checks each is a text file a view can hold, and writes
// down that this chat showed them (the ledger). It never writes a file. A
// save comes from the person, typing in the view, over a client's own
// connection to this Studio, and is carried out only for a path the chat's
// ledger holds. That is what lets a view open a file outside every folder
// Studio knows (a `CLAUDE.md` in the person's home): the agent chose to show
// it, and the person chose to change it. A path no view of the chat showed is
// answered as not there, whatever the client may otherwise name.
//
// The ledger is kept on disk (`file-views.json` in Studio's data folder), so
// a view in yesterday's chat still saves after a restart. It is bounded: a
// chat keeps its most recent MAX_PATHS_PER_CHAT files, and the ledger its most
// recent MAX_CHATS chats; a view whose file fell out is read-only until its
// agent shows it again.
//
// Every save is conditional on the file as the view last read it: a file
// changed on disk since (by the agent, an editor, `git pull`) is answered
// `conflict` and left alone, and the view says so. Saves to one file are
// carried out one at a time, each checking what the one before it wrote.

/** The most files one call shows: tabs past this many are no longer a glance. */
export const FILE_VIEW_MAX_FILES = 8
/** The most ranges one file marks. */
export const FILE_VIEW_MAX_HIGHLIGHTS = 20
/** The longest note beside a range. */
export const FILE_VIEW_MAX_NOTE_CHARS = 200

const MAX_PATHS_PER_CHAT = 64
const MAX_CHATS = 500
const LEDGER_FILE = 'file-views.json'
const LEDGER_VERSION = 1
/** How much of a file is looked at to tell text from bytes. */
const TEXT_SNIFF_BYTES = 8_192

export type FileViewChat = { workspaceId: string; agentId: string }

export type FileViewHighlight = { from: number; to: number; note?: string }

/** One file the agent asked to show, as its call gave it. */
export type FileViewRequest = { path: string; highlights?: FileViewHighlight[] }

/** One file shown: its real path, which the view reads and saves by. */
export type FileViewShown = {
  path: string
  name: string
  lines: number
  highlights: FileViewHighlight[]
}

export type FileViewFailure = { path: string; reason: string }

export type FileViewRefusal = { ok: false; code: 'not_found' | 'too_large' | 'unavailable'; message: string }

export type FileViewsDeps = {
  dataDir: string
  /** The folder a chat works in, for a path its agent gave relative to it; null when it has none. */
  folderOf(chat: FileViewChat): string | null
  home?: string
  now?: () => number
}

type Ledger = { version: number; chats: Record<string, { at: number; paths: string[] }> }

const chatId = (chat: FileViewChat) => `${chat.workspaceId}\u0000${chat.agentId}`
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code

/** Whether bytes read as text: no NUL in what was looked at. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, TEXT_SNIFF_BYTES)
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0) return false
  return true
}

/** The highlights a call gave, read leniently into whole, ordered line ranges within the file; the rest dropped. */
export function readHighlights(value: unknown, lines: number): FileViewHighlight[] {
  if (!Array.isArray(value)) return []
  const ranges: FileViewHighlight[] = []
  for (const item of value.slice(0, FILE_VIEW_MAX_HIGHLIGHTS)) {
    if (!item || typeof item !== 'object') continue
    const { from, to, note } = item as Record<string, unknown>
    if (typeof from !== 'number' || !Number.isFinite(from)) continue
    const start = Math.max(1, Math.min(lines, Math.trunc(from)))
    const end = typeof to === 'number' && Number.isFinite(to) ? Math.max(1, Math.min(lines, Math.trunc(to))) : start
    const text = typeof note === 'string' ? note.trim().slice(0, FILE_VIEW_MAX_NOTE_CHARS) : ''
    ranges.push({ from: Math.min(start, end), to: Math.max(start, end), ...(text ? { note: text } : {}) })
  }
  return ranges.sort((a, b) => a.from - b.from)
}

export type FileViews = ReturnType<typeof createFileViews>

export function createFileViews(deps: FileViewsDeps) {
  const now = deps.now ?? Date.now
  const ledgerPath = join(deps.dataDir, LEDGER_FILE)
  let ledger: Ledger | null = null
  let writing: Promise<void> = Promise.resolve()
  /** Saves to one real path, one at a time. */
  const saving = new Map<string, Promise<unknown>>()

  async function load(): Promise<Ledger> {
    if (ledger) return ledger
    try {
      const parsed = JSON.parse(await readFile(ledgerPath, 'utf8')) as Partial<Ledger>
      const chats: Ledger['chats'] = {}
      if (parsed?.version === LEDGER_VERSION && parsed.chats && typeof parsed.chats === 'object')
        for (const [id, entry] of Object.entries(parsed.chats)) {
          if (!entry || typeof entry !== 'object' || !Array.isArray(entry.paths)) continue
          chats[id] = {
            at: typeof entry.at === 'number' ? entry.at : 0,
            paths: entry.paths.filter((path): path is string => typeof path === 'string'),
          }
        }
      ledger ??= { version: LEDGER_VERSION, chats }
    } catch {
      ledger ??= { version: LEDGER_VERSION, chats: {} }
    }
    return ledger
  }

  async function remember(chat: FileViewChat, paths: readonly string[]): Promise<void> {
    const kept = await load()
    const id = chatId(chat)
    const before = kept.chats[id]?.paths ?? []
    const next = [...before.filter((path) => !paths.includes(path)), ...paths].slice(-MAX_PATHS_PER_CHAT)
    kept.chats[id] = { at: now(), paths: next }
    const ids = Object.keys(kept.chats)
    if (ids.length > MAX_CHATS) {
      ids.sort((a, b) => kept.chats[a]!.at - kept.chats[b]!.at)
      for (const old of ids.slice(0, ids.length - MAX_CHATS)) delete kept.chats[old]
    }
    const snapshot = JSON.stringify(kept)
    writing = writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(deps.dataDir, { recursive: true })
        await writeFileAtomic(ledgerPath, snapshot, { mode: 0o600 })
      })
    await writing
  }

  /** Whether the chat showed this real path. */
  async function shown(chat: FileViewChat, path: string): Promise<boolean> {
    return (await load()).chats[chatId(chat)]?.paths.includes(path) ?? false
  }

  /** A path as the agent gave it: `~/` is the home folder, a relative one is the chat's folder's. */
  function placed(chat: FileViewChat, raw: string): string | null {
    const expanded = expandHomePath(raw.trim(), deps.home)
    if (isAbsolute(expanded)) return resolve(expanded)
    const folder = deps.folderOf(chat)
    return folder ? resolve(folder, expanded) : null
  }

  /** Read a file a view may hold, by its real path. */
  async function readText(
    path: string,
  ): Promise<{ ok: true; read: StudioFileViewRead; bytes: Buffer } | FileViewRefusal> {
    let info
    try {
      info = await stat(path)
    } catch (error) {
      return {
        ok: false,
        code: 'not_found',
        message: errorCode(error) === 'ENOENT' ? 'The file is gone.' : String(error),
      }
    }
    if (!info.isFile()) return { ok: false, code: 'not_found', message: 'Not a file.' }
    if (info.size > STUDIO_FILE_VIEW_MAX_BYTES)
      return {
        ok: false,
        code: 'too_large',
        message: `The file is ${Math.ceil(info.size / 1024)} KB; a view opens files up to ${STUDIO_FILE_VIEW_MAX_BYTES / 1024 / 1024} MB.`,
      }
    const bytes = await readFile(path)
    if (!looksLikeText(bytes)) return { ok: false, code: 'unavailable', message: 'The file is not text.' }
    return {
      ok: true,
      bytes,
      read: { text: bytes.toString('utf8'), hash: sha256(bytes), size: bytes.length, mtimeMs: info.mtimeMs },
    }
  }

  /**
   * The agent's `file.view`: each file resolved to its real path, checked, and
   * written down as this chat's. Nothing is read beyond what the check needs,
   * and nothing is written to any of them.
   */
  async function show(
    chat: FileViewChat,
    files: readonly FileViewRequest[],
  ): Promise<{ shown: FileViewShown[]; failed: FileViewFailure[] }> {
    const shownFiles: FileViewShown[] = []
    const failed: FileViewFailure[] = []
    for (const file of files) {
      const at = placed(chat, file.path)
      if (!at) {
        failed.push({ path: file.path, reason: 'A relative path needs the chat’s folder, and this chat has none.' })
        continue
      }
      let real: string
      try {
        real = await realpath(at)
      } catch (error) {
        failed.push({
          path: file.path,
          reason: errorCode(error) === 'ENOENT' ? `There is no file at ${at}.` : String(error),
        })
        continue
      }
      const read = await readText(real)
      if (!read.ok) {
        failed.push({ path: file.path, reason: read.message })
        continue
      }
      const lines = read.read.text.split('\n').length
      if (!shownFiles.some((entry) => entry.path === real))
        shownFiles.push({
          path: real,
          name: real.split(/[\\/]/u).pop() ?? real,
          lines,
          highlights: readHighlights(file.highlights, lines),
        })
    }
    if (shownFiles.length > 0)
      await remember(
        chat,
        shownFiles.map((file) => file.path),
      )
    return { shown: shownFiles, failed }
  }

  /** The real path of a file the chat showed, or why not. */
  async function ownPath(chat: FileViewChat, path: string): Promise<{ ok: true; path: string } | FileViewRefusal> {
    const refused: FileViewRefusal = {
      ok: false,
      code: 'not_found',
      message: 'This chat did not show that file. Ask its agent to show it again.',
    }
    if (!(await shown(chat, path))) return refused
    // Followed again: a link put at the path since is not the file that was shown.
    const real = await realpath(path).catch(() => null)
    if (real !== null && real !== path) return refused
    return { ok: true, path }
  }

  async function read(
    chat: FileViewChat,
    path: string,
  ): Promise<{ ok: true; read: StudioFileViewRead } | FileViewRefusal> {
    const own = await ownPath(chat, path)
    if (!own.ok) return own
    const read = await readText(own.path)
    return read.ok ? { ok: true, read: read.read } : read
  }

  async function write(
    chat: FileViewChat,
    path: string,
    text: string,
    ifMatch: string,
  ): Promise<{ ok: true; written: StudioFileViewWritten | StudioFileViewConflict } | FileViewRefusal> {
    const own = await ownPath(chat, path)
    if (!own.ok) return own
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > STUDIO_FILE_VIEW_MAX_BYTES)
      return { ok: false, code: 'too_large', message: 'A view saves files up to 2 MB.' }
    const before = saving.get(own.path) ?? Promise.resolve()
    const run = before
      .catch(() => undefined)
      .then(
        async (): Promise<{ ok: true; written: StudioFileViewWritten | StudioFileViewConflict } | FileViewRefusal> => {
          const current = await readFile(own.path).catch((error: unknown) => {
            if (errorCode(error) === 'ENOENT') return null
            throw error
          })
          const currentHash = current === null ? null : sha256(current)
          if (currentHash !== ifMatch) return { ok: true, written: { ok: false, code: 'conflict', currentHash } }
          try {
            await writeFileAtomically(own.path, text)
          } catch (error) {
            return { ok: false, code: 'unavailable', message: `The file could not be saved: ${String(error)}` }
          }
          const info = await stat(own.path)
          return { ok: true, written: { ok: true, hash: sha256(bytes), size: bytes.length, mtimeMs: info.mtimeMs } }
        },
      )
    saving.set(own.path, run)
    try {
      return await run
    } finally {
      if (saving.get(own.path) === run) saving.delete(own.path)
    }
  }

  return { show, read, write, readHighlights }
}
