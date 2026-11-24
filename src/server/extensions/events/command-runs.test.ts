import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { CapabilityManifest } from '../../../shared/modules/manifest'
import { ownerInvoker, runAsInvoker } from '../../../main/module-host/extension-invocation'
import { createMainKernel } from '../../../main/module-host/main-host'
import { extensionCommandRuns } from './command-runs'

// A worker's `studio.runCommand`: one of Studio's actions, to the window whose
// call set it off and no other, with `workspace:operate`; refused for work no
// window set off.

const manifest = (id: string, permissions: string[]): CapabilityManifest => ({
  id,
  displayName: id,
  version: '1.0.0',
  defaultEnabled: true,
  source: 'third-party',
  permissions,
})
const operator = manifest('local.operator', ['workspace:operate'])
const bare = manifest('local.bare', [])

function kernel() {
  const manifests = new Map([operator, bare].map((each) => [each.id, each]))
  return createMainKernel({
    resolveModuleManifest: (id) => manifests.get(id),
    isModulePresent: (id) => manifests.has(id),
    resolveExtensionGrant: (id) => manifests.get(id)?.permissions ?? [],
  })
}

const fromWindow = (connectionId: string) => ({ ...ownerInvoker(), connectionId })

test('it reaches the window whose call set it off, and no other', async () => {
  const heard: Array<{ to: string; moduleId: string; action: string }> = []
  const stops = ['window-a', 'window-b'].map((to) =>
    extensionCommandRuns.listen(to, (run) => heard.push({ to, ...run })),
  )
  try {
    const host = kernel().hostFor('local.operator')
    await runAsInvoker(fromWindow('window-a'), () => host.runCommand('workspace.sidebar.toggle'))
    assert.deepEqual(heard, [{ to: 'window-a', moduleId: 'local.operator', action: 'workspace.sidebar.toggle' }])
  } finally {
    for (const stop of stops) stop()
  }
})

test('work no window set off has no window to run it in', async () => {
  const host = kernel().hostFor('local.operator')
  await assert.rejects(
    runAsInvoker(ownerInvoker(), () => host.runCommand('workspace.sidebar.toggle')),
    (error: Error & { code?: string }) => error.code === 'no_window',
  )
  // A window that is no longer listening is no window either.
  await assert.rejects(
    runAsInvoker(fromWindow('gone'), () => host.runCommand('workspace.sidebar.toggle')),
    (error: Error & { code?: string }) => error.code === 'no_window',
  )
})

test('it needs workspace:operate, and only Studio’s actions an extension may name', async () => {
  const stop = extensionCommandRuns.listen('window-a', () => undefined)
  try {
    const bareHost = kernel().hostFor('local.bare')
    await assert.rejects(
      runAsInvoker(fromWindow('window-a'), () => bareHost.runCommand('workspace.sidebar.toggle')),
      /workspace:operate/,
    )
    const host = kernel().hostFor('local.operator')
    await assert.rejects(
      runAsInvoker(fromWindow('window-a'), () => host.runCommand('app.quit')),
      /not one of Studio's actions/,
    )
  } finally {
    stop()
  }
})
