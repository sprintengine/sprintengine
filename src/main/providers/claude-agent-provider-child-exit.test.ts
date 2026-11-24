import { expect, test } from 'vitest'

import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { ConversationEvent } from '../../shared/conversation-runtime'

// A Claude Code child that quits by itself while the chat is idle leaves the
// session with no process. The runtime is told, so no list goes on counting
// the session as running; a child the runtime ended on purpose is not
// reported back to it.

const SESSION = {
  sessionId: 'conv_1',
  workspaceId: 'workspace',
  agentId: 'agent',
  providerId: CLAUDE_AGENT_PROVIDER_ID,
  modelId: 'sonnet',
  workspaceRoot: '/tmp/workspace',
}

/** A fake SDK whose child answers each message with a result, and ends when `quit` is called. */
function fakeSdk() {
  const quits: Array<() => void> = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    const waiting: Array<(result: IteratorResult<Record<string, unknown>>) => void> = []
    const queued: Record<string, unknown>[] = []
    let ended = false
    const push = (message: Record<string, unknown>) => {
      const resolve = waiting.shift()
      if (resolve) resolve({ value: message, done: false })
      else queued.push(message)
    }
    quits.push(() => {
      ended = true
      for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true })
    })
    void (async () => {
      for await (const message of params.prompt) {
        push({ type: 'system', subtype: 'init', session_id: 'native', model: 'sonnet' })
        push({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'native',
          uuid: `result-${String(message.uuid)}`,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      }
    })()
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const value = queued.shift()
          if (value) return Promise.resolve({ value, done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiting.push(resolve))
        },
      }),
      interrupt: async () => undefined,
    }
  }
  return { loadQuery: () => Promise.resolve(query), quitLatest: () => quits.at(-1)?.() }
}

async function drain(stream: unknown): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = []
  for await (const event of (await stream) as AsyncIterable<ConversationEvent>) events.push(event)
  return events
}

test('a child that quits by itself between turns tells the runtime; one disposed on purpose does not', async () => {
  const sdk = fakeSdk()
  const adapter = createClaudeAgentProvider({
    loadQuery: sdk.loadQuery as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    now: () => 1000,
  })
  let exited = 0
  await drain(adapter.startSession({ ...SESSION, onChildExited: () => exited++ }))
  const turn = (n: number) => ({ ...SESSION, turnId: `turn_${n}`, requestId: `approval_${n}`, message: 'hello' })

  expect((await drain(adapter.sendTurn(turn(1)))).at(-1)?.type).toBe('turn_completed')
  expect(adapter.listLiveSessions()[0]?.hasChildProcess).toBe(true)
  // The idle sweep ends it: the runtime asked, and is not told again.
  expect(adapter.disposeChildProcess('conv_1')).toBe(true)
  sdk.quitLatest()
  await Promise.resolve()
  expect(exited).toBe(0)

  expect((await drain(adapter.sendTurn(turn(2)))).at(-1)?.type).toBe('turn_completed')
  sdk.quitLatest()
  await expect.poll(() => exited).toBe(1)
  expect(adapter.listLiveSessions()[0]?.hasChildProcess).toBe(false)
  await adapter.disposeAll()
})
