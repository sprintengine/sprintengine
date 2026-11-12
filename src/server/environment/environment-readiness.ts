import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  StudioEnvironmentReadiness,
  StudioReadinessCli,
  StudioReadinessWaiting,
} from '../../../packages/studio-protocol/src/readiness'
import { resolveConnectorLaunchFrom } from '../../shared/connector-launch'
import type { McpServerConfig } from '../../shared/electron-api'
import { scheduledAgentTitle, type ScheduledAgent, type ScheduledAgentView } from '../../shared/scheduled-agents'

// What this machine has and lacks for the work it runs on its own
// (`environment.readiness`, packages/studio-protocol/src/readiness.ts), and the
// one rule both schedules and watches wait by: a fact this machine KNOWS is
// missing holds the work, in words; a fact it cannot tell holds nothing.
//
// Keys and sign-ins are never copied here from another machine (owner
// ruling): a person signs in on the machine, or copies a key to it when they
// choose. Until then the work names what it waits for.
//
// What is read, and how sure each read is:
//
//   - A CLI's command: the availability this process already probed; a CLI
//     not looked for yet is null.
//   - A CLI's sign-in: where the CLI keeps one in a file, or a key in the
//     environment. A keychain (Claude Code on macOS) cannot be read, so null.
//   - `gh`: its command and `gh auth token`, asked when a watch's read fails.
//   - MCP servers: the launch settings, by the same rule a launch refuses by.
//   - Skills: the ids the launch's installer answers to.
//   - Extensions: the modules loaded on this server.

export type EnvironmentReadinessDeps = {
  /** This machine's name, as the reasons name it. */
  machine: () => string
  /** The agent CLIs this build knows, and whether each one's command was found here (null: not looked for). */
  clis: () => Array<{ id: string; name: string; installed: boolean | null }>
  /** Where a CLI keeps its sign-in, read here; absent for the file checks below. */
  cliSignedIn?: (cliId: string) => boolean | null
  mcpServers: () => Record<string, McpServerConfig> | undefined
  /** Whether a skill id is one a launch here can install. */
  skillKnown: (skillId: string) => boolean
  /** The extensions loaded on this server; null where no module kernel runs. */
  extensions: () => readonly string[] | null
  /** `gh` here: whether its command is found and whether it holds a sign-in (null: cannot tell). */
  gh: () => Promise<{ installed: boolean | null; signedIn: boolean | null }>
  /** The schedules on this server, for what waits. */
  schedules?: () => ScheduledAgentView[]
  /** The pull requests watched here, with what each one's watch waits for. */
  watches?: () => Array<{ url: string; title: string; waiting?: string }>
}

export type EnvironmentReadiness = {
  read(): Promise<StudioEnvironmentReadiness>
  /** Why this machine cannot run the schedule now; null when it can. */
  scheduleWaitingFor(agent: ScheduledAgent): string | null
  /** What a watch's failed read lacks here (`gh` not installed or not signed in); null when neither. */
  ghLacking(reason: string): Promise<string | null>
}

/** Whether a CLI holds a sign-in on this machine, from where it keeps one; null when that cannot be read. */
export function cliSignedInHere(
  cliId: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): boolean | null {
  const has = (...names: string[]) => names.some((name) => Boolean(env[name]?.trim()))
  if (cliId === 'claude-code') {
    if (
      has(
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
      )
    )
      return true
    const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
    if (exists(join(dir, '.credentials.json'))) return true
    // On macOS the sign-in is in the keychain, which is not read here.
    return platform === 'darwin' ? null : false
  }
  if (cliId === 'codex') {
    if (has('OPENAI_API_KEY', 'CODEX_API_KEY')) return true
    const dir = env.CODEX_HOME?.trim() || join(home, '.codex')
    return exists(join(dir, 'auth.json'))
  }
  return null
}

export function createEnvironmentReadiness(deps: EnvironmentReadinessDeps): EnvironmentReadiness {
  const signedIn = deps.cliSignedIn ?? ((cliId: string) => cliSignedInHere(cliId))
  const on = () => deps.machine() || 'this machine'

  const scheduleWaitingFor = (agent: ScheduledAgent): string | null => {
    const extensions = deps.extensions()
    if (agent.ownerModuleId && extensions && !extensions.includes(agent.ownerModuleId))
      return `the extension "${agent.ownerModuleId}" that made it is not installed on ${on()}`
    if (agent.ownerModuleId && !extensions)
      return `the extension "${agent.ownerModuleId}" that made it does not run on ${on()}`
    // A run on another machine of this computer (a WSL distribution) has
    // that machine's CLIs and sign-ins, which are not read here.
    if (!agent.hostId || agent.hostId === 'local') {
      const cli = deps.clis().find((entry) => entry.id === agent.cli)
      const name = cli?.name ?? agent.cli
      if (cli?.installed === false) return `${name} is not installed on ${on()}`
      if (signedIn(agent.cli) === false) return `${name} is not signed in on ${on()}`
    }
    const servers = deps.mcpServers()
    for (const server of agent.mcpServers) {
      const resolved = resolveConnectorLaunchFrom({ connectorId: server.id, installedServers: servers })
      if (!resolved.ok)
        return servers?.[server.id]
          ? `the MCP server ${server.name || server.id} is switched off on ${on()}`
          : `the MCP server ${server.name || server.id} is not set up on ${on()}`
    }
    for (const skill of agent.skills)
      if (!deps.skillKnown(skill.id)) return `the skill ${skill.name || skill.id} is not on ${on()}`
    return null
  }

  return {
    scheduleWaitingFor,
    async ghLacking(reason) {
      if (reason === 'gh-missing') return `gh is not installed on ${on()}`
      if (reason !== 'gh-failed') return null
      const gh = await deps.gh().catch(() => ({ installed: null, signedIn: null }))
      if (gh.installed === false) return `gh is not installed on ${on()}`
      return gh.signedIn === false ? `gh is not signed in on ${on()}` : null
    },
    async read() {
      const clis: StudioReadinessCli[] = deps
        .clis()
        .map((cli) => ({ id: cli.id, name: cli.name, installed: cli.installed, signedIn: signedIn(cli.id) }))
      const servers = deps.mcpServers() ?? {}
      const waiting: StudioReadinessWaiting[] = []
      for (const agent of deps.schedules?.() ?? []) {
        const reason = agent.waiting ?? scheduleWaitingFor(agent)
        if (reason)
          waiting.push({
            kind: 'schedule',
            id: agent.id,
            title: scheduledAgentTitle(agent.prompt, agent.name),
            reason,
          })
      }
      for (const watch of deps.watches?.() ?? [])
        if (watch.waiting)
          waiting.push({ kind: 'pull-request-watch', id: watch.url, title: watch.title, reason: watch.waiting })
      return {
        machine: on(),
        clis,
        gh: await deps.gh().catch(() => ({ installed: null, signedIn: null })),
        mcpServers: Object.values(servers).map((server) => ({
          id: server.id,
          name: server.name || server.id,
          enabled: server.enabled === true,
        })),
        extensions: [...(deps.extensions() ?? [])],
        waiting,
      }
    },
  }
}
