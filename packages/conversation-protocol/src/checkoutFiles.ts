// A chat's files, read and changed where it is followed
// (`conversation-checkout-files`): what the desktop's own Files tab shows for
// the chat, which is the folder the chat works in there (its worktree when it
// has one). The folder is the desktop's, so the desktop lists it, reads a file
// of it, says when something in it moved, and makes the few changes the Files
// tab and the editor make: a save, a new file or folder, a rename or move, and
// a delete.
//
// A client names a path relative to that folder, never a folder of its own,
// and the desktop keeps every read and write inside it: a path with `..` is
// refused before it is read, and one whose folder leads out through a link is
// refused when it is. A link inside the folder is listed for what it points at
// when that is inside the folder too, and as a file nothing can open otherwise.
//
// Each request is answered by a `result` under its `requestId`; a desktop
// without the capability answers `invalid_frame`, which is the fallback each is
// shaped for: a client sends one only where the capability is advertised.
// Listing, reading and watching need `conversation:read`, as reading the
// transcript does. A change needs `conversation:operate`, as a send does, and a
// desktop refuses one without it under its id, `conversation_operate_required`.

/** A path in the chat's folder, `/` between its segments; `''` is the folder itself. */
export type ConversationCheckoutPath = string

/** List one folder of the chat's folder. Answered with a `ConversationCheckoutFolder`. */
export type ConversationListCheckoutFolderRequest = {
  type: 'listCheckoutFolder'
  requestId: string
  path: ConversationCheckoutPath
}

/** Read one file of the chat's folder. Answered with a `ConversationCheckoutFile`. */
export type ConversationReadCheckoutFileRequest = {
  type: 'readCheckoutFile'
  requestId: string
  path: ConversationCheckoutPath
}

/**
 * Have the desktop say when anything in the chat's folder moves, in
 * `checkoutFiles` frames, until `stop`, until the socket follows another chat,
 * or until it closes. Sent again after each subscription's fence while the
 * client still wants it, as `watchChanges` is.
 */
export type ConversationWatchCheckoutFilesRequest = { type: 'watchCheckoutFiles'; requestId: string; stop?: true }

/** One change to the chat's folder, as the desktop's own Files tab and editor make them. */
export type ConversationCheckoutFileChange =
  /** Write a file's whole text, making it when it is not there. */
  | { kind: 'write'; path: ConversationCheckoutPath; content: string }
  /** Make an empty file, refused when something is already there. */
  | { kind: 'createFile'; path: ConversationCheckoutPath }
  /** Make a folder, refused when something is already there. */
  | { kind: 'createFolder'; path: ConversationCheckoutPath }
  /** Rename or move a file or folder within the chat's folder, refused when `to` is taken. */
  | { kind: 'rename'; path: ConversationCheckoutPath; to: ConversationCheckoutPath }
  /** Delete a file or folder: to the desktop's Trash where it has one, refused where it has none. */
  | { kind: 'delete'; path: ConversationCheckoutPath }

/** Make one change. Answered with `{ path }`, where the thing changed now is (`''` after a delete). */
export type ConversationChangeCheckoutFileRequest = {
  type: 'changeCheckoutFile'
  requestId: string
  change: ConversationCheckoutFileChange
}

/** One entry of a folder. `ignored` where git ignores it, as the Files tab dims it. */
export type ConversationCheckoutEntry = { name: string; kind: 'file' | 'folder'; ignored?: true }

/**
 * A folder's entries, as a `result`'s `data` carries them, and the chat's
 * folder itself as the desktop names it: its last segment and its whole path
 * there, for words only. `truncated` says there were more entries than a
 * listing carries.
 */
export type ConversationCheckoutFolder = {
  root: { name: string; path: string }
  entries: ConversationCheckoutEntry[]
  truncated: boolean
}

/** A file as a `result`'s `data` carries it: its text, too large to send, or not text at all. */
export type ConversationCheckoutFile =
  { kind: 'text'; content: string } | { kind: 'too-large'; size: number } | { kind: 'binary' }

