import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { openTestDatabase } from '../../../tests/studio-database'
import { createPendingFirstMessages } from '../../main/conversation-first-messages'
import { setHandoverExportsAside, STALE_TEMP_MS, sweepDataFolder } from './data-folder-sweep'

test('a start removes what nothing points at in its data folder, and only that', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'se-sweep-'))
  const database = openTestDatabase(dataDir)
  const imagesRoot = join(dataDir, 'conversation-first-messages')
  const firstMessages = createPendingFirstMessages({ database, imagesRoot })
  // One message kept with a picture; one folder whose message is gone; one folder not ours.
  await firstMessages.keep('cmd-kept', { launchCommandId: 'launch-1', message: 'hi', at: 1 }, [
    { id: 'img-1', mediaType: 'image/png', dataBase64: 'aGk=', byteLength: 2 },
  ])
  const kept = readdirSync(imagesRoot)
  mkdirSync(join(imagesRoot, 'f'.repeat(32)))
  mkdirSync(join(imagesRoot, 'notes'))
  // A terminal snapshot half-written long ago, and one being written now.
  const snapshots = join(dataDir, 'terminal-snapshots')
  mkdirSync(snapshots)
  writeFileSync(join(snapshots, 'old.json.tmp'), '{')
  const longAgo = (Date.now() - STALE_TEMP_MS - 60_000) / 1000
  utimesSync(join(snapshots, 'old.json.tmp'), longAgo, longAgo)
  writeFileSync(join(snapshots, 'now.json.tmp'), '{')
  writeFileSync(join(snapshots, 'session.json'), '{}')
  // The last run's hand-over exports, put aside as this run starts.
  mkdirSync(join(dataDir, 'handover-exports', 'ws-1'), { recursive: true })
  setHandoverExportsAside(dataDir)
  assert.equal(existsSync(join(dataDir, 'handover-exports')), false, 'put aside at once')

  const logs: string[] = []
  await sweepDataFolder({ dataDir, firstMessages, log: (message) => logs.push(message) })

  assert.deepEqual(readdirSync(imagesRoot).sort(), [...kept, 'notes'].sort())
  assert.deepEqual(readdirSync(snapshots).sort(), ['now.json.tmp', 'session.json'])
  assert.deepEqual(
    readdirSync(dataDir).filter((name) => name.startsWith('handover-exports')),
    [],
  )
  assert.equal(logs.length, 1)

  // Nothing left to remove: a second start says nothing.
  await sweepDataFolder({ dataDir, firstMessages, log: (message) => logs.push(message) })
  assert.equal(logs.length, 1)
})
