import assert from 'node:assert/strict'
import { workspaceStorePath } from './workspace-store'
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'

import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { ConversationRuntime } from './conversation-runtime'
import type { ConversationProviderAdapter, MockAdapterSessionInput } from './providers/mock-conversation-provider'

function runtimeEvent(
  input: MockAdapterSessionInput,
  type: ConversationEventType,
  payload?: Record<string, unknown>,
): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload,
  }
}

/**
 * A provider that streams `tokens` one delta at a time and parks before the
 * turn ends until `release` is called, so a test can look at the transcript
 * while a message is still streaming.
 */
function streamingProvider(tokens: string[]) {
  let release!: () => void
  const parked = new Promise<void>((resolve) => {
    release = resolve
  })
  let reachedPark!: () => void
  const atPark = new Promise<void>((resolve) => {
    reachedPark = resolve
  })
  const adapter: ConversationProviderAdapter = {
    id: 'streaming-provider',
    listModels: () => ['model'],
    startSession: (input) => [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')],
    sendTurn: (input) =>
      (async function* () {
        yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
        for (const text of tokens) yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text })
        reachedPark()
        await parked
        yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
      })(),
    resolveApproval: () => [],
    interrupt: (input) => [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })],
    stopSession: (input) => [runtimeEvent(input, 'session_closed')],
  }
  return { adapter, release, atPark }
}

async function withRuntime(
  tokens: string[],
  body: (context: {
    runtime: ConversationRuntime
    workspaceRoot: string
    provider: ReturnType<typeof streamingProvider>
    delivered: ConversationEvent[]
    start: () => Promise<string>
  }) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-persistence-'))
  const provider = streamingProvider(tokens)
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
    // Long enough that only boundaries and explicit flushes write in these tests.
    eventLog: { flushDelayMs: 60_000 },
  })
  const delivered: ConversationEvent[] = []
  runtime.onEvent((event) => delivered.push(event))
  const start = async (): Promise<string> => {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'streaming-provider',
      modelId: 'model',
    })
    assert.equal(started.ok, true)
    if (!started.ok) throw new Error('start failed')
    return started.session.sessionId
  }
  try {
    await body({ runtime, workspaceRoot, provider, delivered, start })
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

function transcriptFile(workspaceRoot: string): string {
  return workspaceStorePath(workspaceRoot, 'conversations', 'workspace', 'agent.jsonl')
}

/** The events on disk; a command's receipt is a line of the log too, with no `type`. */
async function readLines(workspaceRoot: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(transcriptFile(workspaceRoot), 'utf-8')
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => typeof line.type === 'string')
}

test('streamed deltas reach listeners only once written, and a batch of them is one record', async () => {
  await withRuntime(['Hel', 'lo ', 'there'], async ({ runtime, workspaceRoot, provider, delivered, start }) => {
    const sessionId = await start()
    const turn = runtime.sendTurn({ sessionId, message: 'hi' })
    await provider.atPark
    assert.equal(
      delivered.some((event) => event.type === 'content_delta'),
      false,
      'a delta that is not on disk has not been published',
    )
    const onDisk = await readLines(workspaceRoot)
    assert.equal(
      onDisk.some((line) => line.type === 'content_delta'),
      false,
      'the batch in flight has not been written token by token',
    )
    await runtime.flushTranscripts()
    const deltas = delivered.filter((event) => event.type === 'content_delta')
    assert.equal(deltas.length, 3, 'every token is published once its batch lands')
    const written = (await readLines(workspaceRoot)).filter((line) => line.type === 'content_delta')
    assert.equal(written.length, 1, 'the batch is one record')
    assert.equal((written[0].payload as { text: string }).text, 'Hello there')
    provider.release()
    await turn
    const after = await readLines(workspaceRoot)
    assert.deepEqual(after.map((line) => line.type).slice(-2), ['content_delta', 'turn_completed'])
  })
})

