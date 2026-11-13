import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  STUDIO_WORKTREES_METHODS,
  type SettledChatDeletionOutcome,
  type SettledChatDeletionPlan,
  type StudioScope,
  type WorktreeDependencyInstallView,
  type WorktreePoolSettings,
  type WorktreePoolSnapshot,
} from '../../../packages/studio-protocol/src/public'
import { worktreeLeases } from '../../main/worktree-leases'
import type { StudioWorktreePool } from '../core/studio-worktree-pool'
import { createStudioWorktrees } from '../worktrees/studio-worktrees'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// The worktree pool, the agents' worktrees and settled-chat deletion over the
// Studio socket, answered by the real service (`studio-worktrees.ts`) over a
// pool that records what it is asked: what an owner runs, that a retried step
// runs once, the streams, what only an owner reaches, what a paired device's
// chat grant reaches (a settled chat's Delete), and a folder on an SSH
// machine refused in words.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SETTINGS: WorktreePoolSettings = {
  enabled: true,
  keepIdle: 3,
  maxSlots: 12,
  diskLimitGb: null,
  idleReturnMinutes: 120,
  dependencyInstall: {},
}

function fakePool() {
  const asked: Array<[string, unknown]> = []
  const poolListeners = new Set<(snapshot: WorktreePoolSnapshot) => void>()
  const installListeners = new Set<(view: WorktreeDependencyInstallView) => void>()
  let settings = { ...SETTINGS }
  const snapshot = (repoRoot: string): WorktreePoolSnapshot => ({
    poolId: 'pool-1',
    repoRoot,
    containerPath: `${repoRoot}-worktrees`,
    heldByOtherInstance: false,
    defaultRef: 'origin/main',
    lastFetchAt: null,
    slots: [],
  })
  const deletions: Array<{ actor: string; workspaceIds: string[] }> = []
  const pool = {
    pool: {
      snapshot: async (repoRoot: string) => (asked.push(['snapshot', repoRoot]), snapshot(repoRoot)),
      getSettings: async () => settings,
      updateSettings: async (patch: Partial<WorktreePoolSettings>) => {
        asked.push(['updateSettings', patch])
        settings = { ...settings, ...patch }
        return settings
      },
      action: async (input: unknown) => (asked.push(['action', input]), { ok: true as const, message: null }),
    },
    installer: {
      list: () => [],
      cancel: (id: string) => (asked.push(['cancel', id]), id === 'install-1'),
    },
    liveWorkPaths: async () => [],
    knownWorkspaceIds: () => null,
    onPoolChanged: (listener: (snapshot: WorktreePoolSnapshot) => void) => {
      poolListeners.add(listener)
      return () => poolListeners.delete(listener)
    },
    onInstallChanged: (listener: (view: WorktreeDependencyInstallView) => void) => {
      installListeners.add(listener)
      return () => installListeners.delete(listener)
    },
    settledChatDeletion: (actor: 'ui' | 'mobile') => ({
      plan: async (workspaceIds: string[]): Promise<SettledChatDeletionPlan[]> =>
        workspaceIds.map((workspaceId) => ({ workspaceId, remoteMachine: null, worktrees: [] })),
      delete: async (workspaceIds: string[]): Promise<SettledChatDeletionOutcome[]> => {
        deletions.push({ actor, workspaceIds })
        return workspaceIds.map((workspaceId) => ({ workspaceId, ok: true as const, worktrees: [] }))
      },
    }),
  }
  return {
    asked,
    deletions,
    snapshot,
    movePool: (repoRoot: string) => {
      for (const listener of poolListeners) listener(snapshot(repoRoot))
    },
    worktrees: createStudioWorktrees(pool as unknown as StudioWorktreePool),
  }
}

async function serve(options: { withWorktrees?: boolean } = {}) {
  const pool = fakePool()
  const started = await startTestServer(options.withWorktrees === false ? {} : { worktrees: pool.worktrees })
  cleanups.push(() => started.dispose())
  return { started, pool }
}

async function client(path: string, token: string) {
  const line = await connectLineClient(path)
  cleanups.push(() => line.close())
  line.send(hello({ token }))
  const welcome = await line.next((frame) => frame.t === 'welcome')
  let seq = 0
  return {
    line,
    welcome,
    async request(method: string, params: unknown) {
      const id = `r${++seq}`
      line.send({ t: 'req', id, method, params })
      return line.next((frame) => frame.t === 'res' && frame.id === id)
    },
    async subscribe(topic: string, params: unknown) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params })
      return id
    },
  }
}

