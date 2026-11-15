import { afterEach, expect, test, vi } from 'vitest'
import type { ConversationSearchHit } from '../../../../shared/conversation-index'
import { createConversationHistoryProvider, type SearchableChat } from './conversationHistoryProvider'
import { openConversationMatch } from '../../utils/conversationHistoryNavigation'
import { installStudioLoopback } from '../../../../../tests/studio-chat-loopback'

vi.mock('../../utils/conversationHistoryNavigation', () => ({ openConversationMatch: vi.fn(async () => true) }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const chat = (id: string, root = '/Users/dev/app'): SearchableChat => ({
  workspaceId: id,
  workspaceRoot: root,
  name: `Chat ${id}`,
  mode: 'standard' as SearchableChat['mode'],
})
const context = { workspaceRoot: '/Users/dev/app', workspaceId: 'one', scope: 'conversations' as const, close: vi.fn() }
const hit = (seq: number, snippet: string, from: ConversationSearchHit['from'] = 'agent'): ConversationSearchHit => ({
  agentId: 'agent',
  seq,
  snippet,
  from,
})

test('every chat the sidebar lists is searched, and a chat is one row however many of its messages match', async () => {
  const search = vi.fn(async ({ workspaceId }: { workspaceId: string; workspaceRoot: string }) => ({
    ok: true as const,
    hits:
      workspaceId === 'one'
        ? [hit(3, 'the wave model'), hit(9, 'is the wave model right?', 'person'), hit(12, 'wave again')]
        : workspaceId === 'two'
          ? [hit(5, 'a wave forecast')]
          : [],
  }))
  vi.stubGlobal('window', { api: { conversationSearch: search, conversationCancelSearch: vi.fn(async () => {}) } })
  installStudioLoopback(globalThis.window as never)
  const rows = await createConversationHistoryProvider({
    getChats: () => [chat('one'), chat('two', '/Users/dev/other'), chat('three')],
  }).load('wave', context)

  expect(search.mock.calls.map(([input]) => [input.workspaceId, input.workspaceRoot])).toEqual([
    ['one', '/Users/dev/app'],
    ['two', '/Users/dev/other'],
    ['three', '/Users/dev/app'],
  ])
  expect(rows.map((row) => row.id)).toEqual(['switch-one', 'switch-two'])
  // The person's own words outrank the agent's, then the newest.
  expect(rows[0].conversationMatch).toEqual({ snippet: 'is the wave model right?', from: 'person', count: 3 })
  expect(rows[0].mark).toEqual({ kind: 'chat', workspaceId: 'one', mode: 'standard' })

  rows[0].run()
  expect(context.close).toHaveBeenCalledOnce()
  expect(openConversationMatch).toHaveBeenCalledWith({
    workspaceRoot: '/Users/dev/app',
    workspaceId: 'one',
    agentId: 'agent',
    seq: 9,
  })
})

test('a chat whose history cannot be read costs its own matches, not the others', async () => {
  vi.stubGlobal('window', {
    api: {
      conversationSearch: async ({ workspaceId }: { workspaceId: string }) =>
        workspaceId === 'broken'
          ? { ok: false as const, message: 'Conversation storage must be a real directory.' }
          : { ok: true as const, hits: [hit(1, 'wave')] },
      conversationCancelSearch: vi.fn(async () => {}),
    },
  })
  installStudioLoopback(globalThis.window as never)
  const rows = await createConversationHistoryProvider({ getChats: () => [chat('broken'), chat('fine')] }).load(
    'wave',
    context,
  )
  expect(rows.map((row) => row.id)).toEqual(['switch-fine'])

  // Every chat failing is a failure, not "no matches".
  await expect(
    createConversationHistoryProvider({ getChats: () => [chat('broken')] }).load('wave', context),
  ).rejects.toThrow('real directory')
})

test('superseding a search cancels the chat in flight and searches no further', async () => {
  let resolve!: (value: unknown) => void
  let signal: AbortSignal | undefined
  const search = vi.fn(
    (_input: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((done) => {
        signal = options?.signal
        resolve = done
      }),
  )
  vi.stubGlobal('window', { api: { conversationSearch: search } })
  installStudioLoopback(globalThis.window as never)
  const provider = createConversationHistoryProvider({ getChats: () => [chat('one'), chat('two')] })
  const pending = provider.load('wave', context)
  await vi.waitFor(() => expect(resolve).toBeDefined())
  provider.cancel?.()
  // The Studio calls off the search it is running for this window.
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  resolve({ ok: true, hits: [hit(1, 'wave')] })
  expect(await pending).toEqual([])
  expect(search).toHaveBeenCalledOnce()
})

test('each chat’s rows are published as that chat is answered, before the next is read', async () => {
  const publish = vi.fn()
  const search = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
    // The first chat's row is up while the second is read.
    if (workspaceId === 'two') expect(publish).toHaveBeenCalledTimes(1)
    return { ok: true as const, hits: [hit(2, `${workspaceId} wave`)] }
  })
  vi.stubGlobal('window', { api: { conversationSearch: search } })
  installStudioLoopback(globalThis.window as never)
  const rows = await createConversationHistoryProvider({ getChats: () => [chat('one'), chat('two')] }).load(
    'wave',
    context,
    publish,
  )
  expect(rows).toHaveLength(2)
  expect(publish).toHaveBeenCalledTimes(2)
})

test('it waits for a second character and for a pause in typing', () => {
  const provider = createConversationHistoryProvider({ getChats: () => [] })
  expect(provider.minQueryLength).toBe(2)
  expect(provider.respondsToEmptyQuery).toBeFalsy()
  expect(provider.debounceMs).toBeGreaterThan(0)
})
