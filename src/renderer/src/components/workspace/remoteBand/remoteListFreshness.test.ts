import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { MeshConnection, MeshConversation, MeshMachineReachability } from '../../../../../shared/tailnet-mesh'
import type { EnvironmentConnectionState, EnvironmentEntry } from '../../../../../shared/environments'
import type { Workspace } from '../../../../../shared/workspace'
import {
  listFailureOf,
  remoteLastKnownOf,
  remoteLastKnownWords,
  remoteReadDue,
  remoteRereadDelayMs,
  REMOTE_FOCUS_REREAD_GAP_MS,
  REMOTE_REREAD_MAX_MS,
  REMOTE_REREAD_MS,
} from './remoteListFreshness'
import {
  attachedConversations,
  buildRemoteBand,
  conversationsOf,
  remoteLastKnownByConnection,
  unattachedConversations,
  type RemoteBrowseEntry,
} from './remoteSessionsModel'

// A paired machine's chats as a last-known list: when the window's own read
// says so, what the rows say, and when the window reads again.

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const miniPairing: MeshConnection = {
  id: 'c1',
  machineName: 'mac-mini',
  endpoint: 'mac-mini.tail1234.ts.net:8471',
  deviceId: 'tnd_1',
  deviceName: 'dev-macbook-air',
  scopes: ['workspace:read', 'conversation:read'],
  pairedAt: '2026-11-01T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'request',
}

function environment(state: EnvironmentConnectionState): EnvironmentEntry {
  return {
    environmentId: null,
    displayName: 'mac-mini',
    routes: [{ kind: 'tailnet', connection: 'c1' }],
    machine: { kind: 'paired', name: 'mac-mini' },
    descriptor: null,
    connection: { state, detail: null, lastReachedAt: null },
    compatibility: 'unknown',
  }
}

function reach(over: Partial<MeshMachineReachability> = {}): MeshMachineReachability {
  return {
    connectionId: 'c1',
    machineName: 'mac-mini',
    checking: false,
    reachable: true,
    unauthorized: false,
    checkedAt: 1_000,
    lastReachedAt: 1_000,
    detail: null,
    ...over,
  }
}

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

test('a refusal that is the answer is not a failure; a refused pairing and a broken read are', () => {
  assert.equal(listFailureOf('conversations_unsupported', 'x'), null, 'a machine that does not serve them lists none')
  assert.equal(listFailureOf('scope_required', 'x'), null, 'a pairing that may not read them lists none')
  assert.deepEqual(listFailureOf('revoked', 'Revoked.'), { kind: 'unauthorized', message: 'Revoked.' })
  assert.deepEqual(listFailureOf('unauthorized', 'No.'), { kind: 'unauthorized', message: 'No.' })
  assert.deepEqual(listFailureOf('peer_mismatch', 'No.'), { kind: 'unauthorized', message: 'No.' })
  assert.deepEqual(listFailureOf('unavailable', 'Gone.'), { kind: 'unavailable', message: 'Gone.' })
  assert.deepEqual(listFailureOf('timeout', 'Slow.'), { kind: 'unavailable', message: 'Slow.' })
})

test('the window’s own failed read makes the list last-known, whatever the background check says', () => {
  // The case that hid a revoked pairing: main's check passes, the read is refused.
  assert.deepEqual(
    remoteLastKnownOf(entry({ listFailure: { kind: 'unauthorized', message: 'Revoked.' } }), 'ready', reach()),
    { reason: 'signed-out', since: 5_000 },
  )
  assert.deepEqual(
    remoteLastKnownOf(entry({ listFailure: { kind: 'unavailable', message: 'Gone.' } }), 'ready', reach()),
    { reason: 'not-answering', since: 5_000 },
  )
  assert.equal(remoteLastKnownOf(entry({ listFailure: null }), 'ready', reach()), null, 'a read that stands is current')
})

test('how the machine stands decides when the window has not read it since', () => {
  const old = entry({ listedAt: 500 })
  assert.deepEqual(remoteLastKnownOf(old, 'signed-out', reach({ unauthorized: true })), {
    reason: 'signed-out',
    since: 500,
  })
  assert.deepEqual(remoteLastKnownOf(old, 'offline', reach({ reachable: false })), {
    reason: 'not-answering',
    since: 500,
  })
  assert.deepEqual(remoteLastKnownOf(old, 'incompatible', reach()), { reason: 'outdated', since: 500 })
  assert.equal(remoteLastKnownOf(old, 'connecting', reach()), null)
  // A read the window made after main's check is the newer word.
  assert.equal(
    remoteLastKnownOf(entry({ listedAt: 9_000 }), 'signed-out', reach({ unauthorized: true, checkedAt: 8_000 })),
    null,
    'a list read after the check that refused it is current',
  )
})