type Frame = { t: string; ok?: boolean; error?: { code: string; message?: string }; result?: unknown }
const codeOf = (frame: Frame) => (frame.t === 'res' && !frame.ok ? (frame.error?.code ?? null) : null)
const resultOf = <T>(frame: Frame) => {
  assert.equal(codeOf(frame), null, JSON.stringify(frame))
  return frame.result as T
}
let commands = 0
const cid = () => `c${++commands}`

test('a Studio advertises its worktrees only where its core gives them', async () => {
  const without = await serve({ withWorktrees: false })
  const owner = await client(without.started.path, OWNER_TOKEN)
  const capabilities = (welcome: unknown) => (welcome as { capabilities: string[] }).capabilities
  assert.equal(capabilities(owner.welcome).includes('worktrees'), false)
  assert.equal(codeOf(await owner.request('worktrees.poolSettings', {})), 'unavailable')
  const served = await serve()
  const window = await client(served.started.path, OWNER_TOKEN)
  assert.equal(capabilities(window.welcome).includes('worktrees'), true)
})

test('an owner reads and sets the pool, acts on a slot and hears the pool move; a retried step runs once', async () => {
  const { started, pool } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const repoRoot = '/Users/dev/app'
  assert.deepEqual(resultOf(await owner.request('worktrees.poolSettings', {})), SETTINGS)
  const set = { commandId: 'set-once', patch: { keepIdle: 5, unknown: true } }
  const changed = resultOf<WorktreePoolSettings>(await owner.request('worktrees.setPoolSettings', set))
  assert.equal(changed.keepIdle, 5)
  assert.deepEqual(resultOf(await owner.request('worktrees.setPoolSettings', set)), changed)
  // Asked once, and only with what a pool's settings hold.
  assert.deepEqual(
    pool.asked.filter(([what]) => what === 'updateSettings'),
    [['updateSettings', { keepIdle: 5 }]],
  )
  assert.deepEqual(resultOf(await owner.request('worktrees.poolSnapshot', { repoRoot })), {
    snapshot: pool.snapshot(repoRoot),
  })
  const held = { kind: 'held', repoRoot, slotId: 'slot-1', action: 'stash', message: 'x'.repeat(3_000) }
  resultOf(await owner.request('worktrees.poolAction', { commandId: cid(), action: held }))
  const acted = pool.asked.find(([what]) => what === 'action')?.[1] as { message: string }
  assert.equal(acted.message.length, 2_000)
  assert.equal(
    codeOf(
      await owner.request('worktrees.poolAction', {
        commandId: cid(),
        action: { kind: 'held', repoRoot, slotId: 'slot-1', action: 'force' },
      }),
    ),
    'invalid_params',
  )
  assert.deepEqual(resultOf(await owner.request('worktrees.installs', {})), { installs: [] })
  assert.deepEqual(resultOf(await owner.request('worktrees.cancelInstall', { commandId: cid(), id: 'install-1' })), {
    cancelled: true,
  })
  const followed = await owner.subscribe('worktrees.poolChanged', {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  pool.movePool(repoRoot)
  const pushed = await owner.line.next((frame) => frame.t === 'push' && frame.sub === followed)
  assert.deepEqual(pushed.t === 'push' && pushed.payload, pool.snapshot(repoRoot))
})

test('a branch the new worktree would take that git would read as an option is refused before git runs', async () => {
  const { started } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const input = {
    repoRoot: '/Users/dev/app',
    containerPath: '/Users/dev/app-worktrees',
    destinationPath: '/Users/dev/app-worktrees/one',
    branchName: '--orphan',
    baseRef: 'HEAD',
  }
  assert.equal(codeOf(await owner.request('worktrees.create', { commandId: cid(), input })), 'invalid_params')
  assert.equal(
    codeOf(
      await owner.request('worktrees.create', {
        commandId: cid(),
        input: { ...input, branchName: 'ok', baseRef: '-b' },
      }),
    ),
    'invalid_params',
  )
})

test('a folder on an SSH machine is refused in words, never read on this disk', async () => {
  const { started } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const app = 'ssh://build-box/home/dev/app'
  for (const [method, params] of [
    ['worktrees.poolSnapshot', { repoRoot: app }],
    [
      'worktrees.create',
      {
        commandId: cid(),
        input: {
          repoRoot: app,
          containerPath: `${app}-w`,
          destinationPath: `${app}-w/one`,
          branchName: 'b',
          baseRef: 'HEAD',
        },
      },
    ],
    ['worktrees.cleanupAgents', { commandId: cid(), input: { repoRoot: '/Users/dev/app', protectedPaths: [app] } }],
  ] as const) {
    const answer = await owner.request(method, params)
    assert.deepEqual([method, codeOf(answer)], [method, 'unavailable'])
    assert.match(String((answer as Frame).error?.message), /Not available for SSH machines yet/)
  }
})

test('a window’s restore of a worktree waits for a removal of its path under way, holding it shared', async () => {
  const { started } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'studio-worktrees-')))
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }))
  // Not one of the app's worktrees, so the restore itself refuses at once.
  const path = join(scratch, 'elsewhere', 'app-01')
  const removing = await worktreeLeases.tryExclusive(path, 'this worktree is being removed')
  assert.ok('release' in removing)
  let done = false
  const restoring = owner
    .request('worktrees.restore', { commandId: cid(), input: { repoRoot: scratch, path, branchName: 'agent/app' } })
    .finally(() => (done = true))
  for (let tries = 0; (await worktreeLeases.holders(path)).length < 2 && tries < 200; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(done, false, 'waits while the removal runs')
  assert.deepEqual(
    (await worktreeLeases.holders(path)).map(({ kind, reason, waiting }) => ({ kind, reason, waiting })),
    [
      { kind: 'exclusive', reason: 'this worktree is being removed', waiting: false },
      { kind: 'shared', reason: 'its chat is bringing it back', waiting: true },
    ],
  )
  removing.release()
  const restored = resultOf<{ ok: boolean; message?: string }>(await restoring)
  assert.equal(restored.ok, false)
  assert.match(restored.message ?? '', /not one of the app's worktrees/)
  assert.deepEqual(await worktreeLeases.holders(path), [], 'let go once it is done')
})

