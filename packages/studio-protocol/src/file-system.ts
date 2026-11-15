import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_FILE_SYSTEM_CAPABILITY } from './handshake.js'
import { isStudioPath } from './key.js'

// The files on a Studio's machine by their absolute paths: what the Files
// pane, the editor, the previews, the palette and a new project's checks read
// and change. Offered as `file-system` by every Studio's core, so a window, a
// paired desktop, a browser tab and the phone reach one machine's files the
// same way, on whichever machine the Studio runs.
//
// The family beside it (`files.ts`) addresses a workspace's files by a root
// and a relative path, for the canvas's boards. The search, stat, picture and
// repository-root reads in `chat.ts` take absolute paths as these do, and the
// same core serves them.
//
// Grants. Reading is `files:read`; changing a file, a folder or a name is
// `files:write`. A client that is not an owner (or an owner's connection held
// to known folders, as a tailnet one is) names paths only inside the folders
// Studio knows. A Studio resolves the path it was given, every link
// followed and every `..` taken, and refuses one whose real place is outside
// them as if it were not there (`not_found`). Its writes are held to the
// workspaces' own folders, never Studio's stores of what chats sent.
//
// Every write carries a `commandId`: a retry under it is answered with the
// first attempt's outcome, so a retried create does not fail as "already
// exists" on its own file.

/** One entry of a folder, as `files.listDirectory` answers it. Links are listed as what they are, unfollowed. */
export type StudioDirectoryEntry = { name: string; isDir: boolean }

/** Whether a folder can be a workspace's: there, and readable in time. */
export type WorkspaceFolderCheckResult =
  | { ok: true; status: 'ready'; path: string; checkedPath: string; message: string }
  | {
      ok: false
      status: 'missing' | 'inaccessible' | 'timeout'
      path: string
      checkedPath: string
      message: string
      code?: string
    }

/**
 * A logo found at the top level of a project's repository. `dataUrl` is the
 * sanitized image ready for an icon slot (downscaled where the Studio's
 * machine has an image codec, else at its own bytes under the size guard);
 * `path` and `mtimeMs` are what a client re-checks on the next open.
 */
export type ProjectLogo = {
  path: string
  mtimeMs: number
  dataUrl: string
}

export type ContentSearchEntry = {
  name: string
  path: string
  parentPath: string
  lineNumber: number
  column: number
  lineText: string
  matchText: string
}

export type ContentSearchResult =
  | {
      ok: true
      results: ContentSearchEntry[]
      truncated: boolean
      engine: 'ripgrep'
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }

/** One burst of changes under a watched folder. */
export type FileWatchEvent = {
  /** `rename` when anything in the burst was created, deleted or renamed. */
  eventType: string
  /** The first path in `paths`, or null when none is known. */
  path: string | null
  /**
   * Every distinct root-relative path that changed inside one coalescing
   * window. Empty with `overflow` set when the OS gave no name or the burst was
   * too large to list: the consumer should re-read.
   */
  paths?: string[]
  overflow?: boolean
}

/** What a copy does when its destination's name is taken. */
export type StudioCopyConflict = 'rename' | 'fail' | 'overwrite'

/** The most text one `files.writeText` carries. */
export const STUDIO_MAX_TEXT_WRITE_CHARS = 64 * 1024 * 1024
/** The most base64 one dropped picture carries (32 MB of bytes). */
export const STUDIO_MAX_DROPPED_IMAGE_CHARS = Math.ceil((32 * 1024 * 1024 * 4) / 3) + 4

type Commanded<P> = P & { commandId: string }
type Path = { path: string }
type Unknown = 'not_found'

