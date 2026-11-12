import type { AppUpdateCheckResult, AppUpdateState } from '../../shared/ipc/window'
import type { StudioUpdates, StudioUpdateSide, StudioUpdateStart } from '../../server/update/studio-updates'

// A desktop's Studio updates itself: its app updater checks, downloads, then
// runs the app's ordered shutdown (which drains the turns that are running)
// and hands over to the installer, which starts the new version. A client
// with `environment:maintain` asks for that with `update.start`, the same
// press as Settings' "Restart to update"; `update.status` follows the
// updater's state.

/** The updater, as far as a client's update needs it. */
export type DesktopUpdater = {
  getState(): AppUpdateState
  checkForUpdates(isManual?: boolean): Promise<AppUpdateCheckResult>
  downloadUpdate(): Promise<AppUpdateCheckResult>
  quitAndInstall(): Promise<AppUpdateCheckResult>
}

/** What a build that does not update itself says: one run from a source checkout. */
export const DEV_BUILD_UPDATE_WORDS =
  'This Studio is a development build, which does not update itself. Update its checkout and build it again.'

/** The updater's state, as `update.status` tells it. */
export function desktopUpdateSide(state: AppUpdateState, now: () => number = Date.now): StudioUpdateSide {
  if (!state.packaged) return { method: 'manual', state: 'idle', manual: DEV_BUILD_UPDATE_WORDS }
  const available = state.updateVersion ? { available: { version: state.updateVersion } } : {}
  // The last update handed to an installer that left this version running.
  const outcome = state.installOutcome?.kind === 'failed' ? state.installOutcome : null
  const lastFailure =
    state.status === 'error'
      ? {
          lastFailure: {
            ...(state.updateVersion ? { version: state.updateVersion } : {}),
            message: state.errorMessage ?? 'The update did not finish.',
            at: state.lastCheckedAt ? Date.parse(state.lastCheckedAt) || now() : now(),
          },
        }
      : outcome
        ? {
            lastFailure: {
              version: outcome.version,
              message: outcome.message ?? `The update to ${outcome.version} did not install.`,
              at: now(),
            },
          }
        : {}
  switch (state.status) {
    case 'checking':
      return { method: 'self', state: 'checking', ...lastFailure }
    case 'available':
      return { method: 'self', state: 'available', ...available, ...lastFailure }
    case 'downloading':
      return { method: 'self', state: 'downloading', ...available, ...lastFailure }
    case 'downloaded':
      return { method: 'self', state: 'ready', ...available, ...lastFailure }
    case 'installing':
      return { method: 'self', state: 'installing', ...available }
    case 'error':
      return { method: 'self', state: 'failed', ...available, ...lastFailure }
    default:
      return { method: 'self', state: 'idle', ...lastFailure }
  }
}

/**
 * The desktop's updates. `start` checks first, so a Studio with nothing to
 * install says so instead of accepting; then the download and the restart
 * run on, and the answer goes out before the restart closes the connection.
 * A desktop installs the newest version its channel offers; a `targetVersion`
 * is not a way to pick another.
 */
export function desktopStudioUpdates(
  updater: DesktopUpdater,
  options: { log?: (message: string) => void; now?: () => number } = {},
): StudioUpdates {
  const now = options.now ?? Date.now
  let running: Promise<void> | null = null
  const finish = async (): Promise<void> => {
    if (!updater.getState().downloaded) {
      const downloaded = await updater.downloadUpdate()
      if (!downloaded.ok) return
    }
    const installed = await updater.quitAndInstall()
    if (!installed.ok) options.log?.(`A client's update did not start: ${installed.message}`)
  }
  return {
    status: () => desktopUpdateSide(updater.getState(), now),
    async start(): Promise<StudioUpdateStart> {
      const before = updater.getState()
      if (!before.packaged) return { ok: false, message: DEV_BUILD_UPDATE_WORDS }
      // Asked again while one runs: the same update, accepted again.
      if (running || before.status === 'installing' || before.status === 'downloading')
        return { ok: true, targetVersion: before.updateVersion }
      if (!before.downloaded) {
        const checked = await updater.checkForUpdates(true)
        if (!checked.ok) return { ok: false, message: checked.message }
        const after = updater.getState()
        if (!after.downloaded && after.status !== 'available' && after.status !== 'downloading')
          return { ok: false, message: `This Studio is up to date: it runs ${after.version}.` }
      }
      const target = updater.getState().updateVersion
      running = finish()
        .catch((error: unknown) =>
          options.log?.(`A client's update failed: ${error instanceof Error ? error.message : String(error)}`),
        )
        .finally(() => {
          running = null
        })
      return { ok: true, targetVersion: target }
    },
  }
}
