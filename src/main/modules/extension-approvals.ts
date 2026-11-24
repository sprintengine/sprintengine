import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { tierRank, type ExtensionTier } from '../../../packages/extension-sdk/src/manifest-schema'
import { extensionHookApprovalLines, isExtensionHookPoint } from '../../../packages/extension-sdk/src/hooks'
import { EXTENSION_SIGNATURE_FILENAME } from '../../../packages/extension-sdk/src/extension-manifest'
import { providerOrigin } from '../../../packages/extension-sdk/src/agent-contributions'
import type { ModuleFileDigests } from '../../shared/modules/manifest'
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
// What it hands the person's agents asks by what it can do. A skill (words an
// agent reads) and a hosted MCP server (a URL an agent reaches) are listed at
// install and ask nothing. A local MCP server is a command the agents start on
// this machine: approved once, at install, with its command, arguments and
// environment shown, and bound into its entry here with every file the
// extension ships, so an update that changes any of them asks again. A model
// provider receives the key the person enters: it asks once, naming the origin
// the key goes to, and again if an update moves it to another.
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
  /**
   * Its commands that run one of Studio's own actions, as `<command>=<action>`,
   * and those that run in place of one (`replaces`), as
   * `<command>=replaces:<action>`, sorted. A replacement takes a key, a menu
   * item or a palette entry the person knows as Studio's, so a new one is
   * asked for again; it lives in this list so the stored record keeps its shape.
   */
  actions: string[]
  /**
   * Its custom editors, the files each takes and whether it opens them by
   * default, as `<editor>=<suffixes and names, lower case, sorted>|<priority>`,
   * sorted: an editor opens the person's files in the extension's code, so a
   * new one, one that takes more files, or one that goes from being offered
   * to opening them by default, is asked for again.
   */
  editors: string[]
  /**
   * The points its worker hooks (`contributes.hooks`), sorted: a hook sees,
   * and before an action may change or refuse, what the person's agents and
   * Studio do, so one it did not hook before is asked for again.
   */
  hooks: string[]
  /**
   * Its local (stdio) MCP servers, as `<server>=<digest>`, sorted: the digest
   * covers the command, its arguments, its environment and every file the
   * extension ships (`localServerRunDigest`).
   */
  localServers: string[]
  /** Its model providers, as `<provider>=<origin its key is sent to>`, sorted. */
  providers: string[]
}

export type ExtensionApprovalRecord = {
  fingerprint: string
  access: ExtensionAccess
  /**
   * The development folder this approval is for, by its real path: present
   * only for one. It holds while that folder asks for no more than `access`,
   * whatever its code does between saves; it never covers another folder, or
   * an installed extension under the same key.
   */
  devFolder?: string
}

type AccessManifest = Pick<ExtensionManifest, 'permissions' | 'tier' | 'main' | 'background' | 'contributes'>

/**
 * The digest a local MCP server's approval is bound to: its command, its
 * arguments, its environment, and the extension's files it may run. Studio
 * cannot tell which of them a command reads, and a command may run any of
 * them (a script beside a skill's SKILL.md, a file named like an image), so
 * every file counts but the signature, extension.json included. Without
 * digests (files that cannot be read) it binds to that, so it never matches an
 * approval.
 */
export function localServerRunDigest(
  server: ExtensionManifest['contributes']['mcpServers'][number],
  files: ModuleFileDigests | undefined,
): string {
  const hash = createHash('sha256')
  hash.update(`command:${server.command ?? ''}\0`)
  for (const arg of server.args ?? []) hash.update(`arg:${arg}\0`)
  for (const variable of [...(server.env ?? [])].sort((a, b) => a.name.localeCompare(b.name)))
    hash.update(`env:${variable.name}=${variable.value}\0`)
  if (!files) return `sha256-${hash.update('files:unavailable').digest('hex')}`
  for (const path of Object.keys(files).sort()) {
    if (path === EXTENSION_SIGNATURE_FILENAME) continue
    hash.update(`file:${path}=${files[path]}\0`)
  }
  return `sha256-${hash.digest('hex')}`
}

/** How `actions` marks a command that runs in place of a Studio action rather than running it. */
const REPLACES = 'replaces:'

