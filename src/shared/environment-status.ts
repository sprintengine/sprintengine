import type { EnvironmentEntry } from './environments'

// What every list of machines says about one (design-environments): the
// state in words, its tone, and the one thing a person can do about it.
// Every surface that names a machine's state reads it here, so a machine
// reads the same in Settings, the Remote popover and the sidebar, whatever
// kind of machine it is. The words a route's owner has for its state
// ("Installing Studio server 0.4.0") win over the generic ones.

export type EnvironmentStatusKind = 'ready' | 'connecting' | 'offline' | 'signed-out' | 'incompatible' | 'not-set-up'

/** The status mark's tone (`StatusDot`): `working` is the bounded-wait spinner, never a dot. */
export type EnvironmentStatusTone = 'good' | 'working' | 'neutral' | 'danger'

/**
 * What a row offers: `retry` asks the route's owner to try again now (Retry,
 * or Connect for a machine nothing has needed yet); `open-settings` goes
 * where the machine is set up, because what it needs (a pairing, a sign-in,
 * an update) is done there.
 */
export type EnvironmentStatusAction = 'retry' | 'open-settings'

export type EnvironmentStatus = {
  kind: EnvironmentStatusKind
  tone: EnvironmentStatusTone
  words: string
  action: EnvironmentStatusAction | null
  /** The action's button label. */
  actionLabel: string | null
}

export function environmentStatus(
  entry: Pick<EnvironmentEntry, 'connection' | 'compatibility' | 'displayName'>,
  now: number = Date.now(),
): EnvironmentStatus {
  const { connection, compatibility } = entry
  // A server whose protocol window does not overlap ours answers nothing
  // useful, whatever the socket does: say why, and where it is fixed. Work
  // under way on it (an SSH machine's server being updated) says so instead,
  // and a route's owner that said why it is not answering (an update that
  // failed and fell back) is heard over the generic words.
  if (
    (compatibility === 'client-outdated' || compatibility === 'server-outdated') &&
    connection.state !== 'connecting'
  ) {
    const own = connection.state === 'offline' ? connection.detail : null
    return {
      kind: 'incompatible',
      tone: 'danger',
      words:
        own ??
        (compatibility === 'client-outdated'
          ? `${entry.displayName} runs a newer Studio: update this app`
          : `${entry.displayName} runs an older Studio: update it there`),
      action: 'open-settings',
      actionLabel: 'Update',
    }
  }
  switch (connection.state) {
    case 'up':
      return { kind: 'ready', tone: 'good', words: connection.detail ?? 'Connected', action: null, actionLabel: null }
    case 'connecting':
      return {
        kind: 'connecting',
        tone: 'working',
        words: connection.detail ?? 'Connecting…',
        action: null,
        actionLabel: null,
      }
    case 'offline': {
      const lead = connection.detail ?? 'Not answering'
      return {
        kind: 'offline',
        tone: 'neutral',
        words: connection.lastReachedAt !== null ? `${lead} · ${since(connection.lastReachedAt, now)}` : lead,
        action: 'retry',
        actionLabel: 'Retry',
      }
    }
    case 'signed-out':
      return {
        kind: 'signed-out',
        tone: 'danger',
        words: connection.detail ?? 'Refused this device',
        action: 'open-settings',
        actionLabel: connection.remedy ?? 'Open settings',
      }
    case 'unknown':
      return {
        kind: 'not-set-up',
        tone: 'neutral',
        words: connection.detail ?? 'Not connected yet',
        action: 'retry',
        actionLabel: 'Connect',
      }
  }
}

/** Whether a machine is answering right now: what the Remote glyph counts. */
export function environmentAnswering(entry: Pick<EnvironmentEntry, 'connection' | 'compatibility'>): boolean {
  return environmentStatus({ ...entry, displayName: '' }).kind === 'ready'
}

/**
 * How long something has been true, without the "ago": "8 min", "2 h". A row
 * that already says what the state is ("Not answering") wants the duration of
 * that state, not a second sentence about when it last was not (owner ruling
 * 2026-09-05).
 */
export function since(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000))
  if (seconds < 60) return 'under a min'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'}`
}
