import assert from 'node:assert/strict'
import { test } from 'vitest'

import { openTestDatabase } from '../../tests/studio-database'
import { ConversationOutbox, readConversationOutboxFile } from './conversation-outbox'

const chat = (agentId: string) => ({ workspaceRoot: '/Users/dev/project', workspaceId: 'workspace', agentId })

test('a chat is kept once it is listed, and leaves when it is settled', async () => {
  const database = openTestDatabase()
  const outbox = new ConversationOutbox(database)
  await outbox.open(chat('a'))
  await outbox.open(chat('a'))
  await outbox.open(chat('b'))
  assert.deepEqual(await new ConversationOutbox(database).pending(), [chat('a'), chat('b')])
  await outbox.settle(chat('a'))
  await outbox.settle(chat('unknown'))
  assert.deepEqual(await new ConversationOutbox(database).pending(), [chat('b')])
})

test('changes made together are all kept, in order', async () => {
  const database = openTestDatabase()
  const outbox = new ConversationOutbox(database)
  await Promise.all([outbox.open(chat('a')), outbox.open(chat('b')), outbox.open(chat('c'))])
  await Promise.all([outbox.settle(chat('a')), outbox.settle(chat('c'))])
  assert.deepEqual(await new ConversationOutbox(database).pending(), [chat('b')])
})

test('a list that cannot be written says so to the one listing, and the chat is not taken as listed', async () => {
  const database = openTestDatabase()
  await database.close()
  const outbox = new ConversationOutbox(database)
  await assert.rejects(outbox.open(chat('a')))
})

test('the file builds before the database kept is read as they wrote it, and one that does not read lists nothing', () => {
  assert.deepEqual(readConversationOutboxFile(JSON.stringify({ version: 1, chats: [chat('a'), { agentId: 'x' }] })), [
    chat('a'),
  ])
  assert.equal(readConversationOutboxFile('{"chats":[{"workspaceRoot":'), null)
})
