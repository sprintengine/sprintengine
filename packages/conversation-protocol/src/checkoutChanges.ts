// A chat's changes, read where it is followed (`conversation-changes`): what
// the desktop's own Diff tab shows when its Changes row is pressed. The chat's
// checkout is the desktop's, so the desktop reads it and says what it found:
// the branch's commits as steps, the files of one step with their line counts,
// and the two sides of one of those files. Nothing else of the checkout is
// readable this way. A file is read only as a side of a step it is listed in,
// at the revisions the desktop works out for that step itself, so a client
// names a step and a path and never a revision or a folder.
//
// Each request is answered by a `result` under its `requestId`; a desktop
// without the capability answers `invalid_frame`, which is the fallback each
// is shaped for: a client sends one only where the capability is advertised.
// All of it needs only `conversation:read`, as reading the transcript does.

/** Which slice of the branch a step is: everything it produced, what is uncommitted, or one commit. */
export type ConversationChangesSelection = { kind: 'span' } | { kind: 'uncommitted' } | { kind: 'commit'; hash: string }

/** One commit of the branch, ahead of the default branch. */
export type ConversationChangesStep = {
  hash: string
  shortHash: string
  subject: string
  /** Epoch ms. */
  authoredAt: number
  /** More than one parent: its diff is what the merge brought in. */
  isMerge: boolean
}

/**
 * How the chat's checkout stands, as the desktop's Diff tab reads it: the
 * branch, where the whole branch is measured from, how much of it may be
 * claimed as the chat's (`ConversationWireChangeScope`), its commits oldest
 * first, and whether anything is uncommitted.
 */
export type ConversationCheckoutChanges = {
  branch: string | null
  baseOid: string | null
  scope: 'worktree' | 'branch' | 'folder'
  steps: ConversationChangesStep[]
  hasUncommitted: boolean
}

/**
 * The followed chat's checkout, whole each time (`conversation-changes`).
 * `changes` is null for a chat whose folder is not a repository on the
 * desktop, or one it cannot read. `revision` moves whenever anything the
 * Diff tab shows may have, the text of a file already changed included, so a
 * client reads what it has open again when it moves.
 */
export type ConversationChangesFrame = {
  type: 'changes'
  key: { workspaceId: string; agentId: string }
  changes: ConversationCheckoutChanges | null
  revision: string
}

/** One file of a step. `oldPath` names where a rename came from. */
export type ConversationChangedFile = {
  path: string
  status: 'new' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  oldPath?: string
}

/** A step's files, as a `result`'s `data` carries them. */
export type ConversationChangesDiff = {
  files: ConversationChangedFile[]
  additions: number
  deletions: number
}

/** One side of a changed file: its text, not there at all, or too large to send. */
export type ConversationChangedFileSide =
  { kind: 'content'; content: string } | { kind: 'absent' } | { kind: 'too-large' }

/** Both sides of a changed file, as a `result`'s `data` carries them. */
export type ConversationChangedFileSides = {
  original: ConversationChangedFileSide
  modified: ConversationChangedFileSide
}

/** The most commits a `changes` frame names: the newest, when the branch has more. */
export const CONVERSATION_MAX_CHANGES_STEPS = 500
/** The most files a step's answer lists. */
export const CONVERSATION_MAX_CHANGED_FILES = 5_000
/** The longest path a file request may name. */
export const CONVERSATION_MAX_CHANGED_PATH_CHARS = 4_096
/** The largest side the desktop sends; a bigger one is `too-large`, as its own Diff tab says. */
export const CONVERSATION_MAX_CHANGED_FILE_BYTES = 5 * 1024 * 1024

// A commit as git names it, never an option: the desktop hands it to git.
const COMMIT_HASH = /^[0-9a-f]{7,40}$/i
const SCOPES = new Set(['worktree', 'branch', 'folder'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/** A step a client asked for, or null for one in the wrong shape. */
export function parseConversationChangesSelection(value: unknown): ConversationChangesSelection | null {
  if (!record(value)) return null
  if (value.kind === 'span' || value.kind === 'uncommitted') return { kind: value.kind }
  if (value.kind === 'commit' && typeof value.hash === 'string' && COMMIT_HASH.test(value.hash))
    return { kind: 'commit', hash: value.hash }
  return null
}

/** A path a client may name: relative, inside the checkout, and short enough to read. */
export function isConversationChangedPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > CONVERSATION_MAX_CHANGED_PATH_CHARS) return false
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-z]:/i.test(value) || value.includes('\0')) return false
  return !value.split(/[\\/]/u).some((part) => part === '..')
}

function step(value: unknown): ConversationChangesStep | null {
  if (
    !record(value) ||
    typeof value.hash !== 'string' ||
    !COMMIT_HASH.test(value.hash) ||
    !text(value.shortHash, 40) ||
    !text(value.subject, 2_000) ||
    !count(value.authoredAt) ||
    typeof value.isMerge !== 'boolean'
  )
    return null
  return {
    hash: value.hash,
    shortHash: value.shortHash,
    subject: value.subject,
    authoredAt: value.authoredAt,
    isMerge: value.isMerge,
  }
}

/** A checkout as a `changes` frame says it, or null when it is in the wrong shape. */
export function parseConversationCheckoutChanges(value: unknown): ConversationCheckoutChanges | null {
  if (!record(value) || !Array.isArray(value.steps) || typeof value.hasUncommitted !== 'boolean') return null
  if (!(value.branch === null || text(value.branch, 1_000))) return null
  if (!(value.baseOid === null || (typeof value.baseOid === 'string' && COMMIT_HASH.test(value.baseOid)))) return null
  const steps: ConversationChangesStep[] = []
  for (const entry of value.steps.slice(-CONVERSATION_MAX_CHANGES_STEPS)) {
    // A commit this client cannot read is left out; the others still step.
    const read = step(entry)
    if (read) steps.push(read)
  }
  return {
    branch: value.branch as string | null,
    baseOid: value.baseOid as string | null,
    // A scope this client does not know claims the least.
    scope: SCOPES.has(value.scope as string) ? (value.scope as ConversationCheckoutChanges['scope']) : 'folder',
    steps,
    hasUncommitted: value.hasUncommitted,
  }
}

/** A `changes` frame, or null for one in the wrong shape. */
export function parseConversationChangesFrame(frame: Record<string, unknown>): ConversationChangesFrame | null {
  const key = frame.key
  if (!record(key) || !id(key.workspaceId) || !id(key.agentId) || !id(frame.revision)) return null
  const changes = frame.changes === null ? null : parseConversationCheckoutChanges(frame.changes)
  if (frame.changes !== null && !changes) return null
  return {
    type: 'changes',
    key: { workspaceId: key.workspaceId, agentId: key.agentId },
    changes,
    revision: frame.revision,
  }
}