export type StudioFileSystemMethodMap = {
  'files.listDirectory': { params: Path; result: { entries: StudioDirectoryEntry[] }; errors: Unknown }
  /** A text file's contents, up to Studio's size limit for text. */
  'files.readText': { params: Path; result: { text: string }; errors: Unknown }
  /** Whether anything is there. A path the client may not name is answered as absent. */
  'files.exists': { params: Path; result: { exists: boolean } }
  'files.checkWorkspaceFolder': { params: Path; result: WorkspaceFolderCheckResult; errors: Unknown }
  /** The logo at the top of a project's folder, if any. A folder the client may not name has none. */
  'files.projectLogo': { params: { folderPath: string }; result: { logo: ProjectLogo | null } }
  /** A picture chosen as a project's icon. One the client may not name is none. */
  'files.projectIcon': { params: Path; result: { logo: ProjectLogo | null } }
  /** Lines matching `query` under a folder. A newer search from the same connection ends this one. */
  'files.searchContent': {
    params: { rootPath: string; query: string; limit?: number }
    result: ContentSearchResult
    errors: Unknown
  }
  'files.cancelContentSearch': { params: Record<string, never>; result: Record<string, never> }
  /** Where a new project's folder goes by default: Documents, else home. Null for a client that may not name it. */
  'files.defaultWorkspaceParent': { params: Record<string, never>; result: { path: string | null } }
  /**
   * Write a text file. `roots` are the folders of the project it was opened
   * in: a save there does not write through a link that leads out of them.
   */
  'files.writeText': {
    params: Commanded<{ path: string; text: string; roots?: string[] }>
    result: Record<string, never>
    errors: Unknown
  }
  /** Keep a dropped or pasted picture in Studio's own picture folder; answers where. */
  'files.saveDroppedImage': {
    params: Commanded<{ mediaType: string; dataBase64: string }>
    result: { path: string }
  }
  /** A new empty file named `name` in a folder; fails if the name is taken. */
  'files.createFile': {
    params: Commanded<{ parentPath: string; name: string }>
    result: { path: string }
    errors: Unknown
  }
  /** A new folder named `name`; with `existing: 'keep'`, one already there (and any missing parents) is fine. */
  'files.createDirectory': {
    params: Commanded<{ parentPath: string; name: string; existing?: 'keep' }>
    result: { path: string }
    errors: Unknown
  }
  /** Give a file or folder another name in the same folder. */
  'files.rename': { params: Commanded<{ path: string; name: string }>; result: { path: string }; errors: Unknown }
  /** Copy a file or folder into another folder, by `onConflict` when its name is taken there. */
  'files.copy': {
    params: Commanded<{ path: string; toFolder: string; onConflict: StudioCopyConflict }>
    result: { path: string }
    errors: Unknown
  }
  /** Move a file or folder into another folder; fails if its name is taken there. */
  'files.move': { params: Commanded<{ path: string; toFolder: string }>; result: { path: string }; errors: Unknown }
  /** Move a file or folder to the Trash of the Studio's machine, where it has one. */
  'files.trash': { params: Commanded<Path>; result: Record<string, never>; errors: Unknown }
}

export type StudioFileSystemMethod = keyof StudioFileSystemMethodMap

