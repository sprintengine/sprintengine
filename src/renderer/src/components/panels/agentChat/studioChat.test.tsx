import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type {
  ConversationEvent,
  ConversationSessionFrame,
  ConversationSubscribeInput,
} from '../../../../../shared/conversation-runtime'
import { installStudioLoopback, type StudioLoopback } from '../../../../../../tests/studio-chat-loopback'

// The chat view on the Studio protocol, end to end inside one process: the
// window's client and transport, a port, the RPC, and main's chat backend over
// a scripted conversation IPC. What a person would notice — a reply that
// repeats or skips text after the connection drops mid-turn, a picture that
// arrives cut, a socket's own words in an error — is what these look for.

beforeEach(() => {})
afterEach(() => {
  vi.unstubAllEnvs()
})

const until = async (check: () => boolean, what: string) => {
  for (let tries = 0; !check() && tries < 400; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

function event(seq: number, type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent {
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock',
    modelId: 'mock',
    createdAt: seq,
    type,
    payload,
  }
}

async function setup(api: Record<string, unknown>) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.assign(dom.window, { api })
  const loopback = installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> }) as StudioLoopback
  const restore = () => {
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  return { dom, loopback, restore }
}

test('a reply streaming when the connection drops resumes from its cursor, with nothing repeated and nothing lost', async () => {
  const subscriptions: { input: ConversationSubscribeInput; receive: (frame: ConversationSessionFrame) => void }[] = []
  const { loopback, restore } = await setup({
    onConversationSession: (input: ConversationSubscribeInput, receive: (frame: ConversationSessionFrame) => void) => {
      subscriptions.push({ input, receive })
      return () => undefined
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useConversationSession } = await import('./useConversationSession')
  let hook!: ReturnType<typeof useConversationSession>
  function Harness() {
    hook = useConversationSession('/Users/dev/project', 'workspace', 'agent')
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(createElement(Harness)))
    await until(() => subscriptions.length === 1, 'the first subscription')
    // The view names its conversation by its folder, as its IPC does.
    expect(subscriptions[0].input.key).toEqual({
      workspaceRoot: '/Users/dev/project',
      workspaceId: 'workspace',
      agentId: 'agent',
    })
    const first = subscriptions[0].receive
    await act(async () => {
      first({
        type: 'snapshot',
        page: { events: [event(1, 'user_message', { text: 'hi' })], hasMore: false, beforeCursor: null },
        generation: 'log-1',
      })
      first({ type: 'synchronized', seq: 1, generation: 'log-1' })
    })
    await until(() => hook.hydrated, 'the transcript')
    await act(async () => {
      first({ type: 'event', event: event(2, 'turn_started', {}) })
      first({ type: 'event', event: event(3, 'content_delta', { text: 'Hel' }) })
      first({ type: 'event', event: event(4, 'content_delta', { text: 'lo' }) })
    })
    await until(() => hook.events.length === 4, 'the streamed text')
    const opened = loopback.connections()
    // The connection goes mid-turn; the window's client reconnects by itself
    // and follows again from the last sequence it holds.
    loopback.drop()
    await until(() => subscriptions.length === 2, 'the resumed subscription')
    expect(loopback.connections()).toBe(opened + 1)
    expect(subscriptions[1].input).toMatchObject({ afterSeq: 4, generation: 'log-1' })
    const second = subscriptions[1].receive
    await act(async () => {
      // A catch-up that starts at the last event the view already has.
      second({ type: 'event', event: event(4, 'content_delta', { text: 'lo' }) })
      second({ type: 'event', event: event(5, 'content_delta', { text: ' world' }) })
      second({ type: 'synchronized', seq: 5, generation: 'log-1' })
      second({ type: 'event', event: event(6, 'content_delta', { text: '!' }) })
    })
    await until(() => hook.events.length === 6, 'the rest of the reply')
    expect(hook.events.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6])
    const text = hook.events
      .filter((entry) => entry.type === 'content_delta')
      .map((entry) => String(entry.payload?.text ?? ''))
      .join('')
    expect(text).toBe('Hello world!')
    expect(hook.error).toBeNull()
  } finally {
    await act(async () => root.unmount())
    restore()
  }
})

