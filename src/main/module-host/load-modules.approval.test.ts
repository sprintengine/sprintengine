import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import { loadMainModules, type CapabilityModule } from './load-modules'
import type { MainHost } from './main-host'
import * as serviceTokens from './service-tokens'

// An extension's calls are held to what it was loaded with and to its approval
// as it stands at each call: an update that kept the approval leaves the
// running version working; an approval that is gone, or now covers less,
// holds it to that.

const manifest: CapabilityManifest = {
  id: 'local.notes',
  displayName: 'Notes',
  version: '1.0.0',
  defaultEnabled: true,
  source: 'third-party',
  permissions: ['conversation:own', 'storage:own'],
}

function load(current: () => ReadonlyMap<string, { access: { permissions: readonly string[] } }>) {
  let studio: MainHost | undefined
  const extension: CapabilityModule = {
    manifest,
    registerMain: (host) => {
      studio = host
    },
  }
  const provider: CapabilityModule = {
    manifest: { id: 'chats', displayName: 'Chats', version: 1, defaultEnabled: true },
    registerMain: (host) => {
      host.provideService(serviceTokens.ConversationModuleServiceToken, () => ({ list: () => [] }) as never)
    },
  }
  const { report } = loadMainModules({
    modules: [provider, extension],
    extensionApprovals: { 'local.notes': { approved: true, permissions: ['conversation:own', 'storage:own'] } },
    currentApprovals: current,
  })
  assert.deepEqual(report.errors, [])
  const chats = studio!.requireService(serviceTokens.ConversationModuleServiceToken) as unknown as {
    list(moduleId: string): unknown[]
  }
  return () => chats.list('local.notes')
}

test('an update that kept the approval leaves the running version working', () => {
  const permissions = ['conversation:own', 'storage:own']
  let approvals = new Map([['local.notes', { fingerprint: 'sha256-loaded', access: { permissions } }]])
  const list = load(() => approvals)
  assert.deepEqual(list(), [])
  // Installing the new version carried the approval over to its fingerprint.
  approvals = new Map([['local.notes', { fingerprint: 'sha256-updated', access: { permissions } }]])
  assert.deepEqual(list(), [], 'still working after the update was installed')
})

test('an approval that is gone, or covers less now, holds the running version to it', () => {
  let approvals = new Map([['local.notes', { access: { permissions: ['conversation:own'] as string[] } }]])
  const list = load(() => approvals)
  assert.deepEqual(list(), [])
  approvals = new Map([['local.notes', { access: { permissions: ['storage:own'] } }]])
  assert.throws(() => list(), /not approved for "conversation:own"/)
  approvals = new Map()
  assert.throws(() => list(), /not approved as it is now/)
})
