import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createModulesApi } from './modules'

test('showing an extension’s folder is the one modules call left on IPC', async () => {
  const calls: Array<{ channel: string; id: string }> = []
  const api = createModulesApi({
    invoke: async (channel, id) => {
      calls.push({ channel, id })
      return { ok: true }
    },
  })
  assert.deepEqual(Object.keys(api), ['revealThirdPartyModule'])
  assert.deepEqual(await api.revealThirdPartyModule('pr-radar'), { ok: true })
  assert.deepEqual(calls, [{ channel: 'modules:third-party:reveal', id: 'pr-radar' }])
})
