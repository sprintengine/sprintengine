// The files by path, as the Studio protocol defines them (`file-system.ts`,
// `chat.ts`), under the names the app has always used.
// ../electron-api.ts re-exports everything here.

// What the Studio protocol's `files.stat` and `files.search` answer by an
// absolute path; these are their names here.
export type {
  ContentSearchEntry,
  ContentSearchResult,
  FileWatchEvent,
  StudioPathStat as FileSystemStat,
  StudioFileSearchEntry as FileSearchEntry,
  StudioFileSearchEngine as FileSearchEngine,
  StudioFileSearchResult as FileSearchResult,
} from '../../../packages/studio-protocol/src/public'