export type StudioFileSystemTopicMap = {
  /** Changes under one folder, coalesced, until the client unsubscribes. */
  'files.watchPath': {
    params: { path: string; includeIgnored?: boolean }
    payload: FileWatchEvent
    stream: 'push'
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
/** One name, never a path: what a new or renamed entry is called. The Studio checks the rest. */
function entryName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[/\\\0]/u.test(value)
}

const PATH = '"path" is a path on the Studio’s machine.'
const COMMAND_ID = '"commandId" must be a string of 1 to 200 characters.'

function path(value: Record<string, unknown>): StudioParsed<Path> {
  return isStudioPath(value.path) ? studioParams({ path: value.path }) : refuse(PATH)
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

function named(value: Record<string, unknown>): StudioParsed<{ parentPath: string; name: string }> {
  if (!isStudioPath(value.parentPath)) return refuse('"parentPath" is the folder it goes in.')
  if (!entryName(value.name)) return refuse('"name" is one file or folder name, with no separators.')
  return studioParams({ parentPath: value.parentPath, name: value.name })
}

function moving(value: Record<string, unknown>): StudioParsed<{ path: string; toFolder: string }> {
  const at = path(value)
  if (!at.ok) return at
  if (!isStudioPath(value.toFolder)) return refuse('"toFolder" is the folder it goes into.')
  return studioParams({ path: at.params.path, toFolder: value.toFolder })
}

const reading = { scope: 'files:read', mutation: false, capability: STUDIO_FILE_SYSTEM_CAPABILITY } as const
const writing = { scope: 'files:write', mutation: true, capability: STUDIO_FILE_SYSTEM_CAPABILITY } as const

export const STUDIO_FILE_SYSTEM_METHODS: StudioMethodTable<StudioFileSystemMethodMap> = {
  'files.listDirectory': { ...reading, params: path },
  'files.readText': { ...reading, params: path },
  'files.exists': { ...reading, params: path },
  'files.checkWorkspaceFolder': { ...reading, params: path },
  'files.projectLogo': {
    ...reading,
    params: (value) =>
      isStudioPath(value.folderPath)
        ? studioParams({ folderPath: value.folderPath })
        : refuse('"folderPath" is the project’s folder.'),
  },
  'files.projectIcon': { ...reading, params: path },
  'files.searchContent': {
    ...reading,
    params: (value) => {
      if (!isStudioPath(value.rootPath)) return refuse('"rootPath" is the folder to search.')
      if (typeof value.query !== 'string' || value.query.length > 1000)
        return refuse('"query" is at most 1000 characters.')
      if (
        value.limit !== undefined &&
        !(typeof value.limit === 'number' && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 5000)
      )
        return refuse('"limit" is between 1 and 5000.')
      return studioParams({
        rootPath: value.rootPath,
        query: value.query,
        ...(value.limit === undefined ? {} : { limit: value.limit as number }),
      })
    },
  },
  'files.cancelContentSearch': { ...reading, params: studioNoParams },
  'files.defaultWorkspaceParent': { ...reading, params: studioNoParams },
  'files.writeText': {
    ...writing,
    params: commanded((value) => {
      const at = path(value)
      if (!at.ok) return at
      if (typeof value.text !== 'string' || value.text.length > STUDIO_MAX_TEXT_WRITE_CHARS)
        return refuse('"text" is the file’s new contents.')
      if (
        value.roots !== undefined &&
        !(Array.isArray(value.roots) && value.roots.length <= 64 && value.roots.every(isStudioPath))
      )
        return refuse('"roots" lists the project’s folders.')
      return studioParams({
        path: at.params.path,
        text: value.text,
        ...(value.roots === undefined ? {} : { roots: [...(value.roots as string[])] }),
      })
    }),
  },
  'files.saveDroppedImage': {
    ...writing,
    params: commanded((value) => {
      if (typeof value.mediaType !== 'string' || !/^image\/[a-z0-9.+-]{1,60}$/iu.test(value.mediaType))
        return refuse('"mediaType" is the picture’s image type.')
      if (
        typeof value.dataBase64 !== 'string' ||
        value.dataBase64.length === 0 ||
        value.dataBase64.length > STUDIO_MAX_DROPPED_IMAGE_CHARS
      )
        return refuse('"dataBase64" is the picture, at most 32 MB.')
      return studioParams({ mediaType: value.mediaType, dataBase64: value.dataBase64 })
    }),
  },
  'files.createFile': { ...writing, params: commanded(named) },
  'files.createDirectory': {
    ...writing,
    params: commanded((value) => {
      const at = named(value)
      if (!at.ok) return at
      if (value.existing !== undefined && value.existing !== 'keep') return refuse('"existing" is "keep" or absent.')
      return studioParams({ ...at.params, ...(value.existing === 'keep' ? { existing: 'keep' as const } : {}) })
    }),
  },
  'files.rename': {
    ...writing,
    params: commanded((value) => {
      const at = path(value)
      if (!at.ok) return at
      if (!entryName(value.name)) return refuse('"name" is the new name, with no separators.')
      return studioParams({ path: at.params.path, name: value.name })
    }),
  },
  'files.copy': {
    ...writing,
    params: commanded((value) => {
      const at = moving(value)
      if (!at.ok) return at
      if (value.onConflict !== 'rename' && value.onConflict !== 'fail' && value.onConflict !== 'overwrite')
        return refuse('"onConflict" is "rename", "fail" or "overwrite".')
      return studioParams({ ...at.params, onConflict: value.onConflict })
    }),
  },
  'files.move': { ...writing, params: commanded(moving) },
  'files.trash': { ...writing, params: commanded(path) },
}

export const STUDIO_FILE_SYSTEM_TOPICS: StudioTopicTable<StudioFileSystemTopicMap> = {
  'files.watchPath': {
    scope: 'files:read',
    capability: STUDIO_FILE_SYSTEM_CAPABILITY,
    push: true,
    params: (value) => {
      const at = path(value)
      if (!at.ok) return at
      if (value.includeIgnored !== undefined && typeof value.includeIgnored !== 'boolean')
        return refuse('"includeIgnored" is true or false.')
      return studioParams({ path: at.params.path, ...(value.includeIgnored === true ? { includeIgnored: true } : {}) })
    },
  },
}
