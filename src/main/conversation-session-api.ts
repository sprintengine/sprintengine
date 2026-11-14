import type {
  ConversationEvent,
  ConversationSubscribeInput,
  ConversationSessionFrame,
  ConversationLoadEarlierInput,
  ConversationPageResult,
  ConversationSendTurnInput,
  ConversationInterruptInput,
  ConversationRespondToRequestInput,
  ConversationSetModelInput,
  ConversationSetPermissionInput,
  ConversationTurnDiffInput,
  ConversationRevertInput,
  ConversationRewindInput,
  ConversationHandoffInput,
  ConversationListSessionsInput,
  ConversationToolDetailInput,
  ConversationEventReadInput,
} from '../shared/conversation-runtime'
import type { ConversationBackend } from '../server/core/conversation-backend'

/** Transport-independent replay, subscription and command boundary. */
export class ConversationSessionApi {
  constructor(private readonly runtime: ConversationBackend) {}
  listSessions(input?: ConversationListSessionsInput) {
    return this.runtime.listSessions(input)
  }
  getToolDetail(input: ConversationToolDetailInput) {
    return this.runtime.getToolDetail(input)
  }
  readEvent(input: ConversationEventReadInput) {
    return this.runtime.readConversationEvent(input)
  }
  getTurnDiff(input: ConversationTurnDiffInput) {
    return this.runtime.getTurnDiff(input)
  }
  revertToTurn(input: ConversationRevertInput) {
    return this.runtime.revertToTurn(input)
  }
  rewindToTurn(input: ConversationRewindInput) {
    return this.runtime.rewindToTurn(input)
  }
  handoffConversation(input: ConversationHandoffInput) {
    return this.runtime.handoffConversation(input)
  }

  subscribe(
    input: ConversationSubscribeInput,
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose: () => void; ready: Promise<void> } {
    let disposed = false
    let joining = true
    let seen = input.afterSeq ?? 0
    const queued: ConversationEvent[] = []
    let unsubscribe = () => {}
    const dispose = () => {
      if (disposed) return
      disposed = true
      unsubscribe()
    }
    const deliver = (frame: ConversationSessionFrame) => {
      if (disposed) return
      try {
        listener(frame)
      } catch {
        dispose()
      }
    }
    const live = (event: ConversationEvent) => {
      if (disposed || event.workspaceId !== input.key.workspaceId || event.agentId !== input.key.agentId) return
      if (joining) {
        queued.push(event)
        return
      }
      if ((event.seq ?? 0) <= seen) return
      seen = event.seq!
      deliver({ type: 'event', event })
    }
    /**
     * Read the log from a cursor and hand over what this subscriber lacks,
     * live events held back meanwhile, using the same cursor and generation
     * rules a client's resubscribe does: the events after the cursor when the
     * log vouches for it, else a reset snapshot.
     */
    const join = async (afterSeq: number | undefined, joinGeneration: string | undefined): Promise<void> => {
      joining = true
      await this.runtime.recoverTranscript(input.key)
      const sync = await this.runtime.readConversationSync(input.key, {
        afterSeq,
        generation: joinGeneration,
        turnLimit: input.turnLimit,
      })
      if (disposed) return
      if (!sync.ok) {
        deliver({ type: 'error', message: sync.message })
        dispose()
        return
      }
      if (sync.kind === 'events') {
        for (const event of sync.events) deliver({ type: 'event', event })
      } else {
        deliver({
          type: 'snapshot',
          page: sync.page,
          generation: sync.generation,
          ...(afterSeq !== undefined ? { reset: true as const } : {}),
        })
      }
      seen = sync.head
      deliver({ type: 'synchronized', seq: seen, generation: sync.generation })
      joining = false
      for (const event of queued.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) live(event)
      queued.length = 0
    }
    const fail = (error: unknown) => {
      deliver({
        type: 'error',
        message: error instanceof Error ? error.message : 'Conversation could not synchronize.',
      })
      dispose()
    }
    // Subscribe before any asynchronous read so the join has no blind window.
    // An event is published only after it is on disk, so each one either is in
    // the read below or arrives here afterwards; the sequence filter drops the
    // overlap.
    unsubscribe = this.runtime.onEvent(live)
    const ready = join(input.afterSeq, input.generation).catch(fail)
    return { dispose, ready }
  }

  async loadEarlier(input: ConversationLoadEarlierInput): Promise<ConversationPageResult> {
    await this.runtime.recoverTranscript(input.key)
    return this.runtime.readConversationPage(input.key, input.beforeCursor, input.turnLimit)
  }

  send(input: ConversationSendTurnInput & { commandId: string }) {
    return this.runtime.sendTurn(input)
  }
  interrupt(input: ConversationInterruptInput & { commandId: string }) {
    return this.runtime.interrupt(input)
  }
  resolveApproval(input: ConversationRespondToRequestInput & { commandId: string }) {
    return this.runtime.respondToRequest(input)
  }
  answerQuestion(input: ConversationRespondToRequestInput & { commandId: string }) {
    return this.runtime.respondToRequest(input)
  }
  setPermissionPreset(input: ConversationSetPermissionInput & { commandId: string }) {
    return this.runtime.setPermission(input)
  }
  setModel(input: ConversationSetModelInput & { commandId: string }) {
    return this.runtime.setModel(input)
  }
}
