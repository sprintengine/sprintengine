// The Studio core's pull request wakes, wired as the core builds them: the
// chat a wake is for is its own agent in its workspace's record, a settled
// workspace is put away, the send goes through a host whose sends are
// Studio's, and a chat provider's usage limit is read off the store.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import { readConversationMessageOrigin } from '../../shared/conversation-runtime'
import {
  PULL_REQUEST_WATCH_ORIGIN,
  STUDIO_PULL_REQUEST_WATCH_CLIENT_ID,
  studioPullRequestWakes,
} from './studio-pull-request-wakes'
import { createPullRequestChatFolders } from '../pull-requests/pull-request-chat-folders'

function wiring() {
  const records = new Map<string, { settledAt?: number | null; agents: Record<string, unknown> }>([
    ['ws-1', { agents: { 'agent-1': {} } }],
    ['ws-2', { settledAt: 1, agents: { 'agent-2': {} } }],
  ])
  const hosts: unknown[] = []
  const commands: unknown[][] = []
  const sessions: ConversationSessionSummary[] = []
  const wakes = studioPullRequestWakes({
    conversations: { listSessions: () => ({ ok: true, sessions }) },
    workspaceRecord: (workspaceId) => records.get(workspaceId) ?? null,
    createHost: (options) => {
      hosts.push(options)
      return {
        resolveKey: (workspaceId: string, agentId: string) =>
          workspaceId === 'ws-1' ? ({ workspaceId, agentId, workspaceRoot: '/Users/dev/acme-app' } as never) : null,
        command: async (...args: unknown[]) => {
          commands.push(args)
          return { ok: true } as never
        },
      }
    },
    rateLimit: (provider) => ({ limited: provider === 'claude', resetsAt: null, windowId: null }),
  })
  return { wakes, hosts, commands }
}

test('a chat is its agent in its workspace record; a settled workspace is put away; a missing one is gone', () => {
  const { wakes } = wiring()
  assert.deepEqual(wakes.chat({ workspaceId: 'ws-1', agentId: 'agent-1' }), { settled: false })
  assert.deepEqual(wakes.chat({ workspaceId: 'ws-2', agentId: 'agent-2' }), { settled: true })
  assert.equal(wakes.chat({ workspaceId: 'ws-1', agentId: 'agent-9' }), null)
  assert.equal(wakes.chat({ workspaceId: 'ws-9', agentId: 'agent-1' }), null)
})

test('a wake goes through a host whose sends are Studio’s, as a send command', async () => {
  const { wakes, hosts, commands } = wiring()
  const sent = await wakes.send({ workspaceId: 'ws-1', agentId: 'agent-1' }, 'News', 'pull-request-watch:1')
  assert.equal(sent.ok, true)
  assert.deepEqual(hosts, [{ origin: PULL_REQUEST_WATCH_ORIGIN }])
  assert.deepEqual(readConversationMessageOrigin(PULL_REQUEST_WATCH_ORIGIN), {
    kind: 'studio',
    reason: 'pull-request-watch',
  })
  assert.deepEqual(commands[0].slice(1), [
    STUDIO_PULL_REQUEST_WATCH_CLIENT_ID,
    'pull-request-watch:1',
    { kind: 'send', message: 'News' },
  ])
  const nowhere = await wakes.send({ workspaceId: 'ws-2', agentId: 'agent-2' }, 'News', 'pull-request-watch:2')
  assert.equal(nowhere.ok, false)
})

test('a chat provider’s usage limit is read off the store; one with no plan never holds a wake', () => {
  const { wakes } = wiring()
  assert.equal(wakes.usageLimit?.('claude-agent').limited, true)
  assert.equal(wakes.usageLimit?.('some-other-provider').limited, false)
})

// A WSL distribution's server and an SSH machine's hold no record of the
// chats they run: the desktop keeps those, and hands each a folder with every
// start. A watch an agent there asked for is that server's, so the server
// finds the chat by what it runs, and by the folder it kept for it.
function serverWiring(dataDir: string, sessions: Array<ConversationSessionSummary & { root: string }>) {
  const commands: unknown[][] = []
  const wakes = studioPullRequestWakes({
    conversations: {
      listSessions: () => ({ ok: true, sessions }),
      sessionWorkspaceRoot: (sessionId) => sessions.find((session) => session.sessionId === sessionId)?.root ?? null,
    },
    workspaceRecord: () => null,
    workspaceRemoved: (workspaceId) => workspaceId === 'ws-removed',
    chatFolders: createPullRequestChatFolders({ dataDir }),
    createHost: () => ({
      resolveKey: () => null,
      command: async (...args: unknown[]) => {
        commands.push(args)
        return { ok: true } as never
      },
    }),
    rateLimit: () => ({ limited: false, resetsAt: null, windowId: null }),
  })
  return { wakes, commands }
}

const liveSession = (over: Partial<ConversationSessionSummary> & { root: string }) =>
  ({
    sessionId: 'conv_1',
    workspaceId: 'ws-wsl',
    agentId: 'agent-1',
    providerId: 'claude-agent',
    modelId: 'default',
    status: 'ready',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }) as ConversationSessionSummary & { root: string }

test('on a server that holds no record of the chat, a watched chat is found by its session and woken in its folder', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pr-wakes-server-'))
  try {
    const { wakes, commands } = serverWiring(dataDir, [liveSession({ root: '/home/dev/acme-app' })])
    const key = { workspaceId: 'ws-wsl', agentId: 'agent-1' }
    wakes.remember?.(key)
    // The bug: answered null here, so the first wake stopped the watch.
    assert.deepEqual(wakes.chat(key), { settled: false })
    const sent = await wakes.send(key, 'News', 'pull-request-watch:1')
    assert.equal(sent.ok, true)
    assert.deepEqual(commands[0], [
      { workspaceRoot: '/home/dev/acme-app', workspaceId: 'ws-wsl', agentId: 'agent-1' },
      STUDIO_PULL_REQUEST_WATCH_CLIENT_ID,
      'pull-request-watch:1',
      { kind: 'send', message: 'News' },
    ])
    // A chat it has never run, and one in a workspace the registry removed, are gone.
    assert.equal(wakes.chat({ workspaceId: 'ws-wsl', agentId: 'agent-9' }), null)
    assert.equal(wakes.chat({ workspaceId: 'ws-removed', agentId: 'agent-1' }), null)
    // What `remember` wrote is on disk before the folder goes, or the cleanup races the write.
    await wakes.flushFolders?.()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('the folder a watched chat works in outlives the server: after a restart, with no session yet, it is woken there', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pr-wakes-server-'))
  try {
    const key = { workspaceId: 'ws-wsl', agentId: 'agent-1' }
    const before = serverWiring(dataDir, [liveSession({ root: '/home/dev/acme-app' })])
    before.wakes.remember?.(key)
    await before.wakes.flushFolders?.()

    // The server started again: the runtime holds no session for the chat yet.
    const after = serverWiring(dataDir, [])
    assert.deepEqual(after.wakes.chat(key), { settled: false })
    const sent = await after.wakes.send(key, 'News', 'pull-request-watch:2')
    assert.equal(sent.ok, true)
    assert.deepEqual(after.commands[0]?.[0], {
      workspaceRoot: '/home/dev/acme-app',
      workspaceId: 'ws-wsl',
      agentId: 'agent-1',
    })

    // Once no watch and no waiting news names the chat, its folder is let go.
    after.wakes.retain?.([])
    await after.wakes.flushFolders?.()
    assert.equal(serverWiring(dataDir, []).wakes.chat(key), null)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
