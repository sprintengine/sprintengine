import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AppUpdateCheckResult, AppUpdateState } from '../../shared/ipc/window'
import {
  ADMIN_UPDATE_WORDS,
  DEV_BUILD_UPDATE_WORDS,
  desktopStudioUpdates,
  desktopUpdateSide,
  type DesktopUpdater,
} from './desktop-updates'

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

/**
 * An updater that finds `found` on a check and downloads it, recording each
 * step. Its install never returns, as a real one does not: the app quits.
 */
function updater(found: string | null, state: Partial<AppUpdateState> = {}, options: { checkHangs?: boolean } = {}) {
  let current: AppUpdateState = { ...base, ...state }
  const steps: string[] = []
  const listeners = new Set<(state: AppUpdateState) => void>()
  const set = (patch: Partial<AppUpdateState>) => {
    current = { ...current, ...patch }
    for (const listener of listeners) listener(current)
  }
  const answer = (): AppUpdateCheckResult => ({ ok: true, state: current, message: 'ok' })
  const fake: DesktopUpdater & { steps: string[]; set: typeof set } = {
    steps,
    set,
    getState: () => current,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    checkForUpdates: async () => {
      steps.push('check')
      if (options.checkHangs) return new Promise<AppUpdateCheckResult>(() => undefined)
      set(found ? { status: 'available', updateVersion: found } : { status: 'not_available' })
      return answer()
    },
    downloadUpdate: async () => {
      steps.push('download')
      set({ status: 'downloaded', downloaded: true })
      return answer()
    },
    quitAndInstall: () => {
      steps.push('install')
      set({ status: 'installing' })
      return new Promise<AppUpdateCheckResult>(() => undefined)
    },
  }
  return fake
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test('the updater state reads as update.status: method self, a version waiting, and the failure kept', () => {
  assert.deepEqual(desktopUpdateSide({ ...base, packaged: false }), {
    method: 'manual',
    state: 'idle',
    manual: DEV_BUILD_UPDATE_WORDS,
  })
  assert.deepEqual(desktopUpdateSide(base), { method: 'self', state: 'idle' })
  assert.deepEqual(desktopUpdateSide({ ...base, status: 'not_available' }), { method: 'self', state: 'idle' })
  assert.deepEqual(desktopUpdateSide({ ...base, status: 'downloaded', updateVersion: '1.1.0' }), {
    method: 'self',
    state: 'ready',
    available: { version: '1.1.0' },
  })
  const failure = { message: 'No network.', at: 2_000 }
  assert.deepEqual(desktopUpdateSide({ ...base, status: 'error' }, failure), {
    method: 'self',
    state: 'failed',
    lastFailure: failure,
  })
})

test('a failure is kept with the time it happened, past the next check clearing the updater’s error', () => {
  let clock = 1_000
  const fake = updater(null)
  const updates = desktopStudioUpdates(fake, { now: () => clock })
  fake.set({ status: 'error', errorMessage: `Bad gateway: ${'x'.repeat(3_000)}` })
  clock = 5_000
  // Said again, it keeps its first time.
  fake.set({ status: 'error', errorMessage: `Bad gateway: ${'x'.repeat(3_000)}` })
  fake.set({ status: 'not_available', errorMessage: null })
  const kept = updates.status().lastFailure
  assert.equal(kept?.at, 1_000)
  assert.equal(kept?.message.length, 2_000)
  assert.equal(updates.status().state, 'idle')
  // The update an installer left undone, read at the start after it.
  const after = desktopStudioUpdates(
    updater(null, {
      installOutcome: {
        kind: 'failed',
        version: '1.1.0',
        fromVersion: '1.0.0',
        message: 'The installer was cancelled.',
      },
    }),
    { now: () => 7 },
  )
  assert.deepEqual(after.status().lastFailure, { version: '1.1.0', message: 'The installer was cancelled.', at: 7 })
})

test('start checks first, then downloads and restarts into the update, answering before the restart', async () => {
  const fake = updater('1.1.0')
  const updates = desktopStudioUpdates(fake)
  // Answered although the install never returns: the answer goes out first.
  assert.deepEqual(await updates.start({}), { ok: true, targetVersion: '1.1.0' })
  // Asked again while it runs: the same update.
  assert.deepEqual(await updates.start({}), { ok: true, targetVersion: '1.1.0' })
  await settle()
  assert.deepEqual(fake.steps, ['check', 'download', 'install'])
  assert.equal(updates.status().state, 'installing')
})

test('a download already under way is joined, and the restart follows it', async () => {
  const fake = updater('1.1.0', { status: 'downloading', updateVersion: '1.1.0' })
  assert.deepEqual(await desktopStudioUpdates(fake).start({}), { ok: true, targetVersion: '1.1.0' })
  await settle()
  assert.deepEqual(fake.steps, ['download', 'install'])
})

test('an update already downloaded goes straight to the restart', async () => {
  const fake = updater('1.1.0', { status: 'downloaded', downloaded: true, updateVersion: '1.1.0' })
  assert.deepEqual(await desktopStudioUpdates(fake).start({}), { ok: true, targetVersion: '1.1.0' })
  await settle()
  assert.deepEqual(fake.steps, ['install'])
})

test('start refuses, in words: up to date, a development build, an administrator needed, another version, a slow check', async () => {
  const current = updater(null)
  assert.deepEqual(await desktopStudioUpdates(current).start({}), {
    ok: false,
    message: 'This Studio is up to date: it runs 1.0.0.',
  })
  assert.deepEqual(current.steps, ['check'])
  const dev = updater('1.1.0', { packaged: false })
  assert.deepEqual(await desktopStudioUpdates(dev).start({}), { ok: false, message: DEV_BUILD_UPDATE_WORDS })
  const admin = updater('1.1.0', { installRequiresAdmin: true })
  assert.deepEqual(await desktopStudioUpdates(admin).start({}), { ok: false, message: ADMIN_UPDATE_WORDS })
  for (const fake of [dev, admin]) assert.deepEqual(fake.steps, [])
  const other = updater('1.1.0')
  assert.deepEqual(await desktopStudioUpdates(other).start({ targetVersion: '1.2.0' }), {
    ok: false,
    message: "This Studio's update channel offers 1.1.0, not 1.2.0.",
  })
  await settle()
  assert.deepEqual(other.steps, ['check'])
  const slow = updater('1.1.0', {}, { checkHangs: true })
  const refused = await desktopStudioUpdates(slow, { checkWaitMs: 10 }).start({})
  assert.equal(refused.ok, false)
  await settle()
  assert.deepEqual(slow.steps, ['check'])
})
