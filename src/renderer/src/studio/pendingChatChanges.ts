import { useSyncExternalStore } from 'react'

import type {
  MeshChangeConversationResult,
  MeshConversationChange,
  MeshSettleConversationResult,
} from '../../../shared/tailnet-mesh'
import type { RemoteChatPending, RemoteConversation } from '../components/workspace/remoteBand/remoteSessionsModel'
import { changeEnvironmentChat, settleEnvironmentChat, type ChatRestAsked } from './environmentChatRecords'
import { followedEnvironmentChats, onFollowedEnvironmentChats } from './environmentChats'
import type { EnvironmentTarget } from './environmentStudio'

// A change asked of a chat's Studio, drawn on its row at once.
//
// A chat's row is its environment's list (`environmentChats.ts`), on this
// computer as on any other machine, and that list says a change only once it
// has been read again after the Studio took it. Meanwhile the row wears what
// was asked, so a Settle, a Star or a Snooze does not flick back for a moment.
// It is held here, by the chat (its route and its id there), for every caller
// of every kind of chat: the store's own gestures on this computer's chats and
// the sidebar's on another machine's. It goes when a list asked after the
// Studio took the change comes back, which then says it (or what anyone did
// since), or at once when the Studio refuses it, which puts the row back as
// its list has it.

/** A change asked of a chat and not yet read back off its environment's list. */
export type PendingChatChange = {
  route: string
  chatId: string
  /** What the row wears meanwhile: every change asked of the chat since its list last said them. */
  facts: RemoteChatPending
  /** When the Studio took the newest of them; null while it has not answered. */
  takenAt: number | null
}

const held = new Map<string, PendingChatChange>()
// Which ask holds each chat's entry: an answer to an older one is not the
// newest change's, and leaves the entry alone.
const holders = new Map<string, number>()
let asks = 0
let drawn: ReadonlyMap<string, PendingChatChange> = new Map()
const listeners = new Set<() => void>()
let unfollow: (() => void) | null = null

/** A chat's key here: its route and its id there. */
export function pendingChatKey(route: string, chatId: string): string {
  return `${route}\u0000${chatId}`
}

function publish(): void {
  drawn = new Map(held)
  for (const listener of listeners) listener()
  if (held.size > 0 && !unfollow) unfollow = onFollowedEnvironmentChats(releaseRead)
  else if (held.size === 0 && unfollow) {
    unfollow()
    unfollow = null
  }
}

/**
 * Whether a list asked once the Studio had taken the change has come back, so
 * the list says it now. The Studio wrote the change before it answered, so a
 * list asked from the moment the answer came (the same millisecond included)
 * was read after the write.
 */
export function pendingChatChangeRead(change: PendingChatChange, listAskedAt: number | null | undefined): boolean {
  return change.takenAt !== null && typeof listAskedAt === 'number' && listAskedAt >= change.takenAt
}

/** Let go of each change its environment's list says now, and of those on an environment no longer followed. */
function releaseRead(): void {
  const asked = new Map(followedEnvironmentChats().map((source) => [source.route, source.snapshot().rows.listAskedAt]))
  let released = false
  for (const [key, change] of held) {
    if (asked.has(change.route) && !pendingChatChangeRead(change, asked.get(change.route))) continue
    held.delete(key)
    holders.delete(key)
    released = true
  }
  if (released) publish()
}

/**
 * Ask a change of a chat's Studio, its row wearing `facts` until its list
 * says them. `ask` is the call; its answer is handed back as it came.
 */
async function askHeld<T extends { ok: boolean }>(
  target: EnvironmentTarget,
  chatId: string,
  facts: RemoteChatPending | undefined,
  ask: () => Promise<T>,
): Promise<T> {
  if (!facts) return ask()
  const key = pendingChatKey(target.route, chatId)
  const mine = ++asks
  holders.set(key, mine)
  held.set(key, { route: target.route, chatId, facts: { ...held.get(key)?.facts, ...facts }, takenAt: null })
  publish()
  const answered = (taken: boolean) => {
    const change = held.get(key)
    if (!change || holders.get(key) !== mine) return
    if (taken) held.set(key, { ...change, takenAt: Date.now() })
    else {
      held.delete(key)
      holders.delete(key)
    }
    publish()
    // Read again, so the list that says the change is what replaces it.
    if (taken)
      followedEnvironmentChats()
        .find((source) => source.route === target.route)
        ?.refresh()
  }
  try {
    const answer = await ask()
    answered(answer.ok)
    return answer
  } catch (error) {
    answered(false)
    throw error
  }
}

/** A row menu or management change to a chat (`changeEnvironmentChat`), its row wearing `facts` until its list says them. */
export function askChatChange(
  target: EnvironmentTarget,
  chatId: string,
  change: MeshConversationChange,
  facts?: RemoteChatPending,
): Promise<MeshChangeConversationResult> {
  return askHeld(target, chatId, facts, () => changeEnvironmentChat(target, chatId, change))
}

/** Settle a chat, or bring it back (`settleEnvironmentChat`), its row wearing `facts` until its list says them. */
export function askChatRest(
  target: EnvironmentTarget,
  chatId: string,
  settled: boolean,
  asked: ChatRestAsked | undefined,
  facts?: RemoteChatPending,
): Promise<MeshSettleConversationResult> {
  return askHeld(target, chatId, facts, () => settleEnvironmentChat(target, chatId, settled, asked))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The changes asked and not yet read back, by `pendingChatKey`. */
export function pendingChatChanges(): ReadonlyMap<string, PendingChatChange> {
  return drawn
}

/** `pendingChatChanges`, kept current. */
export function usePendingChatChanges(): ReadonlyMap<string, PendingChatChange> {
  return useSyncExternalStore(subscribe, pendingChatChanges)
}

/** Each row, wearing the changes asked of its chat that its list does not say yet. */
export function withPendingChatChanges(
  rows: readonly RemoteConversation[],
  pending: ReadonlyMap<string, PendingChatChange>,
): readonly RemoteConversation[] {
  if (pending.size === 0) return rows
  return rows.map((row) => {
    const asked = pending.get(pendingChatKey(row.route, row.workspaceId))?.facts
    if (!asked) return row
    const { autoCompactOn, ...facts } = asked
    return {
      ...row,
      ...facts,
      ...(autoCompactOn !== undefined && row.autoCompact
        ? { autoCompact: { ...row.autoCompact, on: autoCompactOn } }
        : {}),
    }
  })
}

/** Forget every change held (tests). */
export function resetPendingChatChanges(): void {
  held.clear()
  holders.clear()
  publish()
}
