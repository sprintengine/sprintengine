import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createModulesApi } from './modules'

test('showing an extension’s folder and staging a frame’s document are the extension calls left on IPC', async () => {
  const calls: unknown[][] = []
  const api = createModulesApi({
    invoke: (async (...args: unknown[]) => {
      calls.push(args)
      return args[0] === 'extension-frames:stage' ? true : { ok: true }
    }) as never,
  })
  assert.deepEqual(Object.keys(api), ['revealThirdPartyModule', 'stageExtensionFrame'])
  assert.deepEqual(await api.revealThirdPartyModule('pr-radar'), { ok: true })
  assert.equal(await api.stageExtensionFrame('a'.repeat(64), '<!doctype html>'), true)
  assert.deepEqual(calls, [
    ['modules:third-party:reveal', 'pr-radar'],
    ['extension-frames:stage', 'a'.repeat(64), '<!doctype html>'],
  ])
})
