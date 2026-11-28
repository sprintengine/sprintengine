import type { MeshConversationSearchResult } from '../../../../shared/tailnet-mesh'
import { bestConversationHit } from './conversationSnippet'
import type { PaletteCommand, PaletteResultProvider, PaletteRowMark } from './paletteProvider'

export const CONVERSATION_SEARCH_MIN_QUERY = 2
const CONVERSATION_SEARCH_DEBOUNCE_MS = 250

/** A matching message, as an environment's search answers it. */
export type ConversationSearchMatch = { agentId: string; seq: number }

/** A chat an environment's search found, as the palette draws and opens it. */
export type ChatSearchRow = {
  /** Its switch row's id, so a match folds into the chat's own row when that matched too. */
  id: string
  mark: PaletteRowMark
  /** Open the chat at the matching message. */
  open: (match: ConversationSearchMatch) => void
}

/**
 * One environment whose chats the palette searches: this computer's own, a
 * paired desktop's, an SSH machine's or a WSL distribution's. Each answers
 * its own `conversation.searchChats`.
 */
export type ChatSearchPlace = {
  /** What a row of another environment wears beside its title; null for this computer's. */
  badge: string | null
  search: (query: string) => Promise<MeshConversationSearchResult>
  /** How one of its chats is drawn and opened; null for a chat the palette does not list (a hidden one). */
  rowOf: (chat: { workspaceId: string; chatTitle: string }) => ChatSearchRow | null
}

/**
 * What was said in every environment's chats, one row per chat
 * (design-environments PR 3).
 *
 * Each environment is asked once for the question, through its own Studio,
 * as its own palette would ask it: this computer first, then the others in
 * the order the window follows them. Its chats are rows as soon as it
 * answers, each wearing the message that matched (the person's own words
 * first, then the newest) and how many others did. An environment that cannot
 * answer costs its own rows, not the others'; when none answers, the palette
 * says why.
 */
export function createConversationHistoryProvider(options: {
  getPlaces: () => readonly ChatSearchPlace[]
}): PaletteResultProvider {
  let generation = 0
  return {
    id: 'conversation-history',
    group: 'agents',
    debounceMs: CONVERSATION_SEARCH_DEBOUNCE_MS,
    minQueryLength: CONVERSATION_SEARCH_MIN_QUERY,
    cancel: () => {
      generation++
    },
    async load(query, context, publish) {
      const epoch = ++generation
      const rows: PaletteCommand[] = []
      let failure: string | null = null
      let answered = false
      for (const place of options.getPlaces()) {
        const found = await place.search(query).catch((error: unknown): MeshConversationSearchResult => ({
          ok: false,
          code: 'failed',
          message: String(error),
        }))
        if (epoch !== generation) return []
        if (!found.ok) {
          failure ??= found.message
          continue
        }
        answered = true
        for (const chat of found.chats) {
          const best = bestConversationHit(chat.hits)
          const row = best ? place.rowOf(chat) : null
          if (!best || !row) continue
          rows.push({
            id: row.id,
            label: chat.chatTitle,
            keywords: best.snippet,
            group: 'agents',
            mark: row.mark,
            ...(place.badge ? { badge: place.badge } : {}),
            conversationMatch: { snippet: best.snippet, ...(best.from ? { from: best.from } : {}), count: chat.count },
            run: () => {
              context.close()
              row.open({ agentId: best.agentId, seq: best.seq })
            },
          })
        }
        publish?.([...rows])
      }
      if (!answered && failure) throw new Error(failure)
      return rows
    },
  }
}
