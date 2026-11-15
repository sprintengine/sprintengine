import assert from 'node:assert/strict'
import { test } from 'vitest'

import { conversationImagePathOf, sniffConversationImage } from './tailnet-conversation-images'

// Which file a chat's step names as its picture, and what its bytes say it
// is. A device reads a step's picture with `conversation.picture`, end to end
// in tailnet-studio-chat-host.test.ts.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1')

test('the four formats are told apart by their first bytes, and nothing else passes', () => {
  assert.equal(sniffConversationImage(PNG), 'image/png')
  assert.equal(sniffConversationImage(JPEG), 'image/jpeg')
  assert.equal(sniffConversationImage(WEBP), 'image/webp')
  assert.equal(sniffConversationImage(GIF), 'image/gif')
  assert.equal(sniffConversationImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(sniffConversationImage(Buffer.from('BM')), null, 'a bitmap is not one of the four')
  assert.equal(sniffConversationImage(Buffer.alloc(0)), null)
})

test('only a generated picture or a read of a picture names a file', () => {
  assert.equal(
    conversationImagePathOf({ name: 'GenerateImage', kind: 'other', input: { path: '/tmp/a.png' } }),
    '/tmp/a.png',
  )
  assert.equal(
    conversationImagePathOf({ name: 'Read', kind: undefined, input: { file_path: '/tmp/a.jpg' } }),
    '/tmp/a.jpg',
  )
  assert.equal(conversationImagePathOf({ name: 'Read', kind: 'file_read', input: { file_path: '/tmp/a.ts' } }), null)
  assert.equal(conversationImagePathOf({ name: 'Bash', kind: 'command', input: { path: '/tmp/a.png' } }), null)
  assert.equal(conversationImagePathOf({ name: 'Write', kind: 'file_write', input: { file_path: '/tmp/a.png' } }), null)
  assert.equal(conversationImagePathOf({ name: 'GenerateImage', kind: 'other', input: {} }), null)
  assert.equal(conversationImagePathOf({ name: 'GenerateImage', kind: 'other', input: 'not an object' }), null)
})
