import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { applyWorkspaceFieldsPatch, type WorkspaceFieldsPatch } from '../../shared/workspace-sync'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import { projectlessChatsRootIn } from '../../shared/projectless-chats'
import { workspaceStorePath } from '../workspace-store'
import { OWN_SETTLE_GRACE_MS } from './conversation-lifecycle'
import { createConversationMove, moveConversationStorage } from './conversation-move'
import { createConversationTools } from './conversation-tools'

// A chat moved to another folder, and so to that folder's project: at once for
// a chat at rest, once the turn ends for an agent moving its own chat.

const CHAT_FOLDER = '/Users/dev/.sprintengine/chats/2026-11-08-make-a-todo-app-ab12cd34'
const PROJECT = '/Users/dev/code/todo-app'

function fixture(options: { record?: Partial<WorkspaceRegistryRecord>; working?: boolean } = {}) {
  const stored = {
    id: 'ws-1',
    name: 'Make a todo app',
    folderPath: CHAT_FOLDER,
    agents: {},
    ...options.record,
  } as WorkspaceRegistryRecord
  const writes: Array<{ workspaceId: string; patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }> = []
  const steps: string[] = []
  const state = { working: options.working ?? false, onlyTurnOf: 'agent-1' as string | null, messageWaiting: false }
  const folders = new Set([PROJECT, `${PROJECT}/web`, CHAT_FOLDER])
  const timers: Array<{ job: () => void; cancelled: boolean; ms: number }> = []
  const logs: string[] = []
  const mover = createConversationMove({
    getRecord: (workspaceId) => (workspaceId === stored.id ? stored : null),
    updateWorkspaceFields: (workspaceId, patch, actor) => {
      steps.push('write')
      writes.push({ workspaceId, patch, actor })
      applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    isFolder: async (path) => folders.has(path),
    isWorking: () => state.working,
    onlyTurnOf: (_workspaceId, agentId) => state.onlyTurnOf === agentId,
    messageWaiting: () => state.messageWaiting,
    stopChats: async (workspaceId) => {
      steps.push(`stop ${workspaceId}`)
    },
    moveStorage: async (workspaceId, from, to) => {
      steps.push(`move ${workspaceId} ${from} -> ${to}`)
    },
    schedule: (job, ms) => {
      const timer = { job, cancelled: false, ms }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    log: (message) => logs.push(message),
  })
  const changeProject = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: {} as never,
    moveChat: mover.move,
  }).find((tool) => tool.name === 'conversation.change_project')!
  const elapse = async () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.job()
    // The move the timer starts runs on.
    await new Promise((resolve) => setImmediate(resolve))
  }
  const event = (type: ConversationEvent['type'], fields: Partial<ConversationEvent> = {}) =>
    mover.onConversationEvent({
      id: `evt-${type}`,
      sessionId: 'conv-1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      providerId: 'mock',
      modelId: 'default',
      type,
      createdAt: 1,
      ...fields,
    })
  return { stored, writes, steps, state, folders, timers, logs, mover, changeProject, elapse, event }
}

const OWN_AGENT: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1' } }
const structured = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, unknown>
const errorCode = (result: { structuredContent?: unknown }) =>
  (structured(result).error as { code?: string } | undefined)?.code

test('a chat at rest is moved at once: its sessions end, its history goes, then the record names the folder', async () => {
  const f = fixture()
  const result = await f.changeProject.handler({ workspaceId: 'ws-1', folder: `${PROJECT}/` }, undefined)
  assert.equal(result.isError, undefined)
  assert.deepEqual(structured(result), { ok: true, workspaceId: 'ws-1', folderPath: PROJECT, project: PROJECT })
  assert.deepEqual(f.steps, ['stop ws-1', `move ws-1 ${CHAT_FOLDER} -> ${PROJECT}`, 'write'])
  assert.deepEqual(f.writes, [{ workspaceId: 'ws-1', patch: { folderPath: PROJECT }, actor: 'gateway' }])
  assert.equal(f.stored.folderPath, PROJECT)
})

