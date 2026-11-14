import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { StudioClient } from '../../packages/client-runtime/src/public'
import { machineStudioClient } from './machine-studio-client'
import { machineSpellingOf } from './machine-spelling'

const ssh = (id: string) => machineSpellingOf(`ssh:${id}`)!

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
  const machine = machineStudioClient(client, ssh('build-box'))
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
  const machine = machineStudioClient(client, ssh('build-box'))
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
  assert.equal(machineStudioClient(client, ssh('build-box')), machine, 'one per client and machine')
})

test('a WSL distribution is never handed a folder it cannot open: it is refused in words, as the old edge did', async () => {
  const { client, asked } = fake()
  const unmounted = machineStudioClient(
    client,
    machineSpellingOf('wsl:Ubuntu', () => null)!,
  )
  const create = (workspaceRoot: string) =>
    unmounted.request('conversation.create', { workspaceId: 'w', agentId: 'a', workspaceRoot } as never)
  await assert.rejects(create('C:\\code\\repo'), /mounts no Windows drives \(automount is off/u)
  await assert.rejects(create('\\\\wsl.localhost\\Debian\\home\\dev'), /is in WSL: Debian, not in Ubuntu/u)
  await assert.rejects(create('\\\\fileserver\\share\\repo'), /network share/u)
  const sent: unknown[] = []
  const withSend = machineStudioClient(
    { ...client, conversations: { send: async (ref: unknown) => sent.push(ref) } } as unknown as StudioClient,
    machineSpellingOf('wsl:Ubuntu', () => null)!,
  )
  await assert.rejects(
    (withSend.conversations as unknown as { send(ref: unknown): Promise<unknown> }).send({
      workspaceId: 'w',
      agentId: 'a',
      workspaceRoot: 'C:\\code\\repo',
    }),
    /automount is off/u,
  )
  assert.deepEqual(sent, [])
  // Its own share is its own; words naming a drive are only words; a hand-over's records are kept as they are.
  await unmounted.request('conversation.create', {
    workspaceId: 'w',
    agentId: 'a',
    workspaceRoot: '\\\\wsl$\\ubuntu\\home\\dev',
    message: 'C:\\code',
  } as never)
  await unmounted.request('environment.adopt', { records: [{ body: { folderPath: 'C:\\code' } }] } as never)
  assert.deepEqual(
    asked.map((each) => each.method),
    ['conversation.create', 'environment.adopt'],
  )
  assert.equal((asked[0]?.params as { workspaceRoot: string }).workspaceRoot, '/home/dev')
  // An SSH machine's spelling refuses nothing.
  await machineStudioClient(client, ssh('build-box')).request('conversation.create', {
    workspaceRoot: 'C:\\code',
  } as never)
})
