import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { CONVERSATION_OUTBOX_FILE, ConversationOutbox } from './conversation-outbox'

const chat = (agentId: string) => ({ workspaceRoot: '/Users/dev/project', workspaceId: 'workspace', agentId })

test('a chat is on disk once it is listed, and leaves when it is settled', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'conversation-outbox-'))
  try {
    const outbox = new ConversationOutbox(dataDir)
    await outbox.open(chat('a'))
    await outbox.open(chat('a'))
    await outbox.open(chat('b'))
    assert.deepEqual(await new ConversationOutbox(dataDir).pending(), [chat('a'), chat('b')])
    await outbox.settle(chat('a'))
    await outbox.settle(chat('unknown'))
    assert.deepEqual(await new ConversationOutbox(dataDir).pending(), [chat('b')])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a list that does not read names nothing, and is written over by the next', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'conversation-outbox-'))
  try {
    await writeFile(join(dataDir, CONVERSATION_OUTBOX_FILE), '{"chats":[{"workspaceRoot":')
    const outbox = new ConversationOutbox(dataDir)
    assert.deepEqual(await outbox.pending(), [])
    await outbox.open(chat('a'))
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, CONVERSATION_OUTBOX_FILE), 'utf8')), {
      version: 1,
      chats: [chat('a')],
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('changes made while a write is out are all written, in order', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'conversation-outbox-'))
  try {
    const outbox = new ConversationOutbox(dataDir)
    await Promise.all([outbox.open(chat('a')), outbox.open(chat('b')), outbox.open(chat('c'))])
    await Promise.all([outbox.settle(chat('a')), outbox.settle(chat('c'))])
    assert.deepEqual(await new ConversationOutbox(dataDir).pending(), [chat('b')])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a list that cannot be written says so to the one listing, and is written once it can be', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'conversation-outbox-'))
  try {
    // The directory it is written into is, for now, a file.
    const blocked = join(dataDir, 'data')
    await writeFile(blocked, 'not a directory')
    const outbox = new ConversationOutbox(blocked)
    await assert.rejects(outbox.open(chat('a')))
    await rm(blocked)
    await outbox.open(chat('a'))
    assert.deepEqual(
      await new ConversationOutbox(blocked).pending(),
      [chat('a')],
      'the change that failed is written now',
    )
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
