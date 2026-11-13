import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'

import {
  MESH_CANVAS_BOARDS_CHANNEL,
  MESH_CANVAS_SCREENSHOT_CHANNEL,
  MESH_FORGET_CHANNEL,
  MESH_GET_LIVE_STATE_CHANNEL,
  MESH_LIST_CONNECTIONS_CHANNEL,
  MESH_CANCEL_PAIRING_CHANNEL,
  MESH_PAIR_CHANNEL,
  MESH_REQUEST_PAIRING_CHANNEL,
  MESH_EVENT_CHANNEL,
  type MeshConnection,
  type MeshCanvasBoardsResult,
  type MeshCanvasScreenshotResult,
  type MeshEvent,
  type MeshLiveState,
  type MeshPairResult,
  type MeshRequestPairingResult,
  meshConversationFrameChannel,
  MESH_CONVERSATION_CANCEL_SIDE_QUESTION_CHANNEL,
  MESH_CONVERSATION_COMMAND_CHANNEL,
  MESH_CONVERSATION_CONTEXT_BREAKDOWN_CHANNEL,
  MESH_CONVERSATION_EARLIER_CHANNEL,
  MESH_CONVERSATION_FOLLOW_CHANNEL,
  MESH_CONVERSATION_LIST_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_CREATE_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_DRAFT_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_PUSH_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_STATE_CHANNEL,
  MESH_CONVERSATION_SEND_CHANNEL,
  MESH_CONVERSATION_SIDE_QUESTION_CHANNEL,
  MESH_CONVERSATION_TOOL_DETAIL_CHANNEL,
  MESH_CONVERSATION_EVENT_CHANNEL,
  MESH_CONVERSATION_TOOL_IMAGE_CHANNEL,
  MESH_CONVERSATION_ATTACHMENT_CHANNEL,
  MESH_CONVERSATION_TURN_DIFF_CHANNEL,
  MESH_CONVERSATION_WATCH_CHANGES_CHANNEL,
  MESH_CONVERSATION_CHANGES_DIFF_CHANNEL,
  MESH_CONVERSATION_CHANGED_FILE_CHANNEL,
  MESH_CONVERSATION_UNFOLLOW_CHANNEL,
  MESH_CONVERSATION_FILE_SEARCH_CHANNEL,
  MESH_CONVERSATION_COMMANDS_CHANNEL,
  type MeshChangedFileResult,
  type MeshChangesDiffResult,
  type MeshConversationFileSearchResult,
  type MeshConversationCommandsResult,
  type MeshConversationCommand,
  type MeshConversationCommandResult,
  type MeshConversationFrame,
  type MeshConversationKey,
  type MeshConversationSendInput,
  type MeshUsageLimitResumeAction,
  type MeshConversationImageResult,
  type MeshConversationListResult,
  type MeshPullRequestCreateResult,
  type MeshPullRequestDraftResult,
  type MeshPullRequestPushResult,
  type MeshPullRequestStateResult,
} from '../../shared/tailnet-mesh'
import type { PullRequestCheckoutPin } from '../../shared/git/pull-request-create'
import type { ConversationChangesSelection } from '../../../packages/conversation-protocol/src/checkoutChanges'
import type {
  ConversationApprovalDecision,
  ConversationContextBreakdownResult,
  ConversationPageResult,
  ConversationSideQuestionExchange,
  ConversationSideQuestionResult,
  ConversationToolDetailResult,
  ConversationEventReadResult,
  ConversationTurnDiffResult,
} from '../../shared/conversation-runtime'
import type { TailnetScope } from '../../shared/tailnet'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import type { ElectronApi } from '../../shared/electron-api'

