import type * as AgentSettings from './agentSettings'

// A stand-in for the window's agent CLIs and launch settings
// (`agentSettings.ts`), for tests of what calls them. A test mocks the module
// with this one:
//
//   vi.mock('../../studio/agentSettings', () => import('../../studio/agentSettings.double'))
//
// and sets what it needs on `agentSettingsDouble`: each call goes to the
// member of the same name there, as it stands when the call is made. Unset, a
// call answers as a Studio with nothing to say would; `windowHasStudio` says
// yes unless a test says otherwise.

type Api = AgentSettings.AgentSettingsApi

function blank(): Api {
  const installed = {
    ok: false,
    cli: '',
    installed: false,
    version: null,
    resolvedPath: null,
    log: '',
    error: 'No CLIs here.',
  }
  return {
    cliDetect: async (cli) => ({
      cli,
      binary: cli,
      installed: false,
      version: null,
      resolvedPath: null,
      hostId: 'local',
      error: null,
    }),
    cliInstallMethods: async () => [],
    cliInstall: async () => installed,
    cliUpdate: async () => installed,
    cliUpdateAll: async () => ({ ok: true, items: [] }),
    onCliUpdateAllProgress: () => () => undefined,
    onCliInstallOutput: () => () => undefined,
    cliVersionAdvisories: async () => ({ ok: false, message: 'No version checks here.' }),
    cliVersionChecksSetEnabled: async (enabled) => ({ enabled }),
    onCliVersionAdvisoriesChanged: () => () => undefined,
    cliModelsDiscover: async () => ({ entries: [], startedAt: '', finishedAt: '' }),
    onCliModelsChanged: () => () => undefined,
    launchSettingsGet: async () => {
      throw new Error('No launch settings here.')
    },
    launchSettingsUpdate: async () => {
      throw new Error('No launch settings here.')
    },
    launchSettingsMigrate: async () => {
      throw new Error('No launch settings here.')
    },
    onLaunchSettingsChanged: () => () => undefined,
    generateChatTitle: async () => ({ ok: false, code: 'unavailable', message: 'No titles here.' }),
    setTextGenerationSettings: async () => undefined,
    draftCommitMessage: async () => ({ ok: false, code: 'unavailable', message: 'No drafts here.' }),
    cancelCommitMessageDraft: async () => undefined,
  }
}

/** What each call answers: set a member to change it. */
export const agentSettingsDouble: Api = blank()

/** Whether the page has a Studio: true unless a test sets it otherwise. */
export const agentSettingsHasStudio = { value: true }

/** Put every member back as it was. */
export function resetAgentSettingsDouble(): void {
  Object.assign(agentSettingsDouble, blank())
  agentSettingsHasStudio.value = true
}

export const windowHasStudio: typeof AgentSettings.windowHasStudio = () => agentSettingsHasStudio.value

export const agentSettingsApi: Api = Object.fromEntries(
  (Object.keys(blank()) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (agentSettingsDouble[name] as (...args: unknown[]) => unknown)(...args),
  ]),
) as Api
