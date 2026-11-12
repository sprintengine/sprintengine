import assert from 'node:assert/strict'
import { test } from 'vitest'

import { chatLinkFor, isLinkId, parseStudioLink, STUDIO_LINK_SCHEME } from '../src/chat-link'
import { isChatAddress, isEnvironmentId } from '../src/environment'

const ENV = '6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b'
const chat = (environmentId: string | null, chatId: string, agentId: string | null = null) => ({
  kind: 'chat',
  environmentId,
  chatId,
  agentId,
})

test('a chat link names its environment and chat, and its agent when it has one', () => {
  assert.deepEqual(parseStudioLink(`sprintengine://chat/${ENV}/V1StGXR8_Z5jdHi6B-myT`), chat(ENV, 'V1StGXR8_Z5jdHi6B-myT'))
  assert.deepEqual(
    parseStudioLink(`sprintengine://chat/${ENV}/ws-1?agent=agent-claude-0a1b2c3d4e5f6g7h`),
    chat(ENV, 'ws-1', 'agent-claude-0a1b2c3d4e5f6g7h'),
  )
})

test('a link from before links named an environment still reads, with no environment', () => {
  assert.deepEqual(parseStudioLink('sprintengine://chat/V1StGXR8_Z5jdHi6B-myT'), chat(null, 'V1StGXR8_Z5jdHi6B-myT'))
  assert.deepEqual(parseStudioLink('sprintengine://chat/ws-1?agent=a1'), chat(null, 'ws-1', 'a1'))
  assert.deepEqual(parseStudioLink('sprintengine://chat/ws-1/'), chat(null, 'ws-1'))
})

test('scheme and host are read in any case, the ids exactly as written', () => {
  assert.deepEqual(parseStudioLink('SprintEngine://CHAT/Env-A/AbC'), chat('Env-A', 'AbC'))
})

test('the trailing slash a browser on Windows adds is allowed', () => {
  assert.deepEqual(parseStudioLink(`sprintengine://chat/${ENV}/ws-1/`), chat(ENV, 'ws-1'))
  assert.deepEqual(parseStudioLink(`sprintengine://chat/${ENV}/ws-1/?agent=a1`), chat(ENV, 'ws-1', 'a1'))
})

test('other parameters and a fragment are ignored, never acted on', () => {
  assert.deepEqual(
    parseStudioLink(`sprintengine://chat/${ENV}/ws-1?prompt=rm%20-rf%20~&send=1&agent=a1#top`),
    chat(ENV, 'ws-1', 'a1'),
  )
  // A key spelled with an escape is the same key, as URLSearchParams reads it.
  assert.deepEqual(parseStudioLink(`sprintengine://chat/${ENV}/ws-1?ag%65nt=a1`), chat(ENV, 'ws-1', 'a1'))
})

test('an agent that is not a plain id, or is named twice, is dropped and the chat still opens', () => {
  for (const query of [
    'agent=../../etc',
    'agent=',
    'agent',
    'agent=a1&agent=a2',
    'agent=a%20b',
    'agent=a+b',
    'agent=%E0%A4%A',
  ]) {
    assert.deepEqual(parseStudioLink(`sprintengine://chat/${ENV}/ws-1?${query}`), chat(ENV, 'ws-1'), query)
  }
})

test('the sign-in callback is recognised as auth and nothing else', () => {
  assert.deepEqual(parseStudioLink('sprintengine://auth/callback?code=abc&state=xyz'), { kind: 'auth' })
  assert.deepEqual(parseStudioLink('sprintengine://auth/callback'), { kind: 'auth' })
  assert.equal(parseStudioLink('sprintengine://auth/other'), null)
})

test('a host or path the app does not answer is refused', () => {
  for (const raw of [
    'sprintengine://new?project=/Users/dev/app&prompt=hello',
    'sprintengine://chat',
    'sprintengine://chat/',
    'sprintengine://chat//ws-1',
    `sprintengine://chat/${ENV}/ws-1/agent-1`,
    'sprintengine://chats/ws-1',
    'sprintengine:chat/ws-1',
    'sprintengine:///chat/ws-1',
    'sprintengine://verify/chat/ws-1',
    'sprintengine://conversation/device/workspace/agent',
  ]) {
    assert.equal(parseStudioLink(raw), null, raw)
  }
})

test('another scheme is refused', () => {
  for (const raw of [
    'https://chat/ws-1',
    'file:///chat/ws-1',
    'javascript://chat/ws-1',
    'sprintengine2://chat/ws-1',
    'sprintengine-tailnet://chat/ws-1',
  ]) {
    assert.equal(parseStudioLink(raw), null, raw)
  }
})

