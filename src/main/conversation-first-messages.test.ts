import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'

import { openTestDatabase, testChatDatabase } from '../../tests/studio-database'
import type { StudioDatabase } from '../server/db/database'

import type { ConversationSessionActionResult, ConversationSessionSummary } from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import { createConversationGatewayHost } from '../server/core/conversation-host'
import type { ExtensionHookOutcome, ExtensionHooks } from '../server/extensions/hooks/extension-hooks'
import { createConversationLaunchService } from './conversation-launch-service'
import { ConversationAttachmentStore } from './conversation-attachment-store'
import { ConversationRuntime } from './conversation-runtime'
import {
  createPendingFirstMessages,
  FIRST_MESSAGE_CLIENT_ID,
  firstMessageCommandId,
  firstMessageSettled,
  recoverFirstMessages,
  recoveryHookAs,
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

const databases = new Map<string, StudioDatabase>()

/** The store as the core makes it, on the database in the folder `filePath` is in, its pictures beside. */
function storeAt(filePath: string) {
  const dir = dirname(filePath)
  let database = databases.get(dir)
  if (!database) {
    database = openTestDatabase(dir)
    databases.set(dir, database)
  }
  return createPendingFirstMessages({ database, imagesRoot: filePath.replace(/\.json$/u, '') })
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
    const store = storeAt(filePath)
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
    const kept = await storeAt(filePath).all()
    assert.deepEqual(Object.keys(kept), [commandId])
    assert.equal(kept[commandId]!.message, 'fix the build')
    assert.equal(kept[commandId]!.launchCommandId, 'client:phone:c1')
    // Answered, it is let go of.
    answer({ ok: true } as ConversationSessionActionResult)
    await until(
      async () => Object.keys(await storeAt(filePath).all()).length === 0,
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
  const before = new ConversationRuntime({
    database: testChatDatabase(), adapters: [adapter], getProviderById: () => undefined })
  const sessions = new Map<string, string>()
  try {
    const store = storeAt(filePath)
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
    database: testChatDatabase(),
    adapters: [adapter],
    getProviderById: () => undefined,
    attachmentStore: new ConversationAttachmentStore(dir),
  })
  try {
    const store = storeAt(filePath)
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
    const store = storeAt(filePath)
    const launched = await launcher({ store, send: () => new Promise(() => undefined) }).launch({
      workspaceId: 'ws-1',
      cli: 'claude-code',
      prompt: 'what is wrong here',
      attachments: [PICTURE],
      launchCommandId: 'client:phone:c2',
    })
    assert.equal(launched.ok, true)
    const commandId = firstMessageCommandId('client:phone:c2')
    const next = storeAt(filePath)
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
  // A database that takes no write: the message cannot be kept.
  const database = openTestDatabase(dir)
  await database.close()
  const written: string[] = []
  try {
    const launched = await launcher({
      store: createPendingFirstMessages({ database, imagesRoot: join(dir, 'first') }),
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
      const store = storeAt(filePath)
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
        assert.ok(commandId in (await storeAt(filePath).all()), answer.message)
      } else
        await until(
          async () => !(commandId in (await storeAt(filePath).all())),
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
    const store = storeAt(filePath)
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

// An extension's refusal is its last word on the message: sent again at the
// next start, it would only be refused again.
test('a first message an extension refused is settled, and not sent again', async () => {
  const refused = { ok: false as const, code: 'refused_by_extension', message: 'The extension "Guard" refused this' }
  assert.equal(await firstMessageSettled(refused, async () => false), true)
  assert.equal(await firstMessageSettled({ ok: false, code: 'busy', message: 'busy' }, async () => true), false)
})

// A first message sent again after a stop is no longer anyone typing: through
// a host for Studio's own sends it meets the extensions' `agent.prompt.before`
// as `recovery`, and what a hook leaves is what the chat is sent.
test('a first message sent again at the next start meets the prompt hooks as a recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-messages-hooks-'))
  const workspaceRoot = join(dir, 'repo')
  await mkdir(workspaceRoot)
  const mock = createMockConversationProvider()
  const told: string[] = []
  const adapter = {
    ...mock,
    sendTurn: (input: Parameters<typeof mock.sendTurn>[0]) => {
      told.push(input.message)
      return mock.sendTurn({ ...input, message: '/tools' })
    },
  }
  const heard: Array<Record<string, unknown>> = []
  const hooks: ExtensionHooks = {
    wants: (point) => point === 'agent.prompt.before',
    run: async (_point, event) => {
      heard.push(event as Record<string, unknown>)
      const prompt = (event as { prompt: string }).prompt
      return { kind: 'continue', event: { ...event, prompt: `${prompt} (checked)` } } as ExtensionHookOutcome<never>
    },
    notify: () => undefined,
    bind: () => undefined,
  }
  const runtime = new ConversationRuntime({
    database: testChatDatabase(),
    adapters: [adapter],
    getProviderById: () => undefined,
    extensionHooks: hooks,
  })
  const chat = { workspaceId: 'workspace', agentId: 'lost' }
  try {
    const started = await runtime.startSession({
      workspaceRoot,
      ...chat,
      providerId: mock.id,
      modelId: 'mock-model',
      permissionPreset: 'bypass',
    })
    assert.ok(started.ok)
    const store = storeAt(join(dir, 'first.json'))
    const commandId = firstMessageCommandId('client:phone:lost')
    await store.keep(commandId, { launchCommandId: 'client:phone:lost', message: 'hello lost', at: 1 }, [])
    // As the core recovers them (studio-core.ts).
    const host = createConversationGatewayHost(
      runtime,
      () => workspaceRoot,
      () => [{ workspaceRoot, workspaceId: 'workspace' }],
      () => 'bypass',
      undefined,
      undefined,
      undefined,
      { sendHookAs: { inputKind: 'recovery', from: 'studio' } },
    )
    await recoverFirstMessages({
      store,
      findChat: () => chat,
      send: async (target, id, kept) => {
        const sent = await host.command({ workspaceRoot, ...target }, FIRST_MESSAGE_CLIENT_ID, id, {
          kind: 'send',
          message: kept.message,
        })
        return sent.ok ? { ok: true } : { ok: false, message: sent.message ?? 'refused' }
      },
      answered: (target, id) => host.sentBefore({ workspaceRoot, ...target }, FIRST_MESSAGE_CLIENT_ID, id),
      warn: (warning) => assert.fail(warning),
    })
    assert.equal(heard.length, 1)
    assert.equal(heard[0]?.inputKind, 'recovery')
    assert.equal(heard[0]?.from, 'studio')
    assert.equal(told.at(-1), 'hello lost (checked)')
  } finally {
    await runtime.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

// A first message keeps whether a person typed it: sent again after a stop,
// only one nobody typed meets the prompt hooks, as a recovery from whoever
// sent it; a person's own words never do.
test('a kept first message says whether nobody typed it, and only such a one is hooked when sent again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-messages-from-'))
  const filePath = join(dir, 'first.json')
  try {
    const store = storeAt(filePath)
    let suffix = 0
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
      // Cut off by a stop: never answered.
      send: () => new Promise(() => undefined),
      firstMessages: store,
      newAgentSuffix: () => `s${++suffix}`,
    })
    const base = { workspaceId: 'ws-1', cli: 'claude-code', skills: [] }
    await service.launch({ ...base, prompt: 'typed by a person', launchCommandId: 'client:phone:c1' })
    await service.launch({
      ...base,
      prompt: 'from an agent',
      launchCommandId: 'agent:c2',
      promptHookAs: { inputKind: 'launch', from: 'agent' },
    })
    const kept = await storeAt(filePath).all()
    const person = kept[firstMessageCommandId('client:phone:c1')]!
    const agent = kept[firstMessageCommandId('agent:c2')]!
    assert.equal(person.from, undefined)
    assert.equal(agent.from, 'agent')
    assert.equal(recoveryHookAs(person), undefined, 'a person’s words are never hooked')
    assert.deepEqual(recoveryHookAs(agent), { inputKind: 'recovery', from: 'agent' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
