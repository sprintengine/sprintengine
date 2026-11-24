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
import {
  classifyDevelopmentExtension,
  classifyExtension,
  type ExtensionStanding,
  type ExtensionStandingContext,
} from './module-signature'
import { resolveContainedPath } from './entry-containment'
import { devFolderStillResolves, insideRefusedRoot } from './extension-dev-folders'
import { contentFileIssues } from './extension-content'
import { readStudioEnv } from '../../shared/studio-env'
import { agentContributionIssues } from '../../server/extensions/agent-contributions/install-checks'
import { isReservedInstallKey } from '../../../packages/extension-sdk/src/catalogue'

// Discovery and install of extensions under
// ~/.sprintengine/extensions/<publisher>.<id>/extension.json, and of the
// development folders the owner registered (extension-dev-folders.ts), which
// load where they are, after the installed ones. The folder's
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
  /**
   * A development folder the owner registered (extension-dev-folders.ts):
   * loaded from `moduleRoot` where it is, at `order` among the development
   * folders, and `overrides` when an installed extension has its key, which
   * it stands in for while it is registered, once the person approved that;
   * `waiting` until then (`UserModuleListResult.waiting`).
   */
  development?: { order: number; overrides: boolean; waiting?: boolean }
}

export type UserModuleListResult = {
  modules: InstalledModule[]
  rejected: ModuleRejection[]
  /**
   * Development folders whose key an installed extension has, waiting for the
   * person to approve them in its place: until then the installed one runs,
   * and these load nowhere. Listed so they can be reviewed.
   */
  waiting?: InstalledModule[]
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

export type LoadedManifest = { ok: true; extension: ExtensionManifest } | { ok: false; rejection: ModuleRejection }

// Validate extension.json's text for a folder, and that the folder's name is
// the install key of the manifest it holds.
function validateInstalledManifestSource(
  source: string,
  manifestPath: string,
  folderName: string,
  installedFrom: ExtensionStandingContext['installedFrom'],
): LoadedManifest {
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
  // A folder install puts an extension here under `local`; a catalogue or git
  // install under the repository owner, and records it (catalogue-files.ts).
  // A folder named for another publisher was not put here by Studio, and a
  // reserved key only by Studio's official catalogue.
  const from = installedFrom?.get(folderName)
  const placed =
    key.publisher === LOCAL_EXTENSION_PUBLISHER
      ? !isReservedExtensionId(key.id)
      : from !== undefined && (from === 'official' || !isReservedInstallKey(folderName))
  if (!placed) {
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

async function loadManifestFromDir(
  moduleRoot: string,
  folderName: string,
  ctx: ExtensionStandingContext,
): Promise<LoadedManifest> {
  const manifestPath = join(moduleRoot, EXTENSION_MANIFEST_FILENAME)
  try {
    return validateInstalledManifestSource(
      await readFile(manifestPath, 'utf8'),
      manifestPath,
      folderName,
      ctx.installedFrom,
    )
  } catch (error) {
    return missingManifest(manifestPath, error)
  }
}

function loadManifestFromDirSync(
  moduleRoot: string,
  folderName: string,
  ctx: ExtensionStandingContext,
): LoadedManifest {
  const manifestPath = join(moduleRoot, EXTENSION_MANIFEST_FILENAME)
  try {
    return validateInstalledManifestSource(
      readFileSync(manifestPath, 'utf8'),
      manifestPath,
      folderName,
      ctx.installedFrom,
    )
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

/** One development folder as read now: its extension and how it stands, or why it holds none. */
export type DevelopmentFolderEntry =
  | { ok: true; key: string; extension: ExtensionManifest; standing: ExtensionStanding }
  | { ok: false; rejection: ModuleRejection }

/**
 * Read one registered development folder now. It must still be the one place
 * it was registered as (the same real path: a folder or a parent swapped for
 * a link since is not loaded under the first one's approval), and not inside
 * the extensions folder or Studio's data folder.
 */
export function readDevelopmentFolder(
  folder: string,
  root: string,
  ctx: ExtensionStandingContext,
): DevelopmentFolderEntry {
  const manifestPath = join(folder, EXTENSION_MANIFEST_FILENAME)
  const refuse = (message: string): DevelopmentFolderEntry => ({
    ok: false,
    rejection: { path: manifestPath, issues: [{ path: '', message }] },
  })
  const inside = insideRefusedRoot(folder, [root, ...(ctx.dataDir ? [ctx.dataDir] : [])])
  if (inside) return refuse(`${folder} is inside ${inside}, which Studio keeps for itself; remove it.`)
  const still = devFolderStillResolves(folder)
  if (!still.ok)
    return refuse(
      still.now
        ? `${folder} now leads to ${still.now}. Register the folder again (dev load) to load it from there.`
        : `${folder} is gone. Remove it, or register it again once it is back.`,
    )
  const loaded = loadDevelopmentManifest(folder)
  if (!loaded.ok) return loaded
  const key = extensionInstallKey(LOCAL_EXTENSION_PUBLISHER, loaded.extension.id)
  return {
    ok: true,
    key,
    extension: loaded.extension,
    standing: classifyDevelopmentExtension(folder, key, loaded.extension, ctx),
  }
}

// The order every extension loads in, the order its hooks run in among
// others': the installed ones by install key, then the development folders in
// the order they were registered. A development folder whose key an installed
// extension has takes its place only once the person approved it for that key
// (an agent may register a folder; only the person approves); until then it
// waits, and the installed one keeps running. A second folder claiming a key
// one already holds is refused, naming the first. `read` reads one folder
// (readDevelopmentFolder, or a cache of it).
export function withDevelopmentFolders(
  installed: UserModuleListResult,
  ctx: ExtensionStandingContext,
  read: (folder: string) => DevelopmentFolderEntry,
): UserModuleListResult {
  const modules = [...installed.modules].sort((a, b) => a.key.localeCompare(b.key))
  const folders = ctx.devFolders ?? []
  if (folders.length === 0) return { modules, rejected: installed.rejected }
  const rejected = [...installed.rejected]
  const waiting: InstalledModule[] = []
  const claimed = new Map<string, string>()
  folders.forEach((folder, order) => {
    const entry = read(folder)
    if (!entry.ok) {
      rejected.push(entry.rejection)
      return
    }
    const { key, extension, standing } = entry
    const first = claimed.get(key)
    if (first) {
      rejected.push({
        path: join(folder, EXTENSION_MANIFEST_FILENAME),
        issues: [{ path: 'id', message: `"${key}" is already the development folder ${first}; remove one of them.` }],
      })
      return
    }
    claimed.set(key, folder)
    const at = modules.findIndex((module) => module.key === key)
    const module: InstalledModule = {
      key,
      publisher: LOCAL_EXTENSION_PUBLISHER,
      manifest: capabilityManifestOf(key, LOCAL_EXTENSION_PUBLISHER, extension),
      extension,
      moduleRoot: folder,
      standing,
      development: { order, overrides: at >= 0 },
    }
    if (at >= 0) {
      if (ctx.approvals.get(key)?.devFolder !== folder) {
        waiting.push({ ...module, development: { order, overrides: true, waiting: true } })
        return
      }
      modules.splice(at, 1)
    }
    modules.push(module)
  })
  return { modules, rejected, ...(waiting.length > 0 ? { waiting } : {}) }
}

/** A development folder's extension.json, read as Studio reads an installed one. */
export function loadDevelopmentManifest(folder: string): LoadedManifest {
  const manifestPath = join(folder, EXTENSION_MANIFEST_FILENAME)
  let source: string
  try {
    if (lstatSync(manifestPath).isSymbolicLink())
      return {
        ok: false,
        rejection: {
          path: manifestPath,
          issues: [{ path: '', message: 'extension.json is a symbolic link; Studio reads regular files only.' }],
        },
      }
    source = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return missingManifest(manifestPath, error)
  }
  const result = parseExtensionManifest(source)
  if (!result.ok) return { ok: false, rejection: { path: manifestPath, issues: result.issues } }
  if (isReservedExtensionId(result.manifest.id))
    return {
      ok: false,
      rejection: {
        path: manifestPath,
        issues: [{ path: 'id', message: `"${result.manifest.id}" is an id only Studio’s own catalogue installs.` }],
      },
    }
  const readable = studioReadsManifest(result.manifest)
  if (!readable.ok)
    return {
      ok: false,
      rejection: { path: manifestPath, issues: [{ path: 'engines.studio', message: readable.message }] },
    }
  return { ok: true, extension: result.manifest }
}

/**
 * Every extension this server runs, validated and classified: the installed
 * ones, then the development folders `ctx` names. The folders that hold none
 * are `rejected`.
 */
export async function discoverUserModules(root: string, ctx: ExtensionStandingContext): Promise<UserModuleListResult> {
  const result: UserModuleListResult = { modules: [], rejected: [] }
  for (const entry of await readDirSafe(root)) {
    if (!entry.isDirectory() || isHiddenModuleDir(entry.name)) continue
    const moduleRoot = join(root, entry.name)
    const loaded = await loadManifestFromDir(moduleRoot, entry.name, ctx)
    if (loaded.ok) result.modules.push(installedModule(loaded.extension, entry.name, moduleRoot, ctx))
    else result.rejected.push(loaded.rejection)
  }
  return withDevelopmentFolders(result, ctx, (folder) => readDevelopmentFolder(folder, root, ctx))
}

/** The installed extensions alone, validated and classified, by install key: no development folder. */
export function discoverInstalledModulesSync(root: string, ctx: ExtensionStandingContext): UserModuleListResult {
  const result: UserModuleListResult = { modules: [], rejected: [] }
  for (const entry of readDirSafeSync(root)) {
    if (!entry.isDirectory() || isHiddenModuleDir(entry.name)) continue
    const moduleRoot = join(root, entry.name)
    const loaded = loadManifestFromDirSync(moduleRoot, entry.name, ctx)
    if (loaded.ok) result.modules.push(installedModule(loaded.extension, entry.name, moduleRoot, ctx))
    else result.rejected.push(loaded.rejection)
  }
  result.modules.sort((a, b) => a.key.localeCompare(b.key))
  return result
}

export function discoverUserModulesSync(root: string, ctx: ExtensionStandingContext): UserModuleListResult {
  return withDevelopmentFolders(discoverInstalledModulesSync(root, ctx), ctx, (folder) =>
    readDevelopmentFolder(folder, root, ctx),
  )
}

/**
 * Install the extension in a folder: validate its extension.json, then copy
 * the folder into `<root>/<publisher>.<id>/` (`local` for a folder the person
 * picked; the repository owner for a catalogue or git install, which checked
 * the folder out), REPLACING any earlier install of that key. A version on the
 * kill list is refused. Symbolic links are left out of the copy and named in the result, for
 * the install review to show: their bytes live somewhere no digest follows.
 * The standing of the bytes that were installed comes back: what the person is asked to approve.
 */
export async function installModuleFolder(
  selectedDir: string,
  root: string,
  ctx: ExtensionStandingContext,
  options: {
    protectedProviderIds?: ReadonlySet<string>
    /** The publisher Studio derived from where it came from: `local` for a folder (the default). */
    publisher?: string
    /** It came from Studio's official catalogue, which alone may install a reserved id. */
    official?: boolean
  } = {},
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
  if (isReservedExtensionId(extension.id) && !options.official) {
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

  const key = extensionInstallKey(options.publisher ?? LOCAL_EXTENSION_PUBLISHER, extension.id)
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
    if (standing.killed) {
      await rm(staging, { recursive: true, force: true })
      const message = `Studio’s kill list removed ${key} ${extension.version}: ${standing.killed.reason}`
      return { ok: false, rejected: { path: manifestPath, issues: [{ path: '', message }] }, message }
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
