import {
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParsed,
} from './contract.js'
import { STUDIO_PULL_REQUEST_READS_CAPABILITY } from './handshake.js'

// One pull request read in full, by its GitHub URL, for a client that shows
// it in a viewer of its own (the phone's): its state, checks, reviews, the
// latest remarks and the changed files (`pullRequests.detail`), and a page of
// one file's diff at a time (`pullRequests.diff`). Read through the Studio
// machine's `gh` afresh at each ask; nothing is kept.
//
// On `workspaces:operate`, behind the `pull-request-reads` capability: a
// paired device reached them only with its `workspace:operate` pairing
// before they were protocol methods, and still does. A URL that is not a
// GitHub pull request's, or a file it does not change, is refused
// `invalid_params`; one `gh` cannot read is answered `unavailable`.

/** The most of each list a pull request read carries; the totals say how many there are. */
export const STUDIO_PULL_REQUEST_READ_LIMITS = {
  checks: 30,
  remarks: 5,
  remarkChars: 280,
  files: 100,
  /** Lines of one file's diff per page, cut back to a hunk's start where one falls inside it. */
  diffPageLines: 300,
  /** A diff line longer than this is cut, with an ellipsis. */
  diffLineChars: 500,
} as const

export type StudioPullRequestCheck = {
  name: string
  /** The workflow it runs in; empty for a commit status. */
  workflow: string
  status: 'pending' | 'passed' | 'failed'
  /** The base branch requires it; false also when that could not be read. */
  required: boolean
}

export type StudioPullRequestRemark = {
  kind: 'comment' | 'review'
  author: string
  /** A review's verdict; absent on a comment. */
  verdict?: 'approved' | 'changes-requested' | 'commented'
  /** The opening of what was written, at most `remarkChars`; empty for a review left only on lines. */
  excerpt: string
  /** When it was written, ms epoch; 0 when GitHub did not say. */
  at: number
}

export interface StudioPullRequestDetail {
  url: string
  number: number | null
  title: string | null
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  author: string | null
  baseRefName: string | null
  headRefName: string | null
  openedAt: number | null
  /** When it merged or closed; null while open. */
  endedAt: number | null
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  /** Every check on the head, counted; `items` is the failing ones first, then running, then passed. */
  checks: { passed: number; failed: number; pending: number; items: StudioPullRequestCheck[] }
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null
  reviews: { approved: number; changesRequested: number; commented: number }
  /** Comments and reviews together: how many, and the latest few, newest first. */
  remarks: { total: number; latest: StudioPullRequestRemark[] }
  /** The changed files. `total` is GitHub's count, which may be more than `items` lists. Null when they could not be read. */
  files: {
    total: number
    additions: number
    deletions: number
    items: { path: string; additions: number; deletions: number; change: string | null }[]
  } | null
}

export interface StudioPullRequestDiffPage {
  url: string
  path: string
  /** The page as unified diff text: the file's header on the first page, then whole hunks where they fit. */
  patch: string
  offset: number
  /** Where the next page starts, or null when this is the last. */
  nextOffset: number | null
  /** How many lines the file's section of the diff has. */
  totalLines: number
}

export type StudioPullRequestReadsMethodMap = {
  'pullRequests.detail': { params: { url: string }; result: StudioPullRequestDetail }
  'pullRequests.diff': {
    params: { url: string; path: string; offset?: number }
    result: StudioPullRequestDiffPage
  }
}

export type StudioPullRequestReadsMethod = keyof StudioPullRequestReadsMethodMap

const refuse = (message: string): StudioParamsRefusal => studioParamsRefused(message)

/** A pull request URL a client may name: GitHub's own shape, checked again where it is read. */
const MAX_PULL_REQUEST_URL_CHARS = 500
/** A changed file's path, as git names it; longer than any a repository holds. */
const MAX_DIFF_PATH_CHARS = 1000

function url(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PULL_REQUEST_URL_CHARS
}

function parseDetail(value: Record<string, unknown>): StudioParsed<{ url: string }> {
  return url(value.url) ? studioParams({ url: value.url }) : refuse('"url" is a GitHub pull request\'s URL.')
}

function parseDiff(value: Record<string, unknown>): StudioParsed<{ url: string; path: string; offset?: number }> {
  if (!url(value.url)) return refuse('"url" is a GitHub pull request\'s URL.')
  if (
    typeof value.path !== 'string' ||
    !value.path ||
    value.path.length > MAX_DIFF_PATH_CHARS ||
    value.path.includes('\0')
  )
    return refuse('"path" is a changed file\'s path, from pullRequests.detail.')
  if (
    value.offset !== undefined &&
    !(typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0)
  )
    return refuse('"offset" is a line to start from, 0 or more.')
  return studioParams({
    url: value.url,
    path: value.path,
    ...(value.offset !== undefined ? { offset: value.offset as number } : {}),
  })
}

const reads = {
  scope: 'workspaces:operate',
  mutation: false,
  capability: STUDIO_PULL_REQUEST_READS_CAPABILITY,
} as const

export const STUDIO_PULL_REQUEST_READS_METHODS: StudioMethodTable<StudioPullRequestReadsMethodMap> = {
  'pullRequests.detail': { ...reads, params: parseDetail },
  'pullRequests.diff': { ...reads, params: parseDiff },
}
