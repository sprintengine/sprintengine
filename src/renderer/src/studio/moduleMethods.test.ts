import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import { StudioError } from '../../../../packages/client-runtime/src/public'
import { callModuleMethod, callModuleService } from './moduleMethods'

function fakeClient(answer: (method: string, params: unknown) => unknown, capabilities = ['modules']) {
  const requests: Array<{ method: string; params: unknown }> = []
  const client = {
    supports: (capability: string) => capabilities.includes(capability),
    request: async (method: string, params: unknown) => {
      requests.push({ method, params })
      return answer(method, params)
    },
  } as unknown as StudioClient
  return { client, requests }
}

test('a read goes out as module.read, an operate as module.operate under a command id', async () => {
  const { client, requests } = fakeClient(() => ({ ok: true, result: 1 }))
  assert.deepEqual(
    await callModuleMethod(client, { moduleId: 'deck', method: 'list', access: 'read', params: undefined }),
    {
      ok: true,
      result: 1,
    },
  )
  await callModuleMethod(client, {
    moduleId: 'deck',
    method: 'save',
    access: 'operate',
    params: { a: 1 },
    commandId: 'c1',
  })
  await callModuleMethod(client, { moduleId: 'deck', method: 'save', access: 'operate', params: { a: 1 } })
  assert.deepEqual(requests[0], { method: 'module.read', params: { moduleId: 'deck', method: 'list' } })
  assert.deepEqual(requests[1], {
    method: 'module.operate',
    params: { moduleId: 'deck', method: 'save', params: { a: 1 }, commandId: 'c1' },
  })
  const made = (requests[2]!.params as { commandId?: unknown }).commandId
  assert.equal(typeof made === 'string' && made.length > 0, true, 'an operate without an id is given one')
})

test('a refusal from Studio is an answer with its code, never a throw', async () => {
  const { client } = fakeClient(() => {
    throw new StudioError('module_unavailable', 'Module "deck" is not running on this Studio.')
  })
  assert.deepEqual(await callModuleMethod(client, { moduleId: 'deck', method: 'list', access: 'read', params: {} }), {
    ok: false,
    code: 'module_unavailable',
    message: 'Module "deck" is not running on this Studio.',
  })
  const old = fakeClient(() => null, []).client
  const answer = await callModuleMethod(old, { moduleId: 'deck', method: 'list', access: 'read', params: {} })
  assert.equal(!answer.ok && answer.code, 'unavailable')
})

test('a host-service read goes out as it is; a write under a command id made for it', async () => {
  const { client, requests } = fakeClient(() => ({ ok: true }))
  await callModuleService(client, 'moduleBacklog.location', { moduleId: 'deck', workspaceId: 'ws' })
  await callModuleService(client, 'moduleBacklog.updateStatus', {
    moduleId: 'deck',
    workspaceId: 'ws',
    itemId: 'backlog/a.md',
    status: 'ready',
  })
  assert.deepEqual(requests[0], { method: 'moduleBacklog.location', params: { moduleId: 'deck', workspaceId: 'ws' } })
  assert.equal(requests[1]!.method, 'moduleBacklog.updateStatus')
  const made = (requests[1]!.params as { commandId?: unknown }).commandId
  assert.equal(typeof made === 'string' && made.length > 0, true, 'a write is given a command id')
})

test('a host-service refusal is the service’s answer in its own code, never a throw', async () => {
  const gone = fakeClient(() => {
    throw new StudioError('module_unavailable', 'Module "deck" is not running on this Studio.')
  }).client
  assert.deepEqual(await callModuleService(gone, 'moduleBacklog.location', { moduleId: 'deck', workspaceId: 'ws' }), {
    ok: false,
    code: 'backlog_unavailable',
    message: 'Module "deck" is not running on this Studio.',
  })
  const refused = fakeClient(() => {
    throw new StudioError('invalid_params', '"query.from" is a time in epoch milliseconds.')
  }).client
  const answer = await callModuleService(refused, 'moduleUsage.query', { moduleId: 'deck', query: { from: 0, to: 1 } })
  assert.equal(!answer.ok && answer.code, 'invalid_input')
  const old = fakeClient(() => null, []).client
  const none = await callModuleService(old, 'moduleUsage.query', { moduleId: 'deck', query: { from: 0, to: 1 } })
  assert.equal(!none.ok && none.code, 'unavailable')
})