test('a picture goes up in pieces and reaches the runtime whole; the socket’s own words never reach the chat', async () => {
  const sends: Array<Record<string, unknown>> = []
  const { loopback, restore } = await setup({
    conversationSessionSendTurn: async (input: Record<string, unknown>) => {
      sends.push(input)
      return { ok: true, session: { sessionId: 'session', workspaceId: 'workspace', agentId: 'agent' } }
    },
  })
  try {
    const { useConversationTransport } = await import('./conversationTransport')
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    let transport!: ReturnType<typeof useConversationTransport>
    renderToString(
      createElement(() => {
        transport = useConversationTransport()
        return null
      }),
    )
    // Three pieces' worth of a picture, of a length that is not a multiple of a piece.
    const bytes = Buffer.from(Array.from({ length: 1_400_001 }, (_, index) => (index * 7) % 256))
    const dataBase64 = bytes.toString('base64')
    const sent = await transport.send({
      sessionId: 'session',
      message: 'look',
      attachments: [
        { id: 'one', mediaType: 'image/png', dataBase64, byteLength: bytes.length, name: 'one.png' },
        { id: 'two', mediaType: 'image/jpeg', dataBase64: 'iVBORw0KGgo=', byteLength: 8 },
      ],
    })
    expect(sent.ok).toBe(true)
    expect(sends).toHaveLength(1)
    const carried = sends[0].attachments as Array<Record<string, unknown>>
    expect(carried.map(({ id, mediaType, name, byteLength }) => ({ id, mediaType, name, byteLength }))).toEqual([
      { id: 'one', mediaType: 'image/png', name: 'one.png', byteLength: bytes.length },
      { id: 'two', mediaType: 'image/jpeg', name: undefined, byteLength: 8 },
    ])
    expect(carried[0].dataBase64).toBe(dataBase64)
    expect(sends[0]).not.toHaveProperty('commandId')

    // A reconnect Studio refuses ends the client; the call in flight is told
    // in one plain sentence, not in the socket's words.
    const api = window.api as unknown as Record<string, () => Promise<{ connectionId: string; ticket: string }>>
    const connect = api.studioWindowTicket
    api.studioWindowTicket = async () => ({ ...(await connect()), token: 'seticket_not_the_ticket_000000' })
    loopback.drop()
    const refused = await transport.services.providers.list({})
    expect(refused).toEqual({
      ok: false,
      message: 'This window lost its connection to Studio. It reconnects by itself; try again in a moment.',
    })
  } finally {
    restore()
  }
})

