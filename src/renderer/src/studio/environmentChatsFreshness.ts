// When a window reads an environment's chats again, and what a read that did
// not list them means for the rows it had (`environmentChats.ts`).
//
// A change notice from the environment and the window reaching it again are
// what re-read it, but a notice can be lost and a machine can stop taking this
// device without anything arriving here. So a window that can be seen also
// re-reads on a slow clock, and when a person comes back to it. Neither may
// turn into a stream of requests: one read per environment at a time, a few
// minutes apart while it answers, further apart each time it fails, and a
// window coming back to the front no more than once in a while per
// environment.
//
// A read that fails keeps the rows it had: a machine asleep, or one that no
// longer takes this device, still has the chats a person was working in, and
// a row that vanishes is worse than one that is old. The rows say which they
// are (`remoteListFreshness.ts` has the words).

/** Why the newest read of an environment's chats did not replace them. */
export type EnvironmentListFailure = {
  /** `unauthorized`: the environment refused this device. `unavailable`: it did not answer, or the read broke off. */
  kind: 'unauthorized' | 'unavailable'
  message: string
}

/** The codes a Studio refuses a device with: it no longer takes it. */
const UNAUTHORIZED_CODES = new Set(['unauthorized', 'revoked', 'peer_mismatch'])

/**
 * Refusals that are real answers about the chats rather than a failure to
 * read them: a device that may not read them, or a Studio that does not serve
 * them, lists none, and that list is current.
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
export function listFailureOf(code: string, message: string): EnvironmentListFailure | null {
  if (ANSWERED_CODES.has(code)) return null
  return { kind: UNAUTHORIZED_CODES.has(code) ? 'unauthorized' : 'unavailable', message }
}

/** How often a window someone can see re-reads an environment that answers. */
export const REREAD_MS = 3 * 60_000
/** The longest an environment that keeps failing waits between reads on the clock. */
export const REREAD_MAX_MS = 30 * 60_000
/** A window brought to the front re-reads an environment no more often than this. */
export const FOCUS_REREAD_GAP_MS = 30_000
/** How long a read may go unanswered before its rows say the environment is not answering. */
export const ANSWER_GRACE_MS = 20_000

/** How long after a read the clock reads an environment again: the interval, doubled for each failure in a row. */
export function rereadDelayMs(failures: number): number {
  if (failures <= 0) return REREAD_MS
  return Math.min(REREAD_MS * 2 ** failures, REREAD_MAX_MS)
}

/** One environment's read history: when its chats were last asked for, and how many reads of them in a row failed. */
export type ReadHistory = { askedAt: number; failures: number }

/**
 * Whether an environment is due a read: on the clock, once its delay since
 * the last ask has passed; when the window comes back, once the focus gap
 * has. One never asked is always due.
 */
export function readDue(history: ReadHistory | undefined, trigger: 'clock' | 'focus', now: number): boolean {
  if (!history) return true
  const wait = trigger === 'clock' ? rereadDelayMs(history.failures) : FOCUS_REREAD_GAP_MS
  return now - history.askedAt >= wait
}
