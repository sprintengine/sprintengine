// What installed extensions hand the person's agents and chats on this
// machine: their skills, their MCP servers and their model providers
// (`contributes.skills`, `.mcpServers`, `.providers`), projected out of their
// install folders into one place every consumer reads.
//
// Under `<dataDir>/extension-agent-contributions/`:
//
//   state.json                 which generation of each extension is current
//   <key>/<generation>/        one extension's projection: a copy of each of
//                              its skills (`skills/<publisher>.<id>.<skill id>/`) and, when it
//                              has skills, a plugin manifest so the folder is
//                              itself a plugin directory an agent loads
//
// Only an extension that is switched on and may run (approved as it is now,
// or asking for nothing) is projected; anything else is retracted. The
// generation is content-addressed: the same skills, servers and providers make
// the same folder, so a projection that did not change writes nothing.
//
// Restart-safe by its order, never half applied: a generation is copied into a
// staging folder and its completion mark written last before it is renamed
// into place; only then does state.json (written to a temporary file and
// renamed) point at it; only after that are older generations, retracted
// extensions and stray staging folders removed. A crash before the state is
// written leaves the previous state pointing at folders that still exist; a
// crash after it leaves the new one complete and some leftovers, which the next
// reconcile (at every start) removes. Readers trust only a generation that the
// state names and that carries its completion mark.
//
// A skill's files are copied from the digests its standing was judged on, each
// checked against its digest as it is read, so what agents read is what was
// approved (or listed). Its SKILL.md is copied under its namespaced name, with
// every frontmatter key but its description dropped (skill-frontmatter.ts). A local MCP server runs from the install folder, which
// is only projected while the approval covers the files there.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { SKILL_FILE_MAX_BYTES, SKILL_FOLDER_MAX_FILES } from '../../../../packages/extension-sdk/src/extension-manifest'
import {
  extensionMcpServerName,
  extensionProviderId,
  extensionSkillName,
  withExtensionPath,
} from '../../../../packages/extension-sdk/src/agent-contributions'
import type { McpServerConfig } from '../../../shared/electron-api'
import type { ConversationMcpServer } from '../../../shared/conversation-runtime'
import type { ExtensionManifest } from '../../../shared/modules/third-party-manifest'
import { isExtensionRunnable, type ExtensionStanding } from '../../../main/modules/module-signature'
import { projectedSkillText } from './skill-frontmatter'
import { writeFileAtomic } from '../../platform/atomic-file'

/** Under the data folder: every extension's projection, and the state naming the current ones. */
export const AGENT_CONTRIBUTIONS_DIR = 'extension-agent-contributions'
const STATE_FILE = 'state.json'
const COMPLETE_MARK = '.complete'
const STAGING_PREFIX = '.staging-'
/** Bumped when what a generation holds changes shape, so every one is built again. */
const LAYOUT = 2

/** A skill as agents get it. */
export type ProjectedSkill = {
  /** Its id in extension.json. */
  id: string
  /** The name agents see it by: `<publisher>.<id>.<skill id>`. */
  name: string
  /** The copied folder holding its SKILL.md, named `name` as the SKILL.md's own `name` is. */
  dir: string
}

/** A model provider as chats get it: OpenAI-compatible, its key kept under `id`. */
export type ProjectedProvider = {
  /** `<publisher>.<id>/<provider id>`: what Studio knows it by, and keeps its key under. */
  id: string
  /** Its id in extension.json. */
  localId: string
  name: string
  baseUrl: string
  chatCompletionsPath?: string
  modelsPath?: string
  models: Array<{ id: string; name?: string }>
  apiKey?: { label: string }
}

export type ProjectedExtension = {
  key: string
  /** The extension's name and version, for whoever shows where a contribution came from. */
  name: string
  version: string
  generation: string
  /** The generation folder as a plugin directory, when it holds skills. */
  pluginDir: string | null
  skills: ProjectedSkill[]
  mcpServers: McpServerConfig[]
  providers: ProjectedProvider[]
}

export type AgentContributionState = { extensions: Record<string, ProjectedExtension> }

/** One installed extension, as the reconcile judges it. */
export type ProjectionCandidate = {
  key: string
  extension: Pick<ExtensionManifest, 'name' | 'version' | 'contributes'>
  moduleRoot: string
  standing: Pick<ExtensionStanding, 'signature' | 'approval' | 'verifiedFiles'>
}

