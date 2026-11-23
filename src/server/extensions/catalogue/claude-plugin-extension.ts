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
// MCP servers (`.mcp.json`, or `mcpServers` in `.claude-plugin/plugin.json`).
// Studio writes the extension.json that says so into the folder it checked
// out, before the folder is hashed and reviewed, so the install review lists
// exactly these and the approval binds to them. What has no extension point
// (slash commands, sub-agents, hooks) is named as left out.

const PLUGIN_MANIFEST = join('.claude-plugin', 'plugin.json')
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

function mcpServersOf(raw: unknown): Array<Record<string, unknown>> {
  const servers = isRecord(raw) && isRecord(raw.mcpServers) ? raw.mcpServers : isRecord(raw) ? raw : {}
  const out: Array<Record<string, unknown>> = []
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value)) continue
    const id = slug(name, 63) || `server-${out.length + 1}`
    if (typeof value.url === 'string') {
      out.push({ id, name: name.slice(0, 64), transport: 'http', url: value.url })
      continue
    }
    if (typeof value.command !== 'string') continue
    const env = isRecord(value.env)
      ? Object.entries(value.env)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([envName, envValue]) => ({ name: envName, value: withExtensionPath(envValue) }))
      : []
    out.push({
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
  return out
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
  const fromFile = await readJson(join(folder, '.mcp.json'))
  const inline = isRecord(plugin.mcpServers) ? plugin.mcpServers : null
  const mcpServers = mcpServersOf(fromFile ?? (inline ? { mcpServers: inline } : null))

  const leftOut: string[] = []
  for (const [part, words] of [
    ['commands', 'slash commands'],
    ['agents', 'sub-agents'],
    ['hooks', 'hooks'],
  ] as const)
    if (existsSync(join(folder, part)) || plugin[part] !== undefined) leftOut.push(words)
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
      ...(skills.length > 0 ? { skills: skills.slice(0, 64) } : {}),
      ...(mcpServers.length > 0 ? { mcpServers: mcpServers.slice(0, 16) } : {}),
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
