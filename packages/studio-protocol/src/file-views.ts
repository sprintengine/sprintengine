import { studioParams, studioParamsRefused as refuse, type StudioMethodTable, type StudioParsed } from './contract.js'
import { STUDIO_FILE_VIEWS_CAPABILITY } from './handshake.js'
import { isStudioPath, parseStudioConversationKey, type StudioConversationKey } from './key.js'

// A file a chat's agent showed the person (its `file.view` tool), read and
// saved from the chat, on the Studio the chat lives on. The agent's call opens
// the view; what the person types in it is saved here, by these methods,
// which only a client's own connection reaches, never an agent's tools.
//
// A file is reached through the chat that showed it: the key names the chat,
// and the Studio answers only for a path that chat's agent showed, whether or
// not it is inside a folder Studio knows (a `CLAUDE.md` in the person's
// home). Anything else is `not_found`, as a path a client may not name is.
//
// Every save is conditional on the file as the client last read it
// (`ifMatch`, the SHA-256 of its bytes): a file changed on disk since is
// answered `conflict` with its hash now, and left as it is. A save replaces
// the file at once (a file beside it, then a rename), keeping its mode.
//
// Reading needs `conversation:read`; saving `conversation:operate`, which a
// client that can drive the chat (and so ask its agent to change the file)
// already holds. Offered as `file-views`.

/** The largest file a view opens: bigger than any file a person edits in a chat. */
export const STUDIO_FILE_VIEW_MAX_BYTES = 2 * 1024 * 1024

/** A file as a view reads it: its text, and what a save is conditional on. */
export type StudioFileViewRead = { text: string; hash: string; size: number; mtimeMs: number }

/** A save that landed: the file's hash now, which the next save is conditional on. */
export type StudioFileViewWritten = { ok: true; hash: string; size: number; mtimeMs: number }

/** A save refused because the file changed on disk since it was read: its hash now, null when it is gone. */
export type StudioFileViewConflict = { ok: false; code: 'conflict'; currentHash: string | null }

export type StudioFileViewsMethodMap = {
  'fileViews.read': {
    params: { key: StudioConversationKey; path: string }
    result: StudioFileViewRead
    /** `not_found`: not a file this chat showed, or gone. `too_large`: past what a view opens. `unavailable`: not text. */
    errors: 'not_found' | 'too_large'
  }
  'fileViews.write': {
    params: { key: StudioConversationKey; path: string; text: string; ifMatch: string; commandId: string }
    result: StudioFileViewWritten | StudioFileViewConflict
    /** `unavailable`: the disk refused the save, in its words. */
    errors: 'not_found' | 'too_large'
  }
}

export type StudioFileViewsMethod = keyof StudioFileViewsMethodMap

const HASH = /^[0-9a-f]{64}$/
const KEY = '"key" names the chat that showed the file.'
const PATH = '"path" is the file’s absolute path, as the view was given it.'

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function viewed(value: Record<string, unknown>): StudioParsed<{ key: StudioConversationKey; path: string }> {
  const key = parseStudioConversationKey(value.key)
  if (!key) return refuse(KEY)
  if (!isStudioPath(value.path)) return refuse(PATH)
  return studioParams({ key, path: value.path })
}

export const STUDIO_FILE_VIEWS_METHODS: StudioMethodTable<StudioFileViewsMethodMap> = {
  'fileViews.read': {
    scope: 'conversation:read',
    mutation: false,
    capability: STUDIO_FILE_VIEWS_CAPABILITY,
    params: viewed,
  },
  'fileViews.write': {
    scope: 'conversation:operate',
    mutation: true,
    capability: STUDIO_FILE_VIEWS_CAPABILITY,
    params: (value) => {
      const at = viewed(value)
      if (!at.ok) return at
      if (!id(value.commandId)) return refuse('"commandId" must be a string of 1 to 200 characters.')
      if (typeof value.text !== 'string') return refuse('"text" is the file’s new contents.')
      if (value.text.length > STUDIO_FILE_VIEW_MAX_BYTES)
        return refuse(`A view saves at most ${STUDIO_FILE_VIEW_MAX_BYTES} bytes.`, 'too_large')
      if (typeof value.ifMatch !== 'string' || !HASH.test(value.ifMatch))
        return refuse('"ifMatch" is the SHA-256 of the file as last read.')
      return studioParams({ ...at.params, text: value.text, ifMatch: value.ifMatch, commandId: value.commandId })
    },
  },
}
