import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AppUpdateCheckResult, AppUpdateState } from '../../shared/ipc/window'
import { DEV_BUILD_UPDATE_WORDS, desktopStudioUpdates, desktopUpdateSide, type DesktopUpdater } from './desktop-updates'

const base: AppUpdateState = {
  status: 'idle',
  version: '1.0.0',
  channel: 'stable',
  buildChannel: 'stable',
  packaged: true,
  updateVersion: null,
  releaseName: null,
  releaseNotes: null,
  releaseNotesUrl: null,
  downloaded: false,
  progress: null,
  errorMessage: null,
  lastCheckedAt: null,
  autoDownload: false,
  installRequiresAdmin: false,
  installOutcome: null,
}

/** An updater that finds `found` on a check, downloads it, and records each step. */
function updater(found: string | null, state: Partial<AppUpdateState> = {}) {
  let current: AppUpdateState = { ...base, ...state }
  const steps: string[] = []
  const answer = (ok = true): AppUpdateCheckResult => ({ ok, state: current, message: ok ? 'ok' : 'failed' }) as never
  const fake: DesktopUpdater & { steps: string[] } = {
    steps,
    getState: () => current,
    checkForUpdates: async () => {
      steps.push('check')
      current = found
        ? { ...current, status: 'available', updateVersion: found }
        : { ...current, status: 'not_available' }
      return answer()
    },
    downloadUpdate: async () => {
      steps.push('download')
      current = { ...current, status: 'downloaded', downloaded: true }
      return answer()
    },
    quitAndInstall: async () => {
      steps.push('install')
      current = { ...current, status: 'installing' }
      return answer()
    },
  }
  return fake
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the updater state reads as update.status: method self, a version waiting, and why the last one failed', () => {
  const at = () => 1_000
  assert.deepEqual(desktopUpdateSide({ ...base, packaged: false }), {
    method: 'manual',
    state: 'idle',
    manual: DEV_BUILD_UPDATE_WORDS,
  })
  assert.deepEqual(desktopUpdateSide(base, at), { method: 'self', state: 'idle' })
  assert.deepEqual(desktopUpdateSide({ ...base, status: 'not_available' }, at), { method: 'self', state: 'idle' })
  assert.deepEqual(desktopUpdateSide({ ...base, status: 'downloaded', updateVersion: '1.1.0' }, at), {
    method: 'self',
    state: 'ready',
    available: { version: '1.1.0' },
  })
  assert.deepEqual(
    desktopUpdateSide(
      { ...base, status: 'error', errorMessage: 'No network.', lastCheckedAt: '1970-01-01T00:00:02.000Z' },
      at,
    ),
    { method: 'self', state: 'failed', lastFailure: { message: 'No network.', at: 2_000 } },
  )
  // An update that went to an installer and left this version running.
  assert.deepEqual(
    desktopUpdateSide(
      {
        ...base,
        installOutcome: {
          kind: 'failed',
          version: '1.1.0',
          fromVersion: '1.0.0',
          message: 'The installer was cancelled.',
        },
      },
      at,
    ),
    {
      method: 'self',
      state: 'idle',
      lastFailure: { version: '1.1.0', message: 'The installer was cancelled.', at: 1_000 },
    },
  )
})

test('start checks first, then downloads and restarts into the update, answering before the restart', async () => {
  const fake = updater('1.1.0')
  const updates = desktopStudioUpdates(fake)
  assert.deepEqual(await updates.start({}), { ok: true, targetVersion: '1.1.0' })
  // Asked again while it runs: the same update.
  assert.deepEqual(await updates.start({}), { ok: true, targetVersion: '1.1.0' })
  await settle()
  await settle()
  assert.deepEqual(fake.steps, ['check', 'download', 'install'])
  assert.equal(updates.status().state, 'installing')
})

test('start refuses a Studio that is up to date, and a development build, in words', async () => {
  const current = updater(null)
  assert.deepEqual(await desktopStudioUpdates(current).start({}), {
    ok: false,
    message: 'This Studio is up to date: it runs 1.0.0.',
  })
  assert.deepEqual(current.steps, ['check'])
  const dev = updater('1.1.0', { packaged: false })
  assert.deepEqual(await desktopStudioUpdates(dev).start({}), { ok: false, message: DEV_BUILD_UPDATE_WORDS })
  assert.deepEqual(dev.steps, [])
})

test('an update already downloaded goes straight to the restart', async () => {
  const fake = updater('1.1.0', { status: 'downloaded', downloaded: true, updateVersion: '1.1.0' })
  assert.deepEqual(await desktopStudioUpdates(fake).start({}), { ok: true, targetVersion: '1.1.0' })
  await settle()
  assert.deepEqual(fake.steps, ['install'])
})