/** What an extension's manifest asks for, its local MCP servers bound to the files it ships. */
export function extensionAccess(manifest: AccessManifest, files?: ModuleFileDigests): ExtensionAccess {
  return {
    permissions: [...new Set(manifest.permissions)].sort(),
    tier: manifest.tier,
    worker: manifest.main !== undefined,
    background: manifest.background === true,
    tools: Object.fromEntries(manifest.contributes.mcpTools.map((tool) => [tool.name, tool.access])),
    actions: manifest.contributes.commands
      .flatMap((command) => [
        ...(command.action === undefined ? [] : [`${command.id}=${command.action}`]),
        ...(command.replaces === undefined ? [] : [`${command.id}=${REPLACES}${command.replaces}`]),
      ])
      .sort(),
    editors: manifest.contributes.customEditors
      .map((editor) => `${editor.id}=${editorFiles(editor).join(',')}|${editor.priority ?? 'default'}`)
      .sort(),
    hooks: [...new Set(manifest.contributes.hooks.map((hook) => hook.point))].sort(),
    localServers: manifest.contributes.mcpServers
      .filter((server) => server.transport === 'stdio')
      .map((server) => `${server.id}=${localServerRunDigest(server, files)}`)
      .sort(),
    providers: manifest.contributes.providers
      .map((provider) => `${provider.id}=${providerOrigin(provider.baseUrl)}`)
      .sort(),
  }
}

function editorFiles(editor: { extensions?: string[]; filenames?: string[] }): string[] {
  return [
    ...new Set([...(editor.extensions ?? []), ...(editor.filenames ?? [])].map((name) => name.toLowerCase())),
  ].sort()
}

/**
 * Whether an extension waits for the person's approval. Content never does,
 * code (ui, worker) always does. A declarative one does when it carries
 * something that acts for the person: a command, a menu item or a top bar
 * button, a local MCP server, or a model provider. One whose declarative part
 * is only skills and hosted MCP servers is listed at install and asks nothing.
 */
export function extensionNeedsApproval(manifest: Pick<ExtensionManifest, 'tier' | 'contributes'>): boolean {
  if (manifest.tier === 'content') return false
  if (manifest.tier !== 'declarative') return true
  const { commands, menus, topBarItems, mcpServers, providers } = manifest.contributes
  return (
    commands.length + menus.length + topBarItems.length + providers.length > 0 ||
    mcpServers.some((server) => server.transport === 'stdio')
  )
}

/** The fingerprint an approval is bound to: what it may do, and the content of its files. */
export function extensionApprovalFingerprint(access: ExtensionAccess, contentDigest: string): string {
  const canonical = [
    `permissions:${[...access.permissions].sort().join(',')}`,
    `tier:${access.tier}`,
    `worker:${access.worker ? 1 : 0}`,
    `background:${access.background ? 1 : 0}`,
    `localServers:${[...access.localServers].sort().join(',')}`,
    `providers:${[...access.providers].sort().join(',')}`,
    `content:${contentDigest}`,
  ].join('\0')
  return `sha256-${createHash('sha256').update(canonical).digest('hex')}`
}

/**
 * The fingerprint a development folder's approval is bound to: everything it
 * may do (each part of `access`, its local MCP servers by their command,
 * arguments and environment), and the folder itself. Not its files: a
 * development folder is the author's working copy, and binding its code would
 * ask again at every save. So the code is not what the person approved; what
 * it may reach is, and a save that asks for more asks again.
 */
export function devFolderApprovalFingerprint(access: ExtensionAccess, folder: string): string {
  const canonical = [
    `dev-folder:${folder}`,
    `permissions:${[...access.permissions].sort().join(',')}`,
    `tier:${access.tier}`,
    `worker:${access.worker ? 1 : 0}`,
    `background:${access.background ? 1 : 0}`,
    `tools:${Object.entries(access.tools)
      .map(([name, level]) => `${name}=${level}`)
      .sort()
      .join(',')}`,
    `actions:${[...access.actions].sort().join(',')}`,
    `editors:${[...access.editors].sort().join(',')}`,
    `hooks:${[...access.hooks].sort().join(',')}`,
    `localServers:${[...access.localServers].sort().join(',')}`,
    `providers:${[...access.providers].sort().join(',')}`,
  ].join('\0')
  return `sha256-${createHash('sha256').update(canonical).digest('hex')}`
}

