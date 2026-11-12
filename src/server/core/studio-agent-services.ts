import { join } from 'node:path'

import { createAgentConfigImportService, type AgentConfigImportService } from '../../main/agent-config-import'
import { createBuiltinSkillManager, setDefaultSkillManager, type BuiltinSkillManager } from '../../main/builtin-skills'
import { subscribeKnownCliAvailability } from '../../main/cli-availability'
import { createCliRuntimes, type CliRuntimes } from '../../main/cli-runtimes'
import {
  CLI_UPDATE_NOTICES_FILENAME,
  configureCliVersionService,
  launchSettingsCliMachines,
  scheduleCliVersionRead,
} from '../../main/cli-version-advisory-service'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import type { AgentLaunchSettingsStore } from '../../main/launch-settings-store'
import { createMcpConfigService, type McpConfigService } from '../../main/mcp-config-service'
import { setCliModelDiscoveryRuntimesResolver } from '../../main/model-discovery/discovery-pass'
import { getPluginRegistry } from '../../main/plugin-registry-instance'
import { createStudioAreaSkillStore, type StudioAreaSkillStore } from '../../main/studio-area-skill-store'
import { createStudioAgentSetup, type StudioAgentSetup } from '../agent-setup/agent-setup-domain'
import type { StudioPlatform } from '../platform/platform'

// What a Studio's agents run and are set up with, composed in the core so
// every server serves it: the desktop's own in process, the desktop's server
// in a process of its own, and a server on a WSL or SSH machine, which
// detects, installs and sets up the CLIs on that machine.
//
// - The CLIs (`agent-runtimes`): detection, installs and updates, and the
//   version check over the machines the launch settings name.
// - Their setup (`agent-setup`): MCP sync, the import of another CLI's
//   configuration, the built-in skills, the area skills the person opted
//   into, and the project knowledge and the activity agents leave in it.
//
// The desktop's shell uses the same services for what it prepares itself (a
// launch's plugin copy reads the area skills; a module installs a built-in
// skill), so in process it builds them first, with `createStudioAgentServices`,
// and hands them to the core; there is one of each. Out of process the shell
// keeps its own copies over the same files, and its area skill store adopts
// each choice the server makes (desktop-server.ts).

export type StudioAgentServices = {
  mcpConfig: McpConfigService
  builtinSkills: BuiltinSkillManager
  areaSkills: StudioAreaSkillStore
  agentConfigImport: AgentConfigImportService
}

export function createStudioAgentServices(platform: StudioPlatform): StudioAgentServices {
  const mcpConfig = createMcpConfigService()
  // Knows the installed CLI plugins, so a skill meant for every CLI reaches each.
  const builtinSkills = createBuiltinSkillManager({ listPlugins: () => getPluginRegistry().loaded() })
  const areaSkills = createStudioAreaSkillStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  return {
    mcpConfig,
    builtinSkills,
    areaSkills,
    agentConfigImport: createAgentConfigImportService({
      mcpConfigService: mcpConfig,
      builtinSkillManager: builtinSkills,
    }),
  }
}

/** The agent CLIs and their setup, as the core holds and the Studio protocol serves them. */
export type StudioAgents = {
  services: StudioAgentServices
  runtimes: CliRuntimes
  setup: StudioAgentSetup
  /** Stop following the launch settings and detection for the version check. */
  stop(): void
}

export function createStudioAgents(
  platform: StudioPlatform,
  deps: { agentLaunchSettings: AgentLaunchSettingsStore; services?: StudioAgentServices },
): StudioAgents {
  const services = deps.services ?? createStudioAgentServices(platform)
  const { agentLaunchSettings } = deps
  // This process's skill installs (a launch's skill, the Backlog's, a
  // module's) use the manager that knows the CLI plugins.
  setDefaultSkillManager(services.builtinSkills)
  // A discovery pass this process starts itself (after an install, at a
  // launch) probes with the person's own per-CLI commands.
  setCliModelDiscoveryRuntimesResolver(() => agentLaunchSettings.get().cliRuntimes)
  // The version check asks about the machines Settings ▸ Agents lists: this
  // one and each WSL distribution turned on, with the same commands. It
  // compares again whenever detection learns something new about a machine,
  // and when the machines change.
  configureCliVersionService({
    machines: launchSettingsCliMachines(() => agentLaunchSettings.get()),
    noticesPath: () => join(platform.paths.dataDir(), CLI_UPDATE_NOTICES_FILENAME),
  })
  const stopFollowingDetection = subscribeKnownCliAvailability(() => scheduleCliVersionRead())
  let lastHosts = JSON.stringify(agentLaunchSettings.get().hosts)
  const stopFollowingMachines = agentLaunchSettings.subscribe((record) => {
    const next = JSON.stringify(record.settings.hosts)
    if (next === lastHosts) return
    lastHosts = next
    scheduleCliVersionRead()
  })
  return {
    services,
    runtimes: createCliRuntimes(),
    setup: createStudioAgentSetup({
      mcp: services.mcpConfig,
      agentConfig: services.agentConfigImport,
      builtinSkills: services.builtinSkills,
      areaSkills: services.areaSkills,
    }),
    stop() {
      stopFollowingDetection()
      stopFollowingMachines()
    },
  }
}