test('an agent moving its own chat mid-turn is told it moves when the turn ends, and it does', async () => {
  const f = fixture({ working: true })
  const result = await f.changeProject.handler({ folder: PROJECT }, OWN_AGENT)
  assert.equal(result.isError, undefined)
  assert.equal(structured(result).movesWhenTurnEnds, true)
  assert.match(String(structured(result).note), /next turn starts in the new folder/u)
  assert.deepEqual(f.steps, [], 'nothing moves while the turn runs')
  assert.equal(f.mover.movesWhenTurnEnds('ws-1'), PROJECT)

  f.event('turn_completed')
  assert.equal(f.timers[0]?.ms, OWN_SETTLE_GRACE_MS)
  f.state.working = false
  await f.elapse()
  assert.deepEqual(f.steps, ['stop ws-1', `move ws-1 ${CHAT_FOLDER} -> ${PROJECT}`, 'write'])
  assert.equal(f.stored.folderPath, PROJECT)
  assert.equal(f.mover.movesWhenTurnEnds('ws-1'), null)
})

test('a move waiting on the turn is let go by a message, a failed turn, or a message waiting at its end', async () => {
  for (const [what, act] of [
    ['a message', (f: ReturnType<typeof fixture>) => f.event('user_message')],
    ['a failed turn', (f: ReturnType<typeof fixture>) => f.event('turn_failed')],
  ] as const) {
    const f = fixture({ working: true })
    await f.changeProject.handler({ folder: PROJECT }, OWN_AGENT)
    act(f)
    f.event('turn_completed')
    f.state.working = false
    await f.elapse()
    assert.deepEqual(f.steps, [], what)
    assert.equal(f.stored.folderPath, CHAT_FOLDER, what)
  }

  const f = fixture({ working: true })
  await f.changeProject.handler({ folder: PROJECT }, OWN_AGENT)
  f.event('turn_completed')
  f.state.working = false
  f.state.messageWaiting = true
  await f.elapse()
  assert.deepEqual(f.steps, [])
  assert.match(f.logs[0] ?? '', /left where it is: a message is waiting/u)
})

test('anyone else asking while an agent in the chat works is refused', async () => {
  const f = fixture({ working: true })
  const result = await f.changeProject.handler({ workspaceId: 'ws-1', folder: PROJECT }, undefined)
  assert.equal(errorCode(result), 'working')
  assert.deepEqual(f.steps, [])
})

test('a folder in a project files the chat under the project; its own folder again changes nothing', async () => {
  const f = fixture()
  const inside = await f.mover.move('ws-1', `${PROJECT}/web`, 'gateway')
  assert.ok(inside.ok)
  assert.equal(inside.folderPath, `${PROJECT}/web`)

  f.steps.length = 0
  const again = await f.mover.move('ws-1', `${PROJECT}/web`, 'gateway')
  assert.ok(again.ok)
  assert.deepEqual(f.steps, [])
})

test('a folder that is not there, not absolute, or the no-project root is refused', async () => {
  const f = fixture()
  assert.equal(
    errorCode(await f.changeProject.handler({ workspaceId: 'ws-1', folder: '/Users/dev/nowhere' })),
    'not_a_folder',
  )
  assert.equal(
    errorCode(await f.changeProject.handler({ workspaceId: 'ws-1', folder: 'code/todo-app' })),
    'invalid_arguments',
  )
  assert.equal(
    errorCode(await f.changeProject.handler({ workspaceId: 'ws-1', folder: projectlessChatsRootIn('/Users/dev') })),
    'invalid_arguments',
  )
  assert.equal(errorCode(await f.changeProject.handler({ folder: PROJECT })), 'invalid_arguments', 'no chat named')
  assert.deepEqual(f.steps, [])
})

