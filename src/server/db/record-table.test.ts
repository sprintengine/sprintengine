import assert from 'node:assert/strict'

import { test } from 'vitest'

import { openTestDatabase } from '../../../tests/studio-database'
import type { StudioDatabase } from './database'
import { createRecordTable } from './record-table'

/** `database` with every batch it is asked for kept, and refused while `refuse` says so. */
function watched(database: StudioDatabase) {
  const batches: string[][] = []
  const state = { refuse: false }
  const proxy = new Proxy(database, {
    get(target, key) {
      if (key === 'batch')
        return (statements: Parameters<StudioDatabase['batch']>[0]) => {
          batches.push(statements.map((statement) => statement.sql.trim().split(/\s+/u)[0]!))
          return state.refuse ? Promise.reject(new Error('disk full')) : target.batch(statements)
        }
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { database: proxy, batches, state }
}

const rows = (database: StudioDatabase) =>
  database.all<{ id: string; position: number; body: string }>(
    'SELECT id, position, body FROM pull_requests ORDER BY position',
  )

test('a save writes only the rows that changed, and deletes the ones gone', async () => {
  const database = openTestDatabase()
  const { database: counted, batches } = watched(database)
  const table = createRecordTable(counted, 'pull_requests')
  table.loadNow()
  await table.save([
    { id: 'a', body: '1' },
    { id: 'b', body: '2' },
    { id: 'c', body: '3' },
  ])
  await table.save([
    { id: 'a', body: '1' },
    { id: 'b', body: '2b' },
  ])
  await table.save([
    { id: 'a', body: '1' },
    { id: 'b', body: '2b' },
  ])
  assert.deepEqual(
    batches,
    [
      ['INSERT', 'INSERT', 'INSERT'],
      ['DELETE', 'INSERT'],
    ],
    'an unchanged list is no write',
  )
  assert.deepEqual(await rows(database), [
    { id: 'a', position: 0, body: '1' },
    { id: 'b', position: 1, body: '2b' },
  ])
})

test('a save after a failed one writes the whole list again', async () => {
  const database = openTestDatabase()
  const { database: counted, batches, state } = watched(database)
  const table = createRecordTable(counted, 'pull_requests', () => undefined)
  await table.load()
  await table.save([{ id: 'a', body: '1' }])
  state.refuse = true
  assert.equal(
    await table.save([
      { id: 'a', body: '1' },
      { id: 'b', body: '2' },
    ]),
    false,
  )
  state.refuse = false
  assert.equal(
    await table.save([
      { id: 'a', body: '1' },
      { id: 'b', body: '2' },
    ]),
    true,
  )
  assert.deepEqual(batches.at(-1), ['DELETE', 'INSERT', 'INSERT'])
  assert.deepEqual(
    (await rows(database)).map((row) => row.id),
    ['a', 'b'],
  )
})

test('a table never loaded is replaced whole by its first save, and a restart reads what was saved', async () => {
  const database = openTestDatabase()
  await database.run("INSERT INTO pull_requests (id, position, body) VALUES ('old', 0, 'x')")
  const first = createRecordTable(database, 'pull_requests')
  await first.save([{ id: 'new', body: 'y' }])
  const again = createRecordTable(database, 'pull_requests')
  assert.deepEqual(await again.load(), [{ id: 'new', body: 'y' }])
})
