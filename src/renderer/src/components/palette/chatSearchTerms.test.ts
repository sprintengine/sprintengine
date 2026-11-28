import { expect, test } from 'vitest'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import type { Workspace } from '../../../../shared/workspace'
import { commandMatchesQuery } from '../commandPaletteSearch'
import type { RemoteConversation } from '../workspace/remoteBand/remoteSessionsModel'
import {
  chatBranch,
  chatMatchReason,
  chatProjectName,
  chatPullRequestBadge,
  chatPullRequestShown,
  chatSearchKeywords,
  environmentChatFacts,
  mergeChatPullRequests,
  pullRequestSearchTerms,
  sameChatPullRequests,
} from './chatSearchTerms'

function pullRequest(overrides: Partial<BranchPullRequest> = {}): BranchPullRequest {
  return {
    url: 'https://github.com/acme/app/pull/12482',
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    number: 12482,
    title: 'Retry interrupted downloads',
    state: 'open',
    isDraft: false,
    openedAt: 1_000,
    stateAt: 1_000,
    ...overrides,
  }
}

/** A chat row as the palette builds it: its title, folder and keywords. */
function chatRow(keywords: string) {
  return { label: 'Fix the updater', description: '/Users/dev/app', keywords: `switch to Chat ${keywords}` }
}

test('a pull request is searchable by number, owner/repo#number, URL, title and branch', () => {
  expect(pullRequestSearchTerms(pullRequest({ headRefName: 'fix/updater-retry' }))).toEqual([
    '#12482',
    '12482',
    'acme/app#12482',
    'https://github.com/acme/app/pull/12482',
    'Retry interrupted downloads',
    'fix/updater-retry',
  ])
})

test('a repository key with no host still yields the number terms', () => {
  expect(pullRequestSearchTerms(pullRequest({ repoKey: 'app', title: '' }))).toEqual([
    '#12482',
    '12482',
    'https://github.com/acme/app/pull/12482',
  ])
})

test('the palette finds a chat by each way of typing its pull request', () => {
  const row = chatRow(chatSearchKeywords([pullRequest()], null))
  for (const query of ['#12482', '12482', 'acme/app#12482', 'https://github.com/acme/app/pull/12482', 'interrupted']) {
    expect(commandMatchesQuery(row, query)).toBe(true)
  }
  expect(commandMatchesQuery(row, '#12483')).toBe(false)
})

test('the palette finds a chat by its branch without any pull request', () => {
  const row = chatRow(chatSearchKeywords([], 'agent/updater-retry'))
  expect(commandMatchesQuery(row, 'updater-retry')).toBe(true)
  expect(commandMatchesQuery(row, '#12482')).toBe(false)
})

test('a chat with neither adds no keywords', () => {
  expect(chatSearchKeywords([], null)).toBe('')
})

test('the branch is the worktree the chat was cut on', () => {
  expect(chatBranch({ worktree: { branch: ' agent/retry ' } })).toBe('agent/retry')
  expect(chatBranch({ worktree: null })).toBeNull()
  expect(chatBranch({ worktree: { branch: '  ' } })).toBeNull()
})

test('the record and the live marks merge to one entry per URL, the record first', () => {
  const recorded = pullRequest({ title: 'From the record' })
  const sameOnSession = pullRequest({ title: 'From the session' })
  const onlyOnSession = pullRequest({ url: 'https://github.com/acme/app/pull/490', number: 490 })
  const merged = mergeChatPullRequests([recorded], [[sameOnSession, onlyOnSession], undefined])
  expect(merged.map((entry) => entry.title)).toEqual(['From the record', 'Retry interrupted downloads'])
  expect(merged.map((entry) => entry.number)).toEqual([12482, 490])
  expect(mergeChatPullRequests(undefined, [])).toEqual([])
})

test('lists that search and badge the same compare equal; a new title does not', () => {
  expect(sameChatPullRequests([pullRequest()], [pullRequest({ stateAt: 9_000 })])).toBe(true)
  expect(sameChatPullRequests([pullRequest()], [pullRequest({ title: 'Renamed' })])).toBe(false)
  expect(sameChatPullRequests([pullRequest()], [pullRequest({ state: 'merged' })])).toBe(false)
  expect(sameChatPullRequests([pullRequest()], [])).toBe(false)
})

test('the badge names the pull request the query names', () => {
  const older = pullRequest({ url: 'https://github.com/acme/app/pull/12', number: 12, openedAt: 1 })
  const newer = pullRequest({ openedAt: 2 })
  expect(chatPullRequestBadge([older, newer], '#12')).toBe('#12')
  expect(chatPullRequestBadge([older, newer], '  ACME/APP#12 ')).toBe('#12')
})

