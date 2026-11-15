import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'

import { foldReceiptRecord, readConversationReceipts, receiptRecord } from './conversation-command-receipts'
import { workspaceStorePath } from './workspace-store'

test('a turn command is accepted with its turn, and its answer is added once the turn ends', () => {
  const receipts = new Map()
  foldReceiptRecord(receipts, receiptRecord('send-1', 1, { fingerprint: 'fp', turnId: 'turn_1' }))
  assert.deepEqual(receipts.get('send-1'), { fingerprint: 'fp', turnId: 'turn_1' })
  foldReceiptRecord(
    receipts,
    receiptRecord('send-1', 2, { fingerprint: 'fp', answer: { ok: true, session: {} as never, notice: 'later' } }),
  )
  assert.deepEqual(
    receipts.get('send-1'),
    { fingerprint: 'fp', turnId: 'turn_1', answer: { ok: true, notice: 'later' } },
    'the session summary is not kept: it is read again when the answer is given',
  )
})

test('a refusal keeps its words and code, never the event it carried', () => {
  const receipts = new Map()
  const record = receiptRecord('stop-1', 1, {
    answer: { ok: false, message: 'Nothing to stop.', code: 'idle', event: { id: 'x' } as never },
  })
  foldReceiptRecord(receipts, JSON.parse(JSON.stringify(record)))
  assert.deepEqual(receipts.get('stop-1'), { answer: { ok: false, message: 'Nothing to stop.', code: 'idle' } })
})

test('the receipts are read from the log, past its events and a damaged or torn line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-command-receipts-'))
  try {
    const path = workspaceStorePath(root, 'conversations', 'workspace', 'agent.jsonl')
    assert.deepEqual([...(await readConversationReceipts(root, path)).keys()], [], 'no log, no receipts')
    await mkdir(dirname(path), { recursive: true })
    const event = (seq: number) => JSON.stringify({ id: `e${seq}`, type: 'user_message', seq, payload: {} })
    await writeFile(
      path,
      [
        event(1),
        JSON.stringify(receiptRecord('a', 1, { turnId: 't1' })),
        '{"receipt":{"id":"broken"',
        JSON.stringify({ receipt: { id: 'no-time' } }),
        event(2),
        JSON.stringify(receiptRecord('b', 2, { answer: { ok: false, message: 'refused' } })),
        JSON.stringify(receiptRecord('a', 3, { answer: { ok: true, session: {} as never } })),
      ].join('\n') + '\n',
    )
    // A crash mid-write leaves the last line without its end.
    await appendFile(path, JSON.stringify(receiptRecord('torn', 4, { turnId: 't2' })).slice(0, 30))
    const receipts = await readConversationReceipts(root, path)
    assert.deepEqual([...receipts.keys()], ['b', 'a'], 'newest last, and nothing from a line that is not whole')
    assert.deepEqual(receipts.get('a'), { turnId: 't1', answer: { ok: true } })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