test('a chat in a worktree, on another machine, or opened from a paired one stays where it is', async () => {
  const cases: Array<[string, Partial<WorkspaceRegistryRecord>]> = [
    ['a worktree chat', { worktree: { branch: 'agent/x', repoRoot: '/Users/dev/code/app' } as never }],
    ['an agent in a worktree', { agents: { a: { execution: { mode: 'worktree', cwd: '/x' } } } as never }],
    ['a WSL chat', { hostId: 'wsl:Ubuntu' as never }],
    ['a paired chat', { remoteOrigin: { machineId: 'mac-mini' } as never }],
  ]
  for (const [what, record] of cases) {
    const f = fixture({ record })
    const result = await f.changeProject.handler({ workspaceId: 'ws-1', folder: PROJECT })
    assert.equal(errorCode(result), 'not_movable', what)
    assert.deepEqual(f.steps, [], what)
  }
})

test('a chat recorded as on this computer by name is moved like any', async () => {
  const f = fixture({ record: { hostId: 'local' as never } })
  const result = await f.mover.move('ws-1', PROJECT, 'gateway')
  assert.ok(result.ok)
  assert.equal(f.stored.folderPath, PROJECT)
})

test('a history that cannot be moved leaves the record as it was', async () => {
  const f = fixture()
  const mover = createConversationMove({
    getRecord: () => f.stored,
    updateWorkspaceFields: () => assert.fail('the record is not written'),
    isFolder: async () => true,
    isWorking: () => false,
    stopChats: async () => undefined,
    moveStorage: async () => {
      throw new Error('the new project already holds a history for this chat')
    },
  })
  const result = await mover.move('ws-1', PROJECT, 'gateway')
  assert.equal(result.ok, false)
  assert.equal(result.ok ? null : result.code, 'move_failed')
  assert.equal(f.stored.folderPath, CHAT_FOLDER)
})

// ── The store folder on disk ───────────────────────────────────────────────

let home: string
let previousHome: string | undefined
beforeEach(() => {
  previousHome = process.env.SPRINTENGINE_STORE_HOME
  home = mkdtempSync(join(tmpdir(), 'conversation-move-'))
  process.env.SPRINTENGINE_STORE_HOME = home
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.SPRINTENGINE_STORE_HOME
  else process.env.SPRINTENGINE_STORE_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

test("the chat's store folder goes from the no-project store to the new project's, and nothing else does", async () => {
  const chatFolder = join(projectlessChatsRootIn(home), '2026-11-08-make-an-app-ab12cd34')
  const project = join(home, 'code', 'todo-app')
  mkdirSync(chatFolder, { recursive: true })
  mkdirSync(project, { recursive: true })
  const from = workspaceStorePath(chatFolder, 'conversations', 'ws-1')
  const other = workspaceStorePath(chatFolder, 'conversations', 'ws-2')
  mkdirSync(join(from, 'agent-1.tools'), { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(from, 'agent-1.jsonl'), '{"type":"user_message"}\n')
  writeFileSync(join(from, 'agent-1.tools', 'tool-1.json'), '{}')

  await moveConversationStorage('ws-1', chatFolder, project)

  const to = workspaceStorePath(project, 'conversations', 'ws-1')
  assert.notEqual(to, from)
  assert.equal(readFileSync(join(to, 'agent-1.jsonl'), 'utf8'), '{"type":"user_message"}\n')
  assert.equal(existsSync(join(to, 'agent-1.tools', 'tool-1.json')), true)
  assert.equal(existsSync(from), false)
  assert.equal(existsSync(other), true, "another chat's history stays")

  // A store already holding the chat's history is not written over.
  mkdirSync(from, { recursive: true })
  await assert.rejects(moveConversationStorage('ws-1', chatFolder, project), /already holds a history/u)
  // A chat with no history yet has nothing to move.
  await moveConversationStorage('ws-3', chatFolder, project)
})
