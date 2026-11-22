import type { MeshMachineReachability } from '../../../../../shared/tailnet-mesh'
import type { EnvironmentStatusKind } from '../../../../../shared/environment-status'
import { formatRelativeMs, formatRelativeMsAgo } from '../../../utils/relativeTime'
import { copy } from '../../../../../shared/copy'

// Whether a paired machine's chats in the sidebar are what it holds now, or
// what it held the last time this window could read them (a last-known list).
//
// A list read that fails keeps the rows it had: a machine asleep, or one that
// no longer takes this pairing, still has the chats a person was working in,
// and a row that vanishes is worse than one that is old. What was wrong was
// that nothing said so. A paired laptop whose pairing the other machine had
// dropped kept drawing that machine's list from days before, every row
// looking current, with nothing to say why the newest chats were missing.
// So a row from a last-known list says which it is, in words, on the row.
//
// No notices still holds (owner ruling 2026-09-05): there is no sentence
// under a machine and nothing for a scope the pairing lacks. A row says what
// it is in a word or two, as a snoozed row says when it wakes.

/** Why the newest read of a machine's chats did not replace them. */
export type RemoteListFailure = {
  /** `unauthorized`: the machine refused this pairing. `unavailable`: it did not answer, or the read broke off. */
  kind: 'unauthorized' | 'unavailable'
  message: string
}

/**
 * Why a machine's rows are a last-known list: it no longer takes this
 * pairing (`signed-out`), it does not answer (`not-answering`), its Studio and
 * this one share no protocol (`outdated`), or the pairing is gone from here
 * (`unpaired`).
 */
export type RemoteLastKnownReason = 'signed-out' | 'not-answering' | 'outdated' | 'unpaired' | 'superseded'

export type RemoteLastKnown = {
  reason: RemoteLastKnownReason
  /** When its chats were last read whole; null when this window never has. */
  since: number | null
}

/** The codes a Studio refuses a pairing with: the machine no longer takes it. */
const UNAUTHORIZED_CODES = new Set(['unauthorized', 'revoked', 'peer_mismatch'])

/**
 * Refusals that are real answers about the chats rather than a failure to
 * read them: a pairing that may not read them, or a machine that does not
 * serve them, lists none, and that list is current.
 */
const ANSWERED_CODES = new Set([
  'conversations_unsupported',
  'scope_required',
  'owner_required',
  'forbidden',
  'outdated',
  'unknown_method',
])

/**
 * What a failed `conversation.list` means for the rows: null for a refusal
 * that is itself the answer (the list is none, and current), else why the
 * rows the window holds are now a last-known list.
 */
export function listFailureOf(code: string, message: string): RemoteListFailure | null {
  if (ANSWERED_CODES.has(code)) return null
  return { kind: UNAUTHORIZED_CODES.has(code) ? 'unauthorized' : 'unavailable', message }
}

/**
 * Whether a machine's rows are a last-known list, and why.
 *
 * The window's own newest read decides first: a read that failed makes the
 * list last-known whatever main's background check says, because the check
 * can pass while the read is refused. A read that succeeded after main's last
 * check is believed over that check. Otherwise how the machine stands
 * (`environmentStatus`) decides, as it did when these rows were dimmed.
 */
export function remoteLastKnownOf(
  entry: { listedAt?: number; listFailure?: RemoteListFailure | null } | undefined,
  status: EnvironmentStatusKind | null,
  reach?: MeshMachineReachability,
): RemoteLastKnown | null {
  const since = entry?.listedAt ?? null
  const failure = entry?.listFailure ?? null
  if (failure) return { reason: failure.kind === 'unauthorized' ? 'signed-out' : 'not-answering', since }
  const checkedAt = reach?.checkedAt ?? null
  if (since !== null && checkedAt !== null && since > checkedAt) return null
  if (status === 'signed-out') return { reason: 'signed-out', since }
  if (status === 'offline') return { reason: 'not-answering', since }
  if (status === 'incompatible') return { reason: 'outdated', since }
  return null
}

