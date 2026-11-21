import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import { StudioError } from '../../../../packages/client-runtime/src/public'
import { callModuleMethod } from './moduleMethods'

function fakeClient(answer: (method: string, params: unknown) => unknown, capabilities = ['extension-host']) {
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
