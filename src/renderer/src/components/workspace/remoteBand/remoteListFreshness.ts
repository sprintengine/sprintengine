import type { MeshMachineReachability } from '../../../../../shared/tailnet-mesh'
import type { EnvironmentStatusKind } from '../../../../../../packages/client-runtime/src/environments/environmentStatus'
import { formatRelativeMs, formatRelativeMsAgo } from '../../../utils/relativeTime'
import { copy } from '../../../../../shared/copy'
import type { EnvironmentListFailure } from '../../../studio/environmentChatsFreshness'

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
  entry: { listedAt?: number; listFailure?: EnvironmentListFailure | null } | undefined,
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