// The Mesh's data path: the machines this Studio drives, what they
// hold, and the terminals it has open on them.
//
// Nothing here carries a credential. The device tokens stay in main, which is
// also the only place that can dial the listener at all — it refuses any
// request with an `Origin` header, and a renderer always sends one.
export const meshApi = {
  meshListConnections: (): Promise<MeshConnection[]> =>
    ipcRenderer.invoke(MESH_LIST_CONNECTIONS_CHANNEL) as Promise<MeshConnection[]>,
  meshPair: (pairingUrl: string): Promise<MeshPairResult> =>
    ipcRenderer.invoke(MESH_PAIR_CHANNEL, { pairingUrl }) as Promise<MeshPairResult>,
  meshRequestPairing: (
    endpoint: string,
    options?: { scopes?: TailnetScope[]; reverseScopes?: TailnetScope[] },
  ): Promise<MeshRequestPairingResult> =>
    ipcRenderer.invoke(MESH_REQUEST_PAIRING_CHANNEL, {
      endpoint,
      // Omitted rather than sent empty when the caller names nothing, so each
      // end's own default stays in force.
      ...(options?.scopes ? { scopes: options.scopes } : {}),
      ...(options?.reverseScopes ? { reverseScopes: options.reverseScopes } : {}),
    }) as Promise<MeshRequestPairingResult>,
  meshCancelPairing: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(MESH_CANCEL_PAIRING_CHANNEL, requestId) as Promise<void>,
  meshForget: (connectionId: string): Promise<MeshConnection[]> =>
    ipcRenderer.invoke(MESH_FORGET_CHANNEL, connectionId) as Promise<MeshConnection[]>,
  meshCanvasBoards: (input: {
    connectionId: string
    workspaceId: string
    scope: 'workspace' | 'machine'
  }): Promise<MeshCanvasBoardsResult> =>
    ipcRenderer.invoke(MESH_CANVAS_BOARDS_CHANNEL, input) as Promise<MeshCanvasBoardsResult>,
  meshCanvasScreenshot: (input: {
    connectionId: string
    workspaceId: string
    board: string
    dark: boolean
  }): Promise<MeshCanvasScreenshotResult> =>
    ipcRenderer.invoke(MESH_CANVAS_SCREENSHOT_CHANNEL, input) as Promise<MeshCanvasScreenshotResult>,
  // Whole-app mesh lifecycle (remote-sessions-ux): machine paired/forgotten,
  // reachability and pairing waits, broadcast to every window.
  meshGetLiveState: (): Promise<MeshLiveState> =>
    ipcRenderer.invoke(MESH_GET_LIVE_STATE_CHANNEL) as Promise<MeshLiveState>,
  onMeshEvent: (cb: (event: MeshEvent) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, event: MeshEvent) => cb(event)
    ipcRenderer.on(MESH_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(MESH_EVENT_CHANNEL, handler)
  },
  meshConversationList: (connectionId: string): Promise<MeshConversationListResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_LIST_CHANNEL, connectionId) as Promise<MeshConversationListResult>,
  // The same shape as `onConversationSession`: listen first, then ask main
  // to follow, and hand back the unsubscribe. A follow that could not start
  // reaches the callback as an `error` frame, never as a throw.
  onMeshConversationSession: (
    input: { key: MeshConversationKey; turnLimit?: number },
    cb: (frame: MeshConversationFrame) => void,
  ): (() => void) => {
    const followId = `follow-${Date.now()}-${++nextFollowId}`
    const channel = meshConversationFrameChannel(followId)
    let disposed = false
    const handler = (_: IpcRendererEvent, frame: MeshConversationFrame) => {
      if (!disposed) cb(frame)
    }
    ipcRenderer.on(channel, handler)
    const followed = ipcRenderer.invoke(MESH_CONVERSATION_FOLLOW_CHANNEL, { followId, ...input }) as Promise<
      { ok: true } | { ok: false; code: string; message: string }
    >
    void followed
      .then((result) => {
        if (!disposed && !result.ok) cb({ type: 'error', message: result.message })
      })
      .catch((error: unknown) => {
        if (!disposed) cb({ type: 'error', message: String(error) })
      })
    return () => {
      if (disposed) return
      disposed = true
      ipcRenderer.removeListener(channel, handler)
      void followed.then(() => ipcRenderer.invoke(MESH_CONVERSATION_UNFOLLOW_CHANNEL, followId)).catch(() => undefined)
    }
  },
  meshConversationLoadEarlier: (input: {
    key: MeshConversationKey
    beforeCursor: number
    turnLimit?: number
  }): Promise<ConversationPageResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_EARLIER_CHANNEL, input) as Promise<ConversationPageResult>,
  meshConversationSend: (input: MeshConversationSendInput): Promise<MeshConversationCommandResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_SEND_CHANNEL, input) as Promise<MeshConversationCommandResult>,
  meshConversationCancelQueued: (input: { key: MeshConversationKey; queuedId: string }) =>
    command(input.key, { kind: 'cancelQueued', queuedId: input.queuedId }),
  meshConversationInterrupt: (input: { key: MeshConversationKey }) => command(input.key, { kind: 'interrupt' }),
  meshConversationStopSubagent: (input: { key: MeshConversationKey; toolUseId: string }) =>
    command(input.key, { kind: 'stopSubagent', toolUseId: input.toolUseId }),
  meshConversationMessageSubagent: (input: { key: MeshConversationKey; toolUseId: string; message: string }) =>
    command(input.key, { kind: 'messageSubagent', toolUseId: input.toolUseId, message: input.message }),
  meshConversationHandoff: (input: { key: MeshConversationKey }) => command(input.key, { kind: 'handoff' }),
  meshConversationRewind: (input: { key: MeshConversationKey; turnSeq: number }) =>
    command(input.key, { kind: 'rewind', turnSeq: input.turnSeq }),
  meshConversationRevert: (input: {
    key: MeshConversationKey
    turnSeq: number
    undo?: boolean
    confirmed?: boolean
    files?: string[]
  }) =>
    command(input.key, {
      kind: 'revert',
      turnSeq: input.turnSeq,
      ...(input.undo ? { undo: true } : {}),
      ...(input.confirmed ? { confirmed: true, files: input.files ?? [] } : {}),
    }),
  meshConversationFork: (input: {
    key: MeshConversationKey
    fork: Extract<MeshConversationCommand, { kind: 'fork' }>
  }) => command(input.key, input.fork),
  meshConversationSideQuestion: (input: {
    key: MeshConversationKey
    requestId: string
    question: string
    history?: ConversationSideQuestionExchange[]
  }): Promise<ConversationSideQuestionResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_SIDE_QUESTION_CHANNEL, input) as Promise<ConversationSideQuestionResult>,
  meshConversationCancelSideQuestion: (input: {
    key: MeshConversationKey
    requestId: string
  }): Promise<{ ok: true } | { ok: false; message: string }> =>
    ipcRenderer.invoke(MESH_CONVERSATION_CANCEL_SIDE_QUESTION_CHANNEL, input) as Promise<
      { ok: true } | { ok: false; message: string }
    >,
  meshConversationContextBreakdown: (input: {
    key: MeshConversationKey
  }): Promise<ConversationContextBreakdownResult> =>
    ipcRenderer.invoke(
      MESH_CONVERSATION_CONTEXT_BREAKDOWN_CHANNEL,
      input,
    ) as Promise<ConversationContextBreakdownResult>,
  meshConversationScheduleSend: (input: {
    key: MeshConversationKey
    message: string
    sendAt: number
    untilLimitReset?: string
  }) =>
    command(input.key, {
      kind: 'scheduleSend',
      message: input.message,
      sendAt: input.sendAt,
      ...(input.untilLimitReset ? { untilLimitReset: input.untilLimitReset } : {}),
    }),
  meshConversationSendScheduledNow: (input: { key: MeshConversationKey; scheduledId: string }) =>
    command(input.key, { kind: 'sendScheduledNow', scheduledId: input.scheduledId }),
  meshConversationCancelScheduled: (input: { key: MeshConversationKey; scheduledId: string }) =>
    command(input.key, { kind: 'cancelScheduled', scheduledId: input.scheduledId }),
  meshConversationUsageLimitResume: (input: {
    key: MeshConversationKey
    action: MeshUsageLimitResumeAction
    always?: boolean
  }) =>
    command(input.key, { kind: 'usageLimitResume', action: input.action, ...(input.always ? { always: true } : {}) }),
  meshConversationResolveApproval: (input: {
    key: MeshConversationKey
    requestId: string
    decision: ConversationApprovalDecision
  }) => command(input.key, { kind: 'resolveApproval', requestId: input.requestId, decision: input.decision }),
  meshConversationAnswerQuestion: (input: {
    key: MeshConversationKey
    requestId: string
    answers: Record<string, string>
  }) => command(input.key, { kind: 'answerQuestion', requestId: input.requestId, answers: input.answers }),
  meshConversationSetPermissionPreset: (input: {
    key: MeshConversationKey
    preset: CliPermissionPreset
    permissionMode?: string
  }) =>
    command(input.key, {
      kind: 'setPermissionPreset',
      preset: input.preset,
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    }),
  meshConversationSetModel: (input: { key: MeshConversationKey; modelId: string }) =>
    command(input.key, { kind: 'setModel', modelId: input.modelId }),
  meshConversationSetReasoningEffort: (input: { key: MeshConversationKey; effort?: string }) =>
    command(input.key, { kind: 'setReasoningEffort', ...(input.effort ? { effort: input.effort } : {}) }),
  meshConversationMcpServerAction: (input: {
    key: MeshConversationKey
    serverId: string
    action: 'reconnect' | 'enable' | 'disable'
  }) => command(input.key, { kind: 'mcpServerAction', serverId: input.serverId, action: input.action }),
  meshConversationRestartSession: (input: { key: MeshConversationKey }) =>
    command(input.key, { kind: 'restartSession' }),
  meshConversationToolDetail: (input: {
    key: MeshConversationKey
    toolUseId: string
  }): Promise<ConversationToolDetailResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_TOOL_DETAIL_CHANNEL, input) as Promise<ConversationToolDetailResult>,
  meshConversationEvent: (input: { key: MeshConversationKey; seq: number; id: string }) =>
    ipcRenderer.invoke(MESH_CONVERSATION_EVENT_CHANNEL, input) as Promise<ConversationEventReadResult>,
  meshConversationTurnDiff: (input: {
    key: MeshConversationKey
    turnSeq: number
    path?: string
  }): Promise<ConversationTurnDiffResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_TURN_DIFF_CHANNEL, input) as Promise<ConversationTurnDiffResult>,
  meshConversationWatchChanges: (input: {
    key: MeshConversationKey
    watching: boolean
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }> =>
    ipcRenderer.invoke(MESH_CONVERSATION_WATCH_CHANGES_CHANNEL, input) as Promise<
      { ok: true } | { ok: false; code: string; message: string }
    >,
  meshConversationChangesDiff: (input: {
    key: MeshConversationKey
    selection: ConversationChangesSelection
  }): Promise<MeshChangesDiffResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_CHANGES_DIFF_CHANNEL, input) as Promise<MeshChangesDiffResult>,
  meshConversationChangedFile: (input: {
    key: MeshConversationKey
    selection: ConversationChangesSelection
    path: string
  }): Promise<MeshChangedFileResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_CHANGED_FILE_CHANNEL, input) as Promise<MeshChangedFileResult>,
  meshConversationToolImage: (input: {
    key: MeshConversationKey
    toolUseId: string
  }): Promise<MeshConversationImageResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_TOOL_IMAGE_CHANNEL, input) as Promise<MeshConversationImageResult>,
  meshConversationAttachment: (input: {
    key: MeshConversationKey
    ref: string
  }): Promise<MeshConversationImageResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_ATTACHMENT_CHANNEL, input) as Promise<MeshConversationImageResult>,
  meshConversationSearchFiles: (input: {
    key: MeshConversationKey
    query: string
  }): Promise<MeshConversationFileSearchResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_FILE_SEARCH_CHANNEL, input) as Promise<MeshConversationFileSearchResult>,
  meshConversationCommands: (input: {
    key: MeshConversationKey
    refresh?: boolean
  }): Promise<MeshConversationCommandsResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_COMMANDS_CHANNEL, {
      key: input.key,
      ...(input.refresh ? { refresh: true } : {}),
    }) as Promise<MeshConversationCommandsResult>,
  // A remote chat's Create PR: each step runs on the chat's machine.
  meshConversationPullRequestState: (input: { key: MeshConversationKey }): Promise<MeshPullRequestStateResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_STATE_CHANNEL, input) as Promise<MeshPullRequestStateResult>,
  meshConversationPullRequestDraft: (input: {
    key: MeshConversationKey
    draftId?: string
  }): Promise<MeshPullRequestDraftResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_DRAFT_CHANNEL, input) as Promise<MeshPullRequestDraftResult>,
  meshConversationPullRequestDraftCancel: (input: {
    key: MeshConversationKey
    draftId: string
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_CHANNEL, input) as Promise<
      { ok: true } | { ok: false; code: string; message: string }
    >,
  meshConversationPullRequestPush: (input: {
    key: MeshConversationKey
    pin?: PullRequestCheckoutPin
  }): Promise<MeshPullRequestPushResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_PUSH_CHANNEL, input) as Promise<MeshPullRequestPushResult>,
  meshConversationPullRequestCreate: (input: {
    key: MeshConversationKey
    title: string
    body: string
    pin?: PullRequestCheckoutPin
  }): Promise<MeshPullRequestCreateResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_CREATE_CHANNEL, input) as Promise<MeshPullRequestCreateResult>,
} satisfies Pick<
  ElectronApi,
  | 'meshListConnections'
  | 'meshPair'
  | 'meshRequestPairing'
  | 'meshCancelPairing'
  | 'meshForget'
  | 'meshCanvasBoards'
  | 'meshCanvasScreenshot'
  | 'meshGetLiveState'
  | 'onMeshEvent'
  | 'meshConversationList'
  | 'onMeshConversationSession'
  | 'meshConversationLoadEarlier'
  | 'meshConversationSend'
  | 'meshConversationCancelQueued'
  | 'meshConversationInterrupt'
  | 'meshConversationStopSubagent'
  | 'meshConversationMessageSubagent'
  | 'meshConversationHandoff'
  | 'meshConversationRewind'
  | 'meshConversationRevert'
  | 'meshConversationFork'
  | 'meshConversationSideQuestion'
  | 'meshConversationCancelSideQuestion'
  | 'meshConversationContextBreakdown'
  | 'meshConversationScheduleSend'
  | 'meshConversationSendScheduledNow'
  | 'meshConversationCancelScheduled'
  | 'meshConversationUsageLimitResume'
  | 'meshConversationResolveApproval'
  | 'meshConversationAnswerQuestion'
  | 'meshConversationSetPermissionPreset'
  | 'meshConversationSetModel'
  | 'meshConversationSetReasoningEffort'
  | 'meshConversationMcpServerAction'
  | 'meshConversationRestartSession'
  | 'meshConversationToolDetail'
  | 'meshConversationEvent'
  | 'meshConversationTurnDiff'
  | 'meshConversationWatchChanges'
  | 'meshConversationChangesDiff'
  | 'meshConversationChangedFile'
  | 'meshConversationToolImage'
  | 'meshConversationAttachment'
  | 'meshConversationSearchFiles'
  | 'meshConversationCommands'
  | 'meshConversationPullRequestState'
  | 'meshConversationPullRequestDraft'
  | 'meshConversationPullRequestDraftCancel'
  | 'meshConversationPullRequestPush'
  | 'meshConversationPullRequestCreate'
>

let nextFollowId = 0

function command(key: MeshConversationKey, input: MeshConversationCommand): Promise<MeshConversationCommandResult> {
  return ipcRenderer.invoke(MESH_CONVERSATION_COMMAND_CHANNEL, {
    key,
    command: input,
  }) as Promise<MeshConversationCommandResult>
}
