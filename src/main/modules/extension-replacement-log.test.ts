import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { ExtensionContributionsResult } from '../../shared/modules/manifest'
import { createExtensionDevEvents } from '../../server/extensions/dev/dev-events'
import {
  REPLACEMENT_TIME_LIMIT_MS,
  noteReplacementLosers,
  watchReplacementCall,
  withInstallOrder,
} from './extension-replacement-log'
import type { InstalledModule } from './user-module-registry'

// What an extension's own log hears about the Studio actions it replaces:
// that another, installed first, takes the action, and that a replacing call
// failed or ran past the window's 2 s so Studio ran its own.

afterEach(() => vi.useRealTimers())

type Entry = ExtensionContributionsResult['extensions'][number]

function entry(key: string, commands: Array<Record<string, string>>, installedAt?: number): Entry {
  return {
    id: key,
    manifest: { id: key, displayName: key, version: '1.0.0', defaultEnabled: true, source: 'third-party' },
    extension: { contributes: { commands } } as unknown as Entry['extension'],
    ...(installedAt === undefined ? {} : { installedAt }),
  }
}

const module = (key: string, development?: InstalledModule['development']) =>
  ({ key, moduleRoot: `/Users/dev/extensions/${key}`, ...(development ? { development } : {}) }) as InstalledModule

test('install order: the install record’s time, else the folder’s, and a development folder after every installed one', () => {
  const result = withInstallOrder(
    { extensions: [entry('acme.a', []), entry('local.b', []), entry('local.dev', [])], failures: {} },
    [module('acme.a'), module('local.b'), module('local.dev', { order: 0, overrides: false })],
    { 'acme.a': { installedAt: 500 } },
    (root) => (root.endsWith('local.b') ? 900 : 100_000),
  )
  assert.deepEqual(
    result.extensions.map((extension) => [extension.id, extension.installedAt]),
    [
      ['acme.a', 500],
      ['local.b', 900],
      ['local.dev', 901],
    ],
  )
})

test('the loser of two that replace one action hears so in its log, once', () => {
  const events = createExtensionDevEvents()
  const back = [{ id: 'notes.back', title: 'Back', replaces: 'workspace.history.back' }]
  const extensions = [entry('acme.later', back, 2000), entry('zeta.first', back, 1000), entry('acme.none', [])]
  noteReplacementLosers(extensions, events)
  noteReplacementLosers(extensions, events)
  assert.deepEqual(
    events.since(0).map((event) => [event.key, event.kind, event.source, event.message]),
    [
      [
        'acme.later',
        'log',
        'studio',
        '"notes.back" does not run in place of Studio\'s "workspace.history.back": zeta.first, installed first, replaces it. Yours runs only while that one does not.',
      ],
    ],
  )
})

const call = (params: unknown) => ({ moduleId: 'acme.back', method: 'notes.back', params })
const replacing = { where: 'replaces', replaces: 'workspace.history.back', workspaceId: null }

test('a replacing call that refuses, throws or runs past 2 s is said in the extension’s log, once', async () => {
  const events = createExtensionDevEvents()
  await watchReplacementCall(
    call(replacing),
    async () => ({ ok: true, answer: { ok: false, code: 'failed', message: 'No history.' } }),
    events,
  )
  await assert.rejects(
    watchReplacementCall(
      call(replacing),
      async () => {
        throw new Error('worker gone')
      },
      events,
    ),
  )
  vi.useFakeTimers()
  let finish: (value: { ok: boolean; message?: string }) => void = () => undefined
  const slow = watchReplacementCall(
    call(replacing),
    () => new Promise<{ ok: boolean; message?: string }>((resolve) => (finish = resolve)),
    events,
  )
  await vi.advanceTimersByTimeAsync(REPLACEMENT_TIME_LIMIT_MS)
  finish({ ok: false, message: 'late' })
  await slow
  assert.deepEqual(
    events.since(0).map((event) => event.message),
    [
      'Studio ran its own "workspace.history.back": "notes.back" did not run: No history.',
      'Studio ran its own "workspace.history.back": "notes.back" failed: worker gone.',
      'Studio ran its own "workspace.history.back": "notes.back" had not answered within 2 s.',
    ],
  )
})

test('an ordinary call, or a replacing one that answers in time, logs nothing', async () => {
  const events = createExtensionDevEvents()
  await watchReplacementCall(call({ where: 'palette' }), async () => ({ ok: false, message: 'refused' }), events)
  await watchReplacementCall(call(replacing), async () => ({ ok: true, answer: { ok: true, result: null } }), events)
  assert.deepEqual(events.since(0), [])
})
