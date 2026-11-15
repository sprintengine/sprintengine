import {
  chatCheckoutFromRegistry,
  type ConversationPullRequestToolsDeps,
} from '../../main/automation/conversation-pull-request-tools'
import { knownCliAvailability } from '../../main/cli-availability'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import { listPluginRegistryEntries } from '../../main/plugin-registry-instance'
import { createPullRequestCreator } from '../../main/pull-request-create'
import { generatePullRequestText } from '../../main/text-generation/text-generation-service'
import { resolveTextGenerationEngine } from '../../shared/text-generation/contract'
import type { StudioCore } from '../core/studio-core'

// A chat's "Create PR" on the Studio that holds the chat: the checkout, git,
// the forge's CLI and the drafting CLI are all here, and so is the record a
// pull request it opens is kept in. One set of these serves the gateway's
// tools (a paired desktop's lane) and the Studio protocol's
// `pullRequests.createState` … `.create` (every client of this Studio).

export function studioPullRequestCreationDeps(core: StudioCore): ConversationPullRequestToolsDeps {
  return {
    checkoutOf: chatCheckoutFromRegistry((workspaceId) => core.workspaceRegistry.getRecord(workspaceId)),
    creator: createPullRequestCreator(),
    // The engine a chat here is titled with (chat-titler.ts), read as the
    // draft starts: this machine's setting, its CLIs and their overrides.
    draftEngine: () => {
      const settings = core.textGenerationSettings.get()
      const cliRuntimes = core.agentLaunchSettings.get().cliRuntimes
      const engine = resolveTextGenerationEngine(
        settings,
        listPluginRegistryEntries().map((entry) => entry.id),
        (cli) => knownCliAvailability({ cliRuntimes })[cli]?.installed,
      )
      return engine ? { engine, cliRuntimes, writingStyle: settings.writingStyle } : null
    },
    generate: (request) => generatePullRequestText(request),
    link: async (input) => {
      const linked = await core.pullRequests.link(input)
      return linked.ok ? { ok: true } : { ok: false, message: linked.message }
    },
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'agents', title: 'Pull request text not drafted', message })
    },
  }
}
