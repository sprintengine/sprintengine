import type * as AgentSetup from './agentSetup'

// A stand-in for the window's agent setup (`agentSetup.ts`), for tests of what
// calls it. A test mocks the module with this one:
//
//   vi.mock('../../studio/agentSetup', () => import('../../studio/agentSetup.double'))
//
// and sets what it needs on `agentSetupDouble`: each call goes to the member
// of the same name there, as it stands when the call is made. Unset, a call
// answers as a Studio with nothing set up would.

type Api = AgentSetup.AgentSetupApi

function blank(): Api {
  const none = { ok: false as const, message: 'Nothing set up here.' }
  const choices = { enabled: [], dismissed: [] }
  return {
    memoryResolveRoot: async ({ relativeRoot }) => ({
      ok: false,
      status: 'missing-workspace',
      relativeRoot,
      message: 'No workspace here.',
    }),
    memoryIndex: async ({ relativeRoot }) => ({
      ok: false,
      status: 'missing-workspace',
      relativeRoot,
      message: 'No workspace here.',
    }),
    memoryReadPreview: async () => none,
    memoryActivityInstall: async () => none,
    memoryActivityUninstall: async () => none,
    memoryActivityStartWatching: async () => ({ ok: true }),
    memoryActivityGetStatus: async ({ workspaceRoot }) => ({
      workspaceRoot,
      isInstalled: false,
      isWatching: false,
      sessionsRecorded: 0,
      totalEvents: 0,
      eventsToday: 0,
      lastEventAt: null,
    }),
    memoryActivityGetSynapses: async () => [],
    memoryActivityIsInstalled: async () => false,
    onMemoryActivityEvent: () => () => undefined,
    onMemoryActivityStatus: () => () => undefined,
    onMemoryActivitySynapses: () => () => undefined,
    mcpSync: async () => none,
    detectExistingAgentConfig: async () => ({ ok: true, mcpServers: [], skills: [], warnings: [] }),
    adoptAgentConfig: async () => none,
    builtinSkillsList: async () => [],
    builtinSkillStatus: async ({ skillId }) => ({
      ok: false,
      status: 'unknown-skill',
      skillId,
      message: 'No skills here.',
    }),
    studioAreaSkillsGet: async () => choices,
    studioAreaSkillsSetEnabled: async () => choices,
    studioAreaSkillsDismiss: async () => choices,
    onStudioAreaSkillsChanged: () => () => undefined,
  }
}

/** What each call answers: set a member to change it. */
export const agentSetupDouble: Api = blank()

/** Whether the page has a Studio: true unless a test sets it otherwise. */
export const agentSetupHasStudio = { value: true }

/** Put every member back as it was. */
export function resetAgentSetupDouble(): void {
  Object.assign(agentSetupDouble, blank())
  agentSetupHasStudio.value = true
}

export const windowHasStudio: typeof AgentSetup.windowHasStudio = () => agentSetupHasStudio.value

export const agentSetupApi: Api = Object.fromEntries(
  (Object.keys(blank()) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (agentSetupDouble[name] as (...args: unknown[]) => unknown)(...args),
  ]),
) as Api
