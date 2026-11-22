import { lstatSync, readdirSync, readFileSync } from 'fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm } from 'fs/promises'
import { homedir } from 'os'
import { join, relative, sep } from 'path'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import {
  EXTENSION_MANIFEST_FILENAME,
  LOCAL_EXTENSION_PUBLISHER,
  capabilityManifestOf,
  extensionInstallKey,
  isReservedExtensionId,
  parseExtensionInstallKey,
  parseExtensionManifest,
  studioReadsManifest,
  type ExtensionManifest,
} from '../../shared/modules/third-party-manifest'
import { classifyExtension, type ExtensionStanding, type ExtensionStandingContext } from './module-signature'
import { resolveContainedPath } from './entry-containment'
import { contentFileIssues } from './extension-content'
import { readStudioEnv } from '../../shared/studio-env'
import { agentContributionIssues } from '../../server/extensions/agent-contributions/install-checks'

// Discovery and install of extensions under
// ~/.sprintengine/extensions/<publisher>.<id>/extension.json. The folder's
// name is the install key: the publisher Studio derived from where the
// extension came from (`local` for a folder), then the manifest's id. This
// layer validates, classifies and installs; it never runs extension code. An
// extension's standing (its signature, and whether the person approved it as
// it is) is decided over the folder's files every time, from the bytes on
// disk, not carried over from the install.

// SPRINTENGINE_USER_EXTENSION_ROOT redirects discovery for hermetic end-to-end
// testing (paired with SPRINTENGINE_USER_DATA_DIR temp profiles). It moves the
// install root only; approval applies to that root exactly as to the default one.
export function defaultUserModuleRoot(): string {
  const override = readStudioEnv('SPRINTENGINE_USER_EXTENSION_ROOT')?.trim()
  if (override) return override
  return join(homedir(), '.sprintengine', 'extensions')
}

type ModuleRejectionIssue = { path: string; message: string }
export type ModuleRejection = { path: string; issues: ModuleRejectionIssue[] }

export type InstalledModule = {
  /** The install key, `<publisher>.<id>`: the module id everything else knows it by. */
  key: string
  publisher: string
  /** What the module kernel lists it as. */
  manifest: CapabilityManifest
  extension: ExtensionManifest
  moduleRoot: string
  standing: ExtensionStanding
}

export type UserModuleListResult = {
  modules: InstalledModule[]
  rejected: ModuleRejection[]
}

export type InstallModuleResult =
  | {
      ok: true
      /** The install key. */
      id: string
      extension: ExtensionManifest
      standing: ExtensionStanding
      /** Symbolic links in the folder, left out of the copy, relative to it. */
      strippedLinks: string[]
    }
  | { ok: false; rejected: ModuleRejection; message: string }