// ── When to read again ──────────────────────────────────────────────────────
//
// A change notice from the machine and its coming back are what re-read it
// (`useRemoteSessions`), but a notice can be lost and a machine can drop this
// pairing without anything arriving here. So a window that can be seen also
// re-reads on a slow clock, and when a person comes back to it. Neither may
// turn into a stream of requests: one read per machine at a time, a few
// minutes apart while they answer, further apart each time one fails, and a
// window coming back to the front no more than once in a while per machine.

/** How often a window someone can see re-reads a machine that answers. */
export const REMOTE_REREAD_MS = 3 * 60_000
/** The longest a machine that keeps failing waits between reads on the clock. */
export const REMOTE_REREAD_MAX_MS = 30 * 60_000
/** A window brought to the front re-reads a machine no more often than this. */
export const REMOTE_FOCUS_REREAD_GAP_MS = 30_000
/** How long a read may go unanswered before its rows say the machine is not answering. */
export const REMOTE_ANSWER_GRACE_MS = 20_000

/** How long after a read the clock reads a machine again: the interval, doubled for each failure in a row. */
export function remoteRereadDelayMs(failures: number): number {
  if (failures <= 0) return REMOTE_REREAD_MS
  return Math.min(REMOTE_REREAD_MS * 2 ** failures, REMOTE_REREAD_MAX_MS)
}

/** One machine's read history, as the hook keeps it. */
export type RemoteReadHistory = { askedAt: number; failures: number }

/**
 * Whether a machine is due a read: on the clock, once its delay since the
 * last ask has passed; when the window comes back, once the focus gap has.
 * A machine never asked is always due.
 */
export function remoteReadDue(
  history: RemoteReadHistory | undefined,
  trigger: 'clock' | 'focus',
  now: number,
): boolean {
  if (!history) return true
  const wait = trigger === 'clock' ? remoteRereadDelayMs(history.failures) : REMOTE_FOCUS_REREAD_GAP_MS
  return now - history.askedAt >= wait
}

// ── What the row says ───────────────────────────────────────────────────────

/** What a row from a last-known list says: its words, whether Pair again is offered, and the sentence on hover. */
export type RemoteLastKnownWords = {
  /** "Signed out", "Not answering · 2d". */
  text: string
  /** The machine no longer takes this pairing, or it is gone from here: Pair again is the remedy. */
  pairAgain: boolean
  /** The sentence on hover, naming the machine. */
  detail: string
  /**
   * What a screen reader hears on the row: the state and how old the list
   * is, without the machine's name, which the row's machine glyph already
   * says and which is never row text.
   */
  spoken: string
}

export function remoteLastKnownWords(
  lastKnown: RemoteLastKnown,
  machineName: string,
  now: number,
): RemoteLastKnownWords {
  const words = copy.workspace.remoteBand.remoteListFreshness
  const age = lastKnown.since !== null ? formatRelativeMs(lastKnown.since, now) : ''
  const read = lastKnown.since !== null ? words.readAt(formatRelativeMsAgo(lastKnown.since, now)) : words.readEarlier
  const said = (headline: string, text: string, pairAgain: boolean, sentence: string): RemoteLastKnownWords => ({
    text,
    pairAgain,
    detail: `${sentence} ${read}`,
    spoken: `${headline}. ${read}`,
  })
  switch (lastKnown.reason) {
    case 'signed-out':
      return said(words.signedOut, words.signedOut, true, words.refusedThisDevice(machineName))
    case 'unpaired':
      return said(words.notPaired, words.notPaired, true, words.noLongerPaired(machineName))
    case 'superseded':
      // Paired again already: nothing to pair, only the new pairing's row to open.
      return said(words.oldPairing, words.oldPairing, false, words.pairedAgainSince(machineName))
    case 'outdated':
      return said(words.outOfDate, words.outOfDate, false, words.shareNoProtocol(machineName))
    case 'not-answering':
      return said(
        words.notAnswering,
        age ? `${words.notAnswering} · ${age}` : words.notAnswering,
        false,
        words.isNotAnswering(machineName),
      )
  }
}
