// The conversation service: every operation a chat offers, over the core's
// runtime. The Studio protocol's chat surface (studio-rpc/studio-chat-backend.ts)
// serves every client from it, the app's own windows included.

import type {
  ConversationSearchHit,
  ConversationSearchInput,
  ConversationSearchResult,
  ConversationThreadsResult,
  ConversationWorkspaceKey,
} from '../shared/conversation-index'
import type {
  CliAvailability,
  CliDetectResult,
  CliRuntimeSettings,
  ConversationProviderListResult,
  ConversationProviderModelsInput,
  ConversationProviderModelsResult,
  ConversationSecretClearInput,
  ConversationSecretClearResult,
  ConversationSecretSetInput,
  ConversationSecretSetResult,
  ConversationSecretStatusInput,
  ConversationSecretStatusResult,
} from '../shared/electron-api'
import type {
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationEventType,
  ConversationInterruptInput,
  ConversationProvidersListInput,
  ConversationProviderSignInInput,
  ConversationProviderSignInResult,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSetModelInput,
  ConversationMcpServerActionInput,
  ConversationMessageSubagentInput,
  ConversationStopSubagentInput,
  ConversationCancelSideQuestionInput,
  ConversationSideQuestionInput,
  ConversationSideQuestionResult,
  ConversationMcpServerActionResult,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationSuspendSessionInput,
  ConversationTerminalHandoffInput,
  ConversationTerminalHandoffResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationEventReadInput,
  ConversationEventReadResult,
  ConversationAttachmentResult,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationSubscribeInput,
  ConversationLoadEarlierInput,
  ConversationSessionFrame,
  ConversationPageResult,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationRewindResult,
  ConversationHandoffInput,
  ConversationHandoffResult,
  ConversationApprovalRulesResult,
  ConversationApprovalRuleRevokeResult,
  ConversationContextBreakdownInput,
  ConversationContextBreakdownResult,
} from '../shared/conversation-runtime'
import { ConversationRuntime } from './conversation-runtime'
import type { ConversationBackend } from '../server/core/conversation-backend'
import { ConversationSessionApi } from './conversation-session-api'
import { detectAgentCliAvailability, recordCliDetection } from './cli-availability'
import { detectCli } from './cli-runtime-install'
import { resolveConversationSignIn } from './conversation-sign-in'
import {
  getConversationProviderById,
  listConversationProviderRegistryEntries,
  listPluginRegistryEntries,
} from './plugin-registry-instance'
import { listOpenAiCompatibleModels } from './providers/openai-compatible-provider'
import { getSharedCredentialStore } from './secret-store'
import { cliForConversationProvider } from '../shared/conversation-harness'

/**
 * Every operation a chat offers a client: what the Studio protocol's chat
 * surface calls. One object, built once over the core's chats, so every
 * client reaches one chat by the same rules.
 */