test('the clock reads a machine every few minutes, further apart while it fails, and focus no more than once in a while', () => {
  assert.equal(remoteRereadDelayMs(0), REMOTE_REREAD_MS)
  assert.equal(remoteRereadDelayMs(1), REMOTE_REREAD_MS * 2)
  assert.equal(remoteRereadDelayMs(2), REMOTE_REREAD_MS * 4)
  assert.equal(remoteRereadDelayMs(50), REMOTE_REREAD_MAX_MS, 'the backoff has a ceiling')
  assert.ok(REMOTE_REREAD_MS >= 2 * MINUTE && REMOTE_REREAD_MS <= 10 * MINUTE, 'a slow clock: a few minutes')

  assert.equal(remoteReadDue(undefined, 'clock', 0), true, 'a machine never asked is due')
  const answered = { askedAt: 0, failures: 0 }
  assert.equal(remoteReadDue(answered, 'clock', REMOTE_REREAD_MS - 1), false)
  assert.equal(remoteReadDue(answered, 'clock', REMOTE_REREAD_MS), true)
  const failing = { askedAt: 0, failures: 2 }
  assert.equal(remoteReadDue(failing, 'clock', REMOTE_REREAD_MS * 2), false, 'a failing machine waits longer')
  assert.equal(remoteReadDue(failing, 'clock', REMOTE_REREAD_MS * 4), true)
  assert.equal(remoteReadDue(answered, 'focus', REMOTE_FOCUS_REREAD_GAP_MS - 1), false, 'focus flapping asks nothing')
  assert.equal(remoteReadDue(failing, 'focus', REMOTE_FOCUS_REREAD_GAP_MS), true, 'a person back at the window is')
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
  assert.equal(remoteLastKnownWords({ reason: 'unpaired', since: null }, 'mac-mini', now).pairAgain, true)
  assert.equal(remoteLastKnownWords({ reason: 'outdated', since: null }, 'mac-mini', now).pairAgain, false)
})

test('the band marks a last-known list on its rows, and they claim no live work', () => {
  const band = (browse: RemoteBrowseEntry, state: EnvironmentConnectionState = 'up') =>
    buildRemoteBand({
      connections: [miniPairing],
      browses: new Map([['c1', browse]]),
      environments: [environment(state)],
      workspaces: [],
      reachability: new Map([['c1', reach()]]),
      connectionsListed: true,
    })[0]!

  const fresh = band(entry())
  assert.equal(fresh.lastKnown, null)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.rows[0]!.activity, 'working', 'a current list says the turn is running')

  // The check passes, the list read is refused: the rows are kept, and say so.
  const refused = band(entry({ listFailure: { kind: 'unauthorized', message: 'Revoked.' } }))
  assert.deepEqual(refused.lastKnown, { reason: 'signed-out', since: 5_000 })
  assert.equal(refused.stale, true)
  assert.deepEqual(
    refused.rows.map((row) => row.title),
    ['ada'],
    'the last rows stay on screen',
  )
  assert.equal(refused.rows[0]!.activity, 'idle', 'a turn that was running then is not drawn as working now')
  const [conversation] = conversationsOf(refused)
  assert.deepEqual(conversation!.lastKnown, { reason: 'signed-out', since: 5_000 })

  const offline = band(entry({ listedAt: 500 }), 'offline')
  assert.equal(offline.lastKnown?.reason, 'not-answering')
})

test('a chat opened here from a machine that went quiet, or is no longer paired, says so', () => {
  const opened = {
    id: 'w1',
    name: 'ada',
    mode: 'standard',
    folderPath: null,
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'mac-mini',
      workspaceId: 'rw-ada',
      sessionId: 'conversation:rw-ada:ada',
    },
  } as unknown as Workspace
  const quiet = buildRemoteBand({
    connections: [miniPairing],
    browses: new Map([['c1', entry({ listFailure: { kind: 'unavailable', message: 'Gone.' } })]]),
    environments: [environment('up')],
    workspaces: [opened],
    connectionsListed: true,
  })
  assert.equal(attachedConversations(quiet, [opened]).get('w1')?.lastKnown?.reason, 'not-answering')
  assert.equal(remoteLastKnownByConnection(quiet).get('c1')?.reason, 'not-answering')

  // The pairing is gone: once the list of pairings has been read.
  const gone = (connectionsListed: boolean) =>
    remoteLastKnownByConnection(
      buildRemoteBand({
        connections: [],
        browses: new Map(),
        environments: [],
        workspaces: [opened],
        connectionsListed,
      }),
    ).get('c1') ?? null
  assert.deepEqual(gone(true), { reason: 'unpaired', since: null })
  assert.equal(gone(false), null, 'before the pairings are read, an empty list says nothing')
})

