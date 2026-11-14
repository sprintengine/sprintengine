import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationSessionActionResult, ConversationSessionSummary } from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import { createConversationGatewayHost } from '../server/core/conversation-host'
import { createConversationLaunchService } from './conversation-launch-service'
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
      await store.keep(firstMessageCommandId(launchOf(chat.agentId)), message(chat.agentId))
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
  const after = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
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
        const sent = await host.command(key, FIRST_MESSAGE_CLIENT_ID, commandId, {
          kind: 'send',
          message: kept.message,
        })
        return sent.ok ? { ok: true } : { ok: false, message: sent.message ?? 'refused' }
      },
      warn: (warning) => assert.fail(warning),
    })
    for (const chat of Object.values(chats)) {
      const read = await after.readTranscript(chat, { all: true })
      assert.ok(read.ok)
      const said = read.events.filter((event) => event.type === 'user_message').map((event) => event.payload?.text)
      assert.deepEqual(said, [`hello ${chat.agentId}`], `${chat.agentId}: sent once`)
    }
    assert.deepEqual(await store.all(), {}, 'each let go of once answered')
  } finally {
    await after.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})
