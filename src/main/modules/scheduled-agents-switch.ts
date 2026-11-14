import type { CapabilityModule } from '../module-host/load-modules'
import { ScheduledAgentsModuleServiceToken, ScheduledAgentsServiceToken } from '../module-host/service-tokens'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import type { StudioScheduledAgents } from '../../server/core/studio-scheduled-agents'

// The person's Scheduled agents switch, where a module kernel runs (the
// desktop, in process and out).
//
// The schedules are the core's (server/core/studio-scheduled-agents.ts), run
// by every Studio server. This kernel entry is only how the kernel holds them:
// the `scheduled-agents` id the switch in Settings and an extension's
// `dependsOn` name, the services an extension reaches them by, and the
// scheduler turned on while the switch is on. Switched off, the services are
// gone (every door says "switched off") and no schedule runs; nothing is built
// or torn down.

export const SCHEDULED_AGENTS_MANIFEST: CapabilityManifest = {
  id: 'scheduled-agents',
  displayName: 'Scheduled agents',
  version: 1,
  publisher: 'sprintengine',
  category: 'orchestration',
  summary: 'Start a chat agent with a prompt on a schedule.',
  defaultEnabled: true,
  dependsOn: ['agent-runtime'],
}

/** `getModulePermissions` is what an extension's schedule is held to; read late, once the kernel knows every module. */
export function scheduledAgentsSwitchModule(
  scheduledAgents: StudioScheduledAgents,
  getModulePermissions: (moduleId: string) => readonly string[] | undefined,
): CapabilityModule {
  return {
    manifest: SCHEDULED_AGENTS_MANIFEST,
    registerMain(host) {
      host.provideService(ScheduledAgentsServiceToken, () => scheduledAgents.service)
      host.provideService(ScheduledAgentsModuleServiceToken, () => scheduledAgents.moduleRegistry(getModulePermissions))
      host.registerSidecar(
        {
          id: 'scheduled-agents-scheduler',
          kind: 'scheduler',
          description: 'Starts each scheduled agent’s chat when its schedule comes round.',
          startOn: 'startup',
        },
        {
          start: () => scheduledAgents.start(),
          stop: () => scheduledAgents.stop(),
          status: () => ({ state: scheduledAgents.running() ? 'running' : 'stopped' }),
        },
      )
    },
  }
}
