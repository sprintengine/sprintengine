import assert from 'node:assert/strict'

import { test } from 'vitest'

import { CHAT_EXPORT_CHANNEL, type ChatExportInput } from '../../shared/chat-export'
import { registerChatExportIpc } from './chat-export-ipc'

// The export channel is the shell's half: it takes the chat as the window's
// Studio read it and a format, checks both, and passes on nothing else. No
// path or text a window sends reaches the export, and every event is checked
// as one off the wire.

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function setup(options: { foreign?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const runs: ChatExportInput[] = []
  registerChatExportIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never, {
    run: async (input) => {
      runs.push(input)
      return { ok: true, kind: 'copied' }
    },
    assertSender: () => {
      if (options.foreign) throw new Error('This request did not come from a SprintEngine Studio window.')
    },
  })
  const handler = handlers.get(CHAT_EXPORT_CHANNEL)
  assert.ok(handler, 'the channel is registered')
  return { invoke: (payload: unknown) => handler({ sender: {} }, payload), runs }
}

const source = {
  events: [
    {
      id: 'e1',
      seq: 1,
      type: 'user_message',
      sessionId: 's1',
      workspaceId: 'w1',
      agentId: 'agent-1',
      providerId: 'claude-agent',
      modelId: 'default',
      createdAt: 1,
      payload: { text: 'Hello' },
    },
  ],
  attachments: { 'attachments/a.png': { mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' } },
  title: 'Parser review',
  project: 'parser',
  providerId: 'claude-agent',
  modelId: null,
  workspaceRoot: '/Users/dev/parser',
}

test('the channel is the shell’s save, not a read: `chat-export:save`', () => {
  assert.equal(CHAT_EXPORT_CHANNEL, 'chat-export:save')
})

test('a chat as read and a format pass, and only they do', async () => {
  const { invoke, runs } = setup()
  const result = await invoke({ action: 'pdf', source, path: '/etc/hosts', text: 'injected' })
  assert.deepEqual(result, { ok: true, kind: 'copied' })
  assert.equal(runs.length, 1)
  assert.deepEqual(Object.keys(runs[0]!).sort(), ['action', 'source'])
  assert.equal(runs[0]!.source.events.length, 1)
  assert.deepEqual(Object.keys(runs[0]!.source.attachments), ['attachments/a.png'])
  assert.equal(runs[0]!.source.title, 'Parser review')
})

test('every action the menu offers is accepted', async () => {
  const { invoke, runs } = setup()
  for (const action of ['pdf', 'docx', 'markdown', 'copy', 'copy-markdown']) await invoke({ action, source })
  assert.equal(runs.length, 5)
})

test('a malformed request is answered in words and runs nothing', async () => {
  const { invoke, runs } = setup()
  const unread = { ok: false, message: "That chat's transcript could not be read." }
  assert.deepEqual(await invoke(null), { ok: false, message: 'That is not a format a chat exports as.' })
  assert.deepEqual(await invoke({ action: 'exe', source }), {
    ok: false,
    message: 'That is not a format a chat exports as.',
  })
  // The request a window from before sent: the chat by its ids, for main to read.
  assert.deepEqual(await invoke({ workspaceId: 'workspace-1', agentId: 'agent-1', action: 'pdf' }), unread)
  for (const broken of [
    { ...source, events: [{ type: 'user_message' }] },
    { ...source, events: 'no' },
    { ...source, title: 7 },
    { ...source, attachments: [] },
    'no',
  ])
    assert.deepEqual(await invoke({ action: 'copy', source: broken }), unread)
  assert.equal(runs.length, 0)
})

test('a picture that is not one is left out, not passed on', async () => {
  const { invoke, runs } = setup()
  await invoke({
    action: 'copy',
    source: { ...source, attachments: { good: source.attachments['attachments/a.png'], bad: { mediaType: 7 } } },
  })
  assert.deepEqual(Object.keys(runs[0]!.source.attachments), ['good'])
})

test('only the app’s own window is answered', async () => {
  const { invoke, runs } = setup({ foreign: true })
  await assert.rejects(invoke({ action: 'pdf', source }), /SprintEngine Studio window/u)
  assert.equal(runs.length, 0)
})

test('an export that throws is an answer, not a dropped request', async () => {
  const handlers = new Map<string, Handler>()
  registerChatExportIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never, {
    run: async () => {
      throw new Error('The page for the PDF did not load.')
    },
    assertSender: () => undefined,
  })
  assert.deepEqual(await handlers.get(CHAT_EXPORT_CHANNEL)!({ sender: {} }, { action: 'pdf', source }), {
    ok: false,
    message: 'The page for the PDF did not load.',
  })
})