test('a crash with a batch still unwritten never leaves a published sequence number off disk', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-crash-'))
  const base = streamingProvider([])
  // Tokens a few milliseconds apart, so they span several write batches.
  const provider = {
    ...base,
    adapter: {
      ...base.adapter,
      sendTurn: (input: Parameters<ConversationProviderAdapter['sendTurn']>[0]) =>
        (async function* () {
          yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
          for (let index = 0; index < 20; index++) {
            yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: `t${index} ` })
            await new Promise((resolve) => setTimeout(resolve, 3))
          }
          base.release()
          yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
        })(),
    } satisfies ConversationProviderAdapter,
  }
  const written: number[] = []
  let deltaWrites = 0
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    eventLog: {
      flushDelayMs: 1,
      openStream: async () => ({
        write: async (chunk) => {
          // The second batch of deltas never lands: the process dies with it in flight.
          if (chunk.includes('"content_delta"') && ++deltaWrites >= 2) return new Promise<void>(() => undefined)
          for (const line of chunk.trim().split('\n')) {
            const record = JSON.parse(line) as { seq?: number; parts?: unknown[][] }
            if (record.seq === undefined) continue
            written.push(record.seq, ...(record.parts ?? []).map((part) => part[3] as number))
          }
        },
        close: async () => undefined,
      }),
    },
  })
  const published: number[] = []
  runtime.onEvent((event) => {
    assert.ok(written.includes(event.seq!), `seq ${event.seq} was published before it was written`)
    published.push(event.seq!)
  })
  try {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'streaming-provider',
      modelId: 'model',
    })
    assert.ok(started.ok)
    void runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hi' })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(deltaWrites >= 2, 'a delta batch was in flight when the process died')
    assert.ok(published.length > 0)
    assert.ok(Math.max(...published) <= Math.max(...written))
    assert.equal(
      published.some((seq) => !written.includes(seq)),
      false,
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a reload mid-stream replays exactly the events delivered live', async () => {
  await withRuntime(['a', 'b', 'c'], async ({ runtime, workspaceRoot, provider, delivered, start }) => {
    const sessionId = await start()
    const turn = runtime.sendTurn({ sessionId, message: 'hi' })
    await provider.atPark
    const replay = await runtime.readTranscript({ workspaceRoot, workspaceId: 'workspace', agentId: 'agent' })
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    const liveIds = delivered.map((event) => event.id)
    const replayed = replay.events.filter((event) => !event.id.startsWith('conv_evt_replay_close_'))
    assert.deepEqual(
      replayed.map((event) => event.id),
      liveIds,
      'ids match one for one, so the chat view dedupes a mid-stream mount',
    )
    assert.deepEqual(
      replayed.filter((event) => event.type === 'content_delta').map((event) => event.payload?.text),
      ['a', 'b', 'c'],
    )
    provider.release()
    await turn
  })
})

test('after a completed turn the transcript rebuilds the full message', async () => {
  await withRuntime(['The ', 'whole ', 'answer.'], async ({ runtime, workspaceRoot, provider, delivered, start }) => {
    const sessionId = await start()
    provider.release()
    await runtime.sendTurn({ sessionId, message: 'hi' })
    const replay = await runtime.readTranscript({ workspaceRoot, workspaceId: 'workspace', agentId: 'agent' })
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    // Through JSON, as a transcript line is: an absent payload is `undefined` live.
    assert.deepEqual(replay.events, JSON.parse(JSON.stringify(delivered)))
    const text = replay.events
      .filter((event) => event.type === 'content_delta')
      .map((event) => event.payload?.text)
      .join('')
    assert.equal(text, 'The whole answer.')
  })
})

