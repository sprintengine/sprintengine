import { isRecord } from '../../shared/records'
import type { PullRequestConversationKey } from './pull-request-record'
import type { PullRequestWake } from './pull-request-watch'

// News a watch found that its chat has not been told yet: the outbox of the
// pull-request wakes (`pull-request-wakes.ts`).
//
// It is stored on the pull request's row of the record, in the same write as
// the watch state that says the news was seen, so a restart can neither lose
// news the watch has moved past nor find it twice. A message is taken from it
// under a command id, and that id is stamped on what the message carries
// before it is sent: the chat's receipt for the id makes a send repeated
// after a restart a no-op, and the news leaves once the chat has answered.

/** One pull request's news for one chat, and the command id of the message carrying it, once one does. */
export type PullRequestUntoldWake = {
  conversation: PullRequestConversationKey
  wake: PullRequestWake
  commandId?: string
}

/** A message for a chat: everything it carries, under the id it goes by. */
export type PullRequestWakeMessage = { commandId: string; wakes: PullRequestWake[] }

const sameChat = (a: PullRequestConversationKey, b: PullRequestConversationKey) =>
  a.workspaceId === b.workspaceId && a.agentId === b.agentId

export type PullRequestUntoldWakes = {
  /** News for a chat: folded into what it has not been told about that pull request, unless a message already carries that. */
  add(conversation: PullRequestConversationKey, wake: PullRequestWake): void
  /** Chats with news to be told. */
  chats(): PullRequestConversationKey[]
  /**
   * The chat's next message: the one a send already went out under, as it
   * was, or else everything it has not been told, now stamped with `newId()`.
   * Null when there is nothing. `stamped` says the store changed.
   */
  next(
    conversation: PullRequestConversationKey,
    newId: () => string,
  ): (PullRequestWakeMessage & { stamped: boolean }) | null
  /** The chat answered the message sent under `commandId`: what it carried leaves. Whether anything did. */
  told(conversation: PullRequestConversationKey, commandId: string): boolean
  /** The chat is gone: its news goes with it. Whether there was any. */
  forget(conversation: PullRequestConversationKey): boolean
  /** One pull request's untold news, as its row stores it. */
  of(url: string): PullRequestUntoldWake[]
  /** A row's untold news, read back. */
  load(url: string, stored: unknown): void
  /** A pull request that left the record: its news goes with it. */
  drop(url: string): void
}

export function createPullRequestUntoldWakes(): PullRequestUntoldWakes {
  // By pull request, in the order each first had news; within one, oldest first.
  const byUrl = new Map<string, PullRequestUntoldWake[]>()

  const all = () => [...byUrl.values()].flat()

  return {
    add(conversation, wake) {
      const list = byUrl.get(wake.url) ?? []
      const open = list.findLast((item) => !item.commandId && sameChat(item.conversation, conversation))
      // Several reads' news for one pull request: in order, under what the
      // latest read says about it now.
      if (open) open.wake = { ...wake, news: [...open.wake.news, ...wake.news] }
      else list.push({ conversation: { ...conversation }, wake })
      byUrl.set(wake.url, list)
    },
    chats() {
      const chats: PullRequestConversationKey[] = []
      for (const item of all())
        if (!chats.some((known) => sameChat(known, item.conversation))) chats.push(item.conversation)
      return chats
    },
    next(conversation, newId) {
      const theirs = all().filter((item) => sameChat(item.conversation, conversation))
      if (theirs.length === 0) return null
      const sent = theirs.find((item) => item.commandId)?.commandId
      if (sent)
        return {
          commandId: sent,
          wakes: theirs.filter((item) => item.commandId === sent).map((item) => item.wake),
          stamped: false,
        }
      const commandId = newId()
      for (const item of theirs) item.commandId = commandId
      return { commandId, wakes: theirs.map((item) => item.wake), stamped: true }
    },
    told(conversation, commandId) {
      let changed = false
      for (const [url, list] of byUrl) {
        const kept = list.filter((item) => !(item.commandId === commandId && sameChat(item.conversation, conversation)))
        if (kept.length === list.length) continue
        changed = true
        if (kept.length > 0) byUrl.set(url, kept)
        else byUrl.delete(url)
      }
      return changed
    },
    forget(conversation) {
      let changed = false
      for (const [url, list] of byUrl) {
        const kept = list.filter((item) => !sameChat(item.conversation, conversation))
        if (kept.length === list.length) continue
        changed = true
        if (kept.length > 0) byUrl.set(url, kept)
        else byUrl.delete(url)
      }
      return changed
    },
    of(url) {
      return byUrl.get(url) ?? []
    },
    load(url, stored) {
      if (!Array.isArray(stored)) return
      const list = stored.flatMap((item): PullRequestUntoldWake[] => {
        const parsed = parseUntold(item, url)
        return parsed ? [parsed] : []
      })
      if (list.length > 0) byUrl.set(url, list)
    },
    drop(url) {
      byUrl.delete(url)
    },
  }
}

/** One stored piece of untold news; null when it is not one this build wrote for `url`. */
function parseUntold(value: unknown, url: string): PullRequestUntoldWake | null {
  if (!isRecord(value) || !isRecord(value.conversation) || !isRecord(value.wake)) return null
  const { workspaceId, agentId } = value.conversation
  if (typeof workspaceId !== 'string' || !workspaceId || typeof agentId !== 'string' || !agentId) return null
  const wake = value.wake
  if (
    wake.url !== url ||
    typeof wake.number !== 'number' ||
    typeof wake.repo !== 'string' ||
    !Array.isArray(wake.news) ||
    !wake.news.every((news) => isRecord(news) && typeof news.kind === 'string')
  )
    return null
  if (value.commandId !== undefined && typeof value.commandId !== 'string') return null
  return {
    conversation: { workspaceId, agentId },
    // Written by this build from a wake it made; the fields it reads past are its own.
    wake: wake as unknown as PullRequestWake,
    ...(typeof value.commandId === 'string' ? { commandId: value.commandId } : {}),
  }
}
