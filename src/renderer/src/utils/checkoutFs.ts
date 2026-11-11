import type { FileSearchResult, FileWatchEvent } from '../../../shared/ipc/filesystem'
import { isPairedCheckoutPath, pairedCheckoutFs } from './pairedCheckout'

// The reads and writes the Files tab, its tree and the editor make, wherever
// the folder is. A path in a paired machine's chat folder (pairedCheckout.ts)
// is asked of that machine; every other path is this disk's, through
// `window.api` exactly as before. One module, so the tree and the editor never
// need to know there are two machines involved: they hand it a path.

export const checkoutFs = {
  readdir(path: string): Promise<{ name: string; isDir: boolean; ignored?: boolean }[]> {
    return isPairedCheckoutPath(path) ? pairedCheckoutFs.readdir(path) : window.api.readdir(path)
  },
  readfile(path: string): Promise<string> {
    return isPairedCheckoutPath(path) ? pairedCheckoutFs.readfile(path) : window.api.readfile(path)
  },
  pathExists(path: string): Promise<boolean> {
    return isPairedCheckoutPath(path) ? pairedCheckoutFs.pathExists(path) : window.api.pathExists(path)
  },
  writefile(path: string, content: string, options?: { roots?: readonly string[] }): Promise<void> {
    return isPairedCheckoutPath(path)
      ? pairedCheckoutFs.writefile(path, content)
      : window.api.writefile(path, content, options)
  },
  createFile(parentDir: string, name: string): Promise<string> {
    return isPairedCheckoutPath(parentDir)
      ? pairedCheckoutFs.createFile(parentDir, name)
      : window.api.createFile(parentDir, name)
  },
  createDir(parentDir: string, name: string): Promise<string> {
    return isPairedCheckoutPath(parentDir)
      ? pairedCheckoutFs.createDir(parentDir, name)
      : window.api.createDir(parentDir, name)
  },
  renamePath(sourcePath: string, nextName: string): Promise<string> {
    return isPairedCheckoutPath(sourcePath)
      ? pairedCheckoutFs.renamePath(sourcePath, nextName)
      : window.api.renamePath(sourcePath, nextName)
  },
  movePath(sourcePath: string, destinationDir: string): Promise<string> {
    return isPairedCheckoutPath(sourcePath) || isPairedCheckoutPath(destinationDir)
      ? pairedCheckoutFs.movePath(sourcePath, destinationDir)
      : window.api.movePath(sourcePath, destinationDir)
  },
  deletePath(targetPath: string): Promise<void> {
    return isPairedCheckoutPath(targetPath)
      ? pairedCheckoutFs.deletePath(targetPath)
      : window.api.deletePath(targetPath)
  },
  watchPath(path: string, cb: (event: FileWatchEvent) => void): Promise<() => Promise<void>> {
    return isPairedCheckoutPath(path) ? pairedCheckoutFs.watchPath(path, cb) : window.api.watchPath(path, cb)
  },
  searchFiles(rootPath: string, query: string, options?: { limit?: number }): Promise<FileSearchResult> {
    return isPairedCheckoutPath(rootPath)
      ? pairedCheckoutFs.searchFiles(rootPath, query, options)
      : window.api.searchFiles(rootPath, query, options)
  },
  /** Git's word on which paths it ignores; a paired folder's listing already says, so it is not asked. */
  checkIgnored(repoRoot: string, relativePaths: string[]): Promise<string[]> {
    return isPairedCheckoutPath(repoRoot) ? Promise.resolve([]) : window.api.checkIgnored(repoRoot, relativePaths)
  },
}
