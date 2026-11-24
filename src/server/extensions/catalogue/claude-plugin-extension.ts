import { existsSync } from 'node:fs'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_MANIFEST_SINCE,
  validateExtensionManifest,
} from '../../../../packages/extension-sdk/src/extension-manifest'

// A Claude Code plugin repository installed from a git URL, as an extension
// that hands agents what it can: its skills (`skills/<name>/SKILL.md`) and its
// MCP servers (`.mcp.json` and `mcpServers` in `.claude-plugin/plugin.json`,
// merged; `.mcp.json`'s wins a name both use). Studio writes the
// extension.json that says so into the folder it checked out, before the
// folder is hashed and reviewed, so the install review lists exactly these and
// the approval binds to them. Everything else is named as left out, in plain
// words: what has no extension point (slash commands, sub-agents, hooks,
// output styles, other plugin.json fields), skills and servers past the
// extension limits, HTTP headers, and an `sse` server read as HTTP.

const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json')
/** The most skills and MCP servers an extension.json lists. */
const MAX_SKILLS = 64
const MAX_MCP_SERVERS = 16
/** plugin.json fields that describe the plugin, or that this conversion reads. */
const READ_FIELDS = new Set([
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'mcpServers',
  'commands',
  'agents',
  'hooks',
  'outputStyles',
])
const PLUGIN_ROOT_TOKENS = ['${CLAUDE_PLUGIN_ROOT}', '$CLAUDE_PLUGIN_ROOT']
const EXTENSION_PATH = '${extensionPath}'

export type ClaudePluginConversion =
  { kind: 'not-a-plugin' } | { kind: 'converted'; leftOut: string[] } | { kind: 'refused'; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function slug(value: string, max: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
}

const withExtensionPath = (value: string) =>
  PLUGIN_ROOT_TOKENS.reduce((text, token) => text.replaceAll(token, EXTENSION_PATH), value)

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

type McpServerEntry = { name: string; value: Record<string, unknown> }

const serverEntries = (servers: unknown): McpServerEntry[] =>
  isRecord(servers)
    ? Object.entries(servers).flatMap(([name, value]) => (isRecord(value) ? [{ name, value }] : []))
    : []

/** The servers as an extension declares them, and what of each was left out. */
function mcpServersOf(entries: McpServerEntry[]): { servers: Array<Record<string, unknown>>; leftOut: string[] } {
  const servers: Array<Record<string, unknown>> = []
  const leftOut: string[] = []
  for (const { name, value } of entries) {
    const id = slug(name, 63) || `server-${servers.length + 1}`
    if (typeof value.url === 'string') {
      if (isRecord(value.headers) && Object.keys(value.headers).length > 0)
        leftOut.push(`the HTTP headers of MCP server "${name}"`)
      if (value.type === 'sse') leftOut.push(`the SSE transport of MCP server "${name}" (Studio reaches it over HTTP)`)
      servers.push({ id, name: name.slice(0, 64), transport: 'http', url: value.url })
      continue
    }
    if (typeof value.command !== 'string') {
      leftOut.push(`MCP server "${name}", which names no command or URL`)
      continue
    }
    const env = isRecord(value.env)
      ? Object.entries(value.env)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([envName, envValue]) => ({ name: envName, value: withExtensionPath(envValue) }))
      : []
    servers.push({
      id,
      name: name.slice(0, 64),
      transport: 'stdio',
      command: withExtensionPath(value.command),
      ...(Array.isArray(value.args)
        ? { args: value.args.filter((arg): arg is string => typeof arg === 'string').map(withExtensionPath) }
        : {}),
      ...(env.length > 0 ? { env } : {}),
    })
  }
  return { servers, leftOut }
}

/**
 * The plugin's MCP servers: `.mcp.json`'s and plugin.json's inline ones
 * together. A name both use is `.mcp.json`'s, and the other is named as left
 * out; so is a `mcpServers` that names another file.
 */
