import { performance } from 'node:perf_hooks'

import { expect, test } from 'vitest'

import type { ConversationService } from '../main/conversation-service'
import type { ConversationEvent, ConversationSessionFrame } from '../shared/conversation-runtime'
import { connectChatOverStudio } from '../../tests/studio-chat-wire'

// What a chat costs the window on the Studio protocol: a send's round trip,
// the time from following a long chat to its page being in the window, the
// bytes that page takes on the wire, and the heap it leaves behind. One
// process holds the server, the window's client and the transport between
// them (an in-memory socket), so the numbers are the protocol's own costs
// (framing, projection, validation, the client's decode), not a kernel
// socket's or a renderer's paint.
//
// Run it by hand; it is skipped otherwise:
//   MEASURE_CHAT_WIRE=1 npx vitest run src/seams/chatWireMeasure.test.ts
//
// The chat: the reader's page of a long chat (10 turns of 60 steps: 30 KB
// writes, 6 KB edits, 4,000-character previews), well past the wire's 8 MiB
// page bound, so the projection has work to do.

const RUN = process.env.MEASURE_CHAT_WIRE === '1'
const TURNS = 10
const STEPS = 60
const SENDS = 300

const chatKey = { workspaceId: 'measure', agentId: 'chat', workspaceRoot: '/Users/dev/measure' }

function longChat(): ConversationEvent[] {
  const events: ConversationEvent[] = []
  let seq = 0
  const base = { sessionId: 'session', workspaceId: chatKey.workspaceId, agentId: chatKey.agentId }
  const push = (type: ConversationEvent['type'], payload: Record<string, unknown>) =>
    events.push({ ...base, id: `e${++seq}`, seq, providerId: 'mock', modelId: 'mock', type, createdAt: seq, payload })
  const text = (size: number, salt: number) => `line ${salt} `.repeat(Math.ceil(size / 10)).slice(0, size)
  for (let turn = 0; turn < TURNS; turn++) {
    const turnId = `t${turn}`
    push('user_message', { turnId, text: `Turn ${turn}: change the thing.` })
    push('turn_started', { turnId })
    for (let step = 0; step < STEPS; step++) {
      const toolUseId = `${turnId}-s${step}`
      const kind = step % 3
      push('tool_started', {
        turnId,
        toolUseId,
        name: kind === 0 ? 'Write' : kind === 1 ? 'Edit' : 'Read',
        input:
          kind === 0
            ? { file_path: `/Users/dev/measure/src/f${step}.ts`, content: text(30_000, step) }
            : kind === 1
              ? {
                  file_path: `/Users/dev/measure/src/f${step}.ts`,
                  old_string: text(3_000, step),
                  new_string: text(3_000, step + 1),
                }
              : { file_path: `/Users/dev/measure/src/f${step}.ts` },
      })
      push('tool_output', { turnId, toolUseId, output: text(4_000, step), isError: false })
    }
    push('content_delta', { turnId, text: text(2_000, turn) })
    push('turn_completed', { turnId })
  }
  return events
}

/** A conversation service that holds one long chat and answers a send at once. */
function fakeService(events: ConversationEvent[]): ConversationService {
  const last = events.at(-1)!.seq!
  return {
    startSession: async () => ({ ok: false, message: 'not measured' }),
    sendTurn: async () => ({ ok: true }),
    subscribe: (_input: unknown, listener: (frame: ConversationSessionFrame) => void) => {
      queueMicrotask(() => {
        listener({ type: 'snapshot', page: { events, hasMore: true, beforeCursor: 1 }, generation: 'g1' })
        listener({ type: 'synchronized', seq: last, generation: 'g1' })
      })
      return { dispose: () => undefined }
    },
  } as unknown as ConversationService
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!
const heap = () => {
  ;(globalThis as { gc?: () => void }).gc?.()
  return process.memoryUsage().heapUsed
}
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`
const ms = (value: number) => `${value.toFixed(3)} ms`

async function measureProtocol(events: ConversationEvent[]) {
  const wire = connectChatOverStudio(fakeService(events))
  const { parts, bytes } = wire
  // A first call opens the connection, so what follows is the chat's own cost.
  await parts.send({ sessionId: 'session', message: 'warm up' })

  const before = heap()
  bytes.sent = 0
  const started = performance.now()
  let pageEvents = 0
  let synced = 0
  const stop = await new Promise<() => void>((resolve) => {
    const stopper = parts.subscribe({ key: chatKey, turnLimit: TURNS }, (frame) => {
      if (frame.type === 'snapshot') pageEvents = frame.page.events.length
      if (frame.type === 'synchronized') {
        synced = performance.now()
        resolve(stopper)
      }
    })
  })
  const firstPage = synced - started
  const pageBytes = bytes.sent
  const retained = heap() - before

  const sends: number[] = []
  for (let index = 0; index < SENDS; index++) {
    const at = performance.now()
    const answer = await parts.send({ sessionId: 'session', message: `message ${index}` })
    sends.push(performance.now() - at)
    expect((answer as { ok: boolean }).ok).toBe(true)
  }
  stop()
  await wire.close()
  return { firstPage, pageBytes, pageEvents, retained, sendMedian: median(sends), sendP95: p95(sends) }
}

test.skipIf(!RUN)('a long chat and a send over the Studio protocol, as the window reaches them', async () => {
  const events = longChat()
  const stored = events.reduce((total, event) => total + JSON.stringify(event).length, 0)
  const runs: Array<Awaited<ReturnType<typeof measureProtocol>>> = []
  for (let round = 0; round < 3; round++) runs.push(await measureProtocol(events))
  const pick = <K extends keyof (typeof runs)[number]>(key: K) => median(runs.map((run) => run[key] as number))
  console.log(
    [
      `chat page: ${events.length} events, ${mb(stored)} as stored`,
      `protocol: send ${ms(pick('sendMedian'))} median, ${ms(pick('sendP95'))} p95; ` +
        `long chat to the window ${ms(pick('firstPage'))}; page ${mb(pick('pageBytes'))} on the wire, ` +
        `${pick('pageEvents')} events; heap left ${mb(pick('retained'))}`,
    ].join('\n'),
  )
})
