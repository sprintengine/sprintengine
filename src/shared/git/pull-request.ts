// A pull request as the app shows it on a conversation (backlog epic
// pull-request-marks, decisions 1–6). Three states and nothing else: a draft is
// an OPEN pull request with `isDraft` set, never a fourth state, and there is
// no "unknown" — the app draws a pull request only when it definitely has one.
//
// State comes from GitHub (through `gh`) or stays as last read. It is NEVER
// inferred from git ancestry: a rebase, a force push or a squash merge leaves
// no ancestor of the branch tip on main, so `merge-base --is-ancestor` would
// call a landed pull request open for ever (decision 8c). A pull request on
// another forge has no state the app can read: it is shown as opened.

import { classifyPullRequestUrl } from './pr-url'
import { canonicalRepositoryKey } from '../repository-identity'

import type { BranchPullRequest, StudioPullRequestState } from '../../../packages/studio-protocol/src/public'

export type { BranchPullRequest }
export type PullRequestState = StudioPullRequestState

/**
 * The tone a pull request's state inks with (decision 2): open takes the
 * accent because it is the one you can still act on; merged takes the violet
 * the run glyph already wears once a branch lands; closed takes the danger
 * red GitHub itself uses for a pull request that ended without landing.
 * Shape carries the state — the tone only agrees with it.
 */
export type PullRequestTone = 'accent' | 'merged' | 'error'

export function pullRequestTone(state: PullRequestState): PullRequestTone {
  if (state === 'merged') return 'merged'
  if (state === 'closed') return 'error'
  return 'accent'
}

/** The CSS custom property each tone resolves to, for callers that ink by class. */
export const PULL_REQUEST_TONE_VAR: Record<PullRequestTone, string> = {
  accent: 'var(--accent-primary)',
  merged: 'var(--tone-merged)',
  error: 'var(--tone-error)',
}

/** The word a tooltip or a spoken label uses for the state. */
export function pullRequestStateLabel(pr: Pick<BranchPullRequest, 'state' | 'isDraft' | 'forge'>): string {
  // A forge whose state the app cannot read: it is known to have been
  // opened, and nothing more is claimed.
  if (pr.forge) return 'opened'
  if (pr.state === 'merged') return 'merged'
  // "closed" alone reads as resolved; the mockup's wording says the work did
  // NOT land, which is the fact the red cross is drawing.
  if (pr.state === 'closed') return 'closed without merging'
  return pr.isDraft ? 'open, a draft' : 'open'
}

/** What clicking a pull request does, said in words: the forge's own name for GitHub, a browser for the rest. */
export function pullRequestOpenLabel(pr: Pick<BranchPullRequest, 'forge'>): string {
  return pr.forge ? 'Open it in the browser' : 'Open it on GitHub'
}

/**
 * The repository a pull request URL names, on any forge the classifier reads.
 * Built through the one URL classifier and the one repository canonicaliser,
 * so a pull request keys exactly the way a local clone of that repository does
 * and the two join up.
 */
export function pullRequestRepository(url: string): { repoKey: string; repoName: string } | null {
  const classified = classifyPullRequestUrl(url)
  if (!classified) return null
  const repoKey = canonicalRepositoryKey(classified.repositoryUrl)
  if (!repoKey) return null
  const segments = repoKey.split('/').filter((segment) => segment.length > 0)
  const name = segments[segments.length - 1]
  return name ? { repoKey, repoName: name } : null
}

/** The canonical URL for a pull request URL, or null when it is not one. */
export function canonicalPullRequestUrlOf(url: string): string | null {
  return classifyPullRequestUrl(url)?.url ?? null
}

function newestFirst(a: BranchPullRequest, b: BranchPullRequest): number {
  return b.openedAt - a.openedAt || b.number - a.number
}

/**
 * The one pull request a conversation wears (decision 5): the most recent one
 * that is still open, or the newest of all once every one has landed or
 * closed. `null` when there are none — and then nothing is drawn.
 */
export function primaryPullRequest(list: readonly BranchPullRequest[]): BranchPullRequest | null {
  if (list.length === 0) return null
  const sorted = [...list].sort(newestFirst)
  return sorted.find((pr) => pr.state === 'open') ?? sorted[0] ?? null
}

/**
 * The menu's groups (decision 6): open, merged, closed, newest first within
 * each. Callers omit empty groups.
 */
export function groupPullRequests(list: readonly BranchPullRequest[]): {
  open: BranchPullRequest[]
  merged: BranchPullRequest[]
  closed: BranchPullRequest[]
} {
  const sorted = [...list].sort(newestFirst)
  return {
    open: sorted.filter((pr) => pr.state === 'open'),
    merged: sorted.filter((pr) => pr.state === 'merged'),
    closed: sorted.filter((pr) => pr.state === 'closed'),
  }
}

/** Every pull request other than the primary, newest first — the tooltip's "Earlier:" lines. */
export function earlierPullRequests(list: readonly BranchPullRequest[]): BranchPullRequest[] {
  const primary = primaryPullRequest(list)
  return [...list].sort(newestFirst).filter((pr) => pr !== primary)
}

/**
 * The pull request Studio is watching for this list's conversation, if any:
 * an open one on GitHub its agent asked to have watched. What makes a chat
 * read as working between its turns, and what its words are about. The rest
 * sweep leaves such a chat alone: it is waiting to be woken, not done.
 */
export function watchedPullRequest(list: readonly BranchPullRequest[]): BranchPullRequest | null {
  return list.find((pr) => pr.watch && pr.state === 'open' && !pr.forge) ?? null
}
