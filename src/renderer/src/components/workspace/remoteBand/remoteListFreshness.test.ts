import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { MeshConversation } from '../../../../../shared/tailnet-mesh'
import { remoteLastKnownOf, remoteLastKnownWords } from './remoteListFreshness'
import type { RemoteBrowseEntry } from './remoteSessionsModel'

// Whether an environment's rows are a last-known list, and what a row from
// one says (remote-list-freshness): the window's own newest read decides
// first, then how the environment stands.

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

function chat(agentId: string, phase: MeshConversation['phase'] = 'running'): MeshConversation {
  return {
    workspaceId: `rw-${agentId}`,
    agentId,
    title: agentId,
    phase,
    updatedAt: 2_000,
    createdAt: 1_000,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 1,
    lastSeq: 4,
  }
}

function entry(over: Partial<RemoteBrowseEntry> = {}): RemoteBrowseEntry {
  return {
    browse: null,
    loading: false,
    error: null,
    at: 5_000,
    conversations: [chat('ada')],
    listedAt: 5_000,
    ...over,
  }
}

test('the window’s own failed read makes the list last-known, whatever the environment list says', () => {
  // The case that hid a revoked pairing: the environment reads as ready, the read is refused.
  assert.deepEqual(remoteLastKnownOf(entry({ listFailure: { kind: 'unauthorized', message: 'Revoked.' } }), 'ready'), {
    reason: 'signed-out',
    since: 5_000,
  })
  assert.deepEqual(remoteLastKnownOf(entry({ listFailure: { kind: 'unavailable', message: 'Gone.' } }), 'ready'), {
    reason: 'not-answering',
    since: 5_000,
  })
  assert.equal(remoteLastKnownOf(entry({ listFailure: null }), 'ready'), null, 'a read that stands is current')
})

test('how the environment stands decides when the window’s read has not failed', () => {
  const old = entry({ listedAt: 500 })
  assert.deepEqual(remoteLastKnownOf(old, 'signed-out'), { reason: 'signed-out', since: 500 })
  assert.deepEqual(remoteLastKnownOf(old, 'offline'), { reason: 'not-answering', since: 500 })
  assert.deepEqual(remoteLastKnownOf(old, 'incompatible'), { reason: 'outdated', since: 500 })
  assert.equal(remoteLastKnownOf(old, 'connecting'), null)
  // A read the window made that answered is the newer word.
  assert.equal(remoteLastKnownOf(entry({ listFailure: null }), 'offline'), null)
})

test('a last-known row says why in words, and offers Pair again where a pairing is the remedy', () => {
  const now = 10 * DAY
  const signedOut = remoteLastKnownWords({ reason: 'signed-out', since: now - 2 * DAY }, 'mac-mini', now)
  assert.equal(signedOut.text, 'Signed out')
  assert.equal(signedOut.pairAgain, true)
  assert.match(signedOut.detail, /mac-mini no longer accepts this device\. This is its list of chats from 2d ago\./)
  assert.ok(!signedOut.spoken.includes('mac-mini'), 'what a screen reader hears on the row does not repeat the name')

  const quiet = remoteLastKnownWords({ reason: 'not-answering', since: now - 2 * DAY }, 'mac-mini', now)
  assert.equal(quiet.text, 'Not answering · 2d')
  assert.equal(quiet.pairAgain, false)
  assert.equal(remoteLastKnownWords({ reason: 'not-answering', since: null }, 'mac-mini', now).text, 'Not answering')
  assert.equal(remoteLastKnownWords({ reason: 'outdated', since: null }, 'mac-mini', now).pairAgain, false)

  // A WSL distribution that is not running is not started to list its chats.
  const resting = remoteLastKnownWords({ reason: 'not-connected', since: now - DAY }, 'Ubuntu', now)
  assert.equal(resting.text, 'Not connected')
  assert.equal(resting.pairAgain, false)
  assert.match(resting.detail, /Ubuntu is not running/)
})
