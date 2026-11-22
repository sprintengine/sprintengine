import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { tierRank, type ExtensionTier } from '../../../packages/extension-sdk/src/manifest-schema'
import type { ExtensionManifest } from '../../shared/modules/third-party-manifest'

// What the person approved an extension for, on this machine.
//
// An extension that only carries content asks nothing. Anything above content
// (declarative, ui, worker) waits for the person's approval before Studio
// draws or runs any of it, and the approval is bound to a fingerprint: a
// sha256 over what the extension may do (its permissions, sorted, its tier,
// whether it has a worker and whether that worker runs in the background) and
// over the content of every file it ships. Approving names the fingerprint the
// person was shown, so they approve exactly what they saw.
//
// Install asks once. A later install of the same extension changes the
// fingerprint (its files changed), and keeps the approval when it asks for no
// more access than was approved (`accessGrowth` is empty); otherwise it waits
// for the person again. An uninstall forgets the approval.
//
// Kept in `<dataDir>/extension-approvals.json`, {installKey: {fingerprint,
// access}}. A missing or malformed file approves nothing: the safe default.

export type ExtensionAccess = {
  /** The permissions it asks for, sorted. */
  permissions: string[]
  tier: ExtensionTier
  /** It has a worker (`main`): code Studio runs in its own process. */
  worker: boolean
  /** Its worker is started when it is switched on and kept running. */
  background: boolean
  /** The MCP tools it serves agents, by name, with their access. */
  tools: Record<string, 'read' | 'operate'>
  /** Its commands that run one of Studio's own actions, as `<command>=<action>`, sorted. */
  actions: string[]
  /**
   * Its custom editors and the files each takes over, as
   * `<editor>=<suffixes and names, lower case, sorted>`, sorted: an editor
   * opens the person's files in the extension's code, so a new one, or one
   * that takes more files, is asked for again.
   */
  editors: string[]
}

export type ExtensionApprovalRecord = { fingerprint: string; access: ExtensionAccess }

/** What an extension's manifest asks for. */
export function extensionAccess(
  manifest: Pick<ExtensionManifest, 'permissions' | 'tier' | 'main' | 'background' | 'contributes'>,
): ExtensionAccess {
  return {
    permissions: [...new Set(manifest.permissions)].sort(),
    tier: manifest.tier,
    worker: manifest.main !== undefined,
    background: manifest.background === true,
    tools: Object.fromEntries(manifest.contributes.mcpTools.map((tool) => [tool.name, tool.access])),
    actions: manifest.contributes.commands
      .flatMap((command) => (command.action === undefined ? [] : [`${command.id}=${command.action}`]))
      .sort(),
    editors: manifest.contributes.customEditors.map((editor) => `${editor.id}=${editorFiles(editor).join(',')}`).sort(),
  }
}

function editorFiles(editor: { extensions?: string[]; filenames?: string[] }): string[] {
  return [
    ...new Set([...(editor.extensions ?? []), ...(editor.filenames ?? [])].map((name) => name.toLowerCase())),
  ].sort()
}

/** Whether an extension at this access waits for the person's approval: anything beyond content does. */
export function extensionNeedsApproval(access: Pick<ExtensionAccess, 'tier'>): boolean {
  return access.tier !== 'content'
}

/** The fingerprint an approval is bound to: what it may do, and the content of its files. */
export function extensionApprovalFingerprint(access: ExtensionAccess, contentDigest: string): string {
  const canonical = [
    `permissions:${[...access.permissions].sort().join(',')}`,
    `tier:${access.tier}`,
    `worker:${access.worker ? 1 : 0}`,
    `background:${access.background ? 1 : 0}`,
    `content:${contentDigest}`,
  ].join('\0')
  return `sha256-${createHash('sha256').update(canonical).digest('hex')}`
}

/**
 * What `next` asks for beyond `approved`, in words for the person: each
 * permission it adds, a higher tier, a worker, a background worker, and each
 * contribution that carries authority, judged per entry: an MCP tool agents
 * did not have, a tool that may now change things, a command that runs a
 * Studio action it did not run. Empty when it may keep the approval.
 */
