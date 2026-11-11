import {
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodDefinition,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_BOARD_FILES_CAPABILITY } from './handshake.js'

// Files under a workspace's roots: read, list, write, remove and watch, by a
// root and a path relative to it, never by an absolute path. The first
// members of the file family the server keeps (it holds raw access to its
// machine; everything on a screen is a client's), and what a client needs to
// run the canvas over a Studio's board files: the canvas service runs in the
// client, the boards stay on the server's disk.
//
// Owners only in this version. A write is atomic (a temp file beside the
// target, then a rename) and conditional on what the client last read
// (`ifMatch`, the SHA-256 of the file's bytes; null to create only), and in
// this version only a board (`*.excalidraw`) may be written or removed.

/**
 * Where a path is read from: the workspace's own folder, the board store
 * Studio keeps for it, or the project's store, where Studio keeps the rest of
 * what it knows about the project (the browser's captures and recordings, chat
 * transcripts) in the person's home rather than in the project. `store` is
 * additive: a Studio that serves it says `store: true` from `files.roots`, and
 * one built before it leaves the member out and refuses the kind.
 */
export type StudioFileRoot = { kind: 'boards' | 'workspace' | 'store'; workspaceId: string }

export type StudioFileEntry = { name: string; kind: 'file' | 'directory' }

export type StudioFileStat = { kind: 'file' | 'directory'; size: number; mtimeMs: number; hash?: string }

/** A conditional write that found the file other than the client expected: its hash now, null when absent. */
export type StudioFileConflict = { ok: false; code: 'conflict'; currentHash: string | null }

export type StudioFileWritten = { ok: true; hash: string; size: number; mtimeMs: number }

/** The most bytes one file read or written may be. A large answer is chunked; a large write is uploaded first. */
export const STUDIO_MAX_FILE_BYTES = 64 * 1024 * 1024

/** The only files this version writes or removes. */
export const STUDIO_WRITABLE_FILE_EXTENSIONS = ['.excalidraw'] as const

export type StudioFilesMethodMap = {
  /** Which roots a workspace has here. `store` is absent from a Studio that does not serve it. */
  'files.roots': {
    params: { workspaceId: string }
    result: { workspace: boolean; boards: boolean; store?: boolean }
    errors: 'not_found'
  }
  /** One level of a directory. A symbolic link is listed as neither kind, and is not followed. */
  'files.list': {
    params: { root: StudioFileRoot; path: string }
    result: { entries: StudioFileEntry[] }
    errors: 'not_found'
  }
  'files.read': {
    params: { root: StudioFileRoot; path: string }
    result: { text: string; hash: string; size: number; mtimeMs: number }
    errors: 'not_found'
  }
  /** Atomic, conditional; parents are created. `uploadId` names bytes staged with `uploads.begin { purpose: 'file' }`. */
  'files.write': {
    params: {
      root: StudioFileRoot
      path: string
      text?: string
      uploadId?: string
      ifMatch: string | null
      commandId: string
    }
    result: StudioFileWritten | StudioFileConflict
    errors: 'not_found'
  }
  'files.remove': {
    params: { root: StudioFileRoot; path: string; ifMatch: string | null; commandId: string }
    result: { ok: true; removed: boolean } | StudioFileConflict
    errors: 'not_found'
  }
}

export type StudioFilesMethod = keyof StudioFilesMethodMap

export type StudioFilesTopicMap = {
  /** The names in one directory that changed, debounced. */
  'files.watch': { params: { root: StudioFileRoot; path: string }; payload: { names: string[] }; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** A root, or null. */
export function parseStudioFileRoot(value: unknown): StudioFileRoot | null {
  if (
    !record(value) ||
    (value.kind !== 'boards' && value.kind !== 'workspace' && value.kind !== 'store') ||
    !id(value.workspaceId)
  )
    return null
  return { kind: value.kind, workspaceId: value.workspaceId }
}

/**
 * A path under a root: relative, with `/` between its parts, and nothing that
 * could leave the root by its spelling (a `..` part, a drive, a leading `/`, a
 * backslash, a NUL). The empty path is the root itself. A Studio still checks
 * that what the path names, symbolic links followed, stays inside the root.
 */
export function isStudioRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false
  if (value === '') return true
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((part) => part !== '..' && part !== '')
}

/** Whether this version may write or remove the file a path names. */
export function isStudioWritableFile(path: string): boolean {
  const lower = path.toLowerCase()
  return STUDIO_WRITABLE_FILE_EXTENSIONS.some(
    (extension) => lower.endsWith(extension) && lower.length > extension.length,
  )
}

const ROOT = '"root" is { kind: "boards" | "workspace" | "store", workspaceId }.'
const PATH = '"path" is relative to its root, with "/" between parts and no "..".'
const HASH = /^[0-9a-f]{64}$/

type Located = { root: StudioFileRoot; path: string }

/** A root and a path under it, or why not. */
function located(value: Record<string, unknown>): StudioParsed<Located> {
  const root = parseStudioFileRoot(value.root)
  if (!root) return refuse(ROOT)
  if (!isStudioRelativePath(value.path)) return refuse(PATH)
  return studioParams({ root, path: value.path })
}

/** A write's or a removal's common members: a board it may change, its condition and its command id. */
function conditional(
  value: Record<string, unknown>,
): StudioParsed<Located & { ifMatch: string | null; commandId: string }> {
  const at = located(value)
  if (!at.ok) return at
  if (!id(value.commandId)) return refuse('"commandId" must be a string of 1 to 200 characters.')
  if (!isStudioWritableFile(at.params.path)) return refuse('Only a board (*.excalidraw) may be written or removed.')
  if (value.ifMatch !== null && !(typeof value.ifMatch === 'string' && HASH.test(value.ifMatch)))
    return refuse('"ifMatch" is the SHA-256 of the file as last read, or null to create it.')
  return studioParams({ ...at.params, ifMatch: value.ifMatch, commandId: value.commandId })
}

const reading = {
  scope: 'files:read',
  mutation: false,
  capability: STUDIO_BOARD_FILES_CAPABILITY,
  owner: true,
} as const
const writing = {
  scope: 'files:write',
  mutation: true,
  capability: STUDIO_BOARD_FILES_CAPABILITY,
  owner: true,
} as const

const readingAt: StudioMethodDefinition<StudioFilesMethodMap['files.list' | 'files.read']> = {
  ...reading,
  params: located,
}

export const STUDIO_FILES_METHODS: StudioMethodTable<StudioFilesMethodMap> = {
  'files.roots': {
    ...reading,
    params: (value) =>
      id(value.workspaceId)
        ? studioParams({ workspaceId: value.workspaceId })
        : refuse('"workspaceId" names the workspace.'),
  },
  'files.list': readingAt,
  'files.read': readingAt,
  'files.write': {
    ...writing,
    params: (value) => {
      const common = conditional(value)
      if (!common.ok) return common
      const hasText = typeof value.text === 'string'
      const hasUpload = id(value.uploadId)
      if (hasText === hasUpload) return refuse('A write carries "text", or the "uploadId" of bytes staged for it.')
      return studioParams({
        ...common.params,
        ...(hasText ? { text: value.text as string } : { uploadId: value.uploadId as string }),
      })
    },
  },
  'files.remove': { ...writing, params: conditional },
}

export const STUDIO_FILES_TOPICS: StudioTopicTable<StudioFilesTopicMap> = {
  'files.watch': {
    scope: 'files:read',
    capability: STUDIO_BOARD_FILES_CAPABILITY,
    owner: true,
    push: true,
    params: located,
  },
}
