import type {
  StudioAgentSettingsMethod,
  StudioAgentSettingsMethodMap,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import type { CliRuntimes } from '../../main/cli-runtimes'
import type { StudioAgentSettings } from '../agent-settings/agent-settings-domain'
import type { StudioRequestContext } from './studio-rpc-types'

// The router's answers to `cliRuntimes.*`, `cliVersions.*`, `cliModels.*`,
// `launchSettings.*`, `textGeneration.*` and `commitMessage.*`: each method's
// domain call, once the router has held the grant to the method's scope and a
// CLI's `command` to an owner. What is left here is the one rule of their
// own: a commit message is drafted from a checkout a client that is not an
// owner names only inside the folders Studio knows, and its draft is keyed by
// the client, so one client never stops another's.

type Asking = { grant: StudioGrant; context: StudioRequestContext }

export type StudioAgentSettingsHandlers = {
  readonly [M in StudioAgentSettingsMethod]: StudioHandlerOf<StudioAgentSettingsMethodMap[M], Asking>
}

export type StudioAgentSettingsHandlerOptions = {
  /** The CLIs on this machine; without them, `cliRuntimes.*` and `cliVersions.*` are answered `unavailable`. */
  runtimes?: CliRuntimes
  /** The launch settings and the CLIs' texts; without them, the rest are answered `unavailable`. */
  settings?: StudioAgentSettings
  /** Whether the asker may name this folder: any, for an owner's own connection; else one Studio knows. */
  mayName(path: string, asking: Asking): Promise<boolean>
}

const UNKNOWN_FOLDER = 'That folder is not one Studio knows.'

const unserved = (method: StudioAgentSettingsMethod) =>
  ({ ok: false, error: { code: 'unavailable', message: `This Studio does not serve ${method}.` } }) as const

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioAgentSettingsHandlers(
  options: StudioAgentSettingsHandlerOptions,
): StudioAgentSettingsHandlers {
  const { runtimes, settings } = options
  const draftKey = (grant: StudioGrant, draftId: string) => `${grant.clientId}:${draftId}`
  return {
    'cliRuntimes.detect': async ({ cli, runtime }) =>
      runtimes ? ok(await runtimes.detect(cli, runtime)) : unserved('cliRuntimes.detect'),
    'cliRuntimes.installMethods': async ({ cli, runtime }) =>
      runtimes ? ok({ methods: await runtimes.installMethods(cli, runtime) }) : unserved('cliRuntimes.installMethods'),
    'cliRuntimes.install': async ({ cli, methodId, runtime }) =>
      runtimes ? ok(await runtimes.install({ cli, methodId }, runtime)) : unserved('cliRuntimes.install'),
    'cliRuntimes.update': async ({ cli, runtime }) =>
      runtimes ? ok(await runtimes.update(cli, runtime)) : unserved('cliRuntimes.update'),
    'cliRuntimes.updateAll': async () =>
      runtimes ? ok(await runtimes.updateAll()) : unserved('cliRuntimes.updateAll'),
    'cliVersions.advisories': async (input) =>
      runtimes ? ok(await runtimes.advisories(input)) : unserved('cliVersions.advisories'),
    'cliVersions.setEnabled': ({ enabled }) =>
      runtimes ? ok({ enabled: runtimes.setVersionChecksEnabled(enabled) }) : unserved('cliVersions.setEnabled'),

    'cliModels.discover': async (input) =>
      settings ? ok(await settings.discoverModels(input)) : unserved('cliModels.discover'),
    'launchSettings.get': async () => (settings ? ok(await settings.launchSettings()) : unserved('launchSettings.get')),
    'launchSettings.update': async ({ patch }) =>
      settings ? ok(await settings.updateLaunchSettings(patch)) : unserved('launchSettings.update'),
    'launchSettings.migrate': async ({ settings: offered }) =>
      settings ? ok(await settings.migrateLaunchSettings(offered)) : unserved('launchSettings.migrate'),
    'textGeneration.setSettings': ({ settings: chosen }) => {
      if (!settings) return unserved('textGeneration.setSettings')
      settings.setTextGenerationSettings(chosen)
      return ok({})
    },
    'textGeneration.chatTitle': async (request) =>
      settings ? ok(await settings.chatTitle(request)) : unserved('textGeneration.chatTitle'),
    'commitMessage.draft': async ({ draftId, ...request }, asking) => {
      if (!settings) return unserved('commitMessage.draft')
      if (!(await options.mayName(request.repoRoot, asking)))
        return { ok: false, error: { code: 'not_found', message: UNKNOWN_FOLDER } }
      return ok(
        await settings.draftCommitMessage(request, draftId === undefined ? null : draftKey(asking.grant, draftId)),
      )
    },
    'commitMessage.cancel': ({ draftId }, { grant }) => {
      if (!settings) return unserved('commitMessage.cancel')
      settings.cancelCommitMessage(draftKey(grant, draftId))
      return ok({})
    },
  }
}
