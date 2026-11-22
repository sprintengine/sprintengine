import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  MarketplaceInstallEnvelope,
  MarketplacePluginInstalledComponent,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
} from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { isClaudeCodePluginEntry, validateMarketplaceIndex } from '../../shared/marketplace'
import type { SkillHarness } from '../../shared/electron-api'
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import { uninstallSkill } from '../skills/install'
import {
  defaultMarketplacePluginStagingRoot,
  downloadClaudeCodePluginSource,
  type MarketplaceInstallLog,
} from './plugin-download'
import type { MarketplaceResourceResolver } from './resources'
import { trustPinsMatch, type TrustGrant } from './trust-tokens'
import { isRecord } from '../../shared/records'

const MARKETPLACE_PLUGIN_INSTALLS_FILENAME = 'marketplace-plugin-installs.json'
// A receipt records the skill copies a Claude Code plugin install wrote; a
// store holding any other kind is not one this Studio wrote.
const RECEIPT_COMPONENT_KINDS = new Set(['skills'])

export type MarketplacePluginInstallReceipt = {
  id: string
  displayName: string
  version: number
  sourceUrl: string
  classification: 'verified' | 'community' | 'unsigned'
  installedAt: string
  components: MarketplacePluginInstalledComponent[]
}

const INSTALL_STORE_SCHEMA_VERSION = 2

type MarketplacePluginInstallStore = {
  schemaVersion: typeof INSTALL_STORE_SCHEMA_VERSION
  plugins: Record<string, MarketplacePluginInstallReceipt>
}

type FilesystemComponentBackup = {
  originalPath: string
  backupPath: string
  existed: boolean
}

type PreviousInstallSnapshot = {
  filesystem: FilesystemComponentBackup[]
}

export type MarketplacePluginLifecycleServices = {
  receiptStorePath: string
  stagingRoot?: string
  /**
   * Harness dirs a Claude-plugin skill install fans out to when the caller
   * passes no explicit `skillHarnesses` (see resolveInstalledSkillHarnesses).
   * Absent, installs fall back to Claude-only.
   */
  resolveSkillHarnesses?: () => Promise<SkillHarness[]>
  /** Test seam for packaged resource resolution (bundled claude-plugin skills). */
  packagedResourceResolver?: MarketplaceResourceResolver
  log?: MarketplaceInstallLog
}

/**
 * One install or update, as main hands it to the lifecycle. The entry was
 * resolved in main — from the app's registry, or carried inside a trust
 * grant — and never came from the renderer. `grant` is the spent trust token:
 * the person's approval of exactly the content its pin names. A Claude Code
 * plugin is refused without one, and a grant whose pin does not match what
 * was staged is refused too.
 */
export type MarketplacePluginLifecycleInstallInput = MarketplaceInstallEnvelope & {
  entry: MarketplacePluginEntry
  grant?: TrustGrant | null
}

export function defaultMarketplacePluginInstallStorePath(userDataDir: string): string {
  return join(userDataDir, MARKETPLACE_PLUGIN_INSTALLS_FILENAME)
}

export function createMarketplacePluginLifecycleService(services: MarketplacePluginLifecycleServices) {
  return {
    install: (input: MarketplacePluginLifecycleInstallInput): Promise<MarketplacePluginRegistryInstallResult> =>
      installOrUpdateMarketplacePlugin(input, services),
    update: (input: MarketplacePluginLifecycleInstallInput): Promise<MarketplacePluginRegistryInstallResult> =>
      installOrUpdateMarketplacePlugin(input, services),
    uninstall: (input: MarketplacePluginUninstallInput): Promise<MarketplacePluginUninstallResult> =>
      uninstallMarketplacePlugin(input, services),
  }
}

// Read-only view of the install receipts for update detection: the receipt's
// `version` is the registry entry's `latest` at install time.
export async function readMarketplacePluginInstallReceipts(
  receiptStorePath: string,
): Promise<{ ok: true; receipts: MarketplacePluginInstallReceipt[] } | { ok: false; message: string }> {
  const store = await loadInstallStore(receiptStorePath)
  if (!store.ok) return store
  return { ok: true, receipts: Object.values(store.store.plugins) }
}

