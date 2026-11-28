import assert from 'node:assert/strict'

import { test } from 'vitest'

import { openTestDatabase } from '../../../tests/studio-database'
import type { StudioDatabase } from '../db/database'
import { beginChatMoveStatements, endChatMove, settleInterruptedChatMoves, type ChatMove } from './chat-moves'

const MOVE: ChatMove = {
  workspaceId: 'ws-1',
  fromFolder: '/Users/dev/old',
  toFolder: '/Users/dev/new',
  fromKey: '/stores/old/conversations/ws-1',
  toKey: '/stores/new/conversations/ws-1',
}

/** A chat with one log under `MOVE.fromKey`, and the move's first step done: its rows renamed, the move noted. */
async function begun(): Promise<StudioDatabase> {
  const database = openTestDatabase()
  await database.run(
    "INSERT INTO chat_logs (log_key, workspace_root, generation, last_seq) VALUES (?, '/Users/dev/old', 'g', 3)",
    [`${MOVE.fromKey}/agent-1`],
  )
  await database.batch(beginChatMoveStatements(MOVE))
  return database
}

const logKeys = async (database: StudioDatabase) =>
  (await database.all<{ log_key: string }>('SELECT log_key FROM chat_logs')).map((row) => row.log_key)
const notes = async (database: StudioDatabase) => (await database.all('SELECT workspace_id FROM chat_moves')).length

function settle(database: StudioDatabase, recordFolder: string | null, moveFolder = async (..._args: string[]) => {}) {
  const moved: string[] = []
  const logs: string[] = []
  return settleInterruptedChatMoves({
    database,
    folderOf: () => recordFolder,
    moveFolder: async (workspaceId, from, to) => {
      moved.push(`${from} -> ${to}`)
      await moveFolder(workspaceId, from, to)
    },
    log: (message) => logs.push(message),
  }).then(() => ({ moved, logs }))
}

test('a move cut short before its record was written goes back: rows, folder and note', async () => {
  const database = await begun()
  assert.deepEqual(await logKeys(database), [`${MOVE.toKey}/agent-1`])
  const { moved } = await settle(database, MOVE.fromFolder)
  assert.deepEqual(moved, [`${MOVE.toFolder} -> ${MOVE.fromFolder}`])
  assert.deepEqual(await logKeys(database), [`${MOVE.fromKey}/agent-1`])
  assert.equal(await notes(database), 0)
})

test('a move cut short after its record was written is finished: the folder follows, the rows stay', async () => {
  const database = await begun()
  const { moved } = await settle(database, MOVE.toFolder)
  assert.deepEqual(moved, [`${MOVE.fromFolder} -> ${MOVE.toFolder}`])
  assert.deepEqual(await logKeys(database), [`${MOVE.toKey}/agent-1`])
  assert.equal(await notes(database), 0)
})

test('a chat with no record any more has its history put back where it was', async () => {
  const database = await begun()
  await settle(database, null)
  assert.deepEqual(await logKeys(database), [`${MOVE.fromKey}/agent-1`])
})

test('a folder that cannot be moved keeps the note for the next start, and the rows as they were', async () => {
  const database = await begun()
  const { logs } = await settle(database, MOVE.fromFolder, async () => {
    throw new Error('the old project already holds a history for this chat')
  })
  assert.deepEqual(await logKeys(database), [`${MOVE.toKey}/agent-1`])
  assert.equal(await notes(database), 1)
  assert.match(logs.join('\n'), /tried again at the next start/u)
  // Settled twice once it can be: the second start finds nothing to do.
  await settle(database, MOVE.fromFolder)
  await settle(database, MOVE.fromFolder)
  assert.deepEqual(await logKeys(database), [`${MOVE.fromKey}/agent-1`])
})

test('a move that ended leaves no note, and a start finds nothing to do', async () => {
  const database = await begun()
  await endChatMove(database, MOVE.workspaceId)
  const { moved } = await settle(database, MOVE.toFolder)
  assert.deepEqual(moved, [])
  assert.deepEqual(await logKeys(database), [`${MOVE.toKey}/agent-1`])
})
