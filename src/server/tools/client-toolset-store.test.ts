import { savedRecordRows, seedRecordRows, testDatabaseAt } from '../../../tests/studio-database'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { STUDIO_DATABASE_FILENAME } from '../db/database'
import { createClientToolsetStore, readClientToolsetsFile } from './client-toolset-store'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const dataDir = () => {
  const directory = mkdtempSync(join(tmpdir(), 'client-toolsets-'))
  directories.push(directory)
  return directory
}

test('bindings and grants survive a restart, in a database only its owner reads', async () => {
  const directory = dataDir()
  const store = createClientToolsetStore({ database: testDatabaseAt(directory) })
  store.bind('game', 'sla_game', 'Acme Game')
  store.setGranted('game', { workspaceId: 'ws-1', agentId: 'chat' }, true)
  await savedRecordRows(directory, 'client_toolsets')
  const again = createClientToolsetStore({ database: testDatabaseAt(directory) })
  assert.equal(again.binding('game')?.clientId, 'sla_game')
  assert.equal(again.binding('game')?.title, 'Acme Game')
  assert.deepEqual(again.grantsOf({ workspaceId: 'ws-1', agentId: 'chat' }), ['game'])
  if (process.platform !== 'win32')
    assert.equal(statSync(join(directory, STUDIO_DATABASE_FILENAME)).mode & 0o777, 0o600)
  assert.throws(() => again.bind('game', 'sla_other', 'Other'), /bound to another client/)
  assert.deepEqual(again.forgetClient('sla_game'), ['game'])
  assert.deepEqual(await savedRecordRows(directory, 'client_toolsets'), [])
})

test('a row that does not read binds nothing, and an entry in the wrong shape is skipped', () => {
  const directory = dataDir()
  seedRecordRows(directory, 'client_toolsets', [{ id: 'game', body: 'not a binding' }])
  const logs: string[] = []
  const store = createClientToolsetStore({ database: testDatabaseAt(directory), log: (message) => logs.push(message) })
  assert.deepEqual(store.bindings(), [])
  assert.equal(logs.length, 1)
  // The file builds before the database kept, as the import reads it.
  assert.deepEqual(
    readClientToolsetsFile(
      JSON.stringify({
        bindings: [
          { toolset: 'Bad_Name', clientId: 'x' },
          { toolset: 'ok-name', clientId: 'sla_1' },
        ],
      }),
    )?.map((binding) => binding.toolset),
    ['ok-name'],
  )
  assert.equal(readClientToolsetsFile('{ not json'), null)
})
