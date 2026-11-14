import { STUDIO_UPDATE_MAX_TEXT } from '../../../packages/studio-protocol/src/public'
import type { AppUpdateCheckResult, AppUpdateState } from '../../shared/ipc/window'
import { readFileSync } from 'node:fs'

import type { StudioUpdates, StudioUpdateSide, StudioUpdateStart } from '../../server/update/studio-updates'
import { writeFileAtomicSync } from '../../server/platform/atomic-file'

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
  onStateChange?(listener: (state: AppUpdateState) => void): () => void
}

/** What a build that does not update itself says: one run from a source checkout. */
export const DEV_BUILD_UPDATE_WORDS =
  'This Studio is a development build, which does not update itself. Update its checkout and build it again.'

/** What an installation that needs an administrator says: the elevation is asked for at that PC. */
export const ADMIN_UPDATE_WORDS =
  'This Studio needs an administrator to install updates, which Windows asks for at that PC. Update it there, from Settings.'

/**
 * How long a client's `update.start` waits for the check before saying so: the
 * answer has to reach the client inside the shell's own call deadline when
 * the server runs out of process.
 */
export const UPDATE_CHECK_WAIT_MS = 20_000

/**
 * The last `update.start` this desktop accepted, kept across the restart it
 * leads to: a client that lost the answer to that restart asks again with
 * the same command id, and is answered as it was, not "up to date".
 */
export type AcceptedUpdateCommand = { commandId: string; targetVersion: string | null; at: number }

export type UpdateCommandStore = {
  read(): AcceptedUpdateCommand | null
  write(command: AcceptedUpdateCommand): void
}

export const UPDATE_COMMAND_FILENAME = 'update-command.json'