test('the rows read from over there are drawn on the tailnet, whatever this device’s own listener does', () => {
  const groups = buildRemoteBand({
    connections: [miniPairing],
    browses: new Map([['c1', entry()]]),
    environments: [environment('up')],
    workspaces: [],
  })
  assert.equal(unattachedConversations(groups, true, []).length, 1)
  assert.equal(unattachedConversations(groups, false, []).length, 0, 'off the tailnet, none')
})

test('once the machine is paired again and answers, the old pairing does not ask to pair again', () => {
  const now = 10 * DAY
  // The refused pairing, and the new one made by Pair again to the same machine.
  const fresh: MeshConnection = { ...miniPairing, id: 'c2', pairedAt: '2026-11-20T00:00:00.000Z' }
  const opened = {
    id: 'w1',
    name: 'ada',
    mode: 'standard',
    folderPath: null,
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'mac-mini',
      workspaceId: 'rw-ada',
      sessionId: 'conversation:rw-ada:ada',
    },
  } as unknown as Workspace
  const freshEnvironment: EnvironmentEntry = { ...environment('up'), routes: [{ kind: 'tailnet', connection: 'c2' }] }
  const groups = buildRemoteBand({
    connections: [miniPairing, fresh],
    browses: new Map([
      [
        'c1',
        entry({
          conversations: [chat('ada'), chat('bea')],
          listFailure: { kind: 'unauthorized', message: 'Revoked.' },
        }),
      ],
      ['c2', entry({ conversations: [chat('ada'), chat('bea')], listedAt: 9_000 })],
    ]),
    environments: [environment('up'), freshEnvironment],
    workspaces: [opened],
    connectionsListed: true,
  })
  const old = groups.find((group) => group.connectionId === 'c1')!
  assert.equal(old.lastKnown?.reason, 'superseded')
  assert.deepEqual(
    old.rows.map((row) => row.title),
    ['ada'],
    'only the chat open here over it stays; the new pairing lists the rest',
  )
  assert.deepEqual(
    unattachedConversations(groups, true, [opened]).map((conversation) => [
      conversation.connectionId,
      conversation.title,
    ]),
    [
      ['c2', 'ada'],
      ['c2', 'bea'],
    ],
    'the new pairing lists every chat once, and the old pairing none it has not opened here',
  )
  assert.equal(attachedConversations(groups, [opened]).get('w1')?.lastKnown?.reason, 'superseded')
  const words = remoteLastKnownWords({ reason: 'superseded', since: null }, 'mac-mini', now)
  assert.equal(words.text, 'Old pairing')
  assert.equal(words.pairAgain, false, 'it does not point at a step already taken')

  // A pairing forgotten when the machine was paired again (a reverse pairing adopted).
  const forgotten = buildRemoteBand({
    connections: [fresh],
    browses: new Map([['c2', entry({ listedAt: 9_000 })]]),
    environments: [freshEnvironment],
    workspaces: [opened],
    connectionsListed: true,
  })
  assert.equal(remoteLastKnownByConnection(forgotten).get('c1')?.reason, 'superseded')

  // Another machine's refused pairing still says so.
  const other: MeshConnection = {
    ...miniPairing,
    id: 'c3',
    machineName: 'build-box',
    endpoint: 'build-box.tail1234.ts.net:8471',
  }
  const unrelated = buildRemoteBand({
    connections: [other, fresh],
    browses: new Map([
      ['c3', entry({ listFailure: { kind: 'unauthorized', message: 'Revoked.' } })],
      ['c2', entry({ listedAt: 9_000 })],
    ]),
    environments: [freshEnvironment],
    workspaces: [],
    connectionsListed: true,
  })
  assert.equal(unrelated.find((group) => group.connectionId === 'c3')?.lastKnown?.reason, 'signed-out')
})
