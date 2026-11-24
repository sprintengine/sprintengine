import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { gitUrlPublisher, publisherFromOwner } from '../../../../packages/extension-sdk/src/catalogue'
import {
  EXTENSION_MANIFEST_FILENAME,
  parseExtensionManifest,
  type ExtensionManifest,
} from '../../../../packages/extension-sdk/src/extension-manifest'
import {
  fetchGitCommit,
  isFetchableGitUrl,
  materializeGitTree,
  type GitOptions,
} from '../../../../packages/extension-sdk/src/git-source'
import { computeModuleFileDigestsSync } from '../../../../packages/extension-sdk/src/module-files'
import { extensionContentFingerprint } from '../../../../packages/extension-sdk/src/signing'
import type { ModuleFileDigests } from '../../../shared/modules/manifest'
import { convertClaudePlugin } from './claude-plugin-extension'

// One extension's folder at one commit, written into a staging folder of its
// own, its manifest read and its content identity computed exactly as the
// install computes it. The install copies this folder; nothing here runs the
// extension's code.

export type CheckedOut = {
  /** The staging folder holding the extension's files; removed by `dispose`. */
  dir: string
  commit: string
  contentHash: string
  files: ModuleFileDigests
  manifest: ExtensionManifest
  strippedLinks: string[]
  /** What was left out: files an extension never ships, and a Claude Code plugin's parts Studio does not install. */
  leftOut: string[]
  dispose(): Promise<void>
}

export type CheckOutResult =
  | { ok: true; checkedOut: CheckedOut }
  | {
      ok: false
      message: string
      /** A Claude Code plugin marketplace's plugin folders, when the folder checked out is one. */
      folders?: string[]
    }

/**
 * The plugin folders a Claude Code plugin marketplace lists
 * (`.claude-plugin/marketplace.json`, its plugins' relative `source`s), or
 * null when the folder is not one.
 */
function marketplaceFolders(dir: string): string[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'))
  } catch {
    return null
  }
  const plugins = (raw as { plugins?: unknown } | null)?.plugins
  if (!Array.isArray(plugins)) return null
  const folders = plugins.flatMap((plugin) => {
    const source = (plugin as { source?: unknown } | null)?.source
    if (typeof source !== 'string') return []
    const folder = source.replace(/^\.\/+/, '').replace(/\/+$/, '')
    return folder && !folder.startsWith('/') && !folder.split('/').includes('..') ? [folder] : []
  })
  return [...new Set(folders)].sort().slice(0, 100)
}

/**
 * The publisher a source takes: the owner of its repository. A `file://` URL
 * (a development Studio's fixtures) takes the folder its repository is in.
 */
export function sourcePublisher(url: string): string | null {
  const fromUrl = gitUrlPublisher(url)
  if (fromUrl) return fromUrl
  try {
    const path = url.startsWith('file://') ? fileURLToPath(url) : url.startsWith('/') ? url : null
    return path ? publisherFromOwner(basename(dirname(path))) : null
  } catch {
    return null
  }
}

export async function checkOutExtension(input: {
  url: string
  ref: string
  path?: string
  /** A Claude Code plugin repository becomes an extension of its skills and MCP servers (git URL installs). */
  claudePlugins?: boolean
  git: GitOptions
}): Promise<CheckOutResult> {
  if (!isFetchableGitUrl(input.url, input.git))
    return { ok: false, message: 'The git URL must use HTTPS or SSH, with no password or token in it.' }
  let fetched: Awaited<ReturnType<typeof fetchGitCommit>>
  try {
    fetched = await fetchGitCommit({ url: input.url, ref: input.ref, ...input.git })
  } catch (error) {
    return { ok: false, message: `Studio could not fetch ${input.url} at ${input.ref}: ${(error as Error).message}` }
  }
  const staging = await mkdtemp(join(tmpdir(), 'sprintengine-extension-install-'))
  const dir = join(staging, 'extension')
  const dispose = () => rm(staging, { recursive: true, force: true })
  try {
    const tree = await materializeGitTree({
      repository: fetched.repository,
      commit: fetched.commit,
      destination: dir,
      ...(input.path ? { path: input.path } : {}),
      ...input.git,
    })
    const leftOut = [...tree.leftOut]
    if (input.claudePlugins) {
      const converted = await convertClaudePlugin(dir)
      if (converted.kind === 'refused') {
        await dispose()
        return { ok: false, message: converted.message }
      }
      if (converted.kind === 'converted') leftOut.push(...converted.leftOut)
    }
    let source: string
    try {
      source = readFileSync(join(dir, EXTENSION_MANIFEST_FILENAME), 'utf8')
    } catch {
      // A marketplace holds its plugins in folders: say which, to name one.
      const folders = input.claudePlugins ? marketplaceFolders(dir) : null
      await dispose()
      if (folders && folders.length > 0)
        return {
          ok: false,
          message: `${input.path ? `${input.path} of that repository` : 'That repository'} is a Claude Code plugin marketplace. Name the folder of the plugin to install: ${folders.join(', ')}.`,
          folders,
        }
      return {
        ok: false,
        message: `There is no ${EXTENSION_MANIFEST_FILENAME} in ${input.path ? `${input.path} of ` : ''}that repository at ${fetched.commit.slice(0, 12)}. If the extension is in a folder of it, name the folder.`,
      }
    }
    const parsed = parseExtensionManifest(source)
    if (!parsed.ok) {
      await dispose()
      return {
        ok: false,
        message: `Its extension.json is invalid: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
      }
    }
    const digests = computeModuleFileDigestsSync(dir)
    if (!digests.ok) {
      await dispose()
      return {
        ok: false,
        message: `It holds files an extension cannot ship: ${digests.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
      }
    }
    return {
      ok: true,
      checkedOut: {
        dir,
        commit: fetched.commit,
        contentHash: extensionContentFingerprint(digests.files),
        files: digests.files,
        manifest: parsed.manifest,
        strippedLinks: tree.strippedLinks,
        leftOut,
        dispose,
      },
    }
  } catch (error) {
    await dispose()
    return { ok: false, message: `Studio could not check the extension out: ${(error as Error).message}` }
  } finally {
    await fetched.dispose()
  }
}
