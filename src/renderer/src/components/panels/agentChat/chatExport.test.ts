// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'

import type { ChatExportInput, ChatExportSource } from '../../../../../shared/chat-export'
import { useToastStore } from '../../../store/toastStore'
import { exportChatOrToast, readStudioChatExport } from './chatExport'

// A chat is exported from what its Studio reads of it, page by page
// (`conversation.exportPage`), handed to this shell to write. A chat followed
// over a paired machine's lane is read from that machine by its view instead.
// A read that fails is said as any failed export is.

const studio = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('../../../studio/windowStudioClient', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  windowStudioClient: async () => studio.client,
}))

const chat = {
  title: 'Parser review',
  project: 'parser',
  providerId: 'claude-agent',
  modelId: 'default',
  workspaceRoot: '/Users/dev/parser',
}
const source: ChatExportSource = { ...chat, events: [], attachments: {} }
const event = (seq: number) =>
  ({
    id: `e${seq}`,
    seq,
    type: 'user_message',
    sessionId: 's1',
    workspaceId: 'w1',
    agentId: 'agent-1',
    providerId: 'claude-agent',
    modelId: 'default',
    createdAt: seq,
    payload: { text: `Message ${seq}` },
  }) as ChatExportSource['events'][number]

/** A Studio whose export comes in the pages given, recording what it was asked. */
function fakeStudio(
  pages: Array<{ events: number[]; attachments?: string[]; nextOffset: number | null }>,
  serves = true,
) {
  const asked: Array<{ key: unknown; exportId: string; offset: number }> = []
  const client = {
    supports: (capability: string) => serves && capability === 'conversation-export',
    request: async (method: string, params: { key: unknown; exportId: string; offset: number }) => {
      expect(method).toBe('conversation.exportPage')
      asked.push(params)
      const page = pages[asked.length - 1]!
      return {
        chat,
        events: page.events.map(event),
        attachments: Object.fromEntries(
          (page.attachments ?? []).map((ref) => [ref, { mediaType: 'image/png', dataBase64: 'AA==' }]),
        ),
        nextOffset: page.nextOffset,
      }
    },
  }
  return { client, asked }
}

afterEach(() => {
  useToastStore.setState({ toasts: [] })
  studio.client = null
})

test('a chat is read from its Studio page by page under one export id, then handed to the shell', async () => {
  const { client, asked } = fakeStudio([
    { events: [1, 2], nextOffset: 2 },
    { events: [3], attachments: ['attachments/a.png'], nextOffset: null },
  ])
  studio.client = client
  const saved: ChatExportInput[] = []
  ;(window as unknown as { api: unknown }).api = {
    saveChatExport: async (input: ChatExportInput) => {
      saved.push(input)
      return { ok: true, kind: 'copied' }
    },
  }
  await exportChatOrToast({ workspaceId: 'w1', agentId: 'agent-1', action: 'copy' })
  expect(asked.map(({ offset }) => offset)).toEqual([0, 2])
  expect(new Set(asked.map(({ exportId }) => exportId)).size).toBe(1)
  expect(asked[0]!.key).toEqual({ workspaceId: 'w1', agentId: 'agent-1' })
  expect(saved).toHaveLength(1)
  expect(saved[0]!.action).toBe('copy')
  expect(saved[0]!.source).toMatchObject(chat)
  expect(saved[0]!.source.events.map(({ seq }) => seq)).toEqual([1, 2, 3])
  expect(Object.keys(saved[0]!.source.attachments)).toEqual(['attachments/a.png'])
  expect(useToastStore.getState().toasts.some((toast) => toast.title === 'Chat copied')).toBe(true)
})

test('a Studio from before exports were read over the protocol is not asked, and the person is told', async () => {
  const { client, asked } = fakeStudio([], false)
  await expect(readStudioChatExport(client as never, { workspaceId: 'w1', agentId: 'agent-1' })).rejects.toThrow(
    'older than this window',
  )
  expect(asked).toEqual([])
})

test('a Studio whose pages go nowhere is stopped, not asked forever', async () => {
  const { client } = fakeStudio([
    { events: [1], nextOffset: 1 },
    { events: [], nextOffset: 1 },
  ])
  await expect(readStudioChatExport(client as never, { workspaceId: 'w1', agentId: 'agent-1' })).rejects.toThrow(
    'could not be read',
  )
})

test('a paired machine’s chat goes to the shell with what was read from there', async () => {
  const saved: ChatExportInput[] = []
  ;(window as unknown as { api: unknown }).api = {
    saveChatExport: async (input: ChatExportInput) => {
      saved.push(input)
      return { ok: true, kind: 'copied' }
    },
  }
  const read = vi.fn(async () => source)
  await exportChatOrToast({ workspaceId: 'w-followed', agentId: 'agent-there', action: 'copy', remote: read })
  expect(read).toHaveBeenCalledOnce()
  expect(saved).toEqual([{ action: 'copy', source }])
  expect(useToastStore.getState().toasts.some((toast) => toast.title === 'Chat copied')).toBe(true)
})

test('a transcript that could not be read from there is said, and the shell is not asked', async () => {
  const saveChatExport = vi.fn()
  ;(window as unknown as { api: unknown }).api = { saveChatExport }
  await exportChatOrToast({
    workspaceId: 'w-followed',
    agentId: 'agent-there',
    action: 'pdf',
    remote: async () => {
      throw new Error('mac-mini is offline.')
    },
  })
  expect(saveChatExport).not.toHaveBeenCalled()
  expect(useToastStore.getState().toasts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ title: 'Could not export the chat', description: 'mac-mini is offline.' }),
    ]),
  )
})
