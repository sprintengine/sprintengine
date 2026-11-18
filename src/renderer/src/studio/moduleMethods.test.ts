import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import { StudioError } from '../../../../packages/client-runtime/src/public'
import { callModuleMethod, callModuleService } from './moduleMethods'

function fakeClient(answer: (method: string, params: unknown) => unknown, capabilities = ['extension-host']) {
  const requests: Array<{ method: string; params: unknown }> = []
  const client = {
    welcome: { capabilities },
    supports: (capability: string) => capabilities.includes(capability),
    request: async (method: string, params: unknown) => {
      requests.push({ method, params })
      return answer(method, params)
    },
  } as unknown as StudioClient
  return { client, requests }
}

test('a read goes out as extension.read, an operate as extension.operate under a command id', async () => {
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
  assert.deepEqual(requests[0], { method: 'extension.read', params: { moduleId: 'deck', method: 'list' } })
  assert.deepEqual(requests[1], {
    method: 'extension.operate',
    params: { moduleId: 'deck', method: 'save', params: { a: 1 }, commandId: 'c1' },
  })
  const made = (requests[2]!.params as { commandId?: unknown }).commandId
  assert.equal(typeof made === 'string' && made.length > 0, true, 'an operate without an id is given one')
})

test('a refusal from Studio is an answer with its code, never a throw', async () => {
  const { client } = fakeClient(() => {
    throw new StudioError('extension_unavailable', 'Extension "deck" is not running on this Studio.')
  })
  assert.deepEqual(await callModuleMethod(client, { moduleId: 'deck', method: 'list', access: 'read', params: {} }), {
    ok: false,
    code: 'extension_unavailable',
    message: 'Extension "deck" is not running on this Studio.',
  })
  const none = fakeClient(() => null, []).client
  const answer = await callModuleMethod(none, { moduleId: 'deck', method: 'list', access: 'read', params: {} })
  assert.equal(!answer.ok && answer.code, 'unavailable')
  assert.equal(!answer.ok && answer.message, 'This Studio does not serve extension methods.')
})

test('a Studio from before extensions were named so is told to update, not called', async () => {
  const { client, requests } = fakeClient(() => ({ ok: true, result: 1 }), ['modules'])
  const answer = await callModuleMethod(client, { moduleId: 'deck', method: 'list', access: 'read', params: {} })
  assert.deepEqual(answer, {
    ok: false,
    code: 'unavailable',
    message: "This machine's Studio is older. Update it to use its extensions.",
  })
  const service = await callModuleService(client, 'extensionUsage.query', {
    moduleId: 'deck',
    query: { from: 0, to: 1 },
  })
  assert.equal(!service.ok && service.message, "This machine's Studio is older. Update it to use its extensions.")
  assert.deepEqual(requests, [], 'nothing is sent to it')
})

test('a host-service read goes out as it is; a write under a command id made for it', async () => {
  const { client, requests } = fakeClient(() => ({ ok: true }))
  await callModuleService(client, 'extensionBacklog.location', { moduleId: 'deck', workspaceId: 'ws' })
  await callModuleService(client, 'extensionBacklog.updateStatus', {
    moduleId: 'deck',
    workspaceId: 'ws',
    itemId: 'backlog/a.md',
    status: 'ready',
  })
  assert.deepEqual(requests[0], {
    method: 'extensionBacklog.location',
    params: { moduleId: 'deck', workspaceId: 'ws' },
  })
  assert.equal(requests[1]!.method, 'extensionBacklog.updateStatus')
  const made = (requests[1]!.params as { commandId?: unknown }).commandId
  assert.equal(typeof made === 'string' && made.length > 0, true, 'a write is given a command id')
})

test('a host-service refusal is the service’s answer in its own code, never a throw', async () => {
  const gone = fakeClient(() => {
    throw new StudioError('extension_unavailable', 'Extension "deck" is not running on this Studio.')
  }).client
  assert.deepEqual(
    await callModuleService(gone, 'extensionBacklog.location', { moduleId: 'deck', workspaceId: 'ws' }),
    {
      ok: false,
      code: 'backlog_unavailable',
      message: 'Extension "deck" is not running on this Studio.',
    },
  )
  const refused = fakeClient(() => {
    throw new StudioError('invalid_params', '"query.from" is a time in epoch milliseconds.')
  }).client
  const answer = await callModuleService(refused, 'extensionUsage.query', {
    moduleId: 'deck',
    query: { from: 0, to: 1 },
  })
  assert.equal(!answer.ok && answer.code, 'invalid_input')
  const old = fakeClient(() => null, []).client
  const none = await callModuleService(old, 'extensionUsage.query', { moduleId: 'deck', query: { from: 0, to: 1 } })
  assert.equal(!none.ok && none.code, 'unavailable')
})
