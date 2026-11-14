import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react'
import {
  composerDraftStore,
  MAX_DRAFT_CHARS,
  MAX_PENDING_PICTURE_CHARS,
  type ComposerDraft,
  type PendingComposerSend,
} from './draftStore'
import { restoreRefusedText } from './composerQueue'
import { clipKeepingQuotes } from '../../../../../shared/chat-quotes'
import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'

type DraftValue = Omit<ComposerDraft, 'updatedAt'>
export type ComposerDraftMetadata = Pick<DraftValue, 'skillIds' | 'mentions' | 'files'>
const empty = (): DraftValue => ({ text: '', skillIds: [], mentions: [], files: [] })
const isEmpty = (value: DraftValue) =>
  !value.text && !value.skillIds.length && !value.mentions.length && !value.files.length

/** One send, as the composer hands it to `beginDraftSend`. */
export type DraftSendInput = {
  message: string
  /** Sent from the composer, whose draft it clears; else a first message, Retry or a queued message. */
  fromDraft: boolean
  commandId: string
  localTurnId: string
  attachments: ConversationImageAttachment[]
  metadata: ComposerDraftMetadata
}

// The sends this page has out, by command id: a chat view mounted again while
// one is out finds its record, and leaves it to the send.
const sendsOut = new Set<string>()

function pendingRecord(input: DraftSendInput): PendingComposerSend {
  const attachments: ConversationImageAttachment[] = []
  let chars = 0
  for (const picture of input.attachments) {
    if (chars + picture.dataBase64.length > MAX_PENDING_PICTURE_CHARS) continue
    chars += picture.dataBase64.length
    attachments.push(picture)
  }
  return {
    text: input.message.trim(),
    skillIds: input.metadata.skillIds,
    mentions: input.metadata.mentions,
    files: input.metadata.files,
    attachments,
    picturesNotKept: input.attachments.length - attachments.length,
    commandId: input.commandId,
    localTurnId: input.localTurnId,
    fromDraft: input.fromDraft,
    at: Date.now(),
  }
}

/**
 * A send clears the draft, on screen and in storage, before it leaves; a send
 * that fails puts it back. What it sent is kept in storage as a pending send
 * (`PendingComposerSend`) until Studio answers it, never as a draft: a reload
 * in between finds it, and the chat view settles it against the chat's log
 * (`settlePendingSend`): there, it is let go of; not there, it comes back to
 * the composer with a notice, under its command id, so a late copy Studio
 * still carries out is answered from its receipt rather than run twice.
 */