test('after a write the disk refused, a restart numbers above every event a client was given', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-persistence-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const provider = streamingProvider(['lost ', 'to ', 'the ', 'disk'])
  provider.release()
  const run = async (diskFills: boolean) => {
    let full = false
    const runtime = new ConversationRuntime({
      adapters: [provider.adapter],
      getProviderById: () => undefined,
      eventLog: {
        flushDelayMs: 1,
        openStream: async (filePath) => {
          await mkdir(dirname(filePath), { recursive: true })
          return {
            write: async (chunk) => {
              // The disk fills mid-answer and stays full until the app is gone.
              full ||= diskFills && chunk.includes('"content_delta"')
              if (full) throw new Error('ENOSPC: no space left on device')
              await appendFile(filePath, chunk)
            },
            close: async () => undefined,
          }
        },
      },
    })
    const published: number[] = []
    runtime.onEvent((event) => published.push(event.seq!))
    const started = await runtime.startSession({ ...key, providerId: 'streaming-provider', modelId: 'model' })
    assert.ok(started.ok)
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hi' })
    return { runtime, published }
  }
  try {
    const first = await run(true)
    await first.runtime.shutdown()
    const lost = Math.max(...first.published)

    const second = await run(false)
    try {
      assert.ok(second.published.length > 0)
      assert.ok(
        second.published.every((seq) => seq > lost),
        `the next run numbers above ${lost}, a cursor a client may hold, not from the end of the file`,
      )
      const joined = await second.runtime.readConversationSync(key, { turnLimit: 1 })
      assert.ok(joined.ok)
      const caught = await second.runtime.readConversationSync(key, { afterSeq: lost, generation: joined.generation })
      assert.ok(caught.ok && caught.kind === 'events')
      assert.deepEqual(
        caught.events.map((event) => event.type),
        // The first run's unfinished turn is closed when the log is reopened.
        [
          'turn_failed',
          'session_started',
          'session_ready',
          'user_message',
          'turn_started',
          'content_delta',
          'turn_completed',
        ],
        'a client holding the lost cursor catches up on everything published since',
      )
    } finally {
      await second.runtime.shutdown()
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a turn whose events the log refuses stops its session, publishes nothing unwritten, and ends once', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-persistence-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const provider = streamingProvider(['lost ', 'to ', 'the ', 'disk'])
  provider.release()
  let full = false
  const onDisk = new Set<number>()
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    eventLog: {
      flushDelayMs: 1,
      openStream: async (filePath) => {
        await mkdir(dirname(filePath), { recursive: true })
        return {
          write: async (chunk) => {
            // The disk fills as the reply starts streaming.
            full ||= chunk.includes('"content_delta"')
            if (full) throw new Error('ENOSPC: no space left on device')
            await appendFile(filePath, chunk)
            for (const line of chunk.trim().split('\n')) {
              const seq = (JSON.parse(line) as { seq?: number }).seq
              if (seq !== undefined) onDisk.add(seq)
            }
          },
          close: async () => undefined,
        }
      },
    },
  })
  const published: ConversationEvent[] = []
  runtime.onEvent((event) => published.push(event))
  try {
    const started = await runtime.startSession({ ...key, providerId: 'streaming-provider', modelId: 'model' })
    assert.ok(started.ok)
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hi' })
    const stopped = () => {
      const listed = runtime.listSessions()
      return listed.ok && listed.sessions.every((session) => session.status === 'stopped')
    }
    while (!stopped()) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      published.some((event) => event.type === 'content_delta'),
      false,
      'nothing the log did not take reaches a client',
    )
    assert.ok(
      published.every((event) => onDisk.has(event.seq!)),
      'every number a client holds is on disk',
    )

    // The disk is back, and the chat is taken up again.
    full = false
    const resumed = await runtime.startSession({ ...key, providerId: 'streaming-provider', modelId: 'model' })
    assert.ok(resumed.ok)
    const replay = await runtime.readTranscript(key, { all: true, closeOpenTurns: false })
    assert.ok(replay.ok)
    const turnId = replay.events.find((event) => event.type === 'user_message')?.payload?.turnId
    const ends = replay.events.filter(
      (event) => (event.type === 'turn_completed' || event.type === 'turn_failed') && event.payload?.turnId === turnId,
    )
    assert.equal(ends.length, 1, 'the turn ends in the log exactly once')
    assert.equal(replay.events.filter((event) => event.type === 'content_delta').length, 0)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('ending a session leaves no stream open on its log, its answer written', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-persistence-'))
  const provider = streamingProvider([])
  provider.release()
  const open = new Set<number>()
  let streams = 0
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    eventLog: {
      openStream: async (filePath) => {
        await mkdir(dirname(filePath), { recursive: true })
        const id = ++streams
        open.add(id)
        return {
          write: (chunk) => appendFile(filePath, chunk),
          close: async () => void open.delete(id),
        }
      },
    },
  })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'streaming-provider', modelId: 'model' })
    assert.ok(started.ok)
    const ended = await runtime.stopSession({ sessionId: started.session.sessionId, commandId: 'stop-1' })
    assert.ok(ended.ok)
    assert.deepEqual([...open], [], 'a folder the chat leaves can be moved or removed at once')
    const lines = (await readFile(transcriptFile(workspaceRoot), 'utf-8')).trim().split('\n')
    assert.match(lines.at(-1)!, /"receipt":\{"id":"stop-1"/)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
