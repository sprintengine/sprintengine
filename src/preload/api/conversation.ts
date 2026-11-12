import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'

import type { ElectronApi } from '../../shared/electron-api'
import type {
  ConversationInterruptInput,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSetModelInput,
  ConversationMessageSubagentInput,
  ConversationStopSubagentInput,
  ConversationCancelSideQuestionInput,
  ConversationContextBreakdownInput,
  ConversationContextBreakdownResult,
  ConversationSideQuestionInput,
  ConversationSideQuestionResult,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationEventReadInput,
  ConversationEventReadResult,
  ConversationAttachmentInput,
  ConversationAttachmentResult,
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
  ConversationForkInput,
  ConversationForkResult,
} from '../../shared/conversation-runtime'

type ConversationIpcRenderer = {
  invoke(channel: 'conversation:turn:diff', input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult>
  invoke(channel: 'conversation:turn:revert', input: ConversationRevertInput): Promise<ConversationRevertResult>
  invoke(channel: 'conversation:turn:rewind', input: ConversationRewindInput): Promise<ConversationRewindResult>
  invoke(channel: 'conversation:handoff', input: ConversationHandoffInput): Promise<ConversationHandoffResult>
  invoke(channel: 'conversation:turn:fork', input: ConversationForkInput): Promise<ConversationForkResult>
  invoke(
    channel: 'conversation:session:subscribe',
    input: ConversationSubscribeInput & { subscriptionId: string },
  ): Promise<{ ok: boolean; subscriptionId?: string; message?: string }>
  invoke(channel: 'conversation:session:unsubscribe', input: { subscriptionId: string }): Promise<{ ok: boolean }>
  invoke(channel: 'conversation:session:earlier', input: ConversationLoadEarlierInput): Promise<ConversationPageResult>
  on(
    channel: 'conversation:session-event',
    listener: (event: IpcRendererEvent, payload: { subscriptionId: string; frame: ConversationSessionFrame }) => void,
  ): void
  removeListener(
    channel: 'conversation:session-event',
    listener: (event: IpcRendererEvent, payload: { subscriptionId: string; frame: ConversationSessionFrame }) => void,
  ): void
  invoke(
    channel: 'conversation:sessions:start',
    input: ConversationStartSessionInput,
  ): Promise<ConversationStartSessionResult>
  invoke(
    channel: 'conversation:sessions:send-turn',
    input: ConversationSendTurnInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:interrupt',
    input: ConversationInterruptInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:respond-to-request',
    input: ConversationRespondToRequestInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:set-permission',
    input: ConversationSetPermissionInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:set-model',
    input: ConversationSetModelInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:stop-subagent',
    input: ConversationStopSubagentInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:message-subagent',
    input: ConversationMessageSubagentInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:side-question',
    input: ConversationSideQuestionInput,
  ): Promise<ConversationSideQuestionResult>
  invoke(
    channel: 'conversation:sessions:cancel-side-question',
    input: ConversationCancelSideQuestionInput,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  invoke(
    channel: 'conversation:sessions:context-breakdown',
    input: ConversationContextBreakdownInput,
  ): Promise<ConversationContextBreakdownResult>
  invoke(channel: 'conversation:tool-detail', input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  invoke(channel: 'conversation:event:read', input: ConversationEventReadInput): Promise<ConversationEventReadResult>
  invoke(channel: 'conversation:attachment', input: ConversationAttachmentInput): Promise<ConversationAttachmentResult>
}

export function createConversationApi(renderer: ConversationIpcRenderer) {
  let nextScopedId = 0
  return {
    conversationTurnDiff: (input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult> =>
      renderer.invoke('conversation:turn:diff', input),
    conversationRevertToTurn: (input: ConversationRevertInput): Promise<ConversationRevertResult> =>
      renderer.invoke('conversation:turn:revert', input),
    conversationRewindToTurn: (input: ConversationRewindInput): Promise<ConversationRewindResult> =>
      renderer.invoke('conversation:turn:rewind', input),
    conversationHandoff: (input: ConversationHandoffInput): Promise<ConversationHandoffResult> =>
      renderer.invoke('conversation:handoff', input),
    conversationForkAtTurn: (input: ConversationForkInput): Promise<ConversationForkResult> =>
      renderer.invoke('conversation:turn:fork', input),
    conversationSessionStart: (input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> =>
      renderer.invoke('conversation:sessions:start', input),
    conversationSessionSendTurn: (input: ConversationSendTurnInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:send-turn', input),
    conversationSessionInterrupt: (input: ConversationInterruptInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:interrupt', input),
    conversationSessionRespondToRequest: (
      input: ConversationRespondToRequestInput,
    ): Promise<ConversationSessionActionResult> => renderer.invoke('conversation:sessions:respond-to-request', input),
    conversationSessionSetPermission: (
      input: ConversationSetPermissionInput,
    ): Promise<ConversationSessionActionResult> => renderer.invoke('conversation:sessions:set-permission', input),
    conversationSessionSetModel: (input: ConversationSetModelInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:set-model', input),
    conversationSessionStopSubagent: (input: ConversationStopSubagentInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:stop-subagent', input),
    conversationSessionMessageSubagent: (
      input: ConversationMessageSubagentInput,
    ): Promise<ConversationSessionActionResult> => renderer.invoke('conversation:sessions:message-subagent', input),
    conversationSessionAskSideQuestion: (
      input: ConversationSideQuestionInput,
    ): Promise<ConversationSideQuestionResult> => renderer.invoke('conversation:sessions:side-question', input),
    conversationSessionCancelSideQuestion: (
      input: ConversationCancelSideQuestionInput,
    ): Promise<{ ok: true } | { ok: false; message: string }> =>
      renderer.invoke('conversation:sessions:cancel-side-question', input),
    conversationSessionContextBreakdown: (
      input: ConversationContextBreakdownInput,
    ): Promise<ConversationContextBreakdownResult> => renderer.invoke('conversation:sessions:context-breakdown', input),
    conversationToolDetail: (input: ConversationToolDetailInput): Promise<ConversationToolDetailResult> =>
      renderer.invoke('conversation:tool-detail', input),
    conversationEvent: (input: ConversationEventReadInput): Promise<ConversationEventReadResult> =>
      renderer.invoke('conversation:event:read', input),
    conversationAttachment: (input: ConversationAttachmentInput): Promise<ConversationAttachmentResult> =>
      renderer.invoke('conversation:attachment', input),
    conversationLoadEarlier: (input: ConversationLoadEarlierInput): Promise<ConversationPageResult> =>
      renderer.invoke('conversation:session:earlier', input),
    onConversationSession: (
      input: ConversationSubscribeInput,
      cb: (frame: ConversationSessionFrame) => void,
    ): (() => void) => {
      const subscriptionId = `panel-${Date.now()}-${++nextScopedId}`
      let disposed = false
      const receive = (
        _event: IpcRendererEvent,
        payload: { subscriptionId: string; frame: ConversationSessionFrame },
      ) => {
        if (!disposed && payload.subscriptionId === subscriptionId) cb(payload.frame)
      }
      renderer.on('conversation:session-event', receive)
      const subscribed = renderer.invoke('conversation:session:subscribe', { ...input, subscriptionId })
      void subscribed
        .then((result) => {
          if (!disposed && !result.ok)
            cb({ type: 'error', message: result.message ?? 'Conversation subscription failed.' })
        })
        .catch((error) => {
          if (!disposed) cb({ type: 'error', message: String(error) })
        })
      return () => {
        if (disposed) return
        disposed = true
        renderer.removeListener('conversation:session-event', receive)
        void subscribed
          .then(() => renderer.invoke('conversation:session:unsubscribe', { subscriptionId }))
          .catch(() => undefined)
      }
    },
  } satisfies Pick<
    ElectronApi,
    | 'conversationSessionStart'
    | 'conversationSessionSendTurn'
    | 'conversationSessionInterrupt'
    | 'conversationSessionRespondToRequest'
    | 'conversationSessionSetPermission'
    | 'conversationSessionSetModel'
    | 'conversationSessionStopSubagent'
    | 'conversationSessionMessageSubagent'
    | 'conversationSessionAskSideQuestion'
    | 'conversationSessionCancelSideQuestion'
    | 'conversationSessionContextBreakdown'
    | 'conversationToolDetail'
    | 'conversationEvent'
    | 'conversationAttachment'
    | 'conversationLoadEarlier'
    | 'conversationTurnDiff'
    | 'conversationRevertToTurn'
    | 'conversationRewindToTurn'
    | 'conversationHandoff'
    | 'conversationForkAtTurn'
    | 'onConversationSession'
  >
}

export const conversationApi = createConversationApi(ipcRenderer)