async function installOrUpdateMarketplacePlugin(
  rawInput: MarketplacePluginLifecycleInstallInput,
  services: MarketplacePluginLifecycleServices,
): Promise<MarketplacePluginRegistryInstallResult> {
  const entry = validateRegistryEntry(rawInput.entry)
  if (!entry.ok) return { ok: false, message: entry.message, issues: entry.issues }
  if (rawInput.grant && rawInput.grant.entryId !== entry.entry.id) {
    return { ok: false, message: 'The trust approval is for a different extension.' }
  }
  // Only the harnesses the app writes skills for: a name outside that set is
  // a path segment nobody chose (`join(workspaceRoot, '.' + harness, …)`).
  const input: MarketplacePluginLifecycleInstallInput = rawInput.skillHarnesses
    ? { ...rawInput, skillHarnesses: knownSkillHarnesses(rawInput.skillHarnesses) }
    : rawInput

  const storeResult = await loadInstallStore(services.receiptStorePath)
  if (!storeResult.ok) return { ok: false, message: storeResult.message }
  const store = storeResult.store
  const previous = store.plugins[entry.entry.id]

  // Claude Code plugins are the one kind of row the marketplace installs:
  // their content is Claude's plugin format, routed through the claude-plugin
  // adapter (skills copied into workspace harness dirs) behind the trust gate.
  if (!isClaudeCodePluginEntry(entry.entry)) {
    return { ok: false, message: `${entry.entry.name} is not a Claude Code plugin, so there is nothing to install.` }
  }
  return installClaudeCodePluginEntry(entry.entry, input, services, store, previous)
}

// Claude Code plugins install by copying each staged `skills/<dir>` into the
// workspace's harness skill dirs — the same surface the driving-skill install
// uses, so the skills appear in the workspace inventory and skill pickers.
// SKILL.md content is harness-portable, so the default target set is resolved
// via services.resolveSkillHarnesses (shared `.agents` + every installed CLI
// with native skill support); input.skillHarnesses overrides, and this
// Claude-only constant is the last-resort fallback when no resolver is wired.
// Commands/agents in the plugin are not installed — skills are the one
// component the studio delivers.
const DEFAULT_CLAUDE_PLUGIN_HARNESSES: SkillHarness[] = ['claude']

function previousHarnesses(previous: MarketplacePluginInstallReceipt | undefined): SkillHarness[] {
  const harnesses = new Set<SkillHarness>()
  for (const component of previous?.components ?? []) {
    if (component.kind !== 'skills') continue
    for (const harness of component.harnesses ?? []) harnesses.add(harness)
  }
  return [...harnesses]
}

async function resolveInstallHarnesses(
  input: MarketplacePluginLifecycleInstallInput,
  services: MarketplacePluginLifecycleServices,
  previous: MarketplacePluginInstallReceipt | undefined,
): Promise<SkillHarness[]> {
  // An explicit caller set is authoritative — a deliberate narrowing may
  // legitimately drop harness copies (the stale sweep handles it).
  if (input.skillHarnesses?.length) return input.skillHarnesses

  let resolved = DEFAULT_CLAUDE_PLUGIN_HARNESSES
  if (services.resolveSkillHarnesses) {
    // A resolver failure or empty set must not turn the install into a
    // silent no-op writing nowhere — fall back to the Claude-only default.
    try {
      const set = await services.resolveSkillHarnesses()
      if (set.length > 0) resolved = set
    } catch {
      // fall through to the default
    }
  }
  // Auto-resolution must never REMOVE a harness a previous install owned: a
  // transient CLI-probe hiccup (or resolver error) would otherwise narrow the
  // set and make the stale sweep permanently delete still-wanted skill copies
  // from CLIs that are actually still installed. Union with the prior set so
  // an auto-resolved update is only ever additive; a genuinely-removed CLI
  // keeps its harmless copy until an explicit skillHarnesses narrows it.
  const union = new Set<SkillHarness>([...resolved, ...previousHarnesses(previous)])
  return SKILL_PACK_HARNESSES.filter((harness) => union.has(harness))
}

