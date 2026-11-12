import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import type { ConversationCommandsRequest } from '../../shared/ipc/conversation-commands'
import type { FileSearchResult, FileSystemStat } from '../../shared/ipc/filesystem'
import type { StudioChatBackend } from '../../server/rpc/studio-rpc-types'
import type { ConversationCliRuntimeOverrides } from '../../shared/conversation-runtime'
import { onConversationCommandsChanged } from '../conversation-commands/registry'
import { readConversationCommandsRequest } from '../conversation-commands/request'
import {
  parseCancelSideQuestionInput,
  parseMcpServerActionInput,
  parseMessageSubagentInput,
  parseProviderInput,
  parseSecretSetInput,
  parseSideQuestionInput,
  parseStopSubagentInput,
  parseRespondToRequestInput,
  parseSendTurnInput,
  parseSessionIdInput,
  parseSetModelInput,
  parseSetPermissionInput,
  parseStartSessionInput,
} from '../conversation-ipc-inputs'
import type { ConversationService } from '../conversation-service'
import { confineToRoots } from './studio-file-confinement'
import { expandHomePath } from '../home-path'

// The Studio RPC's chat surface in main: the conversation service behind the
// input checks every client meets (conversation-ipc-inputs.ts, named for the
// window IPC they were first written for), with a throw answered as
// `{ ok: false, message }`. It is the only way any client, the app's own
// windows included, reaches a chat's session.
//
// One difference is the command id. A window's IPC sends none; the RPC's
// session commands carry the client's, namespaced (`owner:<id>`), and it is
// passed to the runtime, whose receipts answer a command repeated after a
// dropped connection with its first result.

export type StudioChatBackendDeps = {
  conversation: ConversationService
  /** File search and reads, as the filesystem IPC serves them; a slot stands where a window's id would. */
  files: {
    searchFiles(senderId: number, input: Parameters<StudioChatBackend['searchFiles']>[1]): Promise<FileSearchResult>
    cancelActiveFileSearch(senderId: number, channel?: string): void
    cancelAllFileSearches(senderId: number): void
    statPath(path: string): Promise<FileSystemStat>
    readImageDataUrl(path: string): Promise<string>
  }
  repoRoot(folderPath: string, hostId?: string): Promise<string | null>
  /**
   * The folders a chat's files may be stat'd or read from: workspaces' and
   * live chats' folders, and the app's stores of sent pictures and plans.
   */
  readableRoots(): string[] | Promise<string[]>
  /** Whether the runtime holds a receipt for a session's command id. */
  hasReceipt(sessionId: string, commandId: string): Promise<boolean>
  /** The (CLI, folder) list main holds, probing when it is missing or old. */
  commands(input: ConversationCommandsRequest): Promise<ConversationCommandCatalog>
  onCommandsChanged?: (listener: (catalog: ConversationCommandCatalog) => void) => () => void
}

const unavailable = (what: string): { ok: false; message: string } => ({
  ok: false,
  message: `${what} is unavailable here.`,
})

const failed = (error: unknown): { ok: false; message: string } => ({
  ok: false,
  message: error instanceof Error ? error.message : String(error),
})

/**
 * A session input checked as the IPC checks it. The IPC takes a command id
 * only as a UUID, from a window, and no fingerprint at all; the RPC's id is
 * namespaced to its client and comes with its command's fingerprint, so both
 * are set aside for the check and put back after.
 */
function checked<I>(
  input: { commandId?: string; commandFingerprint?: string },
  parse: (raw: unknown) => { ok: true; input: I } | { ok: false; message: string },
): { ok: true; input: I & { commandId?: string; commandFingerprint?: string } } | { ok: false; message: string } {
  const { commandId, commandFingerprint, ...rest } = input
  const parsed = parse(rest)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    input: {
      ...parsed.input,
      ...(commandId === undefined ? {} : { commandId }),
      ...(commandFingerprint === undefined ? {} : { commandFingerprint }),
    },
  }
}