test('a send that cannot go gives back the pictures it staged, so the window can keep sending', async () => {
  const sends: Array<Record<string, unknown>> = []
  const { restore } = await setup({
    conversationSessionSendTurn: async (input: Record<string, unknown>) => {
      sends.push(input)
      return { ok: true, session: { sessionId: 'session', workspaceId: 'workspace', agentId: 'agent' } }
    },
  })
  try {
    const { useConversationTransport } = await import('./conversationTransport')
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    let transport!: ReturnType<typeof useConversationTransport>
    renderToString(
      createElement(() => {
        transport = useConversationTransport()
        return null
      }),
    )
    const picture = { id: 'one', mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgo=', byteLength: 8 }
    // Studio takes the first picture and refuses the second: the send never goes.
    // More of these than a window may hold staged at once.
    for (let attempt = 0; attempt < 40; attempt++) {
      await expect(
        transport.send({
          sessionId: 'session',
          message: 'look',
          attachments: [picture, { ...picture, id: 'two', mediaType: 'image/svg+xml' as never }],
        }),
      ).resolves.toEqual({ ok: false, message: 'A picture is PNG, JPEG, WebP or GIF.' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const sent = await transport.send({ sessionId: 'session', message: 'look', attachments: [picture] })
    expect(sent.ok).toBe(true)
    expect(sends).toHaveLength(1)
  } finally {
    restore()
  }
})

test('a send resent after the connection dropped mid-send is carried out once, and answered', async () => {
  let release!: () => void
  const sends: Array<Record<string, unknown>> = []
  const { loopback, restore } = await setup({
    conversationSessionSendTurn: async (input: Record<string, unknown>) => {
      sends.push(input)
      await new Promise<void>((resolve) => (release = resolve))
      return { ok: true, session: { sessionId: 'session', workspaceId: 'workspace', agentId: 'agent' } }
    },
  })
  try {
    const { useConversationTransport } = await import('./conversationTransport')
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    let transport!: ReturnType<typeof useConversationTransport>
    renderToString(
      createElement(() => {
        transport = useConversationTransport()
        return null
      }),
    )
    const sent = transport.send({ sessionId: 'session', message: 'once' })
    await until(() => sends.length === 1, 'the send to reach the runtime')
    // Studio restarts under the window while the send runs; the client sends it
    // again under the same command id, and the receipt answers it.
    loopback.drop()
    await until(() => loopback.connections() >= 2, 'the reconnect')
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    expect((await sent).ok).toBe(true)
    expect(sends).toHaveLength(1)
  } finally {
    restore()
  }
})

test('a send’s files attached by path reach the runtime over the protocol, beside the words', async () => {
  const sends: Array<Record<string, unknown>> = []
  const { restore } = await setup({
    conversationSessionSendTurn: async (input: Record<string, unknown>) => {
      sends.push(input)
      return { ok: true, session: { sessionId: 'session', workspaceId: 'workspace', agentId: 'agent' } }
    },
  })
  try {
    const { useConversationTransport } = await import('./conversationTransport')
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    let transport!: ReturnType<typeof useConversationTransport>
    renderToString(
      createElement(() => {
        transport = useConversationTransport()
        return null
      }),
    )
    const sent = await transport.send({
      sessionId: 'session',
      message: 'Summarise',
      files: [{ path: '/Users/dev/Desktop/Q3 budget.xlsx' }],
    })
    expect(sent.ok).toBe(true)
    expect(sends[0]).toMatchObject({ message: 'Summarise', files: [{ path: '/Users/dev/Desktop/Q3 budget.xlsx' }] })
  } finally {
    restore()
  }
})

test('the window’s chat services reach its Studio’s chats over the protocol, each by its method', async () => {
  const asked: string[] = []
  const status = { providerId: 'p', configured: true, source: 'settings', persistence: 'encrypted', label: 'Key' }
  const { restore } = await setup({
    conversationSessionsList: async () => {
      asked.push('list')
      return { ok: true, sessions: [] }
    },
    conversationSessionStop: async ({ sessionId }: { sessionId: string }) => {
      asked.push(`stop:${sessionId}`)
      return { ok: true }
    },
    conversationSessionSuspend: async ({ sessionId }: { sessionId: string }) => {
      asked.push(`suspend:${sessionId}`)
      return { ok: true }
    },
    conversationThreads: async ({ workspaceId }: { workspaceId: string }) => {
      asked.push(`threads:${workspaceId}`)
      return { ok: true, threads: [] }
    },
    conversationSearch: async ({ query }: { query: string }) => {
      asked.push(`search:${query}`)
      return { ok: true, hits: [] }
    },
    conversationApprovalRules: async () => {
      asked.push('rules')
      return { ok: true, rules: [] }
    },
    conversationRevokeApprovalRule: async ({ ruleId }: { ruleId: string }) => {
      asked.push(`revoke:${ruleId}`)
      return { ok: true }
    },
    conversationSecretSet: async ({ providerId, value }: { providerId: string; value: string }) => {
      asked.push(`set:${providerId}:${value}`)
      return { ok: true, status }
    },
    conversationSecretClear: async ({ providerId }: { providerId: string }) => {
      asked.push(`clear:${providerId}`)
      return { ok: true, status }
    },
  })
  try {
    const { windowChatServices } = await import('./windowChat')
    const services = windowChatServices()
    expect(await services.sessions.list()).toEqual({ ok: true, sessions: [] })
    expect((await services.sessions.stop({ sessionId: 's1' })).ok).toBe(true)
    expect((await services.sessions.suspend({ sessionId: 's1' })).ok).toBe(true)
    expect((await services.history.threads({ workspaceId: 'ws', workspaceRoot: '/Users/dev/app' })).ok).toBe(true)
    expect(
      (await services.history.search({ workspaceId: 'ws', workspaceRoot: '/Users/dev/app', query: 'wave' })).ok,
    ).toBe(true)
    expect((await services.approvalRules.list()).ok).toBe(true)
    expect((await services.approvalRules.revoke('rule-1')).ok).toBe(true)
    expect((await services.providers.setSecret({ providerId: 'p', value: 'sk-test' })).ok).toBe(true)
    expect((await services.providers.clearSecret({ providerId: 'p' })).ok).toBe(true)
    expect(asked).toEqual([
      'list',
      'stop:s1',
      'suspend:s1',
      'threads:ws',
      'search:wave',
      'rules',
      'revoke:rule-1',
      'set:p:sk-test',
      'clear:p',
    ])
  } finally {
    restore()
  }
})

test('every chat’s lifecycle is heard across a dropped connection, and the reader is told to read its list again', async () => {
  const listeners = new Set<(event: ConversationEvent) => void>()
  const { loopback, restore } = await setup({
    onConversationEvent: (listener: (event: ConversationEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  try {
    const { windowChatServices } = await import('./windowChat')
    const heard: string[] = []
    let reconnected = 0
    const stop = windowChatServices().sessions.onLifecycleEvent(
      (event) => heard.push(event.type),
      () => reconnected++,
    )
    await until(() => listeners.size === 1, 'the stream to be followed')
    for (const listener of listeners) listener(event(1, 'turn_started', {}))
    await until(() => heard.length === 1, 'the first event')
    const before = reconnected
    // Studio restarts under the window: what happened meanwhile was never heard.
    loopback.drop()
    await until(() => loopback.connections() >= 2 && reconnected > before, 'the reconnect to be told')
    await until(() => listeners.size >= 1, 'the stream to be followed again')
    for (const listener of listeners) listener(event(2, 'turn_completed', {}))
    await until(() => heard.includes('turn_completed'), 'the event after the reconnect')
    stop()
  } finally {
    restore()
  }
})

test('a fork is asked only of a Studio that says where its forks are, and an answer that does not say is not read as made', async () => {
  const { createStudioConversationParts } = await import('./studioChat')
  const asked: string[] = []
  const studio = (capabilities: string[], answer: unknown) => async () =>
    ({
      welcome: { conversation: { capabilities } },
      request: async (method: string) => {
        asked.push(method)
        return answer
      },
    }) as never
  const fork = {
    key: { workspaceRoot: '/Users/dev/app', workspaceId: 'ws', agentId: 'agent' },
    newAgentId: 'agent-2',
    side: 'assistant' as const,
    turnId: 'turn-1',
  }
  // A Studio from before: its fork would leave a transcript no window lists.
  const older = await createStudioConversationParts(studio([], { ok: true })).fork!(fork)
  expect(older).toEqual({ ok: false, message: expect.stringContaining('older than this window') })
  expect(asked).toEqual([])
  // One that forked but did not say where, or said another fork.
  for (const answer of [
    { ok: true },
    { ok: true, address: { environmentId: 'env', chatId: 'ws', agentId: 'another' }, name: 'Atlas (fork)' },
  ]) {
    const unsaid = await createStudioConversationParts(studio(['conversation-fork'], answer)).fork!(fork)
    expect(unsaid).toEqual({ ok: false, message: expect.stringContaining('did not say where it is') })
  }
  const address = { environmentId: 'env', chatId: 'ws', agentId: 'agent-2' }
  const made = await createStudioConversationParts(
    studio(['conversation-fork'], { ok: true, address, name: 'Atlas (fork)' }),
  ).fork!(fork)
  expect(made).toEqual({ ok: true, address, name: 'Atlas (fork)' })
  expect(asked).toEqual(['conversation.fork', 'conversation.fork', 'conversation.fork'])
})

test('a scheduled message whose answer was lost with the connection is asked again under its command id, and kept once', async () => {
  const { StudioError } = await import('../../../../../../packages/client-runtime/src/public')
  const { createStudioConversationParts } = await import('./studioChat')
  // A Studio that keeps a scheduled message once per command id, as its store
  // does, and a window client that gives up the first answer.
  const kept = new Map<string, string>()
  const asked: string[] = []
  let lose = 1
  const client = {
    request: async (method: string, params: { commandId: string; message: string }) => {
      expect(method).toBe('conversation.scheduleSend')
      asked.push(params.commandId)
      if (!kept.has(params.commandId)) kept.set(params.commandId, params.message)
      if (lose > 0) {
        lose--
        throw new StudioError('closed', 'The client is closed.')
      }
      return {}
    },
  }
  const parts = createStudioConversationParts(async () => client as never)
  const key = { workspaceId: 'workspace', agentId: 'agent', workspaceRoot: '/Users/dev/app' }
  expect(await parts.scheduleSend!({ key, message: 'Morning check.', sendAt: 1_900_000_000_000 })).toEqual({ ok: true })
  expect(asked).toHaveLength(2)
  expect(asked[1]).toBe(asked[0])
  expect([...kept.values()]).toEqual(['Morning check.'])
}, 20_000)

test('a queued message whose answer was lost with the connection is asked again under its command id, and held once', async () => {
  const { StudioError } = await import('../../../../../../packages/client-runtime/src/public')
  const { createStudioConversationParts } = await import('./studioChat')
  // A Studio that holds a message once per command id, as its hold does, and
  // a window client that gives up the first answer: closed and replaced
  // before it came, as a client that is replaced or parked gives its requests up.
  const held = new Map<string, string>()
  const asked: Array<{ method: string; commandId: string }> = []
  let lose = 1
  const client = {
    request: async (method: string, params: { commandId: string; message: string; queue?: boolean }) => {
      asked.push({ method, commandId: params.commandId })
      if (params.queue && !held.has(params.commandId)) held.set(params.commandId, params.message)
      if (lose > 0) {
        lose--
        throw new StudioError('closed', 'The client is closed.')
      }
      return {}
    },
  }
  const parts = createStudioConversationParts(async () => client as never)
  const key = { workspaceId: 'workspace', agentId: 'agent', workspaceRoot: '/Users/dev/app' }
  expect(await parts.queue!({ key, message: 'Then the docs.' })).toEqual({ ok: true })
  expect(asked).toHaveLength(2)
  expect(asked[0]!.method).toBe('conversation.send')
  expect(asked[1]!.commandId).toBe(asked[0]!.commandId)
  expect([...held.values()]).toEqual(['Then the docs.'])

  // Lost every time, it is asked a bounded number of times and said in the window's words.
  asked.length = 0
  lose = Number.POSITIVE_INFINITY
  const gaveUp = await parts.queue!({ key, message: 'And the tests.' })
  expect(gaveUp.ok).toBe(false)
  expect(!gaveUp.ok && gaveUp.message).toMatch(/lost its connection to Studio/)
  expect(asked).toHaveLength(4)
  expect(new Set(asked.map((entry) => entry.commandId)).size).toBe(1)

  // A refusal is the Studio's answer, not a lost one: it is not asked again.
  asked.length = 0
  lose = 0
  client.request = async (method, params) => {
    asked.push({ method, commandId: params.commandId })
    throw new StudioError('stale', 'This message was written a while ago and was not sent.')
  }
  const refused = await parts.queue!({ key, message: 'Old words.' })
  expect(refused.ok).toBe(false)
  expect(asked).toHaveLength(1)
}, 20_000)