/**
 * Something in the followed chat's folder moved. `paths` names what moved,
 * relative to the folder, or is null when the desktop could not say (too many
 * at once, or its watch overflowed), which a client reads as "read again
 * whatever you hold".
 */
export type ConversationCheckoutFilesFrame = {
  type: 'checkoutFiles'
  key: { workspaceId: string; agentId: string }
  paths: ConversationCheckoutPath[] | null
}

/**
 * The same, as a client that follows the chat hands it on to whoever reads its
 * files: the chat is the one followed, so it names no key.
 */
export type ConversationCheckoutFilesNotice = Omit<ConversationCheckoutFilesFrame, 'key'>

/** Why a request about a chat's files was not answered, in words a client shows as they are. */
export type ConversationCheckoutFilesRefusal = { ok: false; code: string; message: string }
/** A folder's listing, as a client reads it, or why it could not be listed. */
export type ConversationCheckoutFolderResult =
  ({ ok: true } & ConversationCheckoutFolder) | ConversationCheckoutFilesRefusal
/** A file, as a client reads it, or why it could not be read. */
export type ConversationCheckoutFileResult =
  { ok: true; file: ConversationCheckoutFile } | ConversationCheckoutFilesRefusal
/** Where a change left what it changed, relative to the chat's folder, or why it was not made. */
export type ConversationCheckoutChangeResult =
  { ok: true; path: ConversationCheckoutPath } | ConversationCheckoutFilesRefusal

/** The most entries a folder's listing carries. */
export const CONVERSATION_MAX_CHECKOUT_ENTRIES = 5_000
/** The most paths one `checkoutFiles` frame names; past it, `paths` is null. */
export const CONVERSATION_MAX_CHECKOUT_MOVED_PATHS = 500
/** The longest path a request may name. */
export const CONVERSATION_MAX_CHECKOUT_PATH_CHARS = 4_096
/** The longest name an entry may have. */
const MAX_ENTRY_NAME_CHARS = 1_024
/** The largest file the desktop sends; a bigger one is `too-large`. */
export const CONVERSATION_MAX_CHECKOUT_FILE_BYTES = 5 * 1024 * 1024
/**
 * The longest text a `write` carries. The frame's own cap
 * (`CONVERSATION_MAX_CLIENT_FRAME_BYTES`) is the one that binds: a client
 * measures the frame it is about to send, and says a file too large to save
 * from there in words rather than sending it.
 */
export const CONVERSATION_MAX_CHECKOUT_WRITE_CHARS = 1_000_000

const CHANGE_KINDS = new Set(['write', 'createFile', 'createFolder', 'rename', 'delete'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/**
 * A path a client may name: relative, inside the chat's folder, `''` for the
 * folder itself, and short enough to read. Segments are split on either slash,
 * so a `..` cannot hide behind a backslash.
 */
export function isConversationCheckoutPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > CONVERSATION_MAX_CHECKOUT_PATH_CHARS) return false
  if (value === '') return true
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-z]:/i.test(value) || value.includes('\0')) return false
  return !value.split(/[\\/]/u).some((part) => part === '..' || part === '.')
}

/** A path that names something in the folder, never the folder itself. */
function entryPath(value: unknown): value is string {
  return value !== '' && isConversationCheckoutPath(value)
}

function parseChange(value: unknown): ConversationCheckoutFileChange | null {
  if (!record(value) || !CHANGE_KINDS.has(value.kind as string) || !entryPath(value.path)) return null
  const path = value.path
  switch (value.kind) {
    case 'write':
      return typeof value.content === 'string' && value.content.length <= CONVERSATION_MAX_CHECKOUT_WRITE_CHARS
        ? { kind: 'write', path, content: value.content }
        : null
    case 'createFile':
    case 'createFolder':
    case 'delete':
      return { kind: value.kind, path }
    case 'rename':
      return entryPath(value.to) ? { kind: 'rename', path, to: value.to } : null
    default:
      return null
  }
}