async function installClaudeCodePluginEntry(
  entry: MarketplacePluginEntry,
  input: MarketplacePluginLifecycleInstallInput,
  services: MarketplacePluginLifecycleServices,
  store: MarketplacePluginInstallStore,
  previous: MarketplacePluginInstallReceipt | undefined,
): Promise<MarketplacePluginRegistryInstallResult> {
  const updated = Boolean(previous)
  const sourceUrl = entry.source?.trim() ?? ''
  if (previous && entry.latest < previous.version) {
    return {
      ok: false,
      sourceUrl,
      classification: 'unsigned',
      updated,
      message: rollbackMessage(entry.name, entry.latest, previous.version),
    }
  }
  const grant = input.grant
  if (!grant) {
    return {
      ok: false,
      sourceUrl,
      classification: 'unsigned',
      trust: 'unsigned',
      loadEligible: false,
      updated,
      message: 'Claude Code plugin requires trust approval before install.',
      issues: [{ path: 'source', message: 'Grant trust in the marketplace trust gate before installing this plugin.' }],
    }
  }
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) {
    return {
      ok: false,
      sourceUrl,
      classification: 'unsigned',
      updated,
      message: 'Workspace root is required to install Claude Code plugin skills.',
    }
  }

  services.log?.('claude-plugin:install-start', { entryId: entry.id })
  const download = await downloadClaudeCodePluginSource({
    entry,
    stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(dirname(services.receiptStorePath)),
    packagedResourceResolver: services.packagedResourceResolver,
    log: services.log,
  })
  if (!download.ok) {
    services.log?.('claude-plugin:install-failed', { entryId: entry.id, message: download.message })
    return {
      ok: false,
      sourceUrl: download.sourceUrl,
      classification: 'unsigned',
      updated,
      message: download.message,
      issues: [{ path: 'source', message: download.message }],
    }
  }

  // Install exactly what the trust prompt disclosed: the bundled payload
  // changes only with the app or its catalogue, and when it does the person
  // goes back through the prompt rather than getting different skills.
  if (!trustPinsMatch(grant.pin, download.pin)) {
    services.log?.('claude-plugin:pin-mismatch', { entryId: entry.id })
    await rm(download.stagedPath, { recursive: true, force: true }).catch(() => undefined)
    return pinMismatchResult(sourceUrl, 'unsigned', updated)
  }

  const harnesses = await resolveInstallHarnesses(input, services, previous)
  // Ownership is per dir AND per harness: a previous install owning "foo" in
  // .claude says nothing about a hand-authored .agents/skills/foo.
  const previousHarnessesByDir = new Map<string, Set<SkillHarness>>()
  for (const component of previous?.components ?? []) {
    if (component.kind !== 'skills') continue
    const dir = component.installedDirName ?? component.id
    const owned = previousHarnessesByDir.get(dir) ?? new Set<SkillHarness>()
    for (const harness of component.harnesses ?? []) owned.add(harness)
    previousHarnessesByDir.set(dir, owned)
  }

  const backupRoot = join(dirname(services.receiptStorePath), `${entry.id}-claude-previous-${Date.now()}`)
  try {
    // Pre-flight: never silently clobber a skill dir this plugin does not own
    // (a hand-dropped custom skill or another pack sharing the name) — checked
    // per harness, so widening the harness set cannot skip the check.
    for (const dir of download.skillDirs) {
      for (const harness of harnesses) {
        if (previousHarnessesByDir.get(dir)?.has(harness)) continue
        const target = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', dir)
        if (await pathExists(target)) {
          return {
            ok: false,
            sourceUrl,
            classification: 'unsigned',
            updated,
            message: `A skill folder named "${dir}" already exists in ${SKILL_HARNESS_DIR[harness]}/skills and is not owned by this plugin. Remove or rename it, then install again.`,
          }
        }
      }
    }

    const previousSnapshot = previous
      ? await createPreviousInstallSnapshot(previous, input, backupRoot)
      : { ok: true as const, snapshot: undefined }
    if (!previousSnapshot.ok) {
      return {
        ok: false,
        sourceUrl,
        classification: 'unsigned',
        updated,
        message: `Could not snapshot previous marketplace plugin install: ${previousSnapshot.message}`,
      }
    }

    const components: MarketplacePluginInstalledComponent[] = []
    for (const dir of download.skillDirs) {
      // Count each harness BEFORE its copy starts so a mid-copy failure still
      // rolls back the partially written target — an untracked partial dir
      // would otherwise survive as an orphan the next install refuses over.
      const attempted: SkillHarness[] = []
      try {
        for (const harness of harnesses) {
          attempted.push(harness)
          const target = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', dir)
          await mkdir(dirname(target), { recursive: true })
          await cp(join(download.stagedPath, 'skills', dir), target, { recursive: true, force: true })
        }
      } catch (error) {
        services.log?.('claude-plugin:copy-failed', { entryId: entry.id, skill: dir, message: formatError(error) })
        const partial: MarketplacePluginInstalledComponent = {
          kind: 'skills',
          id: dir,
          installedDirName: dir,
          harnesses: attempted,
          message: 'Partial copy rolled back.',
        }
        const rollback = await rollbackInstalledComponents(entry.id, [...components, partial], input)
        const restored = previousSnapshot.snapshot
          ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot)
          : { ok: true as const }
        return appendRestoreFailure(
          appendRollbackFailure(
            {
              ok: false,
              sourceUrl,
              classification: 'unsigned',
              trust: 'unsigned',
              loadEligible: false,
              installed: components,
              updated,
              message: `Could not copy plugin skill "${dir}": ${formatError(error)}`,
            },
            rollback,
          ),
          restored,
        )
      }
      components.push({
        kind: 'skills',
        id: dir,
        installedDirName: dir,
        harnesses,
        message: `Installed for ${harnesses.join(', ')}.`,
      })
    }

    const receipt: MarketplacePluginInstallReceipt = {
      id: entry.id,
      displayName: entry.name,
      version: entry.latest,
      sourceUrl,
      classification: 'unsigned',
      installedAt: new Date().toISOString(),
      components,
    }

    if (previous) {
      // Stale = previous skill dirs the new install no longer ships, PLUS —
      // because componentsOverlap keys skills on dir name only — the harness
      // copies a still-shipped dir no longer targets (else a harness change
      // would strand untracked copies forever).
      const staleDirs = componentsWithoutOverlap(previous.components, receipt.components)
      const staleHarnessCopies = (previous.components ?? [])
        .filter((component) => component.kind === 'skills')
        .flatMap((component): MarketplacePluginInstalledComponent[] => {
          const dir = component.installedDirName ?? component.id
          if (!download.skillDirs.includes(dir)) return [] // whole dir already stale above
          const removedHarnesses = (component.harnesses ?? []).filter((harness) => !harnesses.includes(harness))
          return removedHarnesses.length > 0 ? [{ ...component, harnesses: removedHarnesses }] : []
        })
      const stale = [...staleDirs, ...staleHarnessCopies]
      if (stale.length > 0) {
        const removed = await uninstallReceipt({ ...previous, components: stale }, { ...input, pluginId: previous.id })
        if (!removed.ok) {
          const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input)
          const restored = previousSnapshot.snapshot
            ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot)
            : { ok: true as const }
          return appendRestoreFailure(
            appendRollbackFailure(
              {
                ok: false,
                sourceUrl,
                classification: 'unsigned',
                trust: 'unsigned',
                loadEligible: false,
                installed: receipt.components,
                updated: true,
                message: `Could not remove previous marketplace plugin components: ${removed.message}`,
              },
              rollback,
            ),
            restored,
          )
        }
      }
    }

    store.plugins[receipt.id] = receipt
    try {
      await writeInstallStore(services.receiptStorePath, store)
    } catch (error) {
      const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input)
      const restored = previousSnapshot.snapshot
        ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot)
        : { ok: true as const }
      return appendRestoreFailure(
        appendRollbackFailure(
          {
            ok: false,
            sourceUrl,
            classification: 'unsigned',
            trust: 'unsigned',
            loadEligible: false,
            installed: receipt.components,
            updated,
            message: `Could not write marketplace plugin install receipt: ${formatError(error)}`,
          },
          rollback,
        ),
        restored,
      )
    }

    services.log?.('claude-plugin:install-ok', {
      entryId: entry.id,
      skills: receipt.components.length,
      harnesses,
      updated,
    })
    const notices =
      download.metadataOnlySkills.length > 0
        ? [
            `${download.metadataOnlySkills.length} skill${download.metadataOnlySkills.length === 1 ? '' : 's'} in this plugin (${download.metadataOnlySkills.join(', ')}) ${download.metadataOnlySkills.length === 1 ? 'ships' : 'ship'} without bundled content and ${download.metadataOnlySkills.length === 1 ? 'was' : 'were'} not installed.`,
          ]
        : []
    return {
      ok: true,
      id: receipt.id,
      displayName: receipt.displayName,
      version: receipt.version,
      trust: 'unsigned',
      loadEligible: false,
      installed: receipt.components,
      ...(notices.length > 0 ? { notices } : {}),
      sourceUrl,
      classification: 'unsigned',
      updated,
    }
  } finally {
    await rm(download.stagedPath, { recursive: true, force: true }).catch(() => undefined)
    await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function uninstallMarketplacePlugin(
  input: MarketplacePluginUninstallInput,
  services: MarketplacePluginLifecycleServices,
): Promise<MarketplacePluginUninstallResult> {
  const pluginId = input.pluginId?.trim()
  if (!pluginId) return { ok: false, message: 'Plugin id is required.' }

  const storeResult = await loadInstallStore(services.receiptStorePath)
  if (!storeResult.ok) return { ok: false, message: storeResult.message }
  const store = storeResult.store
  const receipt = store.plugins[pluginId]
  if (!receipt) return { ok: false, message: `Marketplace plugin ${pluginId} is not installed.` }

  const result = await uninstallReceipt(receipt, input)
  if (!result.ok) return result

  delete store.plugins[pluginId]
  await writeInstallStore(services.receiptStorePath, store)
  return result
}

async function uninstallReceipt(
  receipt: MarketplacePluginInstallReceipt,
  input: MarketplacePluginUninstallInput,
): Promise<MarketplacePluginUninstallResult> {
  const removed: MarketplacePluginInstalledComponent[] = []

  for (const component of [...receipt.components].reverse()) {
    try {
      await removeSkillComponent(component, input)
      removed.push(component)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), removed }
    }
  }

  return { ok: true, id: receipt.id, removed }
}

