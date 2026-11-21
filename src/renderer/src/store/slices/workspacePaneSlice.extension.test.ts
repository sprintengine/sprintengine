import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace, WorkspacePaneState } from '../../../../shared/workspace'
import {
  createWorkspacePaneSlice,
  normalizeWorkspacePaneState,
  partializeWorkspacePaneState,
} from './workspacePaneSlice'

// An extension tab draws one panel an installed extension declares: it names
// the extension's install key and the panel's id. A tab that names neither has
// nothing to draw and is not kept, and a panel already up is focused rather
// than opened twice.

const NOTES = { key: 'acme.notes', panel: 'notes' }

function carrierWith(paneState?: WorkspacePaneState) {
  const workspace = { id: 'ws-ext', paneState } as unknown as Workspace
  const carrier = { workspaces: [workspace] }
  const slice = createWorkspacePaneSlice((mutator) => mutator(carrier))
  return { slice, pane: () => carrier.workspaces[0].paneState! }
}

test('opening a panel shows it in the pane, and opening it again focuses the same tab', () => {
  const { slice, pane } = carrierWith()
  const first = slice.openPaneTab('ws-ext', { kind: 'extension', title: 'Notes', extension: NOTES })
  assert.ok(first)
  assert.equal(pane().activeTabId, first)
  assert.deepEqual(pane().tabs[0], { id: first, kind: 'extension', title: 'Notes', extension: NOTES })

  const otherPanel = slice.openPaneTab('ws-ext', {
    kind: 'extension',
    extension: { key: 'acme.notes', panel: 'archive' },
  })
  const otherExtension = slice.openPaneTab('ws-ext', {
    kind: 'extension',
    extension: { key: 'local.notes', panel: 'notes' },
  })
  assert.notEqual(otherPanel, first)
  assert.notEqual(otherExtension, first, 'the same panel id in another extension is another tab')
  assert.equal(slice.openPaneTab('ws-ext', { kind: 'extension', extension: { ...NOTES } }), first)
  assert.equal(pane().tabs.length, 3)
  assert.equal(pane().activeTabId, first)
})

test('an extension tab is never opened without the panel it draws', () => {
  const { slice, pane } = carrierWith()
  assert.equal(slice.openPaneTab('ws-ext', { kind: 'extension' }), null)
  assert.equal(pane().tabs.length, 0)
})

test('the normalizer drops an extension tab that names no panel, and a second tab on one panel', () => {
  const normalized = normalizeWorkspacePaneState({
    open: true,
    activeTabId: 'dup',
    tabs: [
      { id: 'a', kind: 'extension', extension: NOTES },
      { id: 'dup', kind: 'extension', extension: { ...NOTES } },
      { id: 'b', kind: 'extension', extension: { key: 'acme.notes', panel: 'archive' } },
      { id: 'none', kind: 'extension' },
      { id: 'no-panel', kind: 'extension', extension: { key: 'acme.notes' } },
      { id: 'empty', kind: 'extension', extension: { key: '', panel: 'notes' } },
      { id: 'long', kind: 'extension', extension: { key: 'acme.notes', panel: 'x'.repeat(201) } },
      { id: 'odd', kind: 'extension', extension: 'acme.notes:notes' },
      { id: 'f', kind: 'files' },
    ],
  })
  assert.deepEqual(
    normalized?.tabs.map((tab) => tab.id),
    ['a', 'b', 'f'],
  )
  // The dropped duplicate's focus goes to the tab that holds the same panel.
  assert.equal(normalized?.activeTabId, 'a')
  assert.deepEqual(normalized?.tabs[0]?.extension, NOTES)
})

test('an extension tab persists with what it draws', () => {
  const persisted = partializeWorkspacePaneState({
    open: true,
    activeTabId: 'a',
    tabs: [{ id: 'a', kind: 'extension', title: 'Notes', extension: NOTES }],
  })
  assert.deepEqual(persisted?.tabs, [{ id: 'a', kind: 'extension', title: 'Notes', extension: NOTES }])
})
