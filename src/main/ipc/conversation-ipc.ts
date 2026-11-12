import type { IpcMain, WebContents } from 'electron'
import type {
  ConversationSessionActionResult,
  ConversationSideQuestionResult,
  ConversationStartSessionResult,
  ConversationToolDetailResult,
  ConversationEventReadResult,
  ConversationAttachmentResult,
  ConversationPageResult,
  ConversationTurnDiffResult,
  ConversationRevertResult,
  ConversationRewindResult,
  ConversationHandoffResult,
  ConversationForkResult,
  ConversationContextBreakdownResult,
} from '../../shared/conversation-runtime'
import {
  parseRespondToRequestInput,
  parseSendTurnInput,
  parseSessionIdInput,
  parseSetModelInput,
  parseMessageSubagentInput,
  parseStopSubagentInput,
  parseSideQuestionInput,
  parseCancelSideQuestionInput,
  parseSetPermissionInput,
  parseStartSessionInput,
  parseTranscriptInput,
} from '../conversation-ipc-inputs'
import { isRecord } from '../../shared/records'
import { boundConversationPage, conversationWireFrame } from '../../server/conversation-stream-shaping'

import { createConversationService, type ConversationService } from '../conversation-service'

export function registerConversationIpc(
  ipcMain: IpcMain,
  handlers: ConversationService = createConversationService(),
): void {
  const scopedSubscriptions = new Map<string, { senderId: number; dispose: () => void }>()
  // A reload keeps the webContents, so `destroyed` never fires for the page it
  // replaced: the new page subscribes again while the old page's subscriptions
  // keep sending to the same sender, one more copy of every event per reload.
  // Navigation ends everything the page held, as it does for the git watch.
  const watchedSenders = new WeakSet<WebContents>()
  const releaseOnNavigation = (sender: WebContents): void => {
    if (watchedSenders.has(sender)) return
    watchedSenders.add(sender)
    const senderId = sender.id
    // Emitted for main-frame, cross-document navigations only — a reload is
    // one — once the new page has committed, before its scripts run.
    sender.on('did-navigate', () => {
      for (const subscription of [...scopedSubscriptions.values()])
        if (subscription.senderId === senderId) subscription.dispose()
    })
  }
  ipcMain.handle('conversation:turn:diff', async (_, input: unknown): Promise<ConversationTurnDiffResult> => {
    if (
      !isRecord(input) ||
      !Number.isSafeInteger(input.turnSeq) ||
      Number(input.turnSeq) < 1 ||
      (input.path !== undefined && typeof input.path !== 'string')
    )
      return { ok: false, message: 'Turn sequence and optional file path are required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.getTurnDiff?.({
        key: key.input,
        turnSeq: Number(input.turnSeq),
        path: input.path as string | undefined,
      }) ?? { ok: false, message: 'Checkpoints are unavailable.' }
    )
  })
  ipcMain.handle('conversation:turn:revert', async (_, input: unknown): Promise<ConversationRevertResult> => {
    if (
      !isRecord(input) ||
      !Number.isSafeInteger(input.turnSeq) ||
      Number(input.turnSeq) < 1 ||
      (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') ||
      (input.undo !== undefined && typeof input.undo !== 'boolean') ||
      (input.files !== undefined &&
        (!Array.isArray(input.files) || !input.files.every((path) => typeof path === 'string')))
    )
      return { ok: false, message: 'Turn sequence and explicit confirmation are required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.revertToTurn?.({
        key: key.input,
        turnSeq: Number(input.turnSeq),
        confirmed: input.confirmed === true,
        undo: input.undo === true,
        ...(Array.isArray(input.files) ? { files: input.files as string[] } : {}),
      }) ?? { ok: false, message: 'Checkpoints are unavailable.' }
    )
  })
  ipcMain.handle('conversation:turn:rewind', async (_, input: unknown): Promise<ConversationRewindResult> => {
    if (!isRecord(input) || !Number.isSafeInteger(input.turnSeq) || Number(input.turnSeq) < 1)
      return { ok: false, message: 'The message to edit is required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.rewindToTurn?.({ key: key.input, turnSeq: Number(input.turnSeq) }) ?? {
        ok: false,
        message: 'Editing an earlier message is unavailable.',
      }
    )
  })
  ipcMain.handle('conversation:handoff', async (_, input: unknown): Promise<ConversationHandoffResult> => {
    if (!isRecord(input)) return { ok: false, message: 'The chat to hand off is required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.handoffConversation?.({ key: key.input }) ?? {
        ok: false,
        message: 'Handing a chat off is unavailable.',
      }
    )
  })
  ipcMain.handle('conversation:turn:fork', async (_, input: unknown): Promise<ConversationForkResult> => {
    if (
      !isRecord(input) ||
      typeof input.newAgentId !== 'string' ||
      !input.newAgentId.trim() ||
      (input.title !== undefined && typeof input.title !== 'string') ||
      (input.side === 'user'
        ? !Number.isSafeInteger(input.turnSeq) || Number(input.turnSeq) < 1
        : input.side !== 'assistant' || typeof input.turnId !== 'string' || !input.turnId)
    )
      return { ok: false, message: 'The message to fork from is required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    const common = {
      key: key.input,
      newAgentId: input.newAgentId,
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
    }
    return (
      handlers.forkAtTurn?.(
        input.side === 'user'
          ? { ...common, side: 'user', turnSeq: Number(input.turnSeq) }
          : { ...common, side: 'assistant', turnId: input.turnId as string },
      ) ?? { ok: false, message: 'Forking a conversation is unavailable.' }
    )
  })
  ipcMain.handle('conversation:session:subscribe', (event, input: unknown) => {
    if (!isRecord(input) || typeof input.subscriptionId !== 'string' || !isRecord(input.key))
      return { ok: false, message: 'Subscription identity is required.' }
    const parsed = parseTranscriptInput(input.key)
    if (!parsed.ok) return parsed
    if (input.afterSeq !== undefined && (!Number.isSafeInteger(input.afterSeq) || Number(input.afterSeq) < 0))
      return { ok: false, message: 'afterSeq must be a nonnegative integer.' }
    if (
      input.generation !== undefined &&
      (typeof input.generation !== 'string' || input.generation.length < 1 || input.generation.length > 200)
    )
      return { ok: false, message: 'generation must be a string of 1–200 characters.' }
    if (input.turnLimit !== undefined && (!Number.isSafeInteger(input.turnLimit) || Number(input.turnLimit) < 1))
      return { ok: false, message: 'turnLimit must be a positive integer.' }
    if (!handlers.subscribe) return { ok: false, message: 'Conversation subscriptions are unavailable.' }
    const subscriptionId = input.subscriptionId
    const key = `${event.sender.id}:${subscriptionId}`
    scopedSubscriptions.get(key)?.dispose()
    const subscription = handlers.subscribe(
      {
        key: parsed.input,
        afterSeq: input.afterSeq as number | undefined,
        // Without the cursor's log generation the session cannot vouch for
        // the cursor, and every reconnect would be answered with a reset.
        generation: input.generation as string | undefined,
        turnLimit: input.turnLimit as number | undefined,
      },
      (frame) => {
        if (!event.sender.isDestroyed())
          event.sender.send('conversation:session-event', { subscriptionId, frame: conversationWireFrame(frame) })
      },
    )
    const dispose = () => {
      subscription.dispose()
      event.sender.removeListener('destroyed', dispose)
      if (scopedSubscriptions.get(key)?.dispose === dispose) scopedSubscriptions.delete(key)
    }
    event.sender.once('destroyed', dispose)
    scopedSubscriptions.set(key, { senderId: event.sender.id, dispose })
    releaseOnNavigation(event.sender)
    return { ok: true, subscriptionId }
  })
  ipcMain.handle('conversation:session:unsubscribe', (event, input: unknown) => {
    if (isRecord(input) && typeof input.subscriptionId === 'string')
      scopedSubscriptions.get(`${event.sender.id}:${input.subscriptionId}`)?.dispose()
    return { ok: true }
  })
  ipcMain.handle('conversation:session:earlier', async (_, input: unknown): Promise<ConversationPageResult> => {
    if (!isRecord(input) || !Number.isSafeInteger(input.beforeCursor) || Number(input.beforeCursor) < 1)
      return { ok: false, message: 'beforeCursor must be a positive integer.' }
    const parsed = parseTranscriptInput(input.key)
    if (!parsed.ok) return parsed
    if (input.turnLimit !== undefined && (!Number.isSafeInteger(input.turnLimit) || Number(input.turnLimit) < 1))
      return { ok: false, message: 'turnLimit must be a positive integer.' }
    const result = await handlers.loadEarlier?.({
      key: parsed.input,
      beforeCursor: Number(input.beforeCursor),
      turnLimit: input.turnLimit as number | undefined,
    })
    if (!result) return { ok: false, message: 'Conversation history is unavailable.' }
    return result.ok ? { ...result, page: boundConversationPage(result.page).page } : result
  })

  ipcMain.handle('conversation:sessions:start', async (_, input: unknown): Promise<ConversationStartSessionResult> => {
    const parsed = parseStartSessionInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.startSession(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle(
    'conversation:sessions:send-turn',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSendTurnInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.sendTurn(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:interrupt',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.interrupt(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:respond-to-request',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseRespondToRequestInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.respondToRequest(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:set-permission',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSetPermissionInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.setPermission(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:stop-subagent',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseStopSubagentInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.stopSubagent) return { ok: false, message: 'Stopping one agent is unavailable.' }
      try {
        return await handlers.stopSubagent(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:message-subagent',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseMessageSubagentInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.messageSubagent) return { ok: false, message: 'Writing to one agent is unavailable.' }
      try {
        return await handlers.messageSubagent(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:side-question',
    async (_, input: unknown): Promise<ConversationSideQuestionResult> => {
      const parsed = parseSideQuestionInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.askSideQuestion) return { ok: false, message: 'Side questions are unavailable.' }
      try {
        return await handlers.askSideQuestion(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:cancel-side-question',
    async (_, input: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
      const parsed = parseCancelSideQuestionInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.cancelSideQuestion) return { ok: false, message: 'Side questions are unavailable.' }
      try {
        return await handlers.cancelSideQuestion(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:context-breakdown',
    async (_, input: unknown): Promise<ConversationContextBreakdownResult> => {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return { ok: false, reason: 'failed', message: parsed.message }
      if (!handlers.readContextBreakdown)
        return { ok: false, reason: 'unsupported', message: 'The context breakdown is unavailable.' }
      try {
        return await handlers.readContextBreakdown(parsed.input)
      } catch (err) {
        return { ok: false, reason: 'failed', message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:set-model',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSetModelInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.setModel) return { ok: false, message: 'Changing models mid-conversation is unavailable.' }
      try {
        return await handlers.setModel(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle('conversation:tool-detail', async (_, input: unknown): Promise<ConversationToolDetailResult> => {
    const parsed = parseTranscriptInput(input)
    if (!parsed.ok || !isRecord(input) || typeof input.toolUseId !== 'string' || !input.toolUseId.trim())
      return { ok: false, code: 'invalid_input', message: 'Conversation and tool identity are required.' }
    return (
      handlers.getToolDetail?.({ ...parsed.input, toolUseId: input.toolUseId }) ?? {
        ok: false,
        code: 'unavailable',
        message: 'Tool details are unavailable.',
      }
    )
  })

  // An event that crossed cut to fit (`wireClipped`), read whole. Not the
  // all-chats push on `conversation:event`: a read, by the `seq` and `id` it
  // was sent under.
  ipcMain.handle('conversation:event:read', async (_, input: unknown): Promise<ConversationEventReadResult> => {
    const parsed = parseTranscriptInput(input)
    if (
      !parsed.ok ||
      !isRecord(input) ||
      !Number.isSafeInteger(input.seq) ||
      Number(input.seq) < 1 ||
      typeof input.id !== 'string' ||
      !input.id
    )
      return { ok: false, code: 'invalid_input', message: 'Conversation and event identity are required.' }
    return (
      handlers.readEvent?.({ ...parsed.input, seq: Number(input.seq), id: input.id }) ?? {
        ok: false,
        code: 'unavailable',
        message: 'This chat cannot be read just now.',
      }
    )
  })

  // A sent image, read back for a replayed bubble. The reference is resolved
  // inside the attachment store only; this is not a general file read.
  ipcMain.handle('conversation:attachment', async (_, input: unknown): Promise<ConversationAttachmentResult> => {
    if (!isRecord(input) || typeof input.ref !== 'string') return { ok: false, message: 'ref is required.' }
    return handlers.readAttachment?.(input.ref) ?? { ok: false, message: 'Attachments are unavailable.' }
  })
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
