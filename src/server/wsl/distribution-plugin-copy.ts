// The app's Claude plugin copy for the desktop's WSL terminals, made by the
// distribution's own Studio from its own resources.
//
// On the desktop a launch hands Claude Code `--plugin-dir` pointing at a copy
// materialised under userData (`agent-integration-home.ts`), with that build's
// absolute paths substituted into it: the Node that runs the MCP bridge, the
// bridge, the agent-state reporter and its socket. Those are Windows paths,
// useless to a Claude running in Linux, and a copy is too large to send whole
// over the protocol. But this server's tree ships every source it is built
// from (`resources/studio-plugin`, `hooks`, `automation`, `builtin-skills`), so
// it builds the copy here, as the environment it runs in, with its own paths:
// the Node it runs on, its bridge, its data directory (where its gateway's
// discovery file is) and its agent-state socket. The desktop says only which
// Studio skills the person chose (`environment.pluginCopy`).
//
// The hook commands in the template start with a bare `node`, which in Linux
// would be whatever Node the person has, if any; they are pointed at this
// server's Node.

import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import type { StudioTerminalPluginCopy } from '../../../packages/studio-protocol/src/environment-access'
import {
  LAUNCH_REPORTER_REL,
  LAUNCH_STATUS_LINE_REL,
  launchPluginDirs,
  launchSkillPluginDir,
  writeLaunchSkillPlugins,
} from '../../main/agent-integration-home'
import { materialiseStudioPluginInto, readStudioPluginTemplate } from '../../main/skills/studio-plugin'
import { ensureTree } from './distribution/files.mjs'

type PluginSources = {
  templateRoot: string
  reporterSourcePath: string
  statusLineSourcePath: string
  /** The Studio skills the person opted into; the copy carries only these. */
  enabledSkillDirs: readonly string[]
  /** The bundled skills a launch can ask for, each written as a plugin of its own. */
  launchSkillsSourceRoot: string
}

type PluginTokens = {
  /** This server's Node. */
  nodeCommand: string
  /** This server's resources directory, which holds `automation/mcp-stdio-bridge.mjs`. */
  resourcesDir: string
  /** Where the copy is written: this server's data directory, which is also what the bridge reads its discovery file from. */
  dataDir: string
  agentStateSocketPath: string
}

type BuiltPluginCopy = StudioTerminalPluginCopy & {
  files: Array<{ path: string; b64: string }>
  digest: string
}

/** The tree the copy is written under, in this server's data directory, which is its profile's own. */
const PLUGIN_TREE = 'terminal-plugin'

/** What a launch gets when this build shipped no plugin: the workspace install then carries agent state. */
const NO_PLUGIN_COPY: StudioTerminalPluginCopy = { pluginDirs: [], skillPluginDirs: {}, statusLineScriptPath: null }

function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/gu, '/')
}

function posixRel(path: string): string {
  return path.split(sep).join('/')
}

