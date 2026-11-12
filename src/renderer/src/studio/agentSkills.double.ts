import type * as AgentSkills from './agentSkills'

// A stand-in for the window's skills, design systems and cards
// (`agentSkills.ts`), for tests of what calls it. A test mocks the module with
// this one:
//
//   vi.mock('../../studio/agentSkills', () => import('../../studio/agentSkills.double'))
//
// and sets what it needs on `agentSkillsDouble`: each call goes to the member
// of the same name there, as it stands when the call is made. A suite written
// when these were the preload's may set them on `window.api` instead, and a
// member set there is called first. Unset, a call answers as a Studio with no
// sources, skills or bundles would.

type Api = AgentSkills.AgentSkillsApi

function blank(): Api {
  const none = { ok: false as const, message: 'Nothing here.' }
  const discovery = { results: [], rateLimit: null, degraded: null }
  const check = { checkedAt: '', sources: [], changed: [], newlyChanged: [], failures: [], skipped: [] }
  return {
    skillsListSources: async () =>
      ({ ok: true, sources: [] }) as unknown as Awaited<ReturnType<Api['skillsListSources']>>,
    skillsCheckSourceUpdates: async () => check,
    skillsAddSource: async () => none,
    skillsAddLocalSource: async () => none,
    skillsRemoveSource: async () => none,
    skillsGetScan: async () => none,
    skillsReadFile: async () => none,
    skillsInstall: async () => none,
    skillsUninstall: async () => none,
    skillsSyncSource: async () => none,
    skillsSearch: async () => discovery,
    skillsListPopularRepos: async () => discovery,
    skillsScanLinkedPlugin: async () => none,
    skillsInstallPlugin: async () => none,
    skillsUninstallPlugin: async () => none,
    skillsListInstalledPlugins: async () => ({ ok: true, plugins: [] }),
    onSkillSourcesUpdated: () => () => undefined,
    installedSkillsList: async () => ({ ok: true, skills: [], diagnostics: [] }),
    installedSkillRemove: async () => none,
    workspaceSkillsList: async () => ({ ok: true, skills: [] }),
    agentCapabilities: async () => none as unknown as Awaited<ReturnType<Api['agentCapabilities']>>,
    agentSkillAttach: async () => none,
    ensureDefaultUserSkillsDir: async () => '/Users/dev/.agents/skills',
    seedDesignSystemBundle: async () =>
      ({ ok: false, message: 'Nothing here.' }) as Awaited<ReturnType<Api['seedDesignSystemBundle']>>,
    lintDesignSystemBundle: async () => ({ ok: false, kind: 'error', message: 'Nothing here.' }),
    readDesignSystemBundle: async (bundleDir) =>
      ({ ok: false, reason: 'missing', path: bundleDir, message: 'Nothing here.' }) as Awaited<
        ReturnType<Api['readDesignSystemBundle']>
      >,
    listDesignSystemLibrary: async () => ({ entries: [] }),
    listDesignSystemArrivals: async () => ({ bundles: [] }),
    registerDesignSystemFolder: async () => none,
    forgetDesignSystemFolder: async () => ({ ok: true, forgotten: false }),
    attachDesignSystemBundle: async () =>
      ({ ok: false, stage: 'request', message: 'Nothing here.' }) as Awaited<
        ReturnType<Api['attachDesignSystemBundle']>
      >,
    detachDesignSystemBundle: async () => none,
    cardsRun: async () => ({
      ok: false,
      outcomes: [],
      workspaceRoot: null,
      mcpServers: [],
      chat: null,
      surface: null,
      message: 'Nothing here.',
    }),
  }
}

/** What each call answers: set a member to change it. */
export const agentSkillsDouble: Api = blank()

/** Whether the page has a Studio: true unless a test sets it otherwise. */
export const agentSkillsHasStudio = { value: true }

/** Put every member back as it was. */
export function resetAgentSkillsDouble(): void {
  Object.assign(agentSkillsDouble, blank())
  agentSkillsHasStudio.value = true
}

export const windowHasStudio: typeof AgentSkills.windowHasStudio = () => agentSkillsHasStudio.value

function onWindowApi(name: string): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const agentSkillsApi: Api = Object.fromEntries(
  (Object.keys(blank()) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) =>
      (onWindowApi(name) ?? (agentSkillsDouble[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
