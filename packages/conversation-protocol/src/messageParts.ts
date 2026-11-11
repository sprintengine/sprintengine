// What a message carries beside its words, as Studio's own composer sends it:
// the files and folders it @-mentions, and the files it attaches by path.
// Every way a message reaches a chat reads them with these.

export type ConversationMentionRef = { path: string; kind: 'file' | 'folder'; line?: number; endLine?: number }
export const MAX_CONVERSATION_MENTIONS = 50
export function parseConversationMentions(value: unknown): ConversationMentionRef[] | null {
  if (!Array.isArray(value) || value.length > MAX_CONVERSATION_MENTIONS) return null
  const refs: ConversationMentionRef[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null
    const raw = candidate as Record<string, unknown>
    if (
      typeof raw.path !== 'string' ||
      !raw.path ||
      raw.path.length > 4096 ||
      /[\u0000-\u001f]/u.test(raw.path) ||
      !['file', 'folder'].includes(String(raw.kind))
    )
      return null
    if (raw.line !== undefined && (typeof raw.line !== 'number' || !Number.isSafeInteger(raw.line) || raw.line < 1))
      return null
    if (
      raw.endLine !== undefined &&
      (typeof raw.endLine !== 'number' || !Number.isSafeInteger(raw.endLine) || raw.endLine < Number(raw.line ?? 1))
    )
      return null
    refs.push({
      path: raw.path,
      kind: raw.kind as 'file' | 'folder',
      ...(raw.line === undefined ? {} : { line: raw.line as number }),
      ...(raw.endLine === undefined ? {} : { endLine: raw.endLine as number }),
    })
  }
  return refs
}

// Files attached to a message by path: dropped, picked or pasted from the
// person's own computer into a composer. Each travels on the send and on the
// `user_message` it becomes as `{ path }`, beside the words rather than in
// them: the agent is told about them in its own copy of the message, and a
// view draws them from this list — never from the text, where a path someone
// typed must stay the words they typed.
//
// The path is absolute and names a file on the machine the conversation runs
// on, so only a view on that machine can open it; any other draws its name.

export type ConversationAttachedFile = { path: string }

/** The most files one message may attach. */
export const MAX_CONVERSATION_ATTACHED_FILES = 50
const MAX_PATH_CHARS = 4096

// Absolute on any of the systems a conversation may run on: POSIX, a Windows
// drive, or a Windows UNC path.
function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]/u.test(path)
}

/**
 * A message's attached files, read off a send or a recorded event: each an
 * absolute path, bounded, with no control characters, and each once. Null when
 * the value is not such a list; a caller decides whether that refuses a send
 * or leaves a replayed bubble without cards.
 */
export function parseConversationAttachedFiles(value: unknown): ConversationAttachedFile[] | null {
  if (!Array.isArray(value) || value.length > MAX_CONVERSATION_ATTACHED_FILES) return null
  const files: ConversationAttachedFile[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null
    const path = (candidate as Record<string, unknown>).path
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > MAX_PATH_CHARS ||
      /[\u0000-\u001f]/u.test(path) ||
      !isAbsoluteFilePath(path)
    )
      return null
    if (seen.has(path)) continue
    seen.add(path)
    files.push({ path })
  }
  return files
}

/** The last segment of an attached file's path, whichever separator it uses. */
export function attachedFileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path
}
