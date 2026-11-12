import type {
  AgentLaunchSettingsRecord,
  AgentLaunchSettingsSnapshot,
  AgentLaunchSettingsWriteAck,
  CommitMessageDraftRequest,
} from '../../../packages/studio-protocol/src/public'
import type { DiagnosticLogInput } from '../../shared/electron-api'
import type { CliModelDiscoveryInput, CliModelDiscoveryResult } from '../../shared/ipc/cli-model-discovery'
import type {
  ChatTitleRequest,
  CommitMessageRequest,
  CommitMessageResult,
  TextGenerationResult,
} from '../../shared/text-generation/contract'
import { normalizeWritingStyle, type TextGenerationWritingStyle } from '../../shared/text-generation/writing-style'
import { readCommitMessageDraftInput, type CommitMessageDraftInputOutcome } from '../../main/commit-message-draft'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import { createDraftRuns, folderOf } from '../../main/ipc/text-generation-draft'
import type { AgentLaunchSettingsStore, AgentLaunchSettingsWriteResult } from '../../main/launch-settings-store'
import { discoverAndBroadcastCliModels, onCliModelsChanged } from '../../main/model-discovery/discovery-pass'
import { generateChatTitle, generateCommitMessage } from '../../main/text-generation/text-generation-service'
import type { TextGenerationSettingsStore } from '../../main/text-generation/text-generation-settings-store'

// What every launch on this Studio reads, and what its CLIs write for it, as
// the Studio protocol serves them (`launchSettings.*`, `cliModels.*`,
// `textGeneration.*`, `commitMessage.*`): one domain the RPC router answers
// from, for the app's own windows and every other client alike.
//
// - Launch settings. A client reads the record (`get`), writes to it only
//   through partial patches (`update`), and offers its old local copy once
//   through `migrate`, which the store takes only while it holds no record.
//   Every write that changes the record, whoever made it, is told to every
//   follower with the new record, so clients never push copies at one another.
//   Every answer waits for its write to settle and says whether the record is
//   on disk: a window deletes its local copy only on an answer that says so.
// - Models. A discovery pass a client asks for runs here, where the catalog
//   cache is, and every catalog it produced is told to every follower.
// - Text. A chat's title and a commit message, written by the person's own
//   CLI. Neither throws: a failure is `{ ok: false, code, message }`, which
//   the client shows or (a title) quietly ignores. A failure is written to the
//   diagnostics log, at `info`, because a missing title is nothing the person
//   has to act on, and without the line a refused model looks exactly like a
//   feature that never ran.
// - The titles setting. The window owns it in its settings and pushes it here,
//   where the chats are titled.

export type StudioAgentSettings = {
  launchSettings(): Promise<AgentLaunchSettingsSnapshot>
  updateLaunchSettings(patch: unknown): Promise<AgentLaunchSettingsWriteAck>
  migrateLaunchSettings(settings: unknown): Promise<AgentLaunchSettingsWriteAck>
  onLaunchSettingsChanged(listener: (record: AgentLaunchSettingsRecord) => void): () => void
  discoverModels(input: CliModelDiscoveryInput): Promise<CliModelDiscoveryResult>
  onModelsChanged(listener: (result: CliModelDiscoveryResult) => void): () => void
  setTextGenerationSettings(settings: unknown): void
  chatTitle(request: ChatTitleRequest): Promise<TextGenerationResult>
  /**
   * Draft a commit message for a checkout's staged changes. `draftKey` names
   * the run so `cancelCommitMessage` can stop it; the caller keys it by client,
   * so one client never stops another's.
   */
  draftCommitMessage(request: CommitMessageDraftRequest, draftKey: string | null): Promise<CommitMessageResult>
  cancelCommitMessage(draftKey: string): void
}

