import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import { createTailnetFileUploads } from '../automation/tailnet/tailnet-file-uploads'
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

test('a keyed send’s uploads are staged with the host under the client, for the chat’s session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-backend-uploads-'))
  try {
    const registered: Array<Record<string, unknown>> = []
    const staged = createStudioConversationBackend({
      host: {
        list: async () => [
          { workspaceId: 'ws-1', agentId: 'agent-1', sessionId: 's-1', capabilities: { images: true } },
          { workspaceId: 'ws-1', agentId: 'words-only', sessionId: 's-2', capabilities: { images: false } },
        ],
        registerUpload: (input: Record<string, unknown>) => {
          registered.push(input)
          return `id-${registered.length}`
        },
      } as never,
      launch: async () => ({ ok: false, code: 'unused', message: 'unused' }),
      listSessions: () => ({ ok: true, sessions: [] }),
      stopSession: async () => ({ ok: true, session: session({ status: 'stopped' }) }),
      getWorkspaceAgents: () => [],
      fileUploads: createTailnetFileUploads({ root }),
    }).followed!.stageUploads!
    const made = await staged(key, 'client:phone', [
      { purpose: 'picture', mediaType: 'image/png', name: 'shot.png', bytes: Buffer.from('png') },
      { purpose: 'attachment', mediaType: 'text/plain', name: 'notes.txt', bytes: Buffer.from('notes') },
    ])
    assert.deepEqual(made, { ok: true, ids: ['id-1', 'id-2'] })
    assert.deepEqual(
      registered.map(({ deviceId, sessionId, name, kind, bytes }) => ({ deviceId, sessionId, name, kind, bytes })),
      [
        { deviceId: 'client:phone', sessionId: 's-1', name: 'shot.png', kind: undefined, bytes: 3 },
        { deviceId: 'client:phone', sessionId: 's-1', name: 'notes.txt', kind: 'file', bytes: 5 },
      ],
    )
    // The file is kept under Studio's store, the picture where the host reads it into the turn.
    assert.ok(String(registered[1]!.path).startsWith(root))
    assert.ok(existsSync(String(registered[0]!.path)))
    // A chat whose agent reads no pictures takes none, and nothing is left registered.
    const refused = await staged({ ...key, agentId: 'words-only' }, 'client:phone', [
      { purpose: 'picture', mediaType: 'image/png', bytes: Buffer.from('png') },
    ])
    assert.equal(refused.ok, false)
    assert.equal(registered.length, 2)
    const unknown = await staged({ ...key, agentId: 'gone' }, 'client:phone', [
      { purpose: 'picture', mediaType: 'image/png', bytes: Buffer.from('png') },
    ])
    assert.deepEqual(unknown.ok ? null : unknown.code, 'not_found')
    for (const entry of registered) (entry.dispose as () => void)()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a chat’s picture is read through the host’s record of it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'studio-backend-picture-'))
  try {
    // A PNG's signature is what makes it one.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    writeFileSync(join(folder, 'step.png'), png)
    const read = createStudioConversationBackend({
      host: {
        toolImagePath: async (_key: unknown, toolUseId: string) =>
          toolUseId === 'tool-1' ? { ok: true, path: join(folder, 'step.png') } : { ok: false, code: 'unknown_image' },
        sentImage: async (_key: unknown, ref: string) =>
          ref === 'ref-1'
            ? { ok: true, mediaType: 'image/jpeg', bytes: Buffer.from('jpeg') }
            : { ok: false, code: 'unknown_image' },
      } as never,
      launch: async () => ({ ok: false, code: 'unused', message: 'unused' }),
      listSessions: () => ({ ok: true, sessions: [] }),
      stopSession: async () => ({ ok: true, session: session({ status: 'stopped' }) }),
      getWorkspaceAgents: () => [],
    }).followed!.picture!
    const step = await read(key, { toolUseId: 'tool-1' })
    assert.deepEqual(step.ok && { mediaType: step.mediaType, bytes: [...step.bytes] }, {
      mediaType: 'image/png',
      bytes: [...png],
    })
    const sent = await read(key, { attachment: 'ref-1' })
    assert.equal(sent.ok && sent.mediaType, 'image/jpeg')
    assert.equal((await read(key, { toolUseId: 'tool-2' })).ok, false)
    assert.equal((await read(key, { attachment: 'ref-2' })).ok, false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
