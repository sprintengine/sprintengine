import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import { createStudioConversationBackend } from './studio-conversation-backend'

const key = { workspaceRoot: '/Users/dev/app', workspaceId: 'ws-1', agentId: 'agent-1' }
const session = (extra: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary => ({
  sessionId: 's-1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: 'claude-agent',
  modelId: 'default',
  status: 'ready',
  createdAt: 1,
  updatedAt: 1,
  permissionPreset: 'manual',
  ...extra,
})

function backend(sessions: ConversationSessionSummary[]) {
  return createStudioConversationBackend({
    host: { permissionOf: () => 'manual' } as never,
    launch: async () => ({ ok: false, code: 'unused', message: 'unused' }),
    listSessions: () => ({ ok: true, sessions }),
    stopSession: async () => ({ ok: true, session: session({ status: 'stopped' }) }),
    getWorkspaceAgents: () => [],
  })
}

test('a chat whose session may use tools unasked counts as bypass for a ceiling', () => {
  assert.equal(backend([session()]).permissionOf(key), 'manual')
  assert.equal(backend([session({ allowsUnaskedTools: true })]).permissionOf(key), 'bypass')
  // A stopped session's tools are not in force.
  assert.equal(backend([session({ allowsUnaskedTools: true, status: 'stopped' })]).permissionOf(key), 'manual')
})

test('replies are redacted as the tailnet lane redacts them', () => {
  assert.deepEqual(backend([]).redact({ headers: { authorization: 'Bearer x' }, usage: { inputTokens: 4 } }), {
    headers: { authorization: '[redacted]' },
    usage: { inputTokens: 4 },
  })
})

test('a create carries New chat’s options to the launch service, and "No project" gets a folder of its own', async () => {
  const launched: unknown[] = []
  const made: Array<string | null> = []
  const create = createStudioConversationBackend({
    host: { permissionOf: () => 'manual' } as never,
    launch: async (request) => {
      launched.push(request)
      return { ok: false, code: 'stop_here', message: 'stop here' }
    },
    listSessions: () => ({ ok: true, sessions: [] }),
    stopSession: async () => ({ ok: true, session: session() }),
    getWorkspaceAgents: () => [],
    makeProjectlessFolder: async (prompt) => {
      made.push(prompt)
      return '/Users/dev/No project/fix-it-abc123'
    },
  }).create
  await create(
    { workspaceId: 'ws-1', newChat: true, worktree: true, worktreeName: 'fix', effort: 'high', prompt: 'fix it' },
    'launch-1',
  )
  await create({ workspaceId: 'ws-1', newChat: true, inWorktree: '/Users/dev/app-wt' }, 'launch-2')
  await create({ noProject: true, prompt: 'fix it' }, 'launch-3')
  assert.deepEqual(launched, [
    {
      workspaceId: 'ws-1',
      newChat: true,
      newWorktree: true,
      worktreeName: 'fix',
      reasoningEffort: 'high',
      prompt: 'fix it',
      launchCommandId: 'launch-1',
    },
    { workspaceId: 'ws-1', newChat: true, existingWorktreePath: '/Users/dev/app-wt', launchCommandId: 'launch-2' },
    { newChatIn: { folderPath: '/Users/dev/No project/fix-it-abc123' }, prompt: 'fix it', launchCommandId: 'launch-3' },
  ])
  assert.deepEqual(made, ['fix it'])
})

test('a "No project" create the launch refuses leaves no empty folder behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'projectless-'))
  try {
    const folder = join(root, 'fix-it-abc123')
    const outcome = await createStudioConversationBackend({
      host: { permissionOf: () => 'manual' } as never,
      launch: async () => ({ ok: false, code: 'unknown_cli', message: 'no such CLI' }),
      listSessions: () => ({ ok: true, sessions: [] }),
      stopSession: async () => ({ ok: true, session: session() }),
      getWorkspaceAgents: () => [],
      makeProjectlessFolder: async () => {
        mkdirSync(folder)
        return folder
      },
    }).create({ noProject: true, prompt: 'fix it' }, 'launch-1')
    assert.equal(outcome.ok, false)
    assert.equal(existsSync(folder), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
