import type * as Extensions from './extensions'

// A stand-in for what the window's Studio is extended with (`extensions.ts`),
// for tests of what calls it. A test mocks the module with this one:
//
//   vi.mock('../../studio/extensions', () => import('../../studio/extensions.double'))
//
// and sets what it needs on `extensionsDouble`: each call goes to the member
// of the same name there, as it stands when the call is made. Unset, a call
// answers as a Studio with nothing installed and nothing to offer would;
// `windowHasStudio` says yes unless a test says otherwise.

type Api = Extensions.ExtensionsApi

const NONE = 'Nothing here in this test.'

function blank(): Api {
  return {
    readMarketplaceRegistry: async () => ({
      ok: true,
      state: 'empty',
      registryUrl: 'https://registry.test/marketplace.json',
      source: 'bundled',
      stale: false,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      marketplace: { schemaVersion: 1, plugins: [] },
    }),
    readMarketplacePluginUpdateStates: async () => ({
      ok: true,
      checked: true,
      registryState: 'ok',
      registrySource: 'bundled',
      stale: false,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      entries: [],
    }),
    verifyMarketplacePlugin: async () => ({ classification: 'invalid', permissions: [], sourceUrl: '', message: NONE }),
    installMarketplacePluginFromRegistry: async () => ({ ok: false, message: NONE }),
    updateMarketplacePluginFromRegistry: async () => ({ ok: false, message: NONE }),
    uninstallMarketplacePlugin: async () => ({ ok: false, message: NONE }),
    resolveGithubExtension: async () => ({ ok: false, message: NONE }),
    installGithubExtension: async () => ({ ok: false, message: NONE }),
    pluginsList: async () => ({ ok: true, plugins: [] }),
    pluginsDetectAvailability: async () => ({ ok: true, availability: {} }),
    agentLaunchPreview: async () => ({ ok: false, message: NONE }),
    studioPluginStatus: async () => ({
      bundledVersion: '',
      installedVersion: '',
      skillDirNames: [],
      claudePluginKey: '',
      hooksAcknowledgedAt: '',
    }),
    extensionScaffoldHome: async () => '/Users/dev/Documents/SprintEngine/Extensions',
    extensionScaffoldTarget: async () => null,
    extensionScaffoldCreate: async () => ({ ok: false, code: 'io_error', message: NONE }),
    hostedCardFeedGet: async () => ({ ok: false, state: 'offline', feedUrl: '', message: NONE }),
    onHostedCardFeedChanged: () => () => undefined,
    hostedSourcesFeedGet: async () => ({ ok: false, state: 'offline', feedUrl: '', message: NONE }),
    listThirdPartyModules: async () => ({ modules: [], rejected: [] }),
    listStudioModules: async () => [],
    listThirdPartyRendererEntries: async () => ({ entries: [], failures: {} }),
    onThirdPartyModulesChanged: () => () => undefined,
    setModuleAppState: async () => undefined,
    setModuleRegistrySnapshot: async () => ({ ok: true }),
  }
}

/** What each call answers: set a member to change it. */
export const extensionsDouble: Api = blank()

/** Whether the page has a Studio: true unless a test sets it otherwise. */
export const extensionsHasStudio = { value: true }

/** Put every member back as it was. */
export function resetExtensionsDouble(): void {
  Object.assign(extensionsDouble, blank())
  extensionsHasStudio.value = true
  adopted = null
}

let adopted: (() => object | undefined) | null = null

/**
 * Answer from a test's own stand-in for the window, for a test that builds one
 * object of everything the page calls (`() => window.api`): a member it
 * defines when the call is made answers it; any other, the double's.
 */
export function adoptExtensionsDouble(source: () => object | undefined): void {
  adopted = source
}

export const windowHasStudio: typeof Extensions.windowHasStudio = () => extensionsHasStudio.value

export const extensionsApi: Api = Object.fromEntries(
  (Object.keys(blank()) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => {
      const own = (adopted?.() as Partial<Api> | undefined)?.[name]
      return ((typeof own === 'function' ? own : extensionsDouble[name]) as (...args: unknown[]) => unknown)(...args)
    },
  ]),
) as Api
