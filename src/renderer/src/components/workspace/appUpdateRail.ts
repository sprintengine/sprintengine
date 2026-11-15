// The app update's glyph on the rail (owner ruling 2026-10-30): the update
// lives at the rail's foot instead of arriving as a toast. The glyph is there
// in every packaged build, quiet while there is nothing to take, and lights up
// in the accent once a release is waiting. One press walks it forward:
//
//   idle         Check for updates        press → check now
//   checking     spinning                 —
//   available    download arrow, lit      press → download (the consent)
//   downloading  ring filling with %      —
//   ready        restart arrow, lit       press → confirm, then restart into it
//   installing   spinning                 —
//
// A download that failed stays `available`, so the same press tries again.
// Toasts are left for what the press leads to: "Update downloaded" when it
// lands, and a warning when something refused (appUpdateToast.ts).
//
// Pure: the component that reads the store is AppUpdateRailButton.

import { copy } from '../../../../shared/copy'
import type { AppUpdateState } from '../../../../shared/electron-api'

export type AppUpdateRailPhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing'

export type AppUpdateRailAction = 'check' | 'download' | 'install' | 'none'

export type AppUpdateRailView = {
  phase: AppUpdateRailPhase
  action: AppUpdateRailAction
  /** In the accent: a release is waiting on the person. */
  lit: boolean
  /** 0–100 while downloading, else null. */
  percent: number | null
  /** The tooltip, and the accessible name. */
  label: string
}

const t = copy.appUpdate

/**
 * What the glyph shows and what pressing it does, from update-service's own
 * state. Null when there is no glyph at all: before main has answered, and in
 * an unpackaged build, which follows no release train.
 */
export function appUpdateRailView(state: AppUpdateState | null): AppUpdateRailView | null {
  if (!state || !state.packaged) return null
  const version = state.updateVersion

  if (state.status === 'installing') {
    return { phase: 'installing', action: 'none', lit: true, percent: null, label: t.installing }
  }
  // Main puts a refused install back to `downloaded`, so this is also the retry.
  if (state.downloaded || state.status === 'downloaded') {
    return {
      phase: 'ready',
      action: 'install',
      lit: true,
      percent: null,
      label: t.ready(version),
    }
  }
  if (state.status === 'downloading') {
    const percent = Math.max(0, Math.min(100, Math.floor(state.progress?.percent ?? 0)))
    return {
      phase: 'downloading',
      action: 'none',
      lit: true,
      percent,
      label: t.downloading(percent),
    }
  }
  if (state.status === 'error' && version) {
    return {
      phase: 'available',
      action: 'download',
      lit: true,
      percent: null,
      label: t.downloadFailed(version),
    }
  }
  // The hourly re-check of an update already found is still the same offer:
  // the glyph does not go dark for the length of the check.
  if (state.status === 'available' || (state.status === 'checking' && version)) {
    return {
      phase: 'available',
      action: 'download',
      lit: true,
      percent: null,
      label: t.available(version),
    }
  }
  if (state.status === 'checking') {
    return { phase: 'checking', action: 'none', lit: false, percent: null, label: t.checking }
  }
  if (state.status === 'error') {
    return {
      phase: 'idle',
      action: 'check',
      lit: false,
      percent: null,
      label: t.checkFailed,
    }
  }
  if (state.status === 'not_available') {
    return {
      phase: 'idle',
      action: 'check',
      lit: false,
      percent: null,
      label: t.upToDate,
    }
  }
  return { phase: 'idle', action: 'check', lit: false, percent: null, label: t.check }
}

/** The question the ready glyph asks before it restarts the app. */
export function appUpdateInstallConfirmation(state: Pick<AppUpdateState, 'updateVersion' | 'installRequiresAdmin'>): {
  title: string
  body: string
  confirmLabel: string
} {
  return {
    title: t.confirmTitle(state.updateVersion),
    body: t.confirmBody(state.installRequiresAdmin),
    confirmLabel: t.confirmLabel,
  }
}