async function removeSkillComponent(
  component: MarketplacePluginInstalledComponent,
  input: MarketplacePluginUninstallInput,
): Promise<void> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) throw new Error('Workspace root is required to uninstall skill components.')
  const dirName = component.installedDirName ?? component.id
  const result = await uninstallSkill({
    workspaceRoot,
    dirName,
    // The receipt names the harnesses the install wrote; without one, every
    // harness dir is swept rather than guessing which held a copy.
    harnesses: component.harnesses?.length
      ? knownSkillHarnesses(component.harnesses)
      : input.skillHarnesses?.length
        ? knownSkillHarnesses(input.skillHarnesses)
        : SKILL_PACK_HARNESSES,
  })
  // Already gone is the state uninstall wants, so an empty sweep is fine here;
  // only a real failure is one.
  if (!result.ok) throw new Error(result.message)
}

async function createPreviousInstallSnapshot(
  receipt: MarketplacePluginInstallReceipt,
  input: MarketplacePluginLifecycleInstallInput,
  backupRoot: string,
): Promise<{ ok: true; snapshot: PreviousInstallSnapshot } | { ok: false; message: string }> {
  try {
    const filesystem: FilesystemComponentBackup[] = []
    for (const originalPath of filesystemComponentPaths(receipt.components, input)) {
      const backupPath = join(backupRoot, String(filesystem.length))
      const existed = await pathExists(originalPath)
      if (existed) {
        await mkdir(dirname(backupPath), { recursive: true })
        await cp(originalPath, backupPath, { recursive: true, force: true })
      }
      filesystem.push({ originalPath, backupPath, existed })
    }
    return {
      ok: true,
      snapshot: { filesystem },
    }
  } catch (error) {
    return { ok: false, message: formatError(error) }
  }
}