test('without a query naming one, the badge is the mark the sidebar shows', () => {
  const merged = pullRequest({ url: 'https://github.com/acme/app/pull/12', number: 12, state: 'merged', openedAt: 3 })
  const open = pullRequest({ openedAt: 2 })
  expect(chatPullRequestBadge([merged, open], '')).toBe('#12482')
  expect(chatPullRequestBadge([merged, open], 'updater')).toBe('#12482')
})

test('a chat whose only pull request closed unmerged wears no badge unless it is searched for', () => {
  const closed = pullRequest({ state: 'closed' })
  expect(chatPullRequestBadge([closed], '')).toBeUndefined()
  expect(chatPullRequestBadge([closed], '#12482')).toBe('#12482')
  expect(chatPullRequestBadge([], '#12482')).toBeUndefined()
})

test('a chat found by its pull request says so under its title, with the title the word was in', () => {
  const chat = {
    name: 'Fix open issues for production',
    folderPath: '/Users/dev/.sprintengine-worktrees/app/pool-08',
    pullRequests: [pullRequest({ number: 79, title: 'Read wave directions from open water' })],
    branch: 'agent/open-water',
  }
  expect(chatMatchReason(chat, 'wave')).toEqual({
    kind: 'pull-request',
    text: '#79 Read wave directions from open water',
  })
  expect(chatMatchReason(chat, 'open-water')).toEqual({ kind: 'branch', text: 'agent/open-water' })
  expect(chatMatchReason(chat, 'pool-08')).toEqual({ kind: 'folder', text: chat.folderPath })
  // The title already says why; a match nothing on the row could show says nothing.
  expect(chatMatchReason(chat, 'production')).toBeNull()
  expect(chatMatchReason(chat, 'switch')).toBeNull()
})

test('the pull request a row draws carries its state as well as its number', () => {
  const merged = pullRequest({ number: 79, state: 'merged' })
  expect(chatPullRequestShown([merged], '')).toMatchObject({ number: 79, state: 'merged' })
  expect(chatPullRequestShown([], '')).toBeNull()
})

test('a chat names its project as the sidebar does: the project a worktree was cut from, never the slot', () => {
  const worktree = {
    folderPath: '/Users/dev/.sprintengine-worktrees/app/pool-08',
    worktree: { branch: 'agent/x', baseRef: 'HEAD', repoRoot: '/Users/dev/app' },
  } as unknown as Workspace
  expect(chatProjectName(worktree)).toBe('app')
  expect(chatProjectName({ folderPath: '/Users/dev/app/' } as unknown as Workspace)).toBe('app')
  expect(chatProjectName({ folderPath: null } as unknown as Workspace)).toBeNull()
})

// Another environment's chat is a palette row by its address, from its
// environment's own row: the same row and project the sidebar draws, found by
// its folder there, its branch and its pull requests.
test("another environment's chat is a switch row at its address, found by its folder, branch and pull requests", () => {
  const listed = {
    key: 'env-ssh:rw1',
    title: 'Parser review',
    machineName: 'build-box',
    workspaceRoot: '/home/dev/.sprintengine-worktrees/app/pool-02',
    projectFolder: '/home/dev/app',
    agents: [
      { branch: ' agent/parser ', pullRequests: [pullRequest({ number: 77 })] },
      {
        branch: null,
        pullRequests: [
          pullRequest({ number: 77 }),
          pullRequest({ number: 78, url: 'https://github.com/acme/app/pull/78' }),
        ],
      },
    ],
  } as unknown as RemoteConversation
  const facts = environmentChatFacts(listed)
  expect(facts.project).toBe('app')
  expect(facts.branch).toBe('agent/parser')
  expect(facts.pullRequests.map((entry) => entry.number)).toEqual([77, 78])
  expect(facts.folderPath).toBe('/home/dev/.sprintengine-worktrees/app/pool-02')
  const row = chatRow([facts.folderPath, chatSearchKeywords(facts.pullRequests, facts.branch)].join(' '))
  expect(commandMatchesQuery(row, '#78')).toBe(true)
  expect(commandMatchesQuery(row, 'agent/parser')).toBe(true)
  expect(commandMatchesQuery(row, 'pool-02')).toBe(true)
  // A chat with no folder there is named by its machine, as its sidebar header is.
  expect(environmentChatFacts({ ...listed, workspaceRoot: null, projectFolder: null, agents: [] }).project).toBe(
    'build-box',
  )
})
