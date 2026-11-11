import assert from 'node:assert/strict'

import type { WorkspaceId } from '../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import { openGitDiff } from './openGitDiff'
import { test } from 'vitest'

test('openGitDiff', async () => {
  // `openGitDiff` is the one place that answers "where does a diff open" for the
  // Git panel's rows, the File Explorer's "View Git diff" and an agent's reveal.
  // It always asks for the workspace's Diff tab, carrying the caller's
  // repository; panePopOut.test.tsx owns how that tab comes to show in a window.

  type PaneOpenCall = { workspaceId: string; input: unknown }
  const paneCalls: PaneOpenCall[] = []
  const api: Record<string, unknown> = {}
  Object.defineProperty(globalThis, 'window', { value: { api }, configurable: true })

  useWorkspaceStore.setState({
    openPaneTab: (workspaceId: WorkspaceId, input: unknown) => {
      paneCalls.push({ workspaceId, input })
      return 'tab-diff'
    },
  } as Partial<ReturnType<typeof useWorkspaceStore.getState>>)

  const target = {
    workspaceId: 'ws-1',
    repoRoot: '/repos/app-worktree',
    focusPath: '/repos/app-worktree/src/a.ts',
    scope: 'unstaged' as const,
  }

  // --- a desktop window: the tab is written, never shown in the pane --------
  openGitDiff(target)
  assert.equal(paneCalls.length, 1)
  assert.equal(paneCalls[0].workspaceId, 'ws-1')
  assert.deepEqual(paneCalls[0].input, {
    kind: 'diff',
    diff: {
      // The caller's repository, carried to the tab: the viewer must not
      // re-derive one from the workspace, which is a different repo for a
      // worktree scope.
      repoRoot: '/repos/app-worktree',
      focusPath: '/repos/app-worktree/src/a.ts',
      focusKind: 'unstaged',
    },
    // Activating it would open the pane only for the window to take it away.
    activate: false,
  })

  // --- a browser tab has no second window: the pane shows it ----------------
  api.clientCapabilities = []
  openGitDiff({ ...target, focusPath: '/repos/app-worktree/src/b.ts', scope: 'staged' })
  assert.equal(paneCalls.length, 2)
  assert.deepEqual(paneCalls[1].input, {
    kind: 'diff',
    diff: { repoRoot: '/repos/app-worktree', focusPath: '/repos/app-worktree/src/b.ts', focusKind: 'staged' },
  })

  // A reveal behind the person's tab stays behind it there too.
  openGitDiff({ ...target, background: true })
  assert.equal((paneCalls[2].input as { activate?: boolean }).activate, false)
})
