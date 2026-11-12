import {
  STUDIO_UPDATE_MAX_TEXT,
  type StudioProtocolWindow,
  type StudioUpdateStatus,
} from '../../../packages/studio-protocol/src/public'

// How this Studio is kept up to date, as the update methods tell a client
// (`packages/studio-protocol/src/update.ts`). Each host says which way it is
// updated:
//
//   - a desktop updates itself, through its app updater (`self`);
//   - a server inside WSL or on an SSH machine is installed and replaced by
//     the desktop that manages it, through that desktop's bootstrap
//     (`bootstrap`): nothing here can update it;
//   - a server someone started by hand is updated by hand (`manual`).
//
// The status is read synchronously: an incompatible client is answered with
// it in the frame that replaces its welcome, before anything else it sends is
// read.

/** What a host says about its own updates; the router adds the version and the protocol window. */
export type StudioUpdateSide = Omit<StudioUpdateStatus, 'serverVersion' | 'protocolVersion' | 'minProtocolVersion'>

export type StudioUpdateStart = { ok: true; targetVersion: string | null } | { ok: false; message: string }

export type StudioUpdates = {
  /** Where an update stands now. */
  status(): StudioUpdateSide
  /**
   * Begin updating: check, download, then drain and restart into the new
   * version. Answers once the update is under way (or refused); the restart
   * that follows closes every connection. Only a `self` host starts one.
   */
  start(input: { targetVersion?: string }): Promise<StudioUpdateStart>
}

/** The words a standalone server's clients are told: someone started it, and updates it. */
export const MANUAL_UPDATE_WORDS =
  'This Studio server was started by hand. Update SprintEngine Studio on its machine and start the server again.'

/** A host nothing here can update: `manual` or `bootstrap`, with the words that say how to. */
export function externalStudioUpdates(method: 'manual' | 'bootstrap', words: string): StudioUpdates {
  return {
    status: () => ({ method, state: 'idle', manual: words }),
    start: async () => ({ ok: false, message: words }),
  }
}

/** The whole status, as `update.status` answers and the `incompatible` frame carries it. */
export function studioUpdateStatus(
  updates: StudioUpdates,
  server: { version: string } & StudioProtocolWindow,
): StudioUpdateStatus {
  const side = updates.status()
  // Words are cut here to what a client reads, so none is dropped there.
  const cut = (text: string) => text.slice(0, STUDIO_UPDATE_MAX_TEXT)
  return {
    ...side,
    ...(side.manual ? { manual: cut(side.manual) } : {}),
    ...(side.lastFailure ? { lastFailure: { ...side.lastFailure, message: cut(side.lastFailure.message) } } : {}),
    serverVersion: server.version,
    protocolVersion: server.protocolVersion,
    minProtocolVersion: server.minProtocolVersion,
  }
}

/**
 * A desktop's own updates, as the server out of process holds them: the
 * shell pushes its update state whole on every change (and to a server that
 * has just started), and an update is begun by asking the shell, which owns
 * the app updater.
 */
export function mirroredStudioUpdates(begin: (input: { targetVersion?: string }) => Promise<StudioUpdateStart>): {
  updates: StudioUpdates
  /** The shell said where its updates stand. Anything not a status is ignored. */
  mirror(state: unknown): void
} {
  let side: StudioUpdateSide = { method: 'self', state: 'idle' }
  return {
    updates: { status: () => side, start: (input) => begin(input) },
    mirror(state) {
      const read = readStudioUpdateSide(state)
      if (read) side = read
    },
  }
}

const METHODS = new Set(['self', 'bootstrap', 'manual'])
const STATES = new Set(['idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'failed'])

/** A status the shell sent, checked member by member; null when it is not one. */
export function readStudioUpdateSide(value: unknown): StudioUpdateSide | null {
  if (value === null || typeof value !== 'object') return null
  const side = value as Record<string, unknown>
  if (!METHODS.has(side.method as string) || !STATES.has(side.state as string)) return null
  const available = side.available as { version?: unknown } | undefined
  const failure = side.lastFailure as { version?: unknown; message?: unknown; at?: unknown } | undefined
  return {
    method: side.method as StudioUpdateSide['method'],
    state: side.state as StudioUpdateSide['state'],
    ...(typeof available?.version === 'string' ? { available: { version: available.version } } : {}),
    ...(failure && typeof failure.message === 'string' && typeof failure.at === 'number'
      ? {
          lastFailure: {
            ...(typeof failure.version === 'string' ? { version: failure.version } : {}),
            message: failure.message,
            at: failure.at,
          },
        }
      : {}),
    ...(typeof side.manual === 'string' ? { manual: side.manual } : {}),
  }
}
