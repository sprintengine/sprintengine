import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceId } from '../../types/workspace'
import { openGitDiff } from '../../utils/openGitDiff'
import { useWorkspaceStore } from '../workspaceStore'
import { normalizeWorkspacePaneState, partializeWorkspacePaneState } from './workspacePaneSlice'

// An agent's editor.open_diff in the pane: what it asked for — the changelist,
// the `paths` narrowing, the step and the range — has to survive the pane's own
// normalizer, which every pane write runs, and must not survive a restart.

const reveal = {
  key: 'req-1',
  paths: ['src/a.ts'],
  step: { kind: 'commit' as const, hash: 'a'.repeat(40) },
  range: { startLine: 7, endLine: 9 },
  side: 'modified' as const,
}

const diffTab = {
  id: 'tab-diff',
  kind: 'diff' as const,
  diff: {
    repoRoot: '/Users/dev/repo',
    focusPath: '/Users/dev/repo/src/a.ts',
    focusKind: 'unstaged' as const,
    changelistId: 'agent:agent-7',
    reveal,
  },
}

test('the pane keeps an agent reveal and its changelist through normalization', () => {
  const pane = normalizeWorkspacePaneState({ open: true, activeTabId: 'tab-diff', tabs: [diffTab] })
  assert.deepEqual(pane?.tabs[0].diff, diffTab.diff)
})

test('a restart restores the Diff tab but not the reveal', () => {
  const persisted = partializeWorkspacePaneState({ open: true, activeTabId: 'tab-diff', tabs: [diffTab] })
  const { reveal: _reveal, ...withoutReveal } = diffTab.diff
  assert.deepEqual(persisted?.tabs[0].diff, withoutReveal)
})

test('the step the viewer has open rides the tab for the session, and a restart drops it', () => {
  const kept = { step: { kind: 'commit' as const, hash: 'b'.repeat(40) }, afterReveal: 'req-1' }
  const withKept = { ...diffTab, diff: { ...diffTab.diff, kept } }
  const pane = normalizeWorkspacePaneState({ open: true, activeTabId: 'tab-diff', tabs: [withKept] })
  assert.deepEqual(pane?.tabs[0].diff?.kept, kept)
  // A malformed one is dropped, not the tab.
  const bad = normalizeWorkspacePaneState({
    open: true,
    activeTabId: 'tab-diff',
    tabs: [{ ...diffTab, diff: { ...diffTab.diff, kept: { step: { kind: 'sideways' } } } }],
  })
  assert.equal(bad?.tabs[0].diff?.kept, undefined)
  assert.equal(bad?.tabs[0].id, 'tab-diff')
  const persisted = partializeWorkspacePaneState({ open: true, activeTabId: 'tab-diff', tabs: [withKept] })
  assert.equal(persisted?.tabs[0].diff?.kept, undefined)
  assert.equal(persisted?.tabs[0].diff?.reveal, undefined)
})

test('an agent diff, working tree or commit step, goes to the Diff tab and never takes focus', () => {
  const paneCalls: Array<{ workspaceId: string; input: Record<string, unknown> }> = []
  Object.defineProperty(globalThis, 'window', { value: { api: {} }, configurable: true })
  useWorkspaceStore.setState({
    openPaneTab: (workspaceId: WorkspaceId, input: Record<string, unknown>) => {
      paneCalls.push({ workspaceId, input })
      return 'tab-diff'
    },
  } as unknown as Partial<ReturnType<typeof useWorkspaceStore.getState>>)
  const base = {
    workspaceId: 'ws-1',
    repoRoot: '/Users/dev/repo',
    focusPath: '/Users/dev/repo/src/a.ts',
    scope: 'unstaged' as const,
  }

  // The working tree and a commit step alike: the Diff tab, which shows in a
  // window of its own, carrying the reveal.
  openGitDiff({
    ...base,
    reveal: { key: 'req-2', paths: ['src/a.ts'], step: { kind: 'uncommitted' } },
    takeFocus: false,
  })
  assert.equal(paneCalls.length, 1)
  assert.deepEqual((paneCalls[0].input.diff as { reveal: unknown }).reveal, {
    key: 'req-2',
    paths: ['src/a.ts'],
    step: { kind: 'uncommitted' },
  })
  openGitDiff({ ...base, reveal, takeFocus: false })
  assert.equal(paneCalls.length, 2)
  assert.deepEqual((paneCalls[1].input.diff as { reveal: unknown }).reveal, reveal)
  // Never activated in the pane: the window shows it (panePopOut.test.tsx).
  assert.equal(paneCalls[1].input.activate, false)
})