export function createStudioChatBackend(deps: StudioChatBackendDeps): StudioChatBackend {
  const handlers = deps.conversation
  // A file the chat surface reads is one inside a folder a chat can be about.
  const confined = async (path: string): Promise<string> => {
    const checked = await confineToRoots(path, await deps.readableRoots())
    if (!checked.ok) throw new Error(checked.message)
    return checked.path
  }
  // Studio's own window reads a path anywhere on this disk, as it did over
  // IPC (a picture an agent wrote to a temp folder); every other client only
  // inside those folders.
  const readable = async (path: string, reading?: { anyPath?: boolean }): Promise<string> =>
    reading?.anyPath ? expandHomePath(path) : confined(expandHomePath(path))
  const onCommandsChanged = deps.onCommandsChanged ?? onConversationCommandsChanged
  // A connection's history searches, by its slot and request id.
  const historySearches = new Map<string, AbortController>()
  let searchCount = 0
  return {
    async startSession(input) {
      const parsed = parseStartSessionInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.startSession(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async sendTurn(input) {
      const parsed = checked(input, parseSendTurnInput)
      if (!parsed.ok) return parsed
      try {
        return await handlers.sendTurn(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async interrupt(input) {
      const parsed = checked(input, parseSessionIdInput)
      if (!parsed.ok) return parsed
      try {
        return await handlers.interrupt(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async respond(input) {
      const parsed = checked(input, parseRespondToRequestInput)
      if (!parsed.ok) return parsed
      try {
        return await handlers.respondToRequest(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async setPermission(input) {
      const parsed = checked(input, parseSetPermissionInput)
      if (!parsed.ok) return parsed
      try {
        return await handlers.setPermission(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async setModel(input) {
      const parsed = checked(input, parseSetModelInput)
      if (!parsed.ok) return parsed
      if (!handlers.setModel) return { ok: false, message: 'Changing models mid-conversation is unavailable.' }
      try {
        return await handlers.setModel(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async hasReceipt(input) {
      try {
        return await deps.hasReceipt(input.sessionId, input.commandId)
      } catch {
        return false
      }
    },
    // Each of these answers its own `ok`, so a throw below is that answer
    // failing, not the request: a client reads every outcome in one place.
    async revert(input) {
      try {
        return (await handlers.revertToTurn?.(input)) ?? { ok: false, message: 'Checkpoints are unavailable.' }
      } catch (error) {
        return failed(error)
      }
    },
    async rewind(input) {
      try {
        return (
          (await handlers.rewindToTurn?.(input)) ?? { ok: false, message: 'Editing an earlier message is unavailable.' }
        )
      } catch (error) {
        return failed(error)
      }
    },
    async handoff(input) {
      try {
        return (
          (await handlers.handoffConversation?.(input)) ?? { ok: false, message: 'Handing a chat off is unavailable.' }
        )
      } catch (error) {
        return failed(error)
      }
    },
    async fork(input) {
      try {
        return (await handlers.forkAtTurn?.(input)) ?? { ok: false, message: 'Forking a conversation is unavailable.' }
      } catch (error) {
        return failed(error)
      }
    },
    async attachment(ref) {
      try {
        return (await handlers.readAttachment?.(ref)) ?? { ok: false, message: 'Attachments are unavailable.' }
      } catch (error) {
        return failed(error)
      }
    },
    async planDocument(input) {
      try {
        return (await handlers.planDocument?.(input)) ?? { ok: false, message: 'Plans are unavailable.' }
      } catch (error) {
        return failed(error)
      }
    },
    async commands(raw) {
      const input = readConversationCommandsRequest(raw)
      if (!input) throw new Error('A command list is asked for with a chat CLI and an absolute folder.')
      return deps.commands(input)
    },
    onCommandsChanged: (listener) => onCommandsChanged(listener),
    async providers(input) {
      try {
        // A CLI override is read where a session start reads it, as the IPC reads it.
        return await handlers.listProviders(
          input.cliRuntimes ? { cliRuntimes: input.cliRuntimes as ConversationCliRuntimeOverrides } : {},
        )
      } catch (error) {
        return failed(error)
      }
    },
    async providerModels(input) {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.listProviderModels(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async secretStatus(input) {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.getSecretStatus(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    searchFiles: (slot, input) => deps.files.searchFiles(slot, input),
    cancelFileSearch: (slot, channel) => deps.files.cancelActiveFileSearch(slot, channel),
    releaseFileSearches: (slot) => deps.files.cancelAllFileSearches(slot),
    // Expanded before the roots are checked, so a `~/` path is held to them as the file it names.
    stat: async (path, reading) => deps.files.statPath(await readable(path, reading)),
    readImage: async (path, reading) => deps.files.readImageDataUrl(await readable(path, reading)),
    repoRoot: (folderPath, hostId) => deps.repoRoot(folderPath, hostId),
    isKnownFolder: async (path) => (await confineToRoots(path, await deps.readableRoots())).ok,
    async listSessions(input) {
      try {
        return handlers.listSessions(input)
      } catch (error) {
        return failed(error)
      }
    },
    async stopSession(input) {
      const parsed = checked(input, parseSessionIdInput)
      if (!parsed.ok) return parsed
      try {
        return await handlers.stopSession(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async suspendSession(input) {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return parsed
      try {
        return (await handlers.suspendSession?.(parsed.input)) ?? unavailable('Suspending a chat')
      } catch (error) {
        return failed(error)
      }
    },
    async mcpServerAction(input) {
      const parsed = parseMcpServerActionInput(input)
      if (!parsed.ok) return parsed
      try {
        return (await handlers.mcpServerAction?.(parsed.input)) ?? unavailable('Acting on a chat’s MCP servers')
      } catch (error) {
        return failed(error)
      }
    },
    async stopSubagent(input) {
      const parsed = parseStopSubagentInput(input)
      if (!parsed.ok) return parsed
      try {
        return (await handlers.stopSubagent?.(parsed.input)) ?? unavailable('Stopping an agent a chat spawned')
      } catch (error) {
        return failed(error)
      }
    },
    async messageSubagent(input) {
      const parsed = parseMessageSubagentInput(input)
      if (!parsed.ok) return parsed
      try {
        return (await handlers.messageSubagent?.(parsed.input)) ?? unavailable('Messaging an agent a chat spawned')
      } catch (error) {
        return failed(error)
      }
    },
    async askSideQuestion(input) {
      const parsed = parseSideQuestionInput(input)
      if (!parsed.ok) return parsed
      try {
        return (await handlers.askSideQuestion?.(parsed.input)) ?? unavailable('Asking a side question')
      } catch (error) {
        return failed(error)
      }
    },
    async cancelSideQuestion(input) {
      const parsed = parseCancelSideQuestionInput(input)
      if (!parsed.ok) return parsed
      try {
        return (await handlers.cancelSideQuestion?.(parsed.input)) ?? unavailable('Asking a side question')
      } catch (error) {
        return failed(error)
      }
    },
    async contextBreakdown(input) {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return { ok: false, reason: 'failed', message: parsed.message }
      try {
        return (
          (await handlers.readContextBreakdown?.({ sessionId: parsed.input.sessionId })) ?? {
            ok: false,
            reason: 'unsupported',
            message: 'Reading what fills a chat’s context window is unavailable.',
          }
        )
      } catch (error) {
        return { ok: false, reason: 'failed', message: failed(error).message }
      }
    },
    ...(handlers.terminalHandoff
      ? {
          async terminalHandoff(input: Parameters<NonNullable<StudioChatBackend['terminalHandoff']>>[0]) {
            try {
              return await handlers.terminalHandoff!(input)
            } catch (error) {
              return failed(error)
            }
          },
        }
      : {}),
    async threads(input) {
      try {
        return (await handlers.listThreads?.(input)) ?? unavailable('Conversation history')
      } catch (error) {
        return failed(error)
      }
    },
    async searchHistory(slot, input) {
      // As the IPC keys a window's searches: by who asked and the request id.
      const key = `${slot}:${input.requestId ?? `search-${++searchCount}`}`
      historySearches.get(key)?.abort()
      const controller = new AbortController()
      historySearches.set(key, controller)
      try {
        return (
          (await handlers.searchThreads?.(input, { signal: controller.signal })) ?? unavailable('Conversation search')
        )
      } catch (error) {
        return failed(error)
      } finally {
        if (historySearches.get(key) === controller) historySearches.delete(key)
      }
    },
    cancelHistorySearch(slot, requestId) {
      historySearches.get(`${slot}:${requestId}`)?.abort()
    },
    releaseHistorySearches(slot) {
      for (const [key, controller] of historySearches)
        if (key.startsWith(`${slot}:`)) {
          controller.abort()
          historySearches.delete(key)
        }
    },
    async approvalRules() {
      try {
        return (await handlers.listApprovalRules?.()) ?? unavailable('Permission rules')
      } catch (error) {
        return failed(error)
      }
    },
    async revokeApprovalRule(ruleId) {
      try {
        return (await handlers.revokeApprovalRule?.(ruleId)) ?? unavailable('Permission rules')
      } catch (error) {
        return failed(error)
      }
    },
    async signIn(input) {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      try {
        return (
          (await handlers.resolveSignIn?.({
            providerId: parsed.input.providerId,
            ...(input.cliRuntimes ? { cliRuntimes: input.cliRuntimes as ConversationCliRuntimeOverrides } : {}),
          })) ?? unavailable('Signing a provider in')
        )
      } catch (error) {
        return failed(error)
      }
    },
    async setSecret(input) {
      const parsed = parseSecretSetInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.setSecret(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    async clearSecret(input) {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.clearSecret(parsed.input)
      } catch (error) {
        return failed(error)
      }
    },
    onLifecycleEvent: (listener) => handlers.onLifecycleEvent(listener),
  }
}
