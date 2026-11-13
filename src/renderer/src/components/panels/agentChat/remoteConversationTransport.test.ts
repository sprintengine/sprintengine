import { afterEach, expect, test, vi } from 'vitest'

import { createRemoteConversationTransport } from './conversationTransport'

// The calls a chat on a paired machine makes, as the transport puts them to
// main: what each carries over, and what it leaves for that machine to say.

const key = { connectionId: 'connection', workspaceId: 'remote-workspace', agentId: 'remote-agent' }

function transportWith(api: Record<string, unknown>) {
  vi.stubGlobal('window', { api })
  return createRemoteConversationTransport({
    key,
    machineName: 'mac-mini',
    offer: () => ({ via: 'paired-lane', capabilities: [], access: 'operate', modelCatalog: false }),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('a send hands main the request, saying only what it means, and keeps here what only this machine reads', async () => {
  const meshConversationSend = vi.fn(async () => ({ ok: true as const }))
  const transport = transportWith({ meshConversationSend })
  await transport.send({ sessionId: 'remote-session', message: 'Why does it flake?', mode: 'ask' })
  await transport.send({
    sessionId: 'remote-session',
    commandId: '7f3c1a2e-0000-4000-8000-000000000000',
    localTurnId: 'bubble-1',
    reasoningEffort: 'high',
    origin: { kind: 'studio' } as never,
    message: 'Fix it',
    mode: 'default',
    skills: [{ id: 'review', sourcePath: '/Users/dev/.claude/skills/review/SKILL.md' }],
    mentions: [{ path: 'src/app.ts', kind: 'file' }],
    files: [{ path: '/Users/dev/brief.pdf' }],
    steer: true,
    composedAt: 1_700_000_000_000,
    confirmedStale: true,
  })
  expect(meshConversationSend.mock.calls).toEqual([
    [{ key, message: 'Why does it flake?', mode: 'ask' }],
    [
      {
        key,
        message: 'Fix it',
        skills: [{ id: 'review', sourcePath: '/Users/dev/.claude/skills/review/SKILL.md' }],
        mentions: [{ path: 'src/app.ts', kind: 'file' }],
        files: [{ path: '/Users/dev/brief.pdf' }],
        steer: true,
        composedAt: 1_700_000_000_000,
        confirmedStale: true,
      },
    ],
  ])
})

test('a queued message goes as the same request, held there, under the chat key there', async () => {
  const meshConversationSend = vi.fn(async () => ({ ok: true as const }))
  const transport = transportWith({ meshConversationSend })
  // The view's key names this machine's folder, which means nothing over there.
  const viewKey = { workspaceRoot: '/Users/dev/app', workspaceId: 'here', agentId: 'here-agent' }
  await transport.queue?.({ key: viewKey, message: 'next', skills: [{ id: 'review' }] })
  expect(meshConversationSend.mock.calls).toEqual([[{ key, message: 'next', skills: [{ id: 'review' }], queue: true }]])
})

test('a paired chat names its environment: the machine as the person calls it, the id its Studio said once it has', () => {
  vi.stubGlobal('window', { api: {} })
  let said: string | null = null
  const transport = createRemoteConversationTransport({
    key,
    machineName: 'mac-mini',
    environmentId: () => said,
    offer: () => null,
  })
  const before = transport.environment
  expect(before).toEqual({
    id: null,
    label: 'mac-mini',
    lane: { connectionId: 'connection', workspaceId: 'remote-workspace', commandsKey: expect.any(String) },
  })
  // Held while the id is, as views key memos on it.
  expect(transport.environment).toBe(before)
  said = 'env-mac-mini'
  expect(transport.environment.id).toBe('env-mac-mini')
  expect(transport.environment).not.toBe(before)
  // No transport says a kind, or the old identity fields.
  for (const field of ['kind', 'machineName', 'remoteExtensions', 'commandsFolder', 'environmentId'])
    expect(field in transport, field).toBe(false)
})