async function readDirSafe(dir: string): Promise<import('fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function readDirSafeSync(dir: string): import('fs').Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// An install key never starts with a dot, so a dotted directory under the root
// is never an extension: it is this file's own install staging folder, or an
// editor's. Skipping it keeps a half-written install out of the rejected list.
function isHiddenModuleDir(name: string): boolean {
  return name.startsWith('.')
}

type LoadedManifest = { ok: true; extension: ExtensionManifest } | { ok: false; rejection: ModuleRejection }

// Validate extension.json's text for a folder, and that the folder's name is
// the install key of the manifest it holds.
function validateInstalledManifestSource(source: string, manifestPath: string, folderName: string): LoadedManifest {
  const key = parseExtensionInstallKey(folderName)
  if (!key) {
    return {
      ok: false,
      rejection: {
        path: manifestPath,
        issues: [{ path: '', message: `"${folderName}" is not an install key (<publisher>.<id>).` }],
      },
    }
  }
  // Only a folder install puts an extension here, so its key's publisher is
  // `local`; a folder named for another publisher was not put here by Studio.
  if (key.publisher !== LOCAL_EXTENSION_PUBLISHER || isReservedExtensionId(key.id)) {
    return {
      ok: false,
      rejection: {
        path: manifestPath,
        issues: [
          { path: '', message: `"${folderName}" is not a key Studio installs an extension from a folder under.` },
        ],
      },
    }
  }
  const result = parseExtensionManifest(source)
  if (!result.ok) return { ok: false, rejection: { path: manifestPath, issues: result.issues } }
  if (result.manifest.id !== key.id) {
    return {
      ok: false,
      rejection: {
        path: manifestPath,
        issues: [{ path: 'id', message: `"${result.manifest.id}" must match its folder "${folderName}".` }],
      },
    }
  }
  const readable = studioReadsManifest(result.manifest)
  if (!readable.ok) {
    return {
      ok: false,
      rejection: { path: manifestPath, issues: [{ path: 'engines.studio', message: readable.message }] },
    }
  }
  return { ok: true, extension: result.manifest }
}

function missingManifest(manifestPath: string, error: unknown): LoadedManifest {
  return {
    ok: false,
    rejection: {
      path: manifestPath,
      issues: [
        { path: '', message: error instanceof Error ? error.message : `${EXTENSION_MANIFEST_FILENAME} not found` },
      ],
    },
  }
}

async function loadManifestFromDir(moduleRoot: string, folderName: string): Promise<LoadedManifest> {
  const manifestPath = join(moduleRoot, EXTENSION_MANIFEST_FILENAME)
  try {
    return validateInstalledManifestSource(await readFile(manifestPath, 'utf8'), manifestPath, folderName)
  } catch (error) {
    return missingManifest(manifestPath, error)
  }
}

function loadManifestFromDirSync(moduleRoot: string, folderName: string): LoadedManifest {
  const manifestPath = join(moduleRoot, EXTENSION_MANIFEST_FILENAME)
  try {
    return validateInstalledManifestSource(readFileSync(manifestPath, 'utf8'), manifestPath, folderName)
  } catch (error) {
    return missingManifest(manifestPath, error)
  }
}

function installedModule(
  extension: ExtensionManifest,
  folderName: string,
  moduleRoot: string,
  ctx: ExtensionStandingContext,
): InstalledModule {
  const publisher = parseExtensionInstallKey(folderName)!.publisher
  return {
    key: folderName,
    publisher,
    manifest: capabilityManifestOf(folderName, publisher, extension),
    extension,
    moduleRoot,
    standing: classifyExtension(moduleRoot, folderName, extension, ctx),
  }
}

function sorted(result: UserModuleListResult): UserModuleListResult {
  result.modules.sort((a, b) => a.key.localeCompare(b.key))
  return result
}

/** Every installed extension, validated and classified, and the folders that hold none. */
export async function discoverUserModules(root: string, ctx: ExtensionStandingContext): Promise<UserModuleListResult> {
  const result: UserModuleListResult = { modules: [], rejected: [] }
  for (const entry of await readDirSafe(root)) {
    if (!entry.isDirectory() || isHiddenModuleDir(entry.name)) continue
    const moduleRoot = join(root, entry.name)
    const loaded = await loadManifestFromDir(moduleRoot, entry.name)
    if (loaded.ok) result.modules.push(installedModule(loaded.extension, entry.name, moduleRoot, ctx))
    else result.rejected.push(loaded.rejection)
  }
  return sorted(result)
}

export function discoverUserModulesSync(root: string, ctx: ExtensionStandingContext): UserModuleListResult {
  const result: UserModuleListResult = { modules: [], rejected: [] }
  for (const entry of readDirSafeSync(root)) {
    if (!entry.isDirectory() || isHiddenModuleDir(entry.name)) continue
    const moduleRoot = join(root, entry.name)
    const loaded = loadManifestFromDirSync(moduleRoot, entry.name)
    if (loaded.ok) result.modules.push(installedModule(loaded.extension, entry.name, moduleRoot, ctx))
    else result.rejected.push(loaded.rejection)
  }
  return sorted(result)
}

/**
 * Install the extension in a folder: validate its extension.json, then copy
 * the folder into `<root>/local.<id>/`, REPLACING any earlier install of that
 * key. Symbolic links are left out of the copy and named in the result, for
 * the install review to show: their bytes live somewhere no digest follows.
 * The standing of the bytes that were installed comes back: what the person is asked to approve.
 */
export async function installModuleFolder(
  selectedDir: string,
  root: string,
  ctx: ExtensionStandingContext,
  options: { protectedProviderIds?: ReadonlySet<string> } = {},
): Promise<InstallModuleResult> {
  // The folder itself, wherever a link to it points: a linked root would be
  // copied as the link, and the extension would never appear. A missing one
  // is said by the read below.
  const srcDir = await realpath(selectedDir).catch(() => selectedDir)
  const manifestPath = join(srcDir, EXTENSION_MANIFEST_FILENAME)
  let source: string
  try {
    // A linked manifest is read through the link and then left out of the
    // copy, so it is refused rather than half installed.
    if ((await lstat(manifestPath)).isSymbolicLink()) {
      const message = 'extension.json is a symbolic link; an extension ships regular files only.'
      return { ok: false, rejected: { path: manifestPath, issues: [{ path: '', message }] }, message }
    }
    source = await readFile(manifestPath, 'utf8')
  } catch (error) {
    const rejection = {
      path: manifestPath,
      issues: [{ path: '', message: error instanceof Error ? error.message : 'extension.json not found' }],
    }
    return { ok: false, rejected: rejection, message: 'No extension.json found in the selected folder.' }
  }
  const result = parseExtensionManifest(source)
  if (!result.ok) {
    return {
      ok: false,
      rejected: { path: manifestPath, issues: result.issues },
      message: 'The extension’s extension.json is invalid.',
    }
  }
  const extension = result.manifest
  const readable = studioReadsManifest(extension)
  if (!readable.ok) {
    return {
      ok: false,
      rejected: { path: manifestPath, issues: [{ path: 'engines.studio', message: readable.message }] },
      message: readable.message,
    }
  }
  if (isReservedExtensionId(extension.id)) {
    const message = `"${extension.id}" is an id only Studio’s own catalogue installs; choose another id.`
    return { ok: false, rejected: { path: manifestPath, issues: [{ path: 'id', message }] }, message }
  }

  // Content is checked as Studio will check it when it serves it: a grammar
  // that would never highlight is refused here, where the author can fix it.
  const contentIssues = await contentFileIssues(extension, async (path, maxBytes) => {
    try {
      const file = resolveContainedPath(srcDir, path, path)
      const info = await lstat(file)
      if (!info.isFile() || info.size > maxBytes) return null
      return await readFile(file, 'utf8')
    } catch {
      return null
    }
  })
  if (contentIssues.length > 0) {
    return {
      ok: false,
      rejected: { path: manifestPath, issues: contentIssues },
      message: 'A file the extension’s extension.json names is not one Studio can use.',
    }
  }
  // What it hands agents, checked as the projection will use it.
  const agentIssues = await agentContributionIssues(extension, srcDir, options.protectedProviderIds)
  if (agentIssues.length > 0) {
    return {
      ok: false,
      rejected: { path: manifestPath, issues: agentIssues },
      message: `${agentIssues[0]!.path} ${agentIssues[0]!.message}`,
    }
  }

  const key = extensionInstallKey(LOCAL_EXTENSION_PUBLISHER, extension.id)
  const destination = join(root, key)
  await mkdir(root, { recursive: true })
  // A re-install REPLACES the folder; it does not merge into it, so a file the
  // new version dropped cannot stay behind and keep loading. The copy lands in
  // a temp sibling and is renamed into place, so a copy that fails halfway
  // leaves the previous install standing rather than half of each version.
  const staging = join(root, `.${key}.installing.${process.pid}.${Date.now()}`)
  await rm(staging, { recursive: true, force: true })
  const strippedLinks: string[] = []
  let standing: ExtensionStanding
  try {
    await cp(srcDir, staging, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
      filter: (path) => {
        if (path !== srcDir && lstatSync(path).isSymbolicLink()) {
          strippedLinks.push(relative(srcDir, path).split(sep).join('/'))
          return false
        }
        return true
      },
    })
    standing = classifyExtension(staging, key, extension, ctx)
    if (standing.signature === 'invalid') {
      const issues = standing.issues ?? []
      await rm(staging, { recursive: true, force: true })
      return {
        ok: false,
        rejected: { path: manifestPath, issues },
        message: standing.tampered
          ? `Extension "${extension.id}" has been changed since it was signed: its files do not match extension.sig.`
          : `Extension "${extension.id}" has an invalid signature.`,
      }
    }
    if (standing.contentDigest === undefined) {
      const issues = standing.issues ?? []
      await rm(staging, { recursive: true, force: true })
      return {
        ok: false,
        rejected: { path: manifestPath, issues },
        message:
          `Extension "${extension.id}" has files an extension cannot ship. Install the folder ` +
          '`sprintengine-extension pack` writes, which leaves out node_modules, .git and key files.',
      }
    }
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      rejected: { path: destination, issues: [{ path: '', message }] },
      message: `Could not install extension "${extension.id}": ${message}`,
    }
  }
  return { ok: true, id: key, extension, standing, strippedLinks: strippedLinks.sort() }
}
