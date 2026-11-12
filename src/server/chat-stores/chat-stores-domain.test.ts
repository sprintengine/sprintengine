import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import type { ConversationImportService } from '../../main/conversation-import/conversation-import-service'
import type { ScheduledMessages } from '../../main/scheduled-messages/scheduled-messages'
import { USAGE_LIMITS_CACHE_FILE } from '../../main/usage-limits/disk-cache'
import type { UsageLimitResumer } from '../../main/usage-limits/resume'
import { createUsageLimitsStore } from '../../main/usage-limits/store'
import { createStudioChatStores, type StudioChatStoresDeps } from './chat-stores-domain'

// What the stores domain adds to the core's stores: the limits' cache read
// before the first answer, a failure answered in words rather than thrown,
// and a hold answered in the protocol's shape.

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function deps(overrides: Partial<StudioChatStoresDeps> = {}): StudioChatStoresDeps {
  return {
    resumes: {} as UsageLimitResumer,
    scheduled: {} as ScheduledMessages,
    imports: {} as ConversationImportService,
    dataDir: () => tmpdir(),
    getWorkspaces: () => [],
    limits: createUsageLimitsStore(),
    cacheLimits: false,
    ...overrides,
  }
}

test("the first read waits for the cache, so a window opened at launch has the last run's bars", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-stores-'))
  dirs.push(dir)
  const resetsAt = Date.now() + 60 * 60_000
  await writeFile(
    join(dir, USAGE_LIMITS_CACHE_FILE),
    JSON.stringify({
      version: 1,
      snapshots: [
        {
          provider: 'codex',
          billing: 'subscription',
          observedAt: 5,
          windows: [
            { id: 'codex:primary', label: 'Session (5h)', usedPercent: 50, resetsAt, status: 'allowed', observedAt: 5 },
          ],
        },
      ],
    }),
  )
  const stores = createStudioChatStores(deps({ dataDir: () => dir, cacheLimits: true }))
  const state = await stores.usageLimits()
  expect(state.snapshots.map((snapshot) => [snapshot.provider, snapshot.observedAt])).toEqual([['codex', 5]])
  await stores.dispose()
})

test('a report, a scan or an import that throws is answered with the reason', async () => {
  const stores = createStudioChatStores(
    deps({
      usage: {
        report: async () => {
          throw new Error('The logs could not be read.')
        },
      },
      imports: {
        scan: async () => {
          throw new Error('No home folder.')
        },
        importSessions: async () => {
          throw new Error('The registry is busy.')
        },
      },
    }),
  )
  expect(await stores.usageReport({ from: 0, to: 1 })).toEqual({ ok: false, message: 'The logs could not be read.' })
  expect(await stores.scanImports()).toEqual({ ok: false, message: 'No home folder.' })
  expect(await stores.importConversations({ sessions: [] })).toEqual({ ok: false, message: 'The registry is busy.' })
})

test('a hold is kept under the source it came in on, and a refusal says why', () => {
  const held: Array<[string, string, string]> = []
  const scheduled = {
    hold: (chat: { workspaceId: string; agentId: string }, text: string, source: string) => {
      held.push([`${chat.workspaceId}/${chat.agentId}`, text, source])
      return text === 'too much' ? { ok: false, reason: 'Too many messages are waiting.' } : { ok: true, id: 'h1' }
    },
  } as unknown as ScheduledMessages
  const stores = createStudioChatStores(deps({ scheduled }))
  expect(stores.holdScheduledMessage({ workspaceId: 'w', agentId: 'a' }, 'later', 'owner:c1')).toEqual({
    ok: true,
    id: 'h1',
  })
  expect(stores.holdScheduledMessage({ workspaceId: 'w', agentId: 'a' }, 'too much', 'owner:c2')).toEqual({
    ok: false,
    reason: 'Too many messages are waiting.',
  })
  expect(held).toEqual([
    ['w/a', 'later', 'owner:c1'],
    ['w/a', 'too much', 'owner:c2'],
  ])
})