export type StudioAgentSettingsDeps = {
  launchSettings: Pick<AgentLaunchSettingsStore, 'getSnapshot' | 'update' | 'migrate' | 'subscribe'>
  textGenerationSettings: Pick<TextGenerationSettingsStore, 'set'>
  discover?: (input: CliModelDiscoveryInput) => Promise<CliModelDiscoveryResult>
  onModelsChanged?: (listener: (result: CliModelDiscoveryResult) => void) => () => void
  generateTitle?: (request: ChatTitleRequest) => Promise<TextGenerationResult>
  gatherCommit?: (repoRoot: string, style: TextGenerationWritingStyle) => Promise<CommitMessageDraftInputOutcome>
  generateCommit?: (request: CommitMessageRequest) => Promise<CommitMessageResult>
  log?: (entry: DiagnosticLogInput) => Promise<unknown>
}

async function ack(result: AgentLaunchSettingsWriteResult): Promise<AgentLaunchSettingsWriteAck> {
  return { ok: true, record: result.record, changed: result.changed, persisted: await result.persisted }
}

export function createStudioAgentSettings(deps: StudioAgentSettingsDeps): StudioAgentSettings {
  const generateTitle = deps.generateTitle ?? generateChatTitle
  const gather = deps.gatherCommit ?? readCommitMessageDraftInput
  const generateCommit = deps.generateCommit ?? generateCommitMessage
  const log = deps.log ?? writeDiagnosticLog
  const note = (entry: DiagnosticLogInput) => log(entry).catch(() => undefined)
  const drafts = createDraftRuns()

  return {
    launchSettings: () => deps.launchSettings.getSnapshot(),
    updateLaunchSettings: (patch) => ack(deps.launchSettings.update(patch, 'ui')),
    migrateLaunchSettings: (settings) => ack(deps.launchSettings.migrate(settings)),
    onLaunchSettingsChanged: (listener) => deps.launchSettings.subscribe(listener),
    discoverModels: (input) => (deps.discover ?? discoverAndBroadcastCliModels)(input),
    onModelsChanged: (listener) => (deps.onModelsChanged ?? onCliModelsChanged)(listener),
    setTextGenerationSettings: (settings) => deps.textGenerationSettings.set(settings),

    async chatTitle(request) {
      const result = await generateTitle(request)
      if (!result.ok) {
        const { cli, model, reasoning } = request.engine
        await note({
          level: 'info',
          source: 'agents',
          title: 'Chat title not generated',
          message: `${[cli, model, reasoning].filter(Boolean).join(' · ')}: ${result.code} — ${result.message}`,
        })
      }
      return result
    },

    // Git reads the staged changes of a checkout on this machine (or in one of
    // its WSL distributions, which the git runner routes to), and the person's
    // own CLI drafts the message. A checkout on an SSH machine has its git
    // there, and its path is no absolute path here, so it is refused in words
    // rather than read from this disk.
    async draftCommitMessage(request, draftKey) {
      const repoRoot = folderOf(request.repoRoot)
      if (!repoRoot) return { ok: false, code: 'unsupported', message: 'Only a checkout on this computer can be read.' }
      const writingStyle = normalizeWritingStyle(request.writingStyle)
      const result = await drafts.run(draftKey, async (signal): Promise<CommitMessageResult> => {
        const gathered = await gather(repoRoot, writingStyle)
        if (!gathered.ok) return { ok: false, code: 'unsupported', message: gathered.message }
        if (signal.aborted) return { ok: false, code: 'cancelled', message: 'The draft was stopped.' }
        return generateCommit({
          input: gathered.input,
          engine: request.engine,
          ...(request.cliRuntimes ? { cliRuntimes: request.cliRuntimes } : {}),
          signal,
        })
      })
      if (!result.ok && result.code !== 'cancelled') {
        await note({
          level: 'info',
          source: 'agents',
          title: 'Commit message not drafted',
          message: `${request.engine.cli}: ${result.code} — ${result.message}`,
        })
      }
      return result
    },
    cancelCommitMessage: (draftKey) => drafts.cancel(draftKey),
  }
}
