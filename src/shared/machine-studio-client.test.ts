import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { StudioClient } from '../../packages/client-runtime/src/public'
import { machineStudioClient } from './machine-studio-client'

// The one place a client of an SSH machine's Studio respells paths: a key, a
// mention and a search root go to the machine plain; a plan's path and the
// folders an approval rule names come back as this computer spells them.

function fake() {
  const asked: Array<{ method: string; params: unknown }> = []
  const followed: unknown[][] = []
  const client = {
    async request(method: string, params: unknown) {
      asked.push({ method, params })
      if (method === 'conversation.planDocument') return { path: '/home/dev/repo/PLAN.md', text: 'see /tmp/x' }
      if (method === 'approvalRules.list') return { rules: [{ id: 'r', rootPath: '/home/dev/repo' }] }
      return {}
    },
    conversations: {
      follow(...args: unknown[]) {
        followed.push(args)
        return () => undefined
      },
    },
    state: 'open',
  } as unknown as StudioClient
  return { client, asked, followed }
}

test('what goes to the machine is spelled plain: a key, a mention, a search root', async () => {
  const { client, asked, followed } = fake()
  const machine = machineStudioClient(client, 'build-box')
  await machine.request('conversation.send', {
    key: { workspaceId: 'w', agentId: 'a', workspaceRoot: 'ssh://build-box/home/dev/repo' },
    mentions: [{ path: 'ssh://build-box/home/dev/repo/src/a.ts', kind: 'file' }],
    message: 'look at ssh://other/elsewhere',
  } as never)
  await machine.rpc['files.search']({ root: 'ssh://build-box/home/dev/repo', query: 'a' } as never)
  ;(machine.conversations as unknown as { follow(ref: unknown): void }).follow({
    workspaceId: 'w',
    agentId: 'a',
    workspaceRoot: 'ssh://build-box/home/dev/repo',
  })
  assert.deepEqual(asked[0]?.params, {
    key: { workspaceId: 'w', agentId: 'a', workspaceRoot: '/home/dev/repo' },
    mentions: [{ path: '/home/dev/repo/src/a.ts', kind: 'file' }],
    message: 'look at ssh://other/elsewhere',
  })
  assert.deepEqual(asked[1]?.params, { root: '/home/dev/repo', query: 'a' })
  assert.deepEqual(followed[0]?.[0], { workspaceId: 'w', agentId: 'a', workspaceRoot: '/home/dev/repo' })
})

test("what comes back names the machine's files as this computer spells them; words are left alone", async () => {
  const { client } = fake()
  const machine = machineStudioClient(client, 'build-box')
  const plan = (await machine.request('conversation.planDocument', {} as never)) as unknown as Record<string, string>
  assert.equal(plan.path, 'ssh://build-box/home/dev/repo/PLAN.md')
  assert.equal(plan.text, 'see /tmp/x')
  const rules = (await (machine.request as (method: string, params: unknown) => Promise<unknown>)(
    'approvalRules.list',
    {},
  )) as unknown as {
    rules: Array<{ rootPath: string }>
  }
  assert.equal(rules.rules[0]?.rootPath, 'ssh://build-box/home/dev/repo')
  assert.equal(machineStudioClient(client, 'build-box'), machine, 'one per client and machine')
})
