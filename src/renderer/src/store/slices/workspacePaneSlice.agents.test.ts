import assert from 'node:assert/strict'
import { test } from 'vitest'
import { STATIC_PANE_KINDS } from '../../components/workspace/pane/paneKinds'
import type { Workspace, WorkspacePaneState } from '../../../../shared/workspace'
import { healRetiredRailLayout } from './layoutSlice'
import { normalizeWorkspacePaneState } from './workspacePaneSlice'

// A chat's subagents are on the right-hand panel now, so the tab that listed
// them is gone. An older profile still has it saved.

// What every restore runs: main's records reach a window without passing the
// normalizer, so a record read straight from disk has to come through here.
const restored = (paneState: unknown): Workspace =>
  healRetiredRailLayout({
    id: 'w',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    paneState: paneState as WorkspacePaneState,
  } as unknown as Workspace)

test('restoring a record from disk drops its agents tab and keeps the rest', () => {
  const pane = restored({
    open: true,
    activeTabId: 'old-agents',
    tabs: [
      { id: 'old-agents', kind: 'agents' },
      { id: 'files', kind: 'files' },
    ],
  }).paneState
  assert.deepEqual(pane?.tabs, [{ id: 'files', kind: 'files' }])
  assert.equal(pane?.activeTabId, 'files')
})

test('a record with no agents tab comes back the same record', () => {
  const workspace = restored({ open: false, activeTabId: 'files', tabs: [{ id: 'files', kind: 'files' }] })
  assert.equal(healRetiredRailLayout(workspace), workspace)
})

test('no pane kind lists subagents: the "+" menu offers no such tab', () => {
  assert.equal(
    STATIC_PANE_KINDS.some((definition) => (definition.kind as string) === 'agents'),
    false,
  )
})

test('a saved agents tab is dropped on restore, and the pane opens on what is left', () => {
  const normalized = normalizeWorkspacePaneState({
    open: true,
    activeTabId: 'old-agents',
    tabs: [
      { id: 'files', kind: 'files' },
      { id: 'old-agents', kind: 'agents' },
    ],
  })
  assert.deepEqual(normalized?.tabs, [{ id: 'files', kind: 'files' }])
  assert.notEqual(normalized?.activeTabId, 'old-agents')
})

test('a pane that held only an agents tab restores with nothing in it, and no dangling front tab', () => {
  const normalized = normalizeWorkspacePaneState({
    open: true,
    activeTabId: 'old-agents',
    tabs: [{ id: 'old-agents', kind: 'agents', poppedOut: 'window-1' }],
  })
  assert.deepEqual(normalized?.tabs ?? [], [])
  assert.notEqual(normalized?.activeTabId, 'old-agents')
})