/** The store in a file of its own (userData); one that does not read is no command. */
export function updateCommandFile(path: string, log?: (message: string) => void): UpdateCommandStore {
  return {
    read() {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<AcceptedUpdateCommand>
        return typeof value.commandId === 'string' && value.commandId
          ? {
              commandId: value.commandId,
              targetVersion: typeof value.targetVersion === 'string' ? value.targetVersion : null,
              at: typeof value.at === 'number' ? value.at : 0,
            }
          : null
      } catch {
        return null
      }
    },
    write(command) {
      try {
        writeFileAtomicSync(path, `${JSON.stringify(command)}\n`, { mode: 0o600 })
      } catch (error) {
        log?.(`The accepted update could not be recorded: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/** The last update that did not happen, as `update.status` keeps it. */
export type DesktopUpdateFailure = NonNullable<StudioUpdateSide['lastFailure']>

/** The updater's state, as `update.status` tells it, with the last failure kept beside it. */
export function desktopUpdateSide(
  state: AppUpdateState,
  lastFailure: DesktopUpdateFailure | null = null,
): StudioUpdateSide {
  if (!state.packaged) return { method: 'manual', state: 'idle', manual: DEV_BUILD_UPDATE_WORDS }
  const available = state.updateVersion ? { available: { version: state.updateVersion } } : {}
  const failure = lastFailure ? { lastFailure } : {}
  switch (state.status) {
    case 'checking':
      return { method: 'self', state: 'checking', ...failure }
    case 'available':
      return { method: 'self', state: 'available', ...available, ...failure }
    case 'downloading':
      return { method: 'self', state: 'downloading', ...available, ...failure }
    case 'downloaded':
      return { method: 'self', state: 'ready', ...available, ...failure }
    case 'installing':
      return { method: 'self', state: 'installing', ...available }
    case 'error':
      return { method: 'self', state: 'failed', ...available, ...failure }
    default:
      return { method: 'self', state: 'idle', ...failure }
  }
}

/**
 * The failure a state says happened just now, if any: an updater error, or
 * an update the last installer left undone (read once, at the start after
 * it). Words cut to what a status carries.
 */
export function desktopUpdateFailureOf(state: AppUpdateState, at: number): DesktopUpdateFailure | null {
  const cut = (text: string) => text.slice(0, STUDIO_UPDATE_MAX_TEXT)
  if (state.status === 'error')
    return {
      ...(state.updateVersion ? { version: state.updateVersion } : {}),
      message: cut(state.errorMessage ?? 'The update did not finish.'),
      at,
    }
  if (state.installOutcome?.kind === 'failed')
    return {
      version: state.installOutcome.version,
      message: cut(state.installOutcome.message ?? `The update to ${state.installOutcome.version} did not install.`),
      at,
    }
  return null
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * The desktop's updates. `start` checks first, so a Studio with nothing to
 * install, or not the version asked for, says so instead of accepting; then
 * the download (joined if one is under way) and the restart run on, and the
 * answer goes out before the restart closes the connection.
 */
export function desktopStudioUpdates(
  updater: DesktopUpdater,
  options: {
    log?: (message: string) => void
    now?: () => number
    checkWaitMs?: number
    /** Where the accepted command is kept across the restart; in memory only without one. */
    commands?: UpdateCommandStore
  } = {},
): StudioUpdates {
  const now = options.now ?? Date.now
  let remembered: AcceptedUpdateCommand | null = null
  const commands: UpdateCommandStore = options.commands ?? {
    read: () => remembered,
    write: (command) => {
      remembered = command
    },
  }
  const accept = (commandId: string, targetVersion: string | null): StudioUpdateStart => {
    commands.write({ commandId, targetVersion, at: now() })
    return { ok: true, targetVersion }
  }
  // Kept when it happens, until an update succeeds (which restarts the app):
  // the next hourly check clears the updater's error, not this.
  let lastFailure: DesktopUpdateFailure | null = desktopUpdateFailureOf(updater.getState(), now())
  updater.onStateChange?.((state) => {
    // The same failure said again keeps the time it first happened.
    const failure = desktopUpdateFailureOf(state, now())
    if (failure && (failure.message !== lastFailure?.message || failure.version !== lastFailure?.version))
      lastFailure = failure
  })
  let running: Promise<void> | null = null
  const finish = async (): Promise<void> => {
    if (!updater.getState().downloaded) {
      // Joins a download already under way, as electron-updater hands a second call the one running.
      const downloaded = await updater.downloadUpdate()
      if (!downloaded.ok) return
    }
    const installed = await updater.quitAndInstall()
    if (!installed.ok) options.log?.(`A client's update did not start: ${installed.message}`)
  }
  const begin = (): void => {
    running = finish()
      .catch((error: unknown) =>
        options.log?.(`A client's update failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        running = null
      })
  }
  return {
    status: () => desktopUpdateSide(updater.getState(), lastFailure),
    async start(input): Promise<StudioUpdateStart> {
      // The same command asked again (its answer lost to the restart it
      // began, or to a dropped connection): answered as it was, whatever
      // has happened since. The outcome is the next welcome's version, or
      // `update.status`'s `lastFailure`.
      const seen = commands.read()
      if (seen?.commandId === input.commandId) return { ok: true, targetVersion: seen.targetVersion }
      const before = updater.getState()
      if (!before.packaged) return { ok: false, message: DEV_BUILD_UPDATE_WORDS }
      // Asked again while one runs: the same update, accepted again.
      if (running || before.status === 'installing') return accept(input.commandId, before.updateVersion)
      // Windows would ask for an administrator at that PC, with nobody there to answer.
      if (before.installRequiresAdmin) return { ok: false, message: ADMIN_UPDATE_WORDS }
      if (!before.downloaded && before.status !== 'downloading') {
        const checked = await within(updater.checkForUpdates(true), options.checkWaitMs ?? UPDATE_CHECK_WAIT_MS)
        if (checked === 'late')
          return { ok: false, message: 'Studio could not check for an update in time. Try again in a moment.' }
        if (!checked.ok) return { ok: false, message: checked.message }
        const after = updater.getState()
        if (!after.downloaded && after.status !== 'available' && after.status !== 'downloading')
          return { ok: false, message: `This Studio is up to date: it runs ${after.version}.` }
      }
      const target = updater.getState().updateVersion
      // A desktop installs what its channel offers; another version is not a choice it has.
      if (input.targetVersion !== undefined && input.targetVersion !== target)
        return {
          ok: false,
          message: `This Studio's update channel offers ${target ?? 'no update'}, not ${input.targetVersion}.`,
        }
      const accepted = accept(input.commandId, target)
      begin()
      return accepted
    },
  }
}
