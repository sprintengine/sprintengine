// Part of the IPC contract: file watching, stat, and file and content search.
// ../electron-api.ts re-exports everything here.

export interface FileWatchEvent {
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

// What the Studio protocol's `files.stat` and `files.search` answer by an
// absolute path; these are their names here.
export type {
  StudioPathStat as FileSystemStat,
  StudioFileSearchEntry as FileSearchEntry,
  StudioFileSearchEngine as FileSearchEngine,
  StudioFileSearchResult as FileSearchResult,
} from '../../../packages/studio-protocol/src/public'

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