async function restorePreviousInstallSnapshot(
  snapshot: PreviousInstallSnapshot,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    for (const backup of [...snapshot.filesystem].reverse()) {
      await rm(backup.originalPath, { recursive: true, force: true })
      if (!backup.existed) continue
      await mkdir(dirname(backup.originalPath), { recursive: true })
      await cp(backup.backupPath, backup.originalPath, { recursive: true, force: true })
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: formatError(error) }
  }
}

function filesystemComponentPaths(
  components: MarketplacePluginInstalledComponent[],
  input: MarketplacePluginLifecycleInstallInput,
): string[] {
  const paths = components.flatMap((component) =>
    component.kind === 'skills' ? skillComponentPaths(component, input) : [],
  )
  return Array.from(new Set(paths))
}

function skillComponentPaths(
  component: MarketplacePluginInstalledComponent,
  input: MarketplacePluginLifecycleInstallInput,
): string[] {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) return []
  const dirName = component.installedDirName ?? component.id
  // These paths are snapshotted and, on a failed update, removed and restored,
  // so a harness is only ever one of the app's own dirs.
  const harnesses = component.harnesses?.length
    ? knownSkillHarnesses(component.harnesses)
    : input.skillHarnesses?.length
      ? knownSkillHarnesses(input.skillHarnesses)
      : (['agents'] as SkillHarness[])
  return harnesses.map((harness) => join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', dirName))
}

