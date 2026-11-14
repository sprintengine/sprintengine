import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react'
import { composerDraftStore, MAX_DRAFT_CHARS, type ComposerDraft } from './draftStore'
import { clipKeepingQuotes } from '../../../../../shared/chat-quotes'

type DraftValue = Omit<ComposerDraft, 'updatedAt'>
export type ComposerDraftMetadata = Pick<DraftValue, 'skillIds' | 'mentions' | 'files'>
const empty = (): DraftValue => ({ text: '', skillIds: [], mentions: [], files: [] })
const isEmpty = (value: DraftValue) =>
  !value.text && !value.skillIds.length && !value.mentions.length && !value.files.length

/**
 * A send clears the draft, on screen and in storage, before it leaves; a send
 * that fails puts it back. Nothing of a sent draft is left in storage for a
 * reload to bring back beside the message the chat already has.
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
  // The draft each send took, held in memory only, to put back if it fails.
  const pending = useRef(new Map<string, { token: symbol; snapshot: DraftValue }>())
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
    (message: string): symbol | null => {
      const snapshot = values.current.get(key) ?? initial
      // A queued message is not the user's newer draft.
      if (snapshot.text.trim() !== message.trim()) return null
      const token = Symbol('draft-send')
      pending.current.set(key, { token, snapshot })
      update(empty())
      // Cleared in storage now, not after the store's write delay: a reload
      // once the send has left must not find the draft there.
      flushDraft()
      store.flushDrafts()
      return token
    },
    [key, initial, update, flushDraft, store],
  )
  const finishDraftSend = useCallback(
    (token: symbol | null, succeeded: boolean) => {
      const attempt = pending.current.get(key)
      if (!token || attempt?.token !== token) return
      pending.current.delete(key)
      const active = activeKeys.current.has(key)
      if (succeeded) {
        if (active) flushDraft()
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
      if (!isEmpty(values.current.get(key) ?? empty())) return
      update(attempt.snapshot)
      flushDraft()
      store.flushDrafts()
    },
    [key, update, flushDraft, store, workspaceId, agentId],
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
  }
}