export function useComposerDraft(workspaceId: string, agentId: string, prefill = '') {
  const store = useMemo(() => composerDraftStore(), [])
  const key = JSON.stringify([workspaceId, agentId])
  const initial = useMemo(() => {
    const saved = store.getState().read(workspaceId, agentId)
    return {
      text: saved.updatedAt ? saved.text : clipKeepingQuotes(prefill, MAX_DRAFT_CHARS),
      skillIds: saved.skillIds,
      mentions: saved.mentions,
      files: saved.files,
    }
  }, [store, workspaceId, agentId, prefill])
  const [state, setState] = useState({ key, value: initial })
  const current = state.key === key ? state.value : initial
  const values = useRef(new Map<string, DraftValue>())
  values.current.set(key, current)
  // The draft each send took (null for a send that took none), held in
  // memory, to put back if it fails.
  const pending = useRef(new Map<string, { token: symbol; snapshot: DraftValue | null; commandId: string }>())
  // A send a reload or a restart cut off, found when the chat opened, until
  // the chat view settles it. One still out from this page is the send's own.
  const foundSend = useMemo(() => {
    const send = store.getState().readSend(workspaceId, agentId)
    return send && !send.restored && !sendsOut.has(send.commandId) ? send : null
  }, [store, workspaceId, agentId])
  const [settledSends, setSettledSends] = useState<ReadonlySet<string>>(() => new Set())
  const pendingSend = foundSend && !settledSends.has(foundSend.commandId) ? foundSend : null
  const activeKeys = useRef(new Set<string>())
  // Storage writes land shortly after an edit, so a refused write is reported
  // by the store rather than thrown from the edit that caused it.
  const writeFailed = useSyncExternalStore(store.subscribeDraftWrites, store.draftWriteFailed)
  const persistenceError = writeFailed
    ? 'This draft could not be saved on this device. Keep this tab open or copy the text before closing it.'
    : null
  const write = useCallback(
    (target: string, workspace: string, agent: string) => {
      store.getState().put(workspace, agent, values.current.get(target) ?? empty())
    },
    [store],
  )
  const flushDraft = useCallback(() => write(key, workspaceId, agentId), [key, workspaceId, agentId, write])
  const update = useCallback(
    (value: DraftValue) => {
      values.current.set(key, value)
      setState({ key, value })
    },
    [key],
  )
  const setDraft = useCallback(
    (value: SetStateAction<string>) => {
      const previous = values.current.get(key) ?? initial
      update({
        ...previous,
        // At the cap, never through a quote's token: a half token is noise.
        text: clipKeepingQuotes(typeof value === 'function' ? value(previous.text) : value, MAX_DRAFT_CHARS),
      })
    },
    [key, initial, update],
  )
  const setDraftMetadata = useCallback(
    (metadata: SetStateAction<ComposerDraftMetadata>) => {
      const previous = values.current.get(key) ?? initial
      update({ ...previous, ...(typeof metadata === 'function' ? metadata(previous) : metadata) })
    },
    [key, initial, update],
  )
  useEffect(() => {
    const timer = window.setTimeout(flushDraft, 400)
    return () => window.clearTimeout(timer)
  }, [current, flushDraft])
  useEffect(() => {
    activeKeys.current.add(key)
    // Leaving the page or the chat cannot wait for the store's write delay.
    const flush = () => {
      write(key, workspaceId, agentId)
      store.flushDrafts()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      flush()
      activeKeys.current.delete(key)
      window.removeEventListener('pagehide', flush)
    }
  }, [key, workspaceId, agentId, write, store])

  const beginDraftSend = useCallback(
    (input: DraftSendInput): symbol => {
      const snapshot = values.current.get(key) ?? initial
      // A queued message is not the user's newer draft.
      const takesDraft = input.fromDraft && snapshot.text.trim() === input.message.trim()
      const token = Symbol('draft-send')
      pending.current.set(key, { token, snapshot: takesDraft ? snapshot : null, commandId: input.commandId })
      sendsOut.add(input.commandId)
      // Kept before it goes, and written now, not after the store's write
      // delay: a reload once it has left finds the send, and not a draft.
      store.getState().putSend(workspaceId, agentId, pendingRecord(input))
      if (takesDraft) {
        update(empty())
        flushDraft()
      }
      store.flushDrafts()
      return token
    },
    [key, initial, update, flushDraft, store, workspaceId, agentId],
  )
  const finishDraftSend = useCallback(
    (token: symbol | null, succeeded: boolean) => {
      const attempt = pending.current.get(key)
      if (!token || attempt?.token !== token) return
      pending.current.delete(key)
      sendsOut.delete(attempt.commandId)
      // Answered: the send is let go of. A failed one comes back below, as a draft.
      if (store.getState().readSend(workspaceId, agentId)?.commandId === attempt.commandId)
        store.getState().putSend(workspaceId, agentId, null)
      const active = activeKeys.current.has(key)
      if (succeeded) {
        if (active) flushDraft()
        store.flushDrafts()
        return
      }
      // A send that took no draft is put back by its caller.
      if (!attempt.snapshot) {
        store.flushDrafts()
        return
      }
      // Failed: the draft comes back, unless a newer one was begun meanwhile
      // (the failed text stays on the error's Retry).
      if (!active) {
        if (isEmpty(store.getState().read(workspaceId, agentId))) {
          store.getState().put(workspaceId, agentId, attempt.snapshot)
          store.flushDrafts()
        }
        return
      }
      if (!isEmpty(values.current.get(key) ?? empty())) {
        store.flushDrafts()
        return
      }
      update(attempt.snapshot)
      flushDraft()
      store.flushDrafts()
    },
    [key, update, flushDraft, store, workspaceId, agentId],
  )
  /**
   * Settle the send found when the chat opened, once its log is read: one the
   * log shows is let go of; one it does not is put back in the composer,
   * ahead of anything typed since, and answered with what it carried, for the
   * view to say so and give back its pictures. Its command id stays, for a
   * send of the same words (`commandIdFor`).
   */
  const settlePendingSend = useCallback(
    (landed: boolean): PendingComposerSend | null => {
      const send = pendingSend
      if (!send) return null
      setSettledSends((current) => new Set(current).add(send.commandId))
      const state = store.getState()
      // A newer send from this page holds the record now; it is that send's.
      const stored = state.readSend(workspaceId, agentId)
      const recordIsThis = stored?.commandId === send.commandId
      if (landed) {
        if (recordIsThis) state.putSend(workspaceId, agentId, null)
        store.flushDrafts()
        return null
      }
      const current = values.current.get(key) ?? initial
      update(
        isEmpty(current)
          ? { text: send.text, skillIds: send.skillIds, mentions: send.mentions, files: send.files }
          : {
              text: restoreRefusedText(current.text, send.text),
              skillIds: [...new Set([...send.skillIds, ...current.skillIds])],
              mentions: [...send.mentions, ...current.mentions],
              files: [...new Set([...send.files, ...current.files])],
            },
      )
      flushDraft()
      if (recordIsThis) state.putSend(workspaceId, agentId, { ...send, attachments: [], restored: true })
      store.flushDrafts()
      return send
    },
    [pendingSend, store, workspaceId, agentId, key, initial, update, flushDraft],
  )
  /**
   * The command id a send of `message` goes under: a send given back keeps
   * its own for the same words, so Studio answers a copy that landed late
   * from its receipt instead of running it again. Otherwise a new one.
   */
  const commandIdFor = useCallback(
    (message: string): string => {
      const given = store.getState().readSend(workspaceId, agentId)
      if (given?.restored && given.text === message.trim()) return given.commandId
      return crypto.randomUUID()
    },
    [store, workspaceId, agentId],
  )
  const clearDraft = useCallback(() => {
    pending.current.delete(key)
    update(empty())
    flushDraft()
  }, [key, update, flushDraft])
  return {
    draft: current.text,
    setDraft,
    draftMetadata: { skillIds: current.skillIds, mentions: current.mentions, files: current.files },
    setDraftMetadata,
    flushDraft,
    persistenceError,
    beginDraftSend,
    finishDraftSend,
    clearDraft,
    pendingSend,
    settlePendingSend,
    commandIdFor,
  }
}