function knownSkillHarnesses(harnesses: readonly string[]): SkillHarness[] {
  return SKILL_PACK_HARNESSES.filter((harness) => harnesses.includes(harness))
}

function rollbackMessage(name: string, offered: number, installed: number): string {
  return `${name} version ${offered} is older than the installed version ${installed}, so it was not installed.`
}

function pinMismatchResult(
  sourceUrl: string,
  classification: MarketplacePluginRegistryInstallResult['classification'],
  updated: boolean,
): MarketplacePluginRegistryInstallResult {
  return {
    ok: false,
    sourceUrl,
    ...(classification ? { classification } : {}),
    updated,
    message: 'This extension changed after you reviewed it, so nothing was installed. Review it again.',
    issues: [{ path: 'source', message: 'Installed content does not match the reviewed content.' }],
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

async function rollbackInstalledComponents(
  pluginId: string,
  components: MarketplacePluginInstalledComponent[],
  input: Omit<MarketplacePluginUninstallInput, 'pluginId'>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (components.length === 0) return { ok: true }
  const rollback = await uninstallReceipt(
    {
      id: pluginId,
      displayName: pluginId,
      version: 0,
      sourceUrl: '',
      classification: 'community',
      installedAt: new Date().toISOString(),
      components,
    },
    { ...input, pluginId },
  )
  if (rollback.ok) return { ok: true }
  return { ok: false, message: rollback.message }
}

function appendRollbackFailure<T extends Extract<MarketplacePluginRegistryInstallResult, { ok: false }>>(
  result: T,
  rollback: { ok: true } | { ok: false; message: string },
): T {
  if (rollback.ok) return result
  return {
    ...result,
    message: `${result.message} Rollback after failed marketplace install also failed: ${rollback.message}`,
  }
}

function appendRestoreFailure<T extends Extract<MarketplacePluginRegistryInstallResult, { ok: false }>>(
  result: T,
  restore: { ok: true } | { ok: false; message: string },
): T {
  if (restore.ok) return result
  return {
    ...result,
    message: `${result.message} Restore of previous marketplace install also failed: ${restore.message}`,
  }
}

function componentsWithoutOverlap(
  source: MarketplacePluginInstalledComponent[],
  keepers: MarketplacePluginInstalledComponent[],
): MarketplacePluginInstalledComponent[] {
  return source.filter((component) => !keepers.some((keeper) => componentsOverlap(component, keeper)))
}

function componentsOverlap(a: MarketplacePluginInstalledComponent, b: MarketplacePluginInstalledComponent): boolean {
  if (a.kind !== b.kind) return false
  return (a.installedDirName ?? a.id) === (b.installedDirName ?? b.id)
}

function validateRegistryEntry(
  entry: MarketplacePluginEntry,
):
  | { ok: true; entry: MarketplacePluginEntry }
  | { ok: false; message: string; issues?: Array<{ path: string; message: string }> } {
  const result = validateMarketplaceIndex({ schemaVersion: 1, plugins: [entry] })
  if (!result.ok) return { ok: false, message: 'Marketplace plugin registry entry is invalid.', issues: result.issues }
  return { ok: true, entry: result.marketplace.plugins[0] }
}

async function loadInstallStore(
  path: string,
): Promise<{ ok: true; store: MarketplacePluginInstallStore } | { ok: false; message: string }> {
  const empty: MarketplacePluginInstallStore = { schemaVersion: INSTALL_STORE_SCHEMA_VERSION, plugins: {} }
  try {
    return { ok: true, store: validateInstallStore(JSON.parse(await readFile(path, 'utf8'))) }
  } catch (error) {
    if (isMissingFileError(error)) return { ok: true, store: empty }
    return { ok: false, message: `Marketplace plugin install receipt store is invalid: ${formatError(error)}` }
  }
}

async function writeInstallStore(path: string, store: MarketplacePluginInstallStore): Promise<void> {
  validateInstallStore(store)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

function validateInstallStore(value: unknown): MarketplacePluginInstallStore {
  if (!isRecord(value) || value.schemaVersion !== INSTALL_STORE_SCHEMA_VERSION || !isRecord(value.plugins)) {
    throw new Error(`schemaVersion must be ${INSTALL_STORE_SCHEMA_VERSION} and plugins must be an object.`)
  }
  const plugins: Record<string, MarketplacePluginInstallReceipt> = {}
  for (const [pluginId, receipt] of Object.entries(value.plugins)) {
    if (!isSafeIdentifier(pluginId)) throw new Error(`plugins.${pluginId}: plugin id is not safe.`)
    plugins[pluginId] = validateReceipt(receipt, `plugins.${pluginId}`)
  }
  return { schemaVersion: INSTALL_STORE_SCHEMA_VERSION, plugins }
}

function validateReceipt(value: unknown, path: string): MarketplacePluginInstallReceipt {
  if (!isRecord(value)) throw new Error(`${path}: receipt must be an object.`)
  if (!isSafeIdentifier(value.id)) throw new Error(`${path}.id: id is required and must be a safe identifier.`)
  if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0) {
    throw new Error(`${path}.displayName: displayName is required.`)
  }
  const version = value.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error(`${path}.version: version must be a non-negative integer.`)
  }
  if (typeof value.sourceUrl !== 'string') throw new Error(`${path}.sourceUrl: sourceUrl must be a string.`)
  if (
    value.classification !== 'verified' &&
    value.classification !== 'community' &&
    value.classification !== 'unsigned'
  ) {
    throw new Error(`${path}.classification: classification must be verified, community, or unsigned.`)
  }
  if (typeof value.installedAt !== 'string' || value.installedAt.trim().length === 0) {
    throw new Error(`${path}.installedAt: installedAt is required.`)
  }
  if (!Array.isArray(value.components)) throw new Error(`${path}.components: components must be an array.`)
  const receipt: MarketplacePluginInstallReceipt = {
    id: value.id,
    displayName: value.displayName,
    version,
    sourceUrl: value.sourceUrl,
    classification: value.classification,
    installedAt: value.installedAt,
    components: value.components.map((component, index) =>
      validateReceiptComponent(component, `${path}.components[${index}]`),
    ),
  }
  return receipt
}

function validateReceiptComponent(value: unknown, path: string): MarketplacePluginInstalledComponent {
  if (!isRecord(value)) throw new Error(`${path}: component must be an object.`)
  if (typeof value.kind !== 'string' || !RECEIPT_COMPONENT_KINDS.has(value.kind)) {
    throw new Error(`${path}.kind: unsupported component kind.`)
  }
  if (!isSafeIdentifier(value.id)) throw new Error(`${path}.id: component id must be safe.`)
  const component: MarketplacePluginInstalledComponent = {
    kind: value.kind as MarketplacePluginInstalledComponent['kind'],
    id: value.id,
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  }
  if (value.installedDirName !== undefined) {
    if (!isSafeIdentifier(value.installedDirName))
      throw new Error(`${path}.installedDirName: installed directory name must be safe.`)
    component.installedDirName = value.installedDirName
  }
  if (value.harnesses !== undefined)
    component.harnesses = validateStringArray(
      value.harnesses,
      `${path}.harnesses`,
      isSafeIdentifier,
    ) as typeof component.harnesses
  return component
}

function validateStringArray(value: unknown, path: string, predicate: (entry: unknown) => entry is string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path}: must be an array.`)
  return value.map((entry, index) => {
    if (!predicate(entry)) throw new Error(`${path}[${index}]: value must be a safe string.`)
    return entry
  })
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  )
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
