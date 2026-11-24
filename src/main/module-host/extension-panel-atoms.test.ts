// A components panel's persisted atoms, kept in the extension's data folder:
// the extension's apart from each workspace's, later writes over earlier
// ones, and nothing out of shape stored.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { PanelAtomsRefusal, readPanelAtoms, writePanelAtoms } from './extension-panel-atoms'

const folders: string[] = []
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-atoms-'))
  folders.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('the extension’s atoms and each workspace’s are kept apart', async () => {
  const dir = dataDir()
  assert.deepEqual(await readPanelAtoms(dir, {}), { plugin: {}, workspace: {} })
  await writePanelAtoms(dir, {
    workspaceId: 'ws-1',
    entries: [
      { scope: 'plugin', key: 'count', version: 1, value: 3 },
      { scope: 'workspace', key: 'draft', version: 2, value: { text: 'hi' } },
    ],
  })
  await writePanelAtoms(dir, { workspaceId: 'ws-2', entries: [{ scope: 'workspace', key: 'draft', version: 2, value: null }] })
  await writePanelAtoms(dir, { entries: [{ scope: 'plugin', key: 'count', version: 1, value: 4 }] })
  assert.deepEqual(await readPanelAtoms(dir, { workspaceId: 'ws-1' }), {
    plugin: { count: { version: 1, value: 4 } },
    workspace: { draft: { version: 2, value: { text: 'hi' } } },
  })
  assert.deepEqual((await readPanelAtoms(dir, { workspaceId: 'ws-2' })).workspace, { draft: { version: 2, value: null } })
  assert.deepEqual((await readPanelAtoms(dir, {})).workspace, {})
})

test('writes out of shape are refused, and a workspace atom needs its workspace', async () => {
  const dir = dataDir()
  const refuse = (params: Record<string, unknown>) =>
    assert.rejects(() => writePanelAtoms(dir, params), PanelAtomsRefusal)
  await refuse({ entries: [] })
  await refuse({ entries: [{ scope: 'memory', key: 'a', version: 1, value: 1 }] })
  await refuse({ entries: [{ scope: 'plugin', key: 'no spaces', version: 1, value: 1 }] })
  await refuse({ entries: [{ scope: 'plugin', key: 'a', version: 0, value: 1 }] })
  await refuse({ entries: [{ scope: 'plugin', key: 'a', version: 1 }] })
  await refuse({ entries: [{ scope: 'workspace', key: 'a', version: 1, value: 1 }] })
  await refuse({ entries: [{ scope: 'plugin', key: 'big', version: 1, value: 'x'.repeat(1024 * 1024 + 1) }] })
  assert.deepEqual(await readPanelAtoms(dir, {}), { plugin: {}, workspace: {} })
})
