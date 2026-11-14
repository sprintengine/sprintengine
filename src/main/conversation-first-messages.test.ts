import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationSessionActionResult, ConversationSessionSummary } from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import { createConversationGatewayHost } from '../server/core/conversation-host'
import { createConversationLaunchService } from './conversation-launch-service'
import { ConversationAttachmentStore } from './conversation-attachment-store'
import { ConversationRuntime } from './conversation-runtime'
import {
  createPendingFirstMessages,
  FIRST_MESSAGE_CLIENT_ID,
  firstMessageCommandId,
  recoverFirstMessages,
  type PendingFirstMessage,
} from './conversation-first-messages'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// Waits for what a launch does in the background (its send, the write that
// lets a first message go) by its outcome, not a fixed delay a loaded machine
// can outrun.
// A one-pixel PNG: the chat's attachment store keeps only real pictures.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const PICTURE = {
  id: 'img-1',
  mediaType: 'image/png',
  name: 'shot.png',
  dataBase64: PNG.toString('base64'),
  byteLength: PNG.length,
}

async function until(done: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a created chat’s first message is written down before the launch answers, and let go of once it is answered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-messages-'))
  const filePath = join(dir, 'first.json')
  let answer: (result: ConversationSessionActionResult) => void = () => undefined
  const sends: string[] = []
  try {
    const store = createPendingFirstMessages({ filePath })
    const service = createConversationLaunchService({
      getWorkspace: (id) => (id === 'ws-1' ? { id, folderPath: '/repo/a', agents: {} } : null),
      getLaunchSettings: () => emptyAgentLaunchSettings(),
      writeAgent: () => ({ ok: true }),
      listWorkspaces: () => [],
      createWorkspace: () => ({ ok: false, message: 'not in this test' }),
      removeWorkspace: () => undefined,
      startSession: async (input) => ({
        ok: true,
        session: {
          sessionId: 'conv_1',
          workspaceId: input.workspaceId,
          agentId: input.agentId,
        } as ConversationSessionSummary,
      }),
      // The first message is on its way when the process stops.
      send: (input) => {
        sends.push(input.commandId!)
        return new Promise((resolve) => (answer = resolve))
      },
      firstMessages: store,
      newAgentSuffix: () => 'abc123',
    })
    const launched = await service.launch({
      workspaceId: 'ws-1',
      cli: 'claude-code',
      prompt: 'fix the build',
      skills: [],
      launchCommandId: 'client:phone:c1',
    })
    assert.equal(launched.ok, true)
    const commandId = firstMessageCommandId('client:phone:c1')
    await until(() => sends.length > 0, 'the first message to be sent')
    assert.deepEqual(sends, [commandId], 'sent under its launch’s own id')
    // The next process reads it from disk.
    const kept = await createPendingFirstMessages({ filePath }).all()
    assert.deepEqual(Object.keys(kept), [commandId])
    assert.equal(kept[commandId]!.message, 'fix the build')
    assert.equal(kept[commandId]!.launchCommandId, 'client:phone:c1')
    // Answered, it is let go of.
    answer({ ok: true } as ConversationSessionActionResult)
    await until(
      async () => Object.keys(await createPendingFirstMessages({ filePath }).all()).length === 0,
      'the answered first message to be let go of',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a first message a stop cut off is sent at the next start, and one that went is not sent twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-messages-'))
  const workspaceRoot = join(dir, 'repo')
  const filePath = join(dir, 'first.json')
  const mock = createMockConversationProvider()
  const adapter = {
    ...mock,
    sendTurn: (input: Parameters<typeof mock.sendTurn>[0]) => mock.sendTurn({ ...input, message: '/tools' }),
  }
  const chats = {
    went: { workspaceRoot, workspaceId: 'workspace', agentId: 'went' },
    lost: { workspaceRoot, workspaceId: 'workspace', agentId: 'lost' },
    pictured: { workspaceRoot, workspaceId: 'workspace', agentId: 'pictured' },
  }
  const launchOf = (agentId: string) => `client:phone:${agentId}`
  const hostOf = (runtime: ConversationRuntime) =>
    createConversationGatewayHost(
      runtime,
      (id) => (id === 'workspace' ? workspaceRoot : null),
      () => [{ workspaceRoot, workspaceId: 'workspace' }],
      () => 'bypass',
    )
  const message = (agentId: string): PendingFirstMessage => ({
    launchCommandId: launchOf(agentId),
    message: `hello ${agentId}`,
    at: 1,
  })
  await mkdir(workspaceRoot)
  const before = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const sessions = new Map<string, string>()
  try {
    const store = createPendingFirstMessages({ filePath })
    for (const chat of Object.values(chats)) {
      const started = await before.startSession({
        ...chat,
        providerId: mock.id,
        modelId: 'mock-model',
        permissionPreset: 'bypass',
      })
      assert.ok(started.ok)
      sessions.set(chat.agentId, started.session.sessionId)
      await store.keep(
        firstMessageCommandId(launchOf(chat.agentId)),
        message(chat.agentId),
        chat.agentId === 'pictured' ? [PICTURE] : [],
      )
    }
    // One went before the stop, and its record was not let go of in time.
    const went = await before.sendTurn({
      sessionId: sessions.get('went')!,
      commandId: firstMessageCommandId(launchOf('went')),
      message: 'hello went',
    })
    assert.equal(went.ok, true)
  } finally {
    await before.shutdown()
  }
  // Where the chat keeps the pictures its messages carried, so the transcript names them.
  const after = new ConversationRuntime({
    adapters: [adapter],
    getProviderById: () => undefined,
    attachmentStore: new ConversationAttachmentStore(dir),
  })
  try {
    const store = createPendingFirstMessages({ filePath })
    const host = hostOf(after)
    await recoverFirstMessages({
      store,
      findChat: (launchCommandId) => {
        const chat = Object.values(chats).find((each) => launchOf(each.agentId) === launchCommandId)
        return chat ? { workspaceId: chat.workspaceId, agentId: chat.agentId } : null
      },
      send: async (chat, commandId, kept) => {
        const key = { workspaceRoot, ...chat }
        const images = (kept.images ?? []).map((image) => ({
          path: store.imagePath(commandId, image),
          name: image.name ?? image.file,
          mediaType: image.mediaType,
          bytes: image.byteLength,
        }))
        const sent = await host.command(
          key,
          FIRST_MESSAGE_CLIENT_ID,
          commandId,
          { kind: 'send', message: kept.message },
          undefined,
          images.length ? { images, files: [] } : undefined,
        )
        return sent.ok ? { ok: true } : { ok: false, message: sent.message ?? 'refused' }
      },
      answered: (chat, commandId) => host.sentBefore({ workspaceRoot, ...chat }, FIRST_MESSAGE_CLIENT_ID, commandId),
      warn: (warning) => assert.fail(warning),
    })
    for (const chat of Object.values(chats)) {
      const read = await after.readTranscript(chat, { all: true })
      assert.ok(read.ok)
      const said = read.events.filter((event) => event.type === 'user_message').map((event) => event.payload?.text)
      assert.deepEqual(said, [`hello ${chat.agentId}`], `${chat.agentId}: sent once`)
    }
    const pictured = await after.readTranscript(chats.pictured, { all: true })
    assert.ok(pictured.ok)
    const carried = pictured.events.find((event) => event.type === 'user_message')?.payload?.attachments as
      Array<{ mediaType: string; byteLength: number }> | undefined
    assert.deepEqual(
      carried?.map((each) => [each.mediaType, each.byteLength]),
      [['image/png', PICTURE.byteLength]],
      'its picture went with it',
    )
    assert.deepEqual(await store.all(), {}, 'each let go of once answered')
  } finally {
    await after.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

/** A launch service over a stub session, sending through `send`. */
function launcher(options: {
  store: ReturnType<typeof createPendingFirstMessages>
  send: (input: { commandId?: string }) => Promise<ConversationSessionActionResult>
  receipt?: 'kept' | 'none'
  written?: string[]
}) {
  return createConversationLaunchService({
    getWorkspace: (id) => (id === 'ws-1' ? { id, folderPath: '/repo/a', agents: {} } : null),
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (_workspaceId, agentId) => {
      options.written?.push(agentId)
      return { ok: true }
    },
    listWorkspaces: () => [],
    createWorkspace: () => ({ ok: false, message: 'not in this test' }),
    removeWorkspace: () => undefined,
    startSession: async (input) => ({
      ok: true,
      session: {
        sessionId: 'conv_1',
        workspaceId: input.workspaceId,
        agentId: input.agentId,
      } as ConversationSessionSummary,
    }),
    send: options.send,
    commandReceipt: async () => options.receipt ?? 'none',
    firstMessages: options.store,
    newAgentSuffix: () => 'abc123',
  })
}

test('a first message with pictures is kept whole, its pictures on disk, before the launch answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-messages-'))
  const filePath = join(dir, 'first.json')
  try {
    const store = createPendingFirstMessages({ filePath })
    const launched = await launcher({ store, send: () => new Promise(() => undefined) }).launch({
      workspaceId: 'ws-1',
      cli: 'claude-code',
      prompt: 'what is wrong here',
      attachments: [PICTURE],
      launchCommandId: 'client:phone:c2',
    })
    assert.equal(launched.ok, true)
    const commandId = firstMessageCommandId('client:phone:c2')
    const next = createPendingFirstMessages({ filePath })
    const kept = (await next.all())[commandId]
    assert.equal(kept?.message, 'what is wrong here')
    assert.equal(kept?.images?.length, 1)
    assert.equal(kept?.images?.[0]?.mediaType, 'image/png')
    assert.deepEqual(await readFile(next.imagePath(commandId, kept!.images![0]!)), PNG)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a launch whose first message cannot be written down is refused before any chat is made', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-messages-'))
  // There, but not a file that reads: its messages are not "none".
  const filePath = join(dir, 'first.json')
  await mkdir(filePath)
  const written: string[] = []
  try {
    const launched = await launcher({
      store: createPendingFirstMessages({ filePath }),
      send: async () => ({ ok: true }) as ConversationSessionActionResult,
      written,
    }).launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: 'fix it', launchCommandId: 'client:phone:c3' })
    assert.equal(launched.ok, false)
    assert.deepEqual(written, [], 'no chat made')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a refusal the chat did not record keeps the first message; one it recorded lets it go', async () => {
  for (const [answer, receipt, keptAfter] of [
    [{ ok: false, code: 'busy', message: 'A turn is running.' }, 'none', true],
    [{ ok: false, message: 'The agent did not start.' }, 'none', true],
    [{ ok: false, message: 'Refused for good.' }, 'kept', false],
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'first-messages-'))
    const filePath = join(dir, 'first.json')
    try {
      const store = createPendingFirstMessages({ filePath })
      let sent = false
      const launched = await launcher({
        store,
        send: async () => {
          sent = true
          return answer as unknown as ConversationSessionActionResult
        },
        receipt,
      }).launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: 'go', launchCommandId: 'client:phone:c4' })
      assert.equal(launched.ok, true)
      await until(() => sent, 'the first message to be sent')
      const commandId = firstMessageCommandId('client:phone:c4')
      if (keptAfter) {
        // Give the settle a moment to (wrongly) let it go, then read the disk.
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.ok(commandId in (await createPendingFirstMessages({ filePath }).all()), answer.message)
      } else
        await until(
          async () => !(commandId in (await createPendingFirstMessages({ filePath }).all())),
          'the refused first message to be let go of',
        )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('at the next start, a transient refusal keeps the first message for the start after', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-messages-'))
  const filePath = join(dir, 'first.json')
  try {
    const store = createPendingFirstMessages({ filePath })
    const commandId = firstMessageCommandId('client:phone:c5')
    await store.keep(commandId, { launchCommandId: 'client:phone:c5', message: 'hello', at: 1 }, [PICTURE])
    const warnings: string[] = []
    const recover = (answer: { ok: false; message: string; code?: string }, answered: boolean) =>
      recoverFirstMessages({
        store,
        findChat: () => ({ workspaceId: 'workspace', agentId: 'a1' }),
        send: async () => answer,
        answered: async () => answered,
        warn: (warning) => warnings.push(warning),
      })
    await recover({ ok: false, code: 'busy', message: 'A turn is running.' }, false)
    await recover({ ok: false, message: 'The agent did not start.' }, false)
    assert.ok(commandId in (await store.all()), 'kept through both')
    const picture = (await store.all())[commandId]!.images![0]!
    await recover({ ok: false, message: 'Refused for good.' }, true)
    assert.deepEqual(await store.all(), {}, 'a recorded refusal lets it go')
    await assert.rejects(readFile(store.imagePath(commandId, picture)), 'its picture goes with it')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
