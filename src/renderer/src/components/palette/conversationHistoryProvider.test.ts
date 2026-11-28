import { afterEach, expect, test, vi } from 'vitest'

import type { MeshConversationSearchResult } from '../../../../shared/tailnet-mesh'
import { createConversationHistoryProvider, type ChatSearchPlace } from './conversationHistoryProvider'

// One provider finds what was said in every environment's chats: each is
// asked once, through its own Studio, and its chats are one row each.

afterEach(() => vi.clearAllMocks())

const context = { workspaceRoot: null, workspaceId: null, scope: 'conversations' as const, close: vi.fn() }

const answer = (...chats: Array<[string, string, number]>): MeshConversationSearchResult => ({
  ok: true,
  truncated: false,
  chats: chats.map(([workspaceId, chatTitle, count]) => ({
    workspaceId,
    chatTitle,
    count,
    hits: [
      { agentId: 'agent-1', seq: 9, snippet: `agent said in ${chatTitle}`, from: 'agent' as const },
      { agentId: 'agent-1', seq: 4, snippet: `you said in ${chatTitle}`, from: 'person' as const },
    ],
  })),
})

function place(badge: string | null, search: ChatSearchPlace['search'], opened: string[] = []): ChatSearchPlace {
  return {
    badge,
    search,
    rowOf: (chat) =>
      chat.workspaceId === 'hidden'
        ? null
        : {
            id: `switch-${badge ?? 'here'}:${chat.workspaceId}`,
            mark: { kind: 'chat', workspaceId: chat.workspaceId, mode: 'standard' },
            open: (match) => void opened.push(`${badge ?? 'here'}:${chat.workspaceId}@${match.agentId}/${match.seq}`),
          },
  }
}

test('two environments answer and one fails: the answers are rows, and the failure costs only its own', async () => {
  const opened: string[] = []
  const asked: string[] = []
  const places = [
    place(
      null,
      async (query) => (asked.push(`here ${query}`), answer(['ws1', 'Parser', 3], ['hidden', 'Kept off', 1])),
      opened,
    ),
    place(
      'mac-mini',
      async (query) => (
        asked.push(`mini ${query}`),
        { ok: false, code: 'unavailable', message: 'mac-mini is not connected.' }
      ),
    ),
    place('build-box', async (query) => (asked.push(`box ${query}`), answer(['rw1', 'Lexer', 5])), opened),
  ]
  const provider = createConversationHistoryProvider({ getPlaces: () => places })
  const published: number[] = []
  const rows = await provider.load('parser', context, (next) => void published.push(next.length))
  expect(asked).toEqual(['here parser', 'mini parser', 'box parser'])
  // Each environment's rows are published as it answers.
  expect(published).toEqual([1, 2])
  expect(rows.map((row) => [row.id, row.label, row.badge])).toEqual([
    ['switch-here:ws1', 'Parser', undefined],
    ['switch-build-box:rw1', 'Lexer', 'build-box'],
  ])
  expect(rows[1]).toMatchObject({ conversationMatch: { snippet: 'you said in Lexer', from: 'person', count: 5 } })
  rows[1]!.run()
  expect(context.close).toHaveBeenCalled()
  expect(opened).toEqual(['build-box:rw1@agent-1/4'])
})

test('no environment able to answer is said as the palette says a failed search', async () => {
  const provider = createConversationHistoryProvider({
    getPlaces: () => [
      place(null, async () => {
        throw new Error('The Studio is not answering.')
      }),
      place('mac-mini', async () => ({ ok: false, code: 'unavailable', message: 'mac-mini is not connected.' })),
    ],
  })
  await expect(provider.load('parser', context, undefined)).rejects.toThrow('The Studio is not answering.')
  const none = createConversationHistoryProvider({ getPlaces: () => [] })
  expect(await none.load('parser', context, undefined)).toEqual([])
})

test('a superseded search asks no further environment and returns nothing', async () => {
  let release: () => void = () => {}
  const second = vi.fn(async () => answer(['rw1', 'Lexer', 1]))
  const provider = createConversationHistoryProvider({
    getPlaces: () => [
      place(null, () => new Promise((done) => (release = () => done(answer(['ws1', 'Parser', 1]))))),
      place('build-box', second),
    ],
  })
  const first = provider.load('parser', context, undefined)
  provider.cancel?.()
  release()
  expect(await first).toEqual([])
  expect(second).not.toHaveBeenCalled()
})

test('it waits for a second character and for a pause in typing', () => {
  const provider = createConversationHistoryProvider({ getPlaces: () => [] })
  expect(provider.minQueryLength).toBe(2)
  expect(provider.debounceMs).toBeGreaterThan(0)
})