function mergedMcpServers(
  fromFile: unknown,
  plugin: Record<string, unknown>,
): { entries: McpServerEntry[]; leftOut: string[] } {
  const leftOut: string[] = []
  const file = serverEntries(isRecord(fromFile) && isRecord(fromFile.mcpServers) ? fromFile.mcpServers : fromFile)
  const inline = serverEntries(plugin.mcpServers)
  if (typeof plugin.mcpServers === 'string')
    leftOut.push(`the MCP servers file plugin.json names ("${plugin.mcpServers.slice(0, 120)}")`)
  const names = new Set(file.map((entry) => entry.name))
  for (const entry of inline)
    if (names.has(entry.name))
      leftOut.push(`plugin.json's MCP server "${entry.name}" (.mcp.json's of that name is used)`)
  return { entries: [...file, ...inline.filter((entry) => !names.has(entry.name))], leftOut }
}

/**
 * When `folder` holds a Claude Code plugin and no extension.json, write the
 * extension.json that hands agents its skills and MCP servers.
 */
export async function convertClaudePlugin(folder: string): Promise<ClaudePluginConversion> {
  if (existsSync(join(folder, EXTENSION_MANIFEST_FILENAME))) return { kind: 'not-a-plugin' }
  const plugin = await readJson(join(folder, PLUGIN_MANIFEST))
  if (!isRecord(plugin)) return { kind: 'not-a-plugin' }
  const name = typeof plugin.name === 'string' ? plugin.name : ''
  const id = slug(name, 63)
  if (!id)
    return { kind: 'refused', message: 'The Claude Code plugin’s plugin.json has no name Studio can use as an id.' }
  const version =
    typeof plugin.version === 'string' && /^\d+\.\d+\.\d+$/.test(plugin.version) ? plugin.version : '0.0.0'

  const skills: Array<{ id: string; path: string }> = []
  const skillsDir = join(folder, 'skills')
  for (const entry of await readdir(skillsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillFile = join(skillsDir, entry.name, 'SKILL.md')
    const info = await lstat(skillFile).catch(() => null)
    const skillId = slug(entry.name, 63)
    if (info?.isFile() && skillId && !skills.some((skill) => skill.id === skillId))
      skills.push({ id: skillId, path: `skills/${entry.name}` })
  }
  const merged = mergedMcpServers(await readJson(join(folder, '.mcp.json')), plugin)
  const converted = mcpServersOf(merged.entries)
  const mcpServers = converted.servers

  const leftOut: string[] = []
  for (const [folderName, field, words] of [
    ['commands', 'commands', 'slash commands'],
    ['agents', 'agents', 'sub-agents'],
    ['hooks', 'hooks', 'hooks'],
    ['output-styles', 'outputStyles', 'output styles'],
  ] as const)
    if (existsSync(join(folder, folderName)) || plugin[field] !== undefined) leftOut.push(words)
  for (const field of Object.keys(plugin)) if (!READ_FIELDS.has(field)) leftOut.push(`plugin.json's "${field}"`)
  leftOut.push(...merged.leftOut, ...converted.leftOut)
  if (skills.length > MAX_SKILLS) leftOut.push(`${skills.length - MAX_SKILLS} skills past the first ${MAX_SKILLS}`)
  if (mcpServers.length > MAX_MCP_SERVERS)
    leftOut.push(`${mcpServers.length - MAX_MCP_SERVERS} MCP servers past the first ${MAX_MCP_SERVERS}`)
  if (skills.length === 0 && mcpServers.length === 0)
    return {
      kind: 'refused',
      message: 'The Claude Code plugin holds no skills or MCP servers, which is what Studio installs of one.',
    }

  const manifest = {
    manifestVersion: 1,
    id,
    version,
    engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
    tier: 'declarative',
    name: name.slice(0, 64),
    ...(typeof plugin.description === 'string' ? { description: plugin.description.slice(0, 512) } : {}),
    ...(typeof plugin.license === 'string' ? { license: plugin.license.slice(0, 128) } : {}),
    contributes: {
      ...(skills.length > 0 ? { skills: skills.slice(0, MAX_SKILLS) } : {}),
      ...(mcpServers.length > 0 ? { mcpServers: mcpServers.slice(0, MAX_MCP_SERVERS) } : {}),
    },
  }
  const checked = validateExtensionManifest(manifest)
  if (!checked.ok)
    return {
      kind: 'refused',
      message: `The Claude Code plugin cannot be read as an extension: ${checked.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; ')}`,
    }
  await writeFile(join(folder, EXTENSION_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`)
  return { kind: 'converted', leftOut }
}