export function accessGrowth(approved: ExtensionAccess, next: ExtensionAccess): string[] {
  const growth: string[] = next.permissions
    .filter((permission) => !approved.permissions.includes(permission))
    .map((permission) => `the "${permission}" permission`)
  if (tierRank(next.tier) > tierRank(approved.tier)) growth.push(`the "${next.tier}" tier`)
  if (next.worker && !approved.worker) growth.push('a worker')
  if (next.background && !approved.background) growth.push('a worker that runs in the background')
  for (const [name, access] of Object.entries(next.tools)) {
    const before = Object.hasOwn(approved.tools, name) ? approved.tools[name] : undefined
    if (before === undefined) growth.push(`the MCP tool "${name}"`)
    else if (access === 'operate' && before === 'read') growth.push(`the MCP tool "${name}" changing things`)
  }
  for (const action of next.actions)
    if (!approved.actions.includes(action)) {
      const [command, ...rest] = action.split('=')
      growth.push(`the command "${command}" running "${rest.join('=')}"`)
    }
  const approvedEditors = new Map(
    approved.editors.map((entry) => [
      entry.slice(0, entry.indexOf('=')),
      entry.slice(entry.indexOf('=') + 1).split(','),
    ]),
  )
  for (const entry of next.editors) {
    const id = entry.slice(0, entry.indexOf('='))
    const files = entry.slice(entry.indexOf('=') + 1).split(',')
    const before = approvedEditors.get(id)
    const added = before ? files.filter((file) => !before.includes(file)) : files
    if (added.length === 0) continue
    growth.push(
      before
        ? `the editor "${id}" opening ${added.join(', ')} files too`
        : `the editor "${id}" opening ${added.join(', ')} files`,
    )
  }
  return growth
}

// ── The store ────────────────────────────────────────────────────────────────

const FILE_NAME = 'extension-approvals.json'

const isTier = (value: unknown): value is ExtensionTier =>
  value === 'content' || value === 'declarative' || value === 'ui' || value === 'worker'

function readRecord(value: unknown): ExtensionApprovalRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { fingerprint, access } = value as Record<string, unknown>
  if (typeof fingerprint !== 'string' || !fingerprint.startsWith('sha256-')) return null
  if (!access || typeof access !== 'object' || Array.isArray(access)) return null
  const { permissions, tier, worker, background, tools, actions, editors } = access as Record<string, unknown>
  const strings = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((entry) => typeof entry === 'string')
  if (!strings(permissions) || !strings(actions) || !strings(editors)) return null
  if (!isTier(tier) || typeof worker !== 'boolean' || typeof background !== 'boolean') return null
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return null
  const toolAccess = Object.entries(tools as Record<string, unknown>)
  if (!toolAccess.every(([, value]) => value === 'read' || value === 'operate')) return null
  return {
    fingerprint,
    access: {
      permissions: [...permissions].sort(),
      tier,
      worker,
      background,
      tools: Object.fromEntries(toolAccess) as Record<string, 'read' | 'operate'>,
      actions: [...actions].sort(),
      editors: [...editors].sort(),
    },
  }
}

/** Every approval on this machine, by install key. */
export function readExtensionApprovalsSync(dataDir: string): Map<string, ExtensionApprovalRecord> {
  const path = join(dataDir, FILE_NAME)
  const approvals = new Map<string, ExtensionApprovalRecord>()
  if (!existsSync(path)) return approvals
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return approvals
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = readRecord(value)
      if (key.length > 0 && record) approvals.set(key, record)
    }
  } catch {
    // Unreadable approves nothing.
  }
  return approvals
}

export type ApprovalWriteResult = { ok: true } | { ok: false; message: string }

// Read-modify-write one at a time, so two approvals at once cannot lose one.
let writeChain: Promise<unknown> = Promise.resolve()

/** Record (or, with null, forget) the approval of one install key. */
export function writeExtensionApproval(
  dataDir: string,
  key: string,
  record: ExtensionApprovalRecord | null,
): Promise<ApprovalWriteResult> {
  const run = writeChain.then(async (): Promise<ApprovalWriteResult> => {
    const approvals = readExtensionApprovalsSync(dataDir)
    if (record) approvals.set(key, record)
    else if (!approvals.delete(key)) return { ok: true }
    const path = join(dataDir, FILE_NAME)
    try {
      await mkdir(dataDir, { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      const out: Record<string, ExtensionApprovalRecord> = {}
      for (const name of [...approvals.keys()].sort()) out[name] = approvals.get(name)!
      await writeFile(tmp, JSON.stringify(out), { mode: 0o600 })
      await rename(tmp, path)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  writeChain = run.catch(() => undefined)
  return run
}

/**
 * The approvals as they stand now, for a check made at every host call: read
 * again only when the file changed, so an uninstall or a new approval holds
 * at the next call without a read per call.
 */
export function createExtensionApprovalReader(dataDir: string): () => ReadonlyMap<string, ExtensionApprovalRecord> {
  const path = join(dataDir, FILE_NAME)
  let seen = ''
  let approvals: ReadonlyMap<string, ExtensionApprovalRecord> = new Map()
  return () => {
    let stamp = 'missing'
    try {
      const info = statSync(path)
      stamp = `${info.mtimeMs}:${info.size}:${info.ino}`
    } catch {
      // Missing: nothing is approved.
    }
    if (stamp !== seen) {
      seen = stamp
      approvals = readExtensionApprovalsSync(dataDir)
    }
    return approvals
  }
}
