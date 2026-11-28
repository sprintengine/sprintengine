import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { Workspace } from '../../../../../shared/workspace'
import { WINDOW_STUDIO_ROUTE } from '../../../studio/environmentStudio'
import type { RemoteConversation } from '../remoteBand/remoteSessionsModel'
import { localChatRows } from './localChatRows'

// This computer's rows are the chats its own Studio lists, each drawn over the
// window's record of it: which chats have a row, and what the row says of
// each, are the list's; the record's panes, terminals and order stay.

const record = (id: string, extra: Partial<Workspace> = {}) =>
  ({ id, name: `record ${id}`, mode: 'standard', folderPath: `/p/${id}`, ...extra }) as Workspace

const listed = (id: string, extra: Partial<RemoteConversation> = {}) =>
  ({
    route: WINDOW_STUDIO_ROUTE,
    workspaceId: id,
    title: `listed ${id}`,
    highlight: null,
    snoozedUntil: null,
    autoSettle: false,
    ...extra,
  }) as RemoteConversation

test('a row for each chat the list names, in the records’ order, saying what the list says', () => {
  const records = [
    record('a', { highlight: { starred: true, color: null }, autoSettleEnabled: true }),
    record('b'),
    record('c'),
  ]
  const rows = localChatRows(
    records,
    [listed('c'), listed('a', { snoozedUntil: 99, highlight: { starred: false, color: 'blue' } })],
    [],
  )
  assert.deepEqual(
    rows.map((row) => row.id),
    ['a', 'c'],
    'b is not listed (a hidden kind, or gone): no row',
  )
  assert.equal(rows[0]!.name, 'listed a')
  assert.deepEqual(rows[0]!.highlight, { starred: false, color: 'blue' })
  assert.equal(rows[0]!.snoozedUntil, 99)
  assert.equal(rows[0]!.autoSettleEnabled, null, 'Auto-settle is off over there')
  assert.equal(rows[0]!.folderPath, '/p/a', 'the record is what the row is drawn over')
})

test('a settled chat keeps its row for the chat in front, from the settled list', () => {
  const rows = localChatRows([record('a'), record('b')], [listed('b')], [listed('a', { settledAt: 7 })])
  assert.deepEqual(
    rows.map((row) => [row.id, row.settledAt]),
    [
      ['a', 7],
      ['b', null],
    ],
  )
})

test('another machine’s chats, a copy here, and a chat with no record yet have no row of this computer', () => {
  const rows = localChatRows(
    [record('copy', { environment: { route: 'ssh:build-box' } as unknown as Workspace['environment'] }), record('a')],
    [listed('copy'), listed('a'), listed('new'), { ...listed('a'), route: 'ssh:build-box' }],
    [],
  )
  assert.deepEqual(
    rows.map((row) => row.id),
    ['a'],
  )
  assert.equal(rows[0]!.name, 'listed a', 'its own Studio’s row, not the other machine’s')
})

test('a record that already says what its row says is drawn as it is', () => {
  const same = record('a', { name: 'listed a' })
  assert.equal(localChatRows([same], [listed('a')], [])[0], same)
})
