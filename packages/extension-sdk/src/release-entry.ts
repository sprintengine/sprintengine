// `sprintengine-extension release-entry <dir>`: the release a catalogue lists
// for the committed HEAD of the repository holding an extension's folder.
// The folder is written out from the commit's own blobs and hashed exactly as
// Studio does at install (git-source.ts), so the entry's `contentHash` is the
// one Studio checks. Offline; never runs the extension's code.

import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  catalogueReleaseEntry,
  catalogueReleaseMismatch,
  gitUrlPublisher,
  isAllowedGitUrl,
  type CatalogueRelease,
  type CatalogueSource,
} from './catalogue.js'
import { EXTENSION_MANIFEST_FILENAME, parseExtensionManifest, studioReadsManifest } from './extension-manifest.js'
import { materializeGitTree, runGit } from './git-source.js'
import { computeModuleFileDigestsSync } from './module-files.js'
import { extensionContentFingerprint } from './signing.js'

export type ReleaseEntryReport = {
  /** The `releases` entry for HEAD; absent when HEAD holds no extension Studio could install. */
  entry?: CatalogueRelease
  /** The extension's folder in its repository, for the entry's `source.path`; absent at the root. */
  sourcePath?: string
  /** The entry's `id` and `source`, when the repository's `origin` is an HTTPS or SSH URL. */
  listing?: { id: string; source: CatalogueSource }
  /** Why there is no entry, or that uncommitted changes are not in it. */
  note?: string
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit(args, { cwd, maxBytes: 1024 * 1024 })).toString('utf8').trim()
}

async function committedEntry(
  dir: string,
  commit: string,
  sourcePath: string | undefined,
): Promise<{ entry: CatalogueRelease; id: string } | { note: string }> {
  const tree = await mkdtemp(join(tmpdir(), 'sprintengine-release-entry-'))
  const withoutTree = (message: string) => message.replaceAll(`${tree}${sep}`, '')
  try {
    try {
      await materializeGitTree({
        repository: dir,
        commit,
        destination: tree,
        ...(sourcePath ? { path: sourcePath } : {}),
      })
    } catch (error) {
      return { note: `no release entry: HEAD has no installable extension here (${(error as Error).message})` }
    }
    let source: string
    try {
      source = readFileSync(join(tree, EXTENSION_MANIFEST_FILENAME), 'utf8')
    } catch {
      return { note: `no release entry: HEAD has no ${EXTENSION_MANIFEST_FILENAME} in this folder; commit it first` }
    }
    const parsed = parseExtensionManifest(source)
    if (!parsed.ok)
      return {
        note: `no release entry: the committed ${EXTENSION_MANIFEST_FILENAME} is invalid (${parsed.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')})`,
      }
    const readable = studioReadsManifest(parsed.manifest)
    if (!readable.ok) return { note: `no release entry: ${readable.message}` }
    const digests = computeModuleFileDigestsSync(tree)
    if (!digests.ok)
      return {
        note: `no release entry: the committed folder is not installable (${digests.issues
          .map((issue) => withoutTree(`${issue.path}: ${issue.message}`))
          .join('; ')})`,
      }
    const contentHash = extensionContentFingerprint(digests.files)
    const entry = catalogueReleaseEntry(parsed.manifest, { commit, contentHash })
    // The entry must be what Studio checks the same bytes against.
    const mismatch = catalogueReleaseMismatch({ release: entry, manifest: parsed.manifest, commit, contentHash })
    if (mismatch) return { note: `no release entry: ${mismatch}` }
    return { entry, id: parsed.manifest.id }
  } finally {
    await rm(tree, { recursive: true, force: true })
  }
}

/** The catalogue release entry for HEAD of the repository holding `dir`. */
export async function releaseEntryForHead(dir: string): Promise<ReleaseEntryReport> {
  const prefix = await gitText(dir, ['rev-parse', '--show-prefix']).catch(() => null)
  if (prefix === null) return { note: 'no release entry: the extension is not in a git repository' }
  const sourcePath = prefix.replace(/\/$/, '') || undefined
  const commit = await gitText(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')
  if (!/^[0-9a-f]{40}$/.test(commit))
    return {
      ...(sourcePath ? { sourcePath } : {}),
      note: 'no release entry: HEAD is not a SHA-1 commit; commit the extension first',
    }
  const dirty = (await gitText(dir, ['status', '--porcelain', '--', '.']).catch(() => '')) !== ''
  const result = await committedEntry(dir, commit, sourcePath)
  const origin = await gitText(dir, ['remote', 'get-url', 'origin']).catch(() => '')
  const branch = await gitText(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')
  const publisher = isAllowedGitUrl(origin) ? gitUrlPublisher(origin) : null
  return {
    ...('entry' in result ? { entry: result.entry } : { note: result.note }),
    ...(sourcePath ? { sourcePath } : {}),
    ...('entry' in result && publisher
      ? {
          listing: {
            id: `${publisher}.${result.id}`,
            source: {
              url: origin,
              ref: branch === 'HEAD' ? 'main' : branch,
              ...(sourcePath ? { path: sourcePath } : {}),
            },
          },
        }
      : {}),
    ...(dirty && 'entry' in result ? { note: 'uncommitted changes are not in this release; commit them first' } : {}),
  }
}

/** What `release-entry` prints for a person. */
export function releaseEntryWords(dir: string, report: ReleaseEntryReport): string[] {
  const lines: string[] = []
  if (report.sourcePath)
    lines.push(`Catalogue source path (set "path" in this extension's "source"): ${JSON.stringify(report.sourcePath)}`)
  if (report.listing)
    lines.push(`Listed as ${report.listing.id}, from ${report.listing.source.url} (${report.listing.source.ref}).`)
  if (report.entry)
    lines.push(
      `Catalogue release entry for HEAD (newest first in "releases"):\n${JSON.stringify(report.entry, null, 2)}`,
    )
  if (report.note) lines.push(`${dir}: ${report.note}`)
  return lines
}
