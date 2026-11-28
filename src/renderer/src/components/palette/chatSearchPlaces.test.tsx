// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'

import { STUDIO_CHAT_ROWS_CAPABILITY } from '../../../../../packages/studio-protocol/src/public'
import { followEnvironmentChats, followedEnvironmentChats } from '../../studio/environmentChats'
import { fakePairedStudios, PAIRED_STUDIO_CAPABILITIES } from '../../studio/environmentStudio.double'
import { clearConversationJump, usePendingConversationJump } from '../../utils/conversationHistoryNavigation'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { chatSearchPlaces } from './chatSearchPlaces'
import { createConversationHistoryProvider } from './conversationHistoryProvider'
import type { RemoteSessionOpenSpec } from '../workspace/remoteBand/remoteSessionsModel'

// The palette asks a followed environment's own Studio what was said in its
// chats, and a match opens the chat as its row does, at the message.

const context = { workspaceRoot: null, workspaceId: null, scope: 'all' as const, close: vi.fn() }

afterEach(() => {
  followEnvironmentChats([])
  clearConversationJump('w-here', 'agent-2')
})

test("a followed environment's chats are searched through its Studio, and a match opens at its message", async () => {
  const api = {}
  ;(window as unknown as { api: unknown }).api = api
  const studio = fakePairedStudios(
    api,
    {
      'workspaces.list': () => ({
        workspaces: [
          {
            id: 'rw1',
            name: 'Parser review',
            mode: 'standard',
            folderPath: '/Users/air/app',
            createdAt: 1,
            recencyAt: 1,
          },
        ],
      }),
      'conversation.list': () => ({
        conversations: [
          {
            workspaceId: 'rw1',
            agentId: 'agent-1',
            title: 'Ada',
            chatTitle: 'Parser review',
            phase: 'idle',
            updatedAt: 1,
            createdAt: 1,
            providerId: 'claude-agent',
            modelId: 'opus',
            turnCount: 1,
            lastSeq: 1,
          },
        ],
      }),
      'conversation.searchChats': () => ({
        chats: [
          {
            workspaceId: 'rw1',
            chatTitle: 'Parser review',
            hits: [{ agentId: 'agent-2', seq: 7, snippet: 'you said parser', from: 'person' }],
            count: 1,
          },
        ],
        truncated: false,
      }),
    },
    { capabilities: [...PAIRED_STUDIO_CAPABILITIES, STUDIO_CHAT_ROWS_CAPABILITY] },
  )
  followEnvironmentChats([{ route: 'tailnet:c1', name: 'mac-mini' }])
  await vi.waitFor(() => expect(followedEnvironmentChats()[0]?.snapshot().rows.conversations?.length).toBe(1))
  await vi.waitFor(() => expect(followedEnvironmentChats()[0]?.snapshot().rows.chatRecord).toBeTruthy())

  const opened: RemoteSessionOpenSpec[] = []
  const places = chatSearchPlaces({
    chats: () => new Map(),
    records: () => [],
    openEnvironmentChat: (spec) => (opened.push(spec), 'w-here'),
  })
  // This computer's Studio is asked first; the paired desktop after it.
  expect(places.map((place) => place.badge)).toEqual([null, 'mac-mini'])

  const provider = createConversationHistoryProvider({ getPlaces: () => places.slice(1) })
  const rows = await provider.load('parser', context, undefined)
  expect(studio.calls.filter((call) => call.method === 'conversation.searchChats').map((call) => call.params)).toEqual([
    { query: 'parser' },
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ label: 'Parser review', badge: 'mac-mini', mark: { kind: 'chat' } })

  rows[0]!.run()
  // Opened as its row opens it, on the agent the match is in, which its list did not name.
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ route: 'tailnet:c1', connectionId: 'c1', chatId: 'rw1' })
  expect(opened[0]!.agent?.agentId).toBe('agent-2')
  // The chat view here reads the jump as it reads a match in this computer's chats.
  let pending: number | null = null
  function Probe() {
    pending = usePendingConversationJump('w-here', 'agent-2')
    return null
  }
  const root = createRoot(document.createElement('div'))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await act(async () => root.render(React.createElement(Probe)))
  expect(pending).toBe(7)
  await act(async () => root.unmount())
})