export type ConversationService = {
  listThreads?(input: ConversationWorkspaceKey): Promise<ConversationThreadsResult>
  searchThreads?(
    input: ConversationSearchInput,
    options: { signal: AbortSignal; onBatch?: (hits: ConversationSearchHit[]) => void },
  ): Promise<ConversationSearchResult>
  listProviders(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult>
  listProviderModels(input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult>
  resolveSignIn?(input: ConversationProviderSignInInput): Promise<ConversationProviderSignInResult>
  getSecretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult>
  setSecret(input: ConversationSecretSetInput): Promise<ConversationSecretSetResult>
  clearSecret(input: ConversationSecretClearInput): Promise<ConversationSecretClearResult>
  startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult>
  interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult>
  respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult>
  setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult>
  setModel?(input: ConversationSetModelInput): Promise<ConversationSessionActionResult>
  mcpServerAction?(input: ConversationMcpServerActionInput): Promise<ConversationMcpServerActionResult>
  stopSubagent?(input: ConversationStopSubagentInput): Promise<ConversationSessionActionResult>
  messageSubagent?(input: ConversationMessageSubagentInput): Promise<ConversationSessionActionResult>
  askSideQuestion?(input: ConversationSideQuestionInput): Promise<ConversationSideQuestionResult>
  cancelSideQuestion?(
    input: ConversationCancelSideQuestionInput,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  readContextBreakdown?(input: ConversationContextBreakdownInput): Promise<ConversationContextBreakdownResult>
  stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult>
  suspendSession?(input: ConversationSuspendSessionInput): Promise<ConversationSessionActionResult>
  terminalHandoff?(input: ConversationTerminalHandoffInput): Promise<ConversationTerminalHandoffResult>
  listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult
  getToolDetail?(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  readEvent?(input: ConversationEventReadInput): Promise<ConversationEventReadResult>
  readAttachment?(ref: string): Promise<ConversationAttachmentResult>
  planDocument?(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult>
  subscribe?(
    input: ConversationSubscribeInput,
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose: () => void; ready: Promise<void> }
  loadEarlier?(input: ConversationLoadEarlierInput): Promise<ConversationPageResult>
  getTurnDiff?(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult>
  revertToTurn?(input: ConversationRevertInput): Promise<ConversationRevertResult>
  rewindToTurn?(input: ConversationRewindInput): Promise<ConversationRewindResult>
  handoffConversation?(input: ConversationHandoffInput): Promise<ConversationHandoffResult>
  listApprovalRules?(): Promise<ConversationApprovalRulesResult>
  revokeApprovalRule?(ruleId: string): Promise<ConversationApprovalRuleRevokeResult>
  onEvent(listener: (event: ConversationEvent) => void): () => void
  /** Every chat's lifecycle and status events, each without its payload (`isConversationBroadcastEvent`). */
  onLifecycleEvent(listener: (event: ConversationEvent) => void): () => void
}

// Agent-harness conversation providers ride a local CLI (the shared table in
// conversation-harness); when that CLI is not installed the provider is hidden
// from the picker instead of failing at session start.
//
// Every chat asks for the provider list as it opens, so the answer comes from
// the app's own CLI availability (cli-availability.ts): probed at startup,
// held until Re-check or an install, and one probe per CLI however many ask at
// once. Probing here instead started a `--version` of every harness CLI on
// each chat opened a minute after the last, once per window and pane asking,
// and a New chat on a worktree paid for them while its `worktree add` ran.

// The app holds "not installed" until Re-check, so a CLI installed from a
// terminal since would stay unavailable in every chat; it is looked at again,
// at most this often, rather than on every list.
const CLI_UNAVAILABLE_TTL_MS = 30_000

export type HarnessCliCheckDeps = {
  /** The app's held answer for one CLI (probed only when it has none), or undefined when its probe failed. */
  availability?: (cli: string, runtime: Partial<CliRuntimeSettings> | undefined) => Promise<CliAvailability | undefined>
  /** A probe of one CLI, for a "not installed" looked at again. */
  detect?: (cli: string, runtime: Partial<CliRuntimeSettings> | undefined) => Promise<CliDetectResult>
  /** Tells the app's held answer what a probe here found. */
  record?: (runtime: Partial<CliRuntimeSettings> | undefined, detected: CliDetectResult) => void
  now?: () => number
}

async function heldCliAvailability(
  cli: string,
  runtime: Partial<CliRuntimeSettings> | undefined,
): Promise<CliAvailability | undefined> {
  const entry = listPluginRegistryEntries().find((candidate) => candidate.id === cli)
  if (!entry) return { cli, installed: false, resolvedPath: null, version: null }
  const availability = await detectAgentCliAvailability(
    { cliRuntimes: runtime ? { [cli]: runtime } : undefined },
    { listEntries: () => [entry] },
  )
  return availability[cli]
}

/** Whether a harness provider's CLI can be started, for the provider list. */
export function createHarnessCliCheck(
  deps: HarnessCliCheckDeps = {},
): (cli: string, cliRuntimes?: ConversationCliRuntimeOverrides) => Promise<boolean> {
  const availability = deps.availability ?? heldCliAvailability
  const detect = deps.detect ?? ((cli, runtime) => detectCli(cli, runtime))
  const record = deps.record ?? recordCliDetection
  const now = deps.now ?? Date.now
  const rechecks = new Map<string, { at: number; installed: Promise<boolean> }>()

  return async (cli, cliRuntimes) => {
    const runtime = cliRuntimes?.[cli]
    let held: CliAvailability | undefined
    try {
      held = await availability(cli, runtime)
    } catch {
      held = undefined
    }
    // Fail open: a probe that could not decide must not silently hide the
    // provider — a missing CLI still fails loudly (and actionably) at session
    // start.
    if (!held) return true
    if (held.installed && held.resolvedPath) return true
    const key = `${cli}:${runtime?.command?.trim() ?? ''}:${runtime?.hostId ?? 'local'}`
    const last = rechecks.get(key)
    if (last && now() - last.at < CLI_UNAVAILABLE_TTL_MS) return last.installed
    const installed = detect(cli, runtime).then(
      (detected) => {
        if (detected.error === null) record(runtime, detected)
        return detected.installed && Boolean(detected.resolvedPath)
      },
      () => true,
    )
    rechecks.set(key, { at: now(), installed })
    return installed
  }
}

/**
 * What every chat's lifecycle stream (`onLifecycleEvent`) carries: a chat's
 * lifecycle and status, never its per-token stream. Every workspace window
 * follows it (the IPC's `conversation:event`, the protocol's
 * `conversation.events`), and its readers (the session list, the history rows)
 * only ask whether a chat started, moved, waited or ended. Reply and reasoning
 * deltas, and a running tool's partial output, went to every window, hidden
 * ones included, dozens of times a second per streaming chat, only to be
 * dropped there. The pane showing a chat reads its own stream.
 */
const BROADCAST_EVENT_TYPES: ReadonlySet<ConversationEventType> = new Set<ConversationEventType>([
  'session_started',
  'session_ready',
  'session_updated',
  'session_closed',
  'user_message',
  'turn_started',
  'tool_started',
  'tool_output',
  'approval_requested',
  'approval_resolved',
  'usage_updated',
  'context_compacted',
  'context_compacting',
  'context_handed_off',
  'command_output',
  'turn_completed',
  'turn_failed',
  'subagent_status',
  'subagent_message',
])

/**
 * What the lifecycle stream carries of an event: whose it is, what kind,
 * and when. Its reader (the sessions list) only learns from it that a chat
 * moved and asks for the list again; the payload, a tool's input or result
 * among them, went to every window for every step of every chat unread.
 */
function broadcastEnvelope(event: ConversationEvent): ConversationEvent {
  const { payload: _payload, parts: _parts, ...envelope } = event as ConversationEvent & { parts?: unknown }
  return envelope
}

export function isConversationBroadcastEvent(event: ConversationEvent): boolean {
  if (!BROADCAST_EVENT_TYPES.has(event.type)) return false
  // A running tool's output streams; its final output says the tool is done.
  return !(event.type === 'tool_output' && event.payload?.partial === true)
}

/** Every chat's lifecycle events out of all of its events, each as its envelope. */
export function conversationLifecycleEvents(
  onEvent: (listener: (event: ConversationEvent) => void) => () => void,
): (listener: (event: ConversationEvent) => void) => () => void {
  return (listener) =>
    onEvent((event) => {
      if (isConversationBroadcastEvent(event)) listener(broadcastEnvelope(event))
    })
}

export function createConversationService(
  // The app passes the core's chats (the core owns the runtime, so shutdown and
  // diagnostics reach it); constructing a runtime here keeps tests/legacy
  // callers working standalone.
  runtime: ConversationBackend = new ConversationRuntime({ secretStore: getSharedCredentialStore() }),
): ConversationService {
  const secretStore = getSharedCredentialStore()
  const sessions = new ConversationSessionApi(runtime)
  const isHarnessCliInstalled = createHarnessCliCheck()

  return {
    listThreads: (input) => runtime.listThreads(input),
    searchThreads: (input, options) => runtime.searchThreads(input, options),
    async listProviders(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult> {
      try {
        const providers = listConversationProviderRegistryEntries().map((provider) => ({
          ...provider,
          capabilities: runtime.getProviderCapabilities(provider.id),
        }))
        const listed: typeof providers = []
        for (const provider of providers) {
          const harnessCli = cliForConversationProvider(provider.id)
          if (harnessCli && !(await isHarnessCliInstalled(harnessCli, input?.cliRuntimes))) {
            // Never hide the provider: an undetectable CLI is annotated so the
            // picker can say WHY it is unavailable (spawn defaults skip it).
            listed.push({
              ...provider,
              unavailable: `The ${provider.displayName} CLI wasn’t found from the app. Launch SprintEngine from a terminal, or set a command override in Settings → CLI runtimes.`,
            })
            continue
          }
          listed.push(provider)
        }
        return { ok: true, providers: listed }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
    listProviderModels(input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult> {
      const nativeModels = runtime.getNativeProviderModels(input.providerId)
      if (nativeModels) return Promise.resolve({ ok: true, models: nativeModels })
      return listOpenAiCompatibleModels({
        providerId: input.providerId,
        getProviderById: getConversationProviderById,
        resolveSecret: (providerId) => secretStore.resolveSecret(providerId),
      })
    },
    resolveSignIn(input: ConversationProviderSignInInput): Promise<ConversationProviderSignInResult> {
      return resolveConversationSignIn(input)
    },
    getSecretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult> {
      return secretStore.getStatus(input.providerId)
    },
    setSecret(input: ConversationSecretSetInput): Promise<ConversationSecretSetResult> {
      return secretStore.setSecret(input.providerId, input.value)
    },
    clearSecret(input: ConversationSecretClearInput): Promise<ConversationSecretClearResult> {
      return secretStore.clearSecret(input.providerId)
    },
    startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
      return runtime.startSession(input)
    },
    sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult> {
      return runtime.sendTurn(input)
    },
    interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult> {
      return runtime.interrupt(input)
    },
    respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult> {
      return runtime.respondToRequest(input)
    },
    setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult> {
      return runtime.setPermission(input)
    },
    setModel(input: ConversationSetModelInput): Promise<ConversationSessionActionResult> {
      return runtime.setModel(input)
    },
    mcpServerAction(input: ConversationMcpServerActionInput): Promise<ConversationMcpServerActionResult> {
      return runtime.mcpServerAction(input)
    },
    stopSubagent(input: ConversationStopSubagentInput): Promise<ConversationSessionActionResult> {
      return runtime.stopSubagent(input)
    },
    messageSubagent(input: ConversationMessageSubagentInput): Promise<ConversationSessionActionResult> {
      return runtime.messageSubagent(input)
    },
    askSideQuestion(input: ConversationSideQuestionInput): Promise<ConversationSideQuestionResult> {
      return runtime.askSideQuestion(input)
    },
    cancelSideQuestion(
      input: ConversationCancelSideQuestionInput,
    ): Promise<{ ok: true } | { ok: false; message: string }> {
      return runtime.cancelSideQuestion(input)
    },
    readContextBreakdown(input: ConversationContextBreakdownInput): Promise<ConversationContextBreakdownResult> {
      return runtime.readContextBreakdown(input)
    },
    stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> {
      return runtime.stopSession(input)
    },
    suspendSession(input: ConversationSuspendSessionInput): Promise<ConversationSessionActionResult> {
      return runtime.suspendSession(input)
    },
    listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult {
      return runtime.listSessions(input)
    },
    readAttachment(ref) {
      return runtime.readAttachment(ref)
    },
    planDocument(input) {
      return runtime.planDocument(input)
    },
    getToolDetail(input) {
      return runtime.getToolDetail(input)
    },
    readEvent(input) {
      return runtime.readConversationEvent(input)
    },
    listApprovalRules() {
      return runtime.listApprovalRules()
    },
    revokeApprovalRule(ruleId) {
      return runtime.revokeApprovalRule(ruleId)
    },
    subscribe(input, listener) {
      return sessions.subscribe(input, listener)
    },
    loadEarlier(input) {
      return sessions.loadEarlier(input)
    },
    getTurnDiff(input) {
      return sessions.getTurnDiff(input)
    },
    revertToTurn(input) {
      return sessions.revertToTurn(input)
    },
    rewindToTurn(input) {
      return sessions.rewindToTurn(input)
    },
    handoffConversation(input) {
      return sessions.handoffConversation(input)
    },
    onEvent(listener: (event: ConversationEvent) => void): () => void {
      return runtime.onEvent(listener)
    },
    onLifecycleEvent: conversationLifecycleEvents((listener) => runtime.onEvent(listener)),
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
