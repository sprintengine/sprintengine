/**
 * The renderer half of the module app-state mirror: a module's entry.main
 * reads its Settings section's values from main's copy, so every change to
 * the `module:<id>` namespaces is pushed, and nothing else is.
 */
import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import { useWorkspaceStore } from '../store/workspaceStore'
import { initModuleAppStateSync } from './moduleAppStateSync'
import { adoptExtensionsDouble } from '../studio/extensions.double'

// What the window's Studio is extended with: answered from this test's own stand-in for the window.
vi.mock('../studio/extensions', () => import('../studio/extensions.double'))
adoptExtensionsDouble(() => (window as unknown as { api?: object }).api)

const pushes: Array<Record<string, Record<string, unknown>>> = []
;(globalThis as { window?: unknown }).window = {
  api: {
    setModuleAppState: (bag: Record<string, Record<string, unknown>>): Promise<void> => {
      pushes.push(bag)
      return Promise.resolve()
    },
  },
}

test('the mount push goes, a Settings write reaches main, and unrelated writes do not push', () => {
  const dispose = initModuleAppStateSync()
  try {
    assert.equal(pushes.length, 1, 'the mount push goes even with nothing set')

    useWorkspaceStore.getState().setModuleSettingValue('insights', 'time', '09:00')
    assert.deepEqual(pushes.at(-1)?.['module:insights'], { time: '09:00' })

    const before = pushes.length
    useWorkspaceStore.getState().setSidebarCollapsed(true)
    useWorkspaceStore.getState().setModuleSettingValue('insights', 'time', '09:00')
    assert.equal(pushes.length, before, 'an unchanged bag is not pushed again')

    useWorkspaceStore.getState().setModuleSettingValue('insights', 'time', undefined)
    assert.deepEqual(pushes.at(-1)?.['module:insights'] ?? {}, {}, 'a deleted key reaches main too')
  } finally {
    dispose()
  }
})
