// Digests of an extension's own files: what `sprintengine-extension sign`
// records in `extension.sig`, the content identity Studio binds a trust grant
// to, and what it checks again before it loads or serves the extension's code.
//
// Reached through the `@sprintengine/extension-sdk/signing` subpath (it needs
// node:crypto and node:fs, and the root index must stay loadable in a
// renderer). The app and the CLI both walk a folder through this file, so what
// an author signs and what the app accepts cannot disagree about which files
// count.
//
// The walk refuses what a module cannot vouch for rather than skipping it: a
// symbolic link (its bytes live somewhere the digest does not follow), anything
// that is not a regular file or a directory, and a name no manifest could
// record. Only extension.sig at the root is left out, because it carries the
// digests; extension.json is covered like any other file.

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { EXTENSION_SIGNATURE_FILENAME } from './extension-manifest.js'
import type { ModuleFileDigests } from './index.js'
import {
  compareModuleFileDigests,
  isPackExcludedPath,
  isSafeManifestRelativePath,
  type ThirdPartyManifestIssue,
} from './manifest-validate.js'

/**
 * Which files count.
 *
 * - `installed` (the default): every file in the folder. node_modules, .git and
 *   key files are refused, because pack never ships them — a folder that has
 *   one is a source tree, not a module.
 * - `pack`: the folder as `sprintengine-extension pack` will copy it, with those
 *   paths left out. What `sign` records, so a module can be signed in its
 *   source tree and still match once packed.
 * - `development`: a development folder, the author's working copy, which
 *   Studio loads where it is. node_modules, .git, key files, every dotted
 *   folder (an editor's or a tool's, such as `.sprintengine/`) and symbolic
 *   links are left out rather than refused, at any depth: none of them is
 *   ever served or run from the folder, and their churn is not an edit. It
 *   holds at most `DEVELOPMENT_FOLDER_MAX_FILES` files and
 *   `DEVELOPMENT_FOLDER_MAX_BYTES` bytes, so a folder pointed at the wrong
 *   place (a home folder) is refused rather than read whole.
 */
export type ModuleFileWalk = 'installed' | 'pack' | 'development'

/** The most files a development folder may hold (what is left out does not count). */
export const DEVELOPMENT_FOLDER_MAX_FILES = 2000
/** The most bytes a development folder's files may hold together. */
export const DEVELOPMENT_FOLDER_MAX_BYTES = 50 * 1024 * 1024

/** Whether a development folder leaves a path out: what pack leaves out, and anything dotted. */
export function isDevelopmentSkippedPath(relativePath: string): boolean {
  return isPackExcludedPath(relativePath) || relativePath.split('/').some((segment) => segment.startsWith('.'))
}

export type ModuleFileDigestOptions = { walk?: ModuleFileWalk }

export type ModuleFileDigestsResult =
  { ok: true; files: ModuleFileDigests } | { ok: false; files: ModuleFileDigests; issues: ThirdPartyManifestIssue[] }

/** sha256 of every file the module ships, keyed by POSIX path relative to its root. */
export function computeModuleFileDigestsSync(
  moduleRoot: string,
  options: ModuleFileDigestOptions = {},
): ModuleFileDigestsResult {
  const walk = options.walk ?? 'installed'
  const development = walk === 'development'
  const found: ModuleFileDigests = {}
  const issues: ThirdPartyManifestIssue[] = []
  let count = 0
  let bytes = 0
  let tooBig = false

  const visit = (absoluteDir: string, relativeDir: string): void => {
    let names: string[]
    try {
      names = readdirSync(absoluteDir).sort()
    } catch (error) {
      issues.push({ path: fileIssuePath(relativeDir), message: `could not be read: ${errorMessage(error)}.` })
      return
    }
    for (const name of names) {
      if (tooBig) return
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name
      if (relativePath === EXTENSION_SIGNATURE_FILENAME) continue
      const issuePath = fileIssuePath(relativePath)
      // A dotted file or folder at any depth is a tool's (.gitignore, .vscode/), never served.
      if (development && (name.startsWith('.') || isDevelopmentSkippedPath(relativePath))) continue
      if (!isSafeManifestRelativePath(relativePath)) {
        issues.push({ path: issuePath, message: 'has a name extension.sig cannot record.' })
        continue
      }
      if (isPackExcludedPath(relativePath)) {
        if (walk === 'installed') {
          issues.push({
            path: issuePath,
            message: 'cannot be part of an extension: node_modules, .git and key files are never packed or installed.',
          })
        }
        continue
      }
      const absolutePath = join(absoluteDir, name)
      let entry
      try {
        entry = lstatSync(absolutePath)
      } catch (error) {
        issues.push({ path: issuePath, message: `could not be read: ${errorMessage(error)}.` })
        continue
      }
      if (entry.isSymbolicLink()) {
        // A link in a working copy is left out: Studio never follows one out of the folder.
        if (development) continue
        issues.push({ path: issuePath, message: 'is a symbolic link; an extension ships regular files only.' })
      } else if (entry.isDirectory()) {
        visit(absolutePath, relativePath)
      } else if (!entry.isFile()) {
        if (development) continue
        issues.push({ path: issuePath, message: 'is not a regular file; an extension ships regular files only.' })
      } else {
        if (development) {
          count += 1
          bytes += entry.size
          if (count > DEVELOPMENT_FOLDER_MAX_FILES || bytes > DEVELOPMENT_FOLDER_MAX_BYTES) {
            tooBig = true
            issues.push({
              path: 'files',
              message: `a development folder holds at most ${DEVELOPMENT_FOLDER_MAX_FILES} files and ${DEVELOPMENT_FOLDER_MAX_BYTES / 1024 / 1024} MiB, leaving out node_modules, .git and dotted folders.`,
            })
            return
          }
        }
        found[relativePath] = createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
      }
    }
  }

  let rootIsDirectory = false
  try {
    rootIsDirectory = statSync(moduleRoot).isDirectory()
  } catch {
    rootIsDirectory = false
  }
  if (rootIsDirectory) visit(moduleRoot, '')
  else issues.push({ path: 'files', message: 'the extension folder does not exist or is not a directory.' })

  const files: ModuleFileDigests = {}
  for (const path of Object.keys(found).sort()) files[path] = found[path]!
  return issues.length > 0 ? { ok: false, files, issues } : { ok: true, files }
}

/**
 * Everything wrong between a module folder and the digests it is held to:
 * files that cannot be digested at all, then the exact-set comparison. Empty
 * means the folder holds exactly the listed files with exactly the listed
 * bytes.
 */
export function moduleFileDigestIssuesSync(
  moduleRoot: string,
  expected: ModuleFileDigests,
  options: ModuleFileDigestOptions & { label?: string } = {},
): ThirdPartyManifestIssue[] {
  const actual = computeModuleFileDigestsSync(moduleRoot, options)
  return [...(actual.ok ? [] : actual.issues), ...compareModuleFileDigests(expected, actual.files, options.label)]
}

function fileIssuePath(relativePath: string): string {
  return relativePath ? `files.${relativePath}` : 'files'
}

// The error code, not the message: a message names the absolute path, and
// these issues reach the app's UI.
function errorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : 'read error'
}