test('the pool and the agents’ worktrees are an owner’s, whatever a paired app holds', async () => {
  const { started } = await serve()
  const every: StudioScope[] = [
    'conversation:read',
    'conversation:operate',
    'conversation:create',
    'providers:read',
    'files:read',
    'workspaces:read',
    'files:write',
    'settings:write',
    'workspaces:operate',
  ]
  const app = await client(started.path, pairFakeClient(started.auth, 'app', every))
  for (const method of Object.keys(STUDIO_WORKTREES_METHODS).filter((name) => name.startsWith('worktrees.'))) {
    const answer = await app.request(method, { commandId: cid(), repoRoot: '/Users/dev/app' })
    assert.deepEqual([method, codeOf(answer)], [method, 'owner_required'])
  }
  const followed = await app.subscribe('worktrees.installChanged', {})
  const failed = await app.line.next((frame) => frame.t === 'subFailed' && frame.sub === followed)
  assert.equal(failed.t === 'subFailed' && failed.code, 'owner_required')
})

test('a settled chat’s Delete reaches what a paired device’s chat grant does, and is recorded as the device’s', async () => {
  const { started, pool } = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  const driver = await client(started.path, pairFakeClient(started.auth, 'driver', ['conversation:operate']))
  const owner = await client(started.path, OWNER_TOKEN)
  const plan = resultOf<{ plans: SettledChatDeletionPlan[] }>(
    await reader.request('settledChats.planDelete', { workspaceIds: ['ws-1', 'ws-1', 'ws-2'] }),
  )
  assert.deepEqual(
    plan.plans.map((entry) => entry.workspaceId),
    ['ws-1', 'ws-2'],
  )
  assert.equal(
    codeOf(await reader.request('settledChats.delete', { commandId: cid(), workspaceIds: ['ws-1'] })),
    'scope_required',
  )
  const once = { commandId: 'delete-once', workspaceIds: ['ws-1'] }
  const deleted = resultOf<{ outcomes: SettledChatDeletionOutcome[] }>(
    await driver.request('settledChats.delete', once),
  )
  assert.deepEqual(resultOf(await driver.request('settledChats.delete', once)), deleted)
  resultOf(await owner.request('settledChats.delete', { commandId: cid(), workspaceIds: ['ws-2'] }))
  assert.deepEqual(pool.deletions, [
    { actor: 'mobile', workspaceIds: ['ws-1'] },
    { actor: 'ui', workspaceIds: ['ws-2'] },
  ])
  assert.equal(
    codeOf(
      await owner.request('settledChats.planDelete', {
        workspaceIds: Array.from({ length: 2_001 }, (_, i) => `w${i}`),
      }),
    ),
    'invalid_params',
  )
})