/** One of this file's client frames, or null when it is not one or is in the wrong shape. */
export function parseConversationCheckoutFilesRequest(
  value: Record<string, unknown>,
):
  | ConversationListCheckoutFolderRequest
  | ConversationReadCheckoutFileRequest
  | ConversationWatchCheckoutFilesRequest
  | ConversationChangeCheckoutFileRequest
  | null {
  if (!id(value.requestId)) return null
  const requestId = value.requestId
  if (value.type === 'watchCheckoutFiles') {
    if (value.stop !== undefined && value.stop !== true) return null
    return { type: 'watchCheckoutFiles', requestId, ...(value.stop === true ? { stop: true } : {}) }
  }
  if (value.type === 'listCheckoutFolder')
    return isConversationCheckoutPath(value.path) ? { type: 'listCheckoutFolder', requestId, path: value.path } : null
  if (value.type === 'readCheckoutFile')
    return entryPath(value.path) ? { type: 'readCheckoutFile', requestId, path: value.path } : null
  if (value.type === 'changeCheckoutFile') {
    const change = parseChange(value.change)
    return change ? { type: 'changeCheckoutFile', requestId, change } : null
  }
  return null
}

/** Whether a frame type is one of this file's client frames. */
export function isConversationCheckoutFilesRequestType(type: unknown): boolean {
  return (
    type === 'listCheckoutFolder' ||
    type === 'readCheckoutFile' ||
    type === 'watchCheckoutFiles' ||
    type === 'changeCheckoutFile'
  )
}

/** A name a listing may carry: one segment, never a path. */
function entryName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ENTRY_NAME_CHARS &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/\0]/u.test(value)
  )
}

/** A folder's listing from a `result`'s `data`, or null. An entry this client cannot read is left out alone. */
export function parseConversationCheckoutFolder(value: unknown): ConversationCheckoutFolder | null {
  if (!record(value) || !record(value.root) || !Array.isArray(value.entries) || typeof value.truncated !== 'boolean')
    return null
  const { name, path } = value.root
  if (typeof name !== 'string' || name.length > MAX_ENTRY_NAME_CHARS) return null
  if (typeof path !== 'string' || path.length > CONVERSATION_MAX_CHECKOUT_PATH_CHARS) return null
  const entries: ConversationCheckoutEntry[] = []
  for (const entry of value.entries.slice(0, CONVERSATION_MAX_CHECKOUT_ENTRIES)) {
    if (!record(entry) || !entryName(entry.name) || (entry.kind !== 'file' && entry.kind !== 'folder')) continue
    entries.push({ name: entry.name, kind: entry.kind, ...(entry.ignored === true ? { ignored: true } : {}) })
  }
  return { root: { name, path }, entries, truncated: value.truncated }
}

/** A file from a `result`'s `data`, or null. */
export function parseConversationCheckoutFile(value: unknown): ConversationCheckoutFile | null {
  if (!record(value)) return null
  if (value.kind === 'binary') return { kind: 'binary' }
  if (value.kind === 'too-large')
    return typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
      ? { kind: 'too-large', size: value.size }
      : null
  if (value.kind === 'text' && typeof value.content === 'string') return { kind: 'text', content: value.content }
  return null
}

/** Where a change left the thing it changed, from a `result`'s `data`, or null. */
export function parseConversationCheckoutChangeAnswer(value: unknown): { path: ConversationCheckoutPath } | null {
  return record(value) && isConversationCheckoutPath(value.path) ? { path: value.path } : null
}

/** A `checkoutFiles` frame, or null for one in the wrong shape. */
export function parseConversationCheckoutFilesFrame(
  frame: Record<string, unknown>,
): ConversationCheckoutFilesFrame | null {
  const key = frame.key
  if (!record(key) || !id(key.workspaceId) || !id(key.agentId)) return null
  let paths: string[] | null = null
  if (frame.paths !== null) {
    if (!Array.isArray(frame.paths) || frame.paths.length > CONVERSATION_MAX_CHECKOUT_MOVED_PATHS) return null
    // A path this client cannot read is one it cannot hold either: re-read what is held.
    paths = frame.paths.every(isConversationCheckoutPath) ? (frame.paths as string[]) : null
  }
  return { type: 'checkoutFiles', key: { workspaceId: key.workspaceId, agentId: key.agentId }, paths }
}