/**
 * What `next` asks for beyond `approved`, in words for the person: each
 * permission it adds, a higher tier, a worker, a background worker, and each
 * contribution that carries authority, judged per entry: an MCP tool agents
 * did not have, a tool that may now change things, a command that runs a
 * Studio action it did not run or runs in place of one it did not replace.
 * Empty when it may keep the approval.
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
      const target = rest.join('=')
      growth.push(
        target.startsWith(REPLACES)
          ? `the command "${command}" running in place of Studio's "${target.slice(REPLACES.length)}"`
          : `the command "${command}" running "${target}"`,
      )
    }
  const editorOf = (entry: string) => {
    const [files = '', priority = 'default'] = entry.slice(entry.indexOf('=') + 1).split('|')
    return { id: entry.slice(0, entry.indexOf('=')), files: files.split(','), priority }
  }
  const approvedEditors = new Map(approved.editors.map((entry) => [editorOf(entry).id, editorOf(entry)]))
  for (const entry of next.editors) {
    const { id, files, priority } = editorOf(entry)
    const before = approvedEditors.get(id)
    const added = before ? files.filter((file) => !before.files.includes(file)) : files
    if (added.length > 0)
      growth.push(
        before
          ? `the editor "${id}" opening ${added.join(', ')} files too`
          : `the editor "${id}" opening ${added.join(', ')} files`,
      )
    if (before && before.priority === 'option' && priority === 'default')
      growth.push(`the editor "${id}" opening its files by default`)
  }
  for (const point of next.hooks)
    if (!approved.hooks.includes(point)) {
      const [line] = isExtensionHookPoint(point) ? extensionHookApprovalLines([point]) : []
      growth.push(line ? `a hook: ${line.charAt(0).toLowerCase()}${line.slice(1)}` : `the hook "${point}"`)
    }
  const entries = (list: readonly string[]) =>
    new Map(list.map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))
  const approvedServers = entries(approved.localServers)
  for (const [id, digest] of entries(next.localServers)) {
    const before = approvedServers.get(id)
    if (before === undefined) growth.push(`the local MCP server "${id}"`)
    else if (before !== digest)
      growth.push(`the local MCP server "${id}", with a changed command, environment or files`)
  }
  const approvedProviders = entries(approved.providers)
  for (const [id, origin] of entries(next.providers)) {
    const before = approvedProviders.get(id)
    if (before === undefined) growth.push(`the model provider "${id}", sending its key to ${origin}`)
    else if (before !== origin)
      growth.push(`the model provider "${id}" sending its key to ${origin} instead of ${before}`)
  }
  return growth
}

// ── The store ────────────────────────────────────────────────────────────────

const FILE_NAME = 'extension-approvals.json'

const isTier = (value: unknown): value is ExtensionTier =>
  value === 'content' || value === 'declarative' || value === 'ui' || value === 'worker'

function readRecord(value: unknown): ExtensionApprovalRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { fingerprint, access, devFolder } = value as Record<string, unknown>
  if (devFolder !== undefined && typeof devFolder !== 'string') return null
  if (typeof fingerprint !== 'string' || !fingerprint.startsWith('sha256-')) return null
  if (!access || typeof access !== 'object' || Array.isArray(access)) return null
  const { permissions, tier, worker, background, tools, actions, editors, hooks, localServers, providers } =
    access as Record<string, unknown>
  const strings = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((entry) => typeof entry === 'string')
  if (!strings(permissions) || !strings(actions) || !strings(editors) || !strings(hooks)) return null
  if (!strings(localServers) || !strings(providers)) return null
  if (!isTier(tier) || typeof worker !== 'boolean' || typeof background !== 'boolean') return null
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return null
  const toolAccess = Object.entries(tools as Record<string, unknown>)
  if (!toolAccess.every(([, value]) => value === 'read' || value === 'operate')) return null
  return {
    fingerprint,
    ...(typeof devFolder === 'string' ? { devFolder } : {}),
    access: {
      permissions: [...permissions].sort(),
      tier,
      worker,
      background,
      tools: Object.fromEntries(toolAccess) as Record<string, 'read' | 'operate'>,
      actions: [...actions].sort(),
      editors: [...editors].sort(),
      hooks: [...hooks].sort(),
      localServers: [...localServers].sort(),
      providers: [...providers].sort(),
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