/** `node "<script>"` hook commands pointed at `nodeCommand` instead of PATH's node. */
export function pinHookNode(hooksJson: string, nodeCommand: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(hooksJson)
  } catch {
    return hooksJson
  }
  const quoted = `'${nodeCommand.replace(/'/g, `'\\''`)}'`
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.command === 'string' && record.command.startsWith('node "')) {
        record.command = `${quoted}${record.command.slice('node'.length)}`
      }
      Object.values(record).forEach(visit)
    }
  }
  visit(parsed)
  return `${JSON.stringify(parsed, null, 2)}\n`
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** The copy in memory, or null when this build shipped no plugin. */
export async function buildPluginCopy(sources: PluginSources, tokens: PluginTokens): Promise<BuiltPluginCopy | null> {
  const read = await readStudioPluginTemplate(sources.templateRoot)
  if (!read.ok) return null
  const root = posixJoin(tokens.dataDir, PLUGIN_TREE)
  const staging = await mkdtemp(join(tmpdir(), 'sprintengine-terminal-plugin-'))
  try {
    const destination = join(staging, 'copy')
    const materialised = await materialiseStudioPluginInto({
      template: read.template,
      destination,
      tokens: {
        nodeCommand: tokens.nodeCommand,
        bridgeScriptPath: posixJoin(tokens.resourcesDir, 'automation', 'mcp-stdio-bridge.mjs'),
        userDataDir: tokens.dataDir,
        agentStateReporterPath: posixJoin(root, posixRel(LAUNCH_REPORTER_REL)),
        agentStateSocketPath: tokens.agentStateSocketPath,
      },
      neuterHooks: false,
      skillDirs: sources.enabledSkillDirs,
    })
    if (!materialised.ok) return null
    const skillPluginDirs: Record<string, string> = {}
    const written = await writeLaunchSkillPlugins(destination, sources.launchSkillsSourceRoot).catch(() => ({}))
    for (const skillId of Object.keys(written)) {
      skillPluginDirs[skillId] = posixJoin(root, posixRel(relative(destination, launchSkillPluginDir(destination, skillId))))
    }
    const files = new Map<string, Buffer>()
    for (const path of await walk(destination)) {
      const rel = posixRel(relative(destination, path))
      const data = await readFile(path)
      files.set(
        rel,
        rel.endsWith('hooks/hooks.json') ? Buffer.from(pinHookNode(data.toString('utf8'), tokens.nodeCommand)) : data,
      )
    }
    // Without its reporter the copy's hooks would report nothing: no copy.
    const reporter = await readFile(sources.reporterSourcePath).catch(() => null)
    if (!reporter) return null
    files.set(posixRel(LAUNCH_REPORTER_REL), reporter)
    // Optional, as on this machine: without it the launch sends no status line.
    const statusLine = await readFile(sources.statusLineSourcePath).catch(() => null)
    if (statusLine) files.set(posixRel(LAUNCH_STATUS_LINE_REL), statusLine)
    const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const hash = createHash('sha256')
    for (const [path, data] of sorted) hash.update(path).update('\0').update(data).update('\0')
    return {
      files: sorted.map(([path, data]) => ({ path, b64: data.toString('base64') })),
      digest: hash.digest('hex'),
      pluginDirs: launchPluginDirs(root).map(posixRel),
      skillPluginDirs,
      statusLineScriptPath: statusLine ? posixJoin(root, posixRel(LAUNCH_STATUS_LINE_REL)) : null,
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * This server's plugin copies for the desktop's WSL terminals: `ensure` builds
 * the copy for a choice of Studio skills and writes it under the data
 * directory, unless the copy there already matches, and says where it is.
 */
export function createDistributionPluginCopies(options: {
  /** This server's resources directory; null (a run with none) makes no copy. */
  resourcesDir: string | null
  dataDir: string
  agentStateSocketPath: string
  /** Defaults to the Node this server runs on. */
  nodeCommand?: string
}): { ensure(enabledSkills: readonly string[]): Promise<StudioTerminalPluginCopy> } {
  const resourcesDir = options.resourcesDir
  // One at a time: two writes of the tree would share a staging directory.
  let chain: Promise<unknown> = Promise.resolve()
  return {
    ensure(enabledSkills) {
      const run = async (): Promise<StudioTerminalPluginCopy> => {
        if (!resourcesDir) return NO_PLUGIN_COPY
        const copy = await buildPluginCopy(
          {
            templateRoot: posixJoin(resourcesDir, 'studio-plugin'),
            reporterSourcePath: posixJoin(resourcesDir, 'hooks', 'sprintengine-agent-state.mjs'),
            statusLineSourcePath: posixJoin(resourcesDir, 'hooks', 'sprintengine-status-line.mjs'),
            enabledSkillDirs: enabledSkills,
            launchSkillsSourceRoot: posixJoin(resourcesDir, 'builtin-skills'),
          },
          {
            nodeCommand: options.nodeCommand ?? process.execPath,
            resourcesDir,
            dataDir: options.dataDir,
            agentStateSocketPath: options.agentStateSocketPath,
          },
        )
        if (!copy) return NO_PLUGIN_COPY
        ensureTree({ base: options.dataDir, name: PLUGIN_TREE, digest: copy.digest, files: copy.files })
        return {
          pluginDirs: copy.pluginDirs,
          skillPluginDirs: copy.skillPluginDirs,
          statusLineScriptPath: copy.statusLineScriptPath,
        }
      }
      const next = chain.then(run, run)
      chain = next.catch(() => undefined)
      return next
    },
  }
}
