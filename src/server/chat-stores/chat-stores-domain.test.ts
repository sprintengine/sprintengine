import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import type { ConversationImportService } from '../../main/conversation-import/conversation-import-service'
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
