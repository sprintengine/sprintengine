// A components panel's persisted atoms, kept in the extension's data folder:
// the extension's apart from each workspace's, later writes over earlier
// ones, nothing out of shape stored, nothing stored written over unread, and
// nothing made once the extension is gone.

import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
  await writePanelAtoms(dir, {
    workspaceId: 'ws-2',
    entries: [{ scope: 'workspace', key: 'draft', version: 2, value: null }],
  })
  await writePanelAtoms(dir, { entries: [{ scope: 'plugin', key: 'count', version: 1, value: 4 }] })
  assert.deepEqual(await readPanelAtoms(dir, { workspaceId: 'ws-1' }), {
    plugin: { count: { version: 1, value: 4 } },
    workspace: { draft: { version: 2, value: { text: 'hi' } } },
  })
  assert.deepEqual((await readPanelAtoms(dir, { workspaceId: 'ws-2' })).workspace, {
    draft: { version: 2, value: null },
  })
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

test('a call’s scopes are queued together, so a later call’s write is never overwritten by an earlier one', async () => {
  const dir = dataDir()
  const first = writePanelAtoms(dir, {
    workspaceId: 'ws-1',
    entries: [
      { scope: 'plugin', key: 'count', version: 1, value: 1 },
      { scope: 'workspace', key: 'draft', version: 1, value: 'older' },
    ],
  })
  const second = writePanelAtoms(dir, {
    workspaceId: 'ws-1',
    entries: [{ scope: 'workspace', key: 'draft', version: 1, value: 'newer' }],
  })
  await Promise.all([first, second])
  assert.deepEqual((await readPanelAtoms(dir, { workspaceId: 'ws-1' })).workspace, {
    draft: { version: 1, value: 'newer' },
  })
})

test('a file that does not parse is moved aside before a write, never written over', async () => {
  const dir = dataDir()
  mkdirSync(join(dir, 'panel-atoms'))
  writeFileSync(join(dir, 'panel-atoms', 'plugin.json'), '{"count": {"version": 1, "val')
  assert.deepEqual((await readPanelAtoms(dir, {})).plugin, {})
  await writePanelAtoms(dir, { entries: [{ scope: 'plugin', key: 'count', version: 1, value: 2 }] })
  assert.deepEqual((await readPanelAtoms(dir, {})).plugin, { count: { version: 1, value: 2 } })
  const aside = readdirSync(join(dir, 'panel-atoms')).filter((name) => name.startsWith('plugin.json.malformed-'))
  assert.equal(aside.length, 1)
  assert.equal(readFileSync(join(dir, 'panel-atoms', aside[0]!), 'utf8'), '{"count": {"version": 1, "val')
})

test('an entry the reader does not take is kept by a write beside it', async () => {
  const dir = dataDir()
  mkdirSync(join(dir, 'panel-atoms'))
  writeFileSync(join(dir, 'panel-atoms', 'plugin.json'), JSON.stringify({ odd: { version: 'two', value: 1 } }))
  await writePanelAtoms(dir, { entries: [{ scope: 'plugin', key: 'count', version: 1, value: 2 }] })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'panel-atoms', 'plugin.json'), 'utf8')), {
    odd: { version: 'two', value: 1 },
    count: { version: 1, value: 2 },
  })
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a file that cannot be read refuses the read and the write, and stays as it is',
  async () => {
    const dir = dataDir()
    mkdirSync(join(dir, 'panel-atoms'))
    const file = join(dir, 'panel-atoms', 'plugin.json')
    writeFileSync(file, JSON.stringify({ count: { version: 1, value: 7 } }))
    chmodSync(file, 0o000)
    try {
      await assert.rejects(() => readPanelAtoms(dir, {}), /EACCES|permission/iu)
      await assert.rejects(() =>
        writePanelAtoms(dir, { entries: [{ scope: 'plugin', key: 'other', version: 1, value: 1 }] }),
      )
    } finally {
      chmodSync(file, 0o600)
    }
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { count: { version: 1, value: 7 } })
  },
)

test('a write admitted before its extension went makes no folder and no file', async () => {
  const root = dataDir()
  const dir = join(root, 'local.todo')
  let admitted = true
  let checks = 0
  const place = (onCheck?: (count: number) => void) => ({
    key: 'extension:local.todo',
    // As the module storage does: asking for the folder makes it.
    dataDir: () => {
      mkdirSync(dir, { recursive: true })
      return dir
    },
    stillAdmitted: () => {
      checks += 1
      onCheck?.(checks)
      if (!admitted) throw new Error('not installed')
    },
  })
  const entries = [{ scope: 'plugin', key: 'count', version: 1, value: 1 }]

  // Queued behind another write, and the extension is uninstalled before its turn.
  const ahead = writePanelAtoms(place(), { entries })
  const queued = writePanelAtoms(place(), { entries })
  admitted = false
  await assert.rejects(ahead, /not installed/u)
  await assert.rejects(queued, /not installed/u)
  assert.equal(existsSync(dir), false)

  // Uninstalled while its read is out: the check after the read refuses it.
  admitted = true
  checks = 0
  const reading = writePanelAtoms(
    place((count) => {
      if (count !== 2) return
      rmSync(dir, { recursive: true, force: true })
      admitted = false
    }),
    { entries },
  )
  await assert.rejects(reading, /not installed/u)
  assert.equal(existsSync(dir), false)
})