export type ReconcileInput = {
  dataDir: string
  extensions: readonly ProjectionCandidate[]
  /** Whether the person has it switched on. */
  enabled: (key: string) => boolean
  /** Ids a provider may not take: the built-in providers' and agent CLIs'. */
  protectedProviderIds?: ReadonlySet<string>
  warn?: (message: string) => void
}

export type ReconcileResult = {
  state: AgentContributionState
  /** Extensions that may run but whose projection failed, with why. */
  failed: Array<{ key: string; message: string }>
}

const rootOf = (dataDir: string) => join(dataDir, AGENT_CONTRIBUTIONS_DIR)

// One reconcile at a time per data folder: two must not each write a state
// the other's cleanup then undoes.
const chains = new Map<string, Promise<unknown>>()

/** Make the projection match the extensions installed, switched on and runnable now. */
export function reconcileAgentContributions(input: ReconcileInput): Promise<ReconcileResult> {
  const root = rootOf(input.dataDir)
  const previous = chains.get(root) ?? Promise.resolve()
  const run = previous.then(
    () => reconcile(input),
    () => reconcile(input),
  )
  chains.set(
    root,
    run.catch(() => undefined),
  )
  return run
}

async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const root = rootOf(input.dataDir)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const current = readStateFile(root)
  const next: AgentContributionState = { extensions: {} }
  const failed: ReconcileResult['failed'] = []
  for (const candidate of input.extensions) {
    if (!input.enabled(candidate.key) || !isExtensionRunnable(candidate.standing as ExtensionStanding)) continue
    const { contributes } = candidate.extension
    if (contributes.skills.length + contributes.mcpServers.length + contributes.providers.length === 0) continue
    try {
      next.extensions[candidate.key] = await projectExtension(root, candidate, input.protectedProviderIds)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ key: candidate.key, message })
      input.warn?.(`Extension "${candidate.key}": what it hands agents was not projected: ${message}`)
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await writeFileAtomic(join(root, STATE_FILE), `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      exactMode: true,
    })
  }
  await removeUnreferenced(root, next)
  return { state: next, failed }
}

async function projectExtension(
  root: string,
  candidate: ProjectionCandidate,
  protectedProviderIds: ReadonlySet<string> | undefined,
): Promise<ProjectedExtension> {
  const { key, extension, moduleRoot } = candidate
  const files = candidate.standing.verifiedFiles
  if (!files) throw new Error('its files were not verified.')
  const skills = extension.contributes.skills.map((skill) => {
    const prefix = `${skill.path.replace(/\/+$/, '')}/`
    const listed = Object.keys(files)
      .filter((path) => path.startsWith(prefix))
      .sort()
    if (!listed.includes(`${prefix}SKILL.md`)) throw new Error(`skill "${skill.id}" has no SKILL.md in ${skill.path}.`)
    if (listed.length > SKILL_FOLDER_MAX_FILES)
      throw new Error(`skill "${skill.id}" holds more than ${SKILL_FOLDER_MAX_FILES} files.`)
    return { skill, files: listed.map((path) => ({ path, rest: path.slice(prefix.length), digest: files[path]! })) }
  })
  for (const provider of extension.contributes.providers)
    if (protectedProviderIds?.has(provider.id))
      throw new Error(`provider "${provider.id}" takes the id of one of Studio’s own.`)
  const mcpServers = extension.contributes.mcpServers.map((server) => projectedServer(key, moduleRoot, server))
  const providers = extension.contributes.providers.map((provider): ProjectedProvider => ({
    id: extensionProviderId(key, provider.id),
    localId: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    ...(provider.chatCompletionsPath ? { chatCompletionsPath: provider.chatCompletionsPath } : {}),
    ...(provider.modelsPath ? { modelsPath: provider.modelsPath } : {}),
    models: provider.models.map((model) => ({ id: model.id, ...(model.name ? { name: model.name } : {}) })),
    ...(provider.apiKey ? { apiKey: { label: provider.apiKey.label } } : {}),
  }))
  const generation = createHash('sha256')
    .update(
      JSON.stringify({
        layout: LAYOUT,
        key,
        name: extension.name,
        version: extension.version,
        skills: skills.map(({ skill, files }) => [skill.id, files.map((file) => [file.rest, file.digest])]),
      }),
    )
    .digest('hex')
    .slice(0, 24)
  const folder = join(root, key, generation)
  if (skills.length > 0 && !existsSync(join(folder, COMPLETE_MARK))) {
    const staging = join(root, key, `${STAGING_PREFIX}${process.pid}-${Date.now()}`)
    await rm(staging, { recursive: true, force: true })
    try {
      for (const { skill, files: skillFiles } of skills)
        for (const file of skillFiles) {
          const bytes = await readVerified(join(moduleRoot, ...file.path.split('/')), file.digest)
          if (file.rest === 'SKILL.md' && bytes.length > SKILL_FILE_MAX_BYTES)
            throw new Error(`skill "${skill.id}" has a SKILL.md over ${SKILL_FILE_MAX_BYTES / 1024} KiB.`)
          const name = extensionSkillName(key, skill.id)
          const target = join(staging, 'skills', name, ...file.rest.split('/'))
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await writeFile(target, file.rest === 'SKILL.md' ? projectedSkillText(bytes.toString('utf8'), name) : bytes, {
            mode: 0o600,
          })
        }
      await mkdir(join(staging, '.claude-plugin'), { recursive: true, mode: 0o700 })
      await writeFile(
        join(staging, '.claude-plugin', 'plugin.json'),
        `${JSON.stringify({ name: pluginName(key), description: `Skills from the extension ${extension.name}.`, version: extension.version }, null, 2)}\n`,
        { mode: 0o600 },
      )
      // Last: a staging folder without it was never finished.
      await writeFile(join(staging, COMPLETE_MARK), `${generation}\n`, { mode: 0o600 })
      await rm(folder, { recursive: true, force: true })
      await rename(staging, folder)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
  return {
    key,
    name: extension.name,
    version: extension.version,
    generation,
    pluginDir: skills.length > 0 ? folder : null,
    skills: skills.map(({ skill }) => ({
      id: skill.id,
      name: extensionSkillName(key, skill.id),
      dir: join(folder, 'skills', extensionSkillName(key, skill.id)),
    })),
    mcpServers,
    providers,
  }
}

/** A plugin name agents accept: the install key with its dot as a double dash, which no id or publisher holds. */
function pluginName(key: string): string {
  return key.replace('.', '--')
}

function projectedServer(
  key: string,
  moduleRoot: string,
  server: ExtensionManifest['contributes']['mcpServers'][number],
): McpServerConfig {
  const fill = (value: string) => withExtensionPath(value, moduleRoot)
  const base: McpServerConfig = {
    id: extensionMcpServerName(key, server.id),
    name: server.name,
    ...(server.description ? { description: server.description } : {}),
    transport: server.transport,
    enabled: true,
    required: false,
    clients: [],
    scope: 'user',
    source: 'custom',
    riskLevel: server.transport === 'stdio' ? 'local-command' : 'network',
  }
  if (server.transport === 'http') return { ...base, url: server.url, args: [], env: {} }
  return {
    ...base,
    command: fill(server.command ?? ''),
    args: (server.args ?? []).map(fill),
    env: Object.fromEntries((server.env ?? []).map((variable) => [variable.name, fill(variable.value)])),
  }
}

async function readVerified(path: string, digest: string): Promise<Buffer> {
  const info = await lstat(path)
  if (!info.isFile()) throw new Error(`${path} is not a regular file.`)
  const bytes = await readFile(path)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== digest) throw new Error(`${path} changed since its extension was checked.`)
  return bytes
}

async function removeUnreferenced(root: string, state: AgentContributionState): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === STATE_FILE) continue
    const path = join(root, entry.name)
    const kept = state.extensions[entry.name]
    if (!entry.isDirectory() || !kept) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
      continue
    }
    for (const generation of await readdir(path).catch(() => [] as string[]))
      if (kept.pluginDir === null || generation !== kept.generation)
        await rm(join(path, generation), { recursive: true, force: true }).catch(() => undefined)
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStateFile(root: string): AgentContributionState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, STATE_FILE), 'utf8'))
    if (!isRecord(parsed) || !isRecord(parsed.extensions)) return { extensions: {} }
    return parsed as AgentContributionState
  } catch {
    return { extensions: {} }
  }
}

/** Only what the state names and is whole on disk: a generation without its mark is never handed out. */
function completeOnly(state: AgentContributionState): AgentContributionState {
  const extensions: Record<string, ProjectedExtension> = {}
  for (const [key, projected] of Object.entries(state.extensions)) {
    if (!isRecord(projected) || projected.key !== key) continue
    if (!Array.isArray(projected.skills) || !Array.isArray(projected.mcpServers) || !Array.isArray(projected.providers))
      continue
    if (projected.pluginDir !== null && !existsSync(join(projected.pluginDir, COMPLETE_MARK))) continue
    extensions[key] = projected
  }
  return { extensions }
}

const readers = new Map<string, () => AgentContributionState>()

/**
 * What the extensions on this data folder hand agents and chats now. The
 * state is parsed again only when it changed, so a launch or a provider
 * lookup costs a stat and a look for each extension's completion mark.
 */
export function readAgentContributions(dataDir: string): AgentContributionState {
  const root = rootOf(dataDir)
  let reader = readers.get(root)
  if (!reader) {
    let seen = ''
    let state: AgentContributionState = { extensions: {} }
    reader = () => {
      let stamp = 'missing'
      try {
        const info = statSync(join(root, STATE_FILE))
        stamp = `${info.mtimeMs}:${info.size}:${info.ino}`
      } catch {
        // Missing: nothing is projected.
      }
      if (stamp !== seen) {
        seen = stamp
        state = stamp === 'missing' ? { extensions: {} } : readStateFile(root)
      }
      // The marks are looked at on every read, not cached with the state: a
      // folder rebuilt under an unchanged state is whole again at once.
      return completeOnly(state)
    }
    readers.set(root, reader)
  }
  return reader()
}

/** Every projected extension, in install-key order. */
export function projectedExtensions(dataDir: string): ProjectedExtension[] {
  const { extensions } = readAgentContributions(dataDir)
  return Object.keys(extensions)
    .sort()
    .map((key) => extensions[key]!)
}

/** Every MCP server the extensions hand agents. */
export function projectedMcpServers(dataDir: string): McpServerConfig[] {
  return projectedExtensions(dataDir).flatMap((extension) => extension.mcpServers)
}

/** Every skill the extensions hand agents, with the plugin directory that carries it. */
export function projectedSkills(dataDir: string): Array<ProjectedSkill & { pluginDir: string; version: string }> {
  return projectedExtensions(dataDir).flatMap((extension) =>
    extension.pluginDir
      ? extension.skills.map((skill) => ({ ...skill, pluginDir: extension.pluginDir!, version: extension.generation }))
      : [],
  )
}

/** Every model provider the extensions add to chats. */
export function projectedProviders(dataDir: string): Array<ProjectedProvider & { extension: string }> {
  return projectedExtensions(dataDir).flatMap((extension) =>
    extension.providers.map((provider) => ({ ...provider, extension: extension.name })),
  )
}

/** What a terminal launch is handed of the extensions' projection: their servers, and their skills with the folder carrying each. */
export function launchExtensionContributions(dataDir: string): {
  servers: McpServerConfig[]
  skills: Array<{ name: string; dir: string; pluginDir: string; version: string }>
} {
  return {
    servers: projectedMcpServers(dataDir),
    skills: projectedSkills(dataDir).map(({ name, dir, pluginDir, version }) => ({ name, dir, pluginDir, version })),
  }
}

/** What a chat on this machine is handed of the extensions' projection: their servers, and their skills' plugin folders. */
export function chatExtensionContributions(dataDir: string): ChatExtensionContributions {
  const extensions = projectedExtensions(dataDir)
  return {
    mcpServers: extensions.flatMap((extension) =>
      extension.mcpServers.map((server) => ({
        id: server.id,
        name: server.name,
        transport: server.transport,
        ...(server.command ? { command: server.command } : {}),
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
        ...(server.url ? { url: server.url } : {}),
      })),
    ),
    pluginDirs: extensions.flatMap((extension) => (extension.pluginDir ? [extension.pluginDir] : [])),
  }
}

export type ChatExtensionContributions = {
  mcpServers: ConversationMcpServer[]
  /** Plugin folders carrying the extensions' skills. */
  pluginDirs: string[]
}