test('an id that could mean something to a shell or a file system is refused, in either segment', () => {
  for (const id of ['..', '%2e%2e', 'ws%2F1', 'ws-1;rm', '$(id)', '`id`', 'ws"1', "ws'1", 'ws.1', 'ws\\1', 'a'.repeat(129)]) {
    assert.equal(parseStudioLink(`sprintengine://chat/${id}`), null, id)
    assert.equal(parseStudioLink(`sprintengine://chat/${ENV}/${id}`), null, id)
    assert.equal(parseStudioLink(`sprintengine://chat/${id}/ws-1`), null, id)
  }
  for (const raw of ['sprintengine://chat/../../etc/passwd', 'sprintengine://chat/ws-1/../ws-2']) {
    assert.equal(parseStudioLink(raw), null, raw)
  }
})

test('a user, password or port in the authority is refused', () => {
  for (const raw of [
    'sprintengine://evil@chat/ws-1',
    'sprintengine://user:pass@chat/ws-1',
    'sprintengine://chat:80/ws-1',
    'sprintengine://chat.example.com/ws-1',
  ]) {
    assert.equal(parseStudioLink(raw), null, raw)
  }
})

test('whitespace, control characters and oversized links are refused', () => {
  for (const raw of [
    ' sprintengine://chat/ws-1',
    'sprintengine://chat/ws-1 ',
    'sprintengine://chat/ws 1',
    'sprintengine://chat/ws-1\n--inspect',
    'sprintengine://chat/ws-1\u0000',
    'sprintengine://chat/ws-1\u007f',
    `sprintengine://chat/ws-1?pad=${'x'.repeat(2048)}`,
    '',
  ]) {
    assert.equal(parseStudioLink(raw), null, JSON.stringify(raw))
  }
})

test('anything that is not a string is refused', () => {
  for (const raw of [undefined, null, 42, {}, ['sprintengine://chat/ws-1']]) {
    assert.equal(parseStudioLink(raw), null)
  }
})

test('the link a client writes names the environment, and is the link it reads', () => {
  const link = chatLinkFor({ environmentId: ENV, chatId: 'V1StGXR8_Z5jdHi6B-myT' })
  assert.equal(link, `${STUDIO_LINK_SCHEME}://chat/${ENV}/V1StGXR8_Z5jdHi6B-myT`)
  assert.deepEqual(parseStudioLink(link), chat(ENV, 'V1StGXR8_Z5jdHi6B-myT'))
  const withAgent = chatLinkFor({ environmentId: ENV, chatId: 'ws-1' }, 'agent-codex-0a1b2c3d4e5f6g7h')
  assert.equal(withAgent, `sprintengine://chat/${ENV}/ws-1?agent=agent-codex-0a1b2c3d4e5f6g7h`)
  assert.deepEqual(parseStudioLink(withAgent), chat(ENV, 'ws-1', 'agent-codex-0a1b2c3d4e5f6g7h'))
})

test('no link is written for an id a link cannot carry', () => {
  assert.equal(chatLinkFor({ environmentId: ENV, chatId: 'ws.legacy' }), null)
  assert.equal(chatLinkFor({ environmentId: ENV, chatId: '' }), null)
  assert.equal(chatLinkFor({ environmentId: 'env:1', chatId: 'ws-1' }), null)
  assert.equal(chatLinkFor({ environmentId: '', chatId: 'ws-1' }), null)
  assert.equal(chatLinkFor({ environmentId: ENV, chatId: 'ws-1' }, 'agent/1'), null)
})

// A link carries an environment id and a chat id as they are, unescaped, so
// the link alphabet and the address alphabet must be one rule: an id one
// accepts and the other refuses is a chat with an address and no link, or a
// link that names no address.
test('the link alphabet is the environment id and chat address alphabet', () => {
  const samples: string[] = ['', 'a'.repeat(127), 'a'.repeat(128), 'a'.repeat(129), ENV, 'ws-1', '_', '-']
  for (let code = 0; code < 0x180; code += 1) {
    const char = String.fromCharCode(code)
    samples.push(char, `a${char}b`)
  }
  for (const id of samples) {
    const label = JSON.stringify(id)
    assert.equal(isLinkId(id), isEnvironmentId(id), `environment id ${label}`)
    assert.equal(isLinkId(id), isChatAddress({ environmentId: ENV, chatId: id }), `chat id ${label}`)
    const written = chatLinkFor({ environmentId: id, chatId: id })
    assert.equal(written !== null, isChatAddress({ environmentId: id, chatId: id }), `link for ${label}`)
    if (written) assert.deepEqual(parseStudioLink(written), chat(id, id))
  }
})
