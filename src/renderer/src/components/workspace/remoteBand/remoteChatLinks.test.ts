import assert from 'node:assert/strict'
import { test } from 'vitest'

import { publishRemoteChatLinkTargets, remoteChatLinkTargets, remoteChatOnConnection } from './remoteChatLinks'
import { environmentChatRows, type EnvironmentChatSourceView } from './remoteSessionsModel'
import type { EnvironmentEntry } from '../../../../../shared/environments'
import { UNKNOWN_CONNECTION } from '../../../../../shared/environments'
import { chatLinkOfWorkspace } from '../../../../../shared/environment-keys'

const entry = (environmentId: string, route: EnvironmentEntry['routes'][number]): EnvironmentEntry => ({
  environmentId,
  displayName: environmentId,
  routes: [route],
  machine: { kind: 'local' },
  descriptor: null,
  connection: UNKNOWN_CONNECTION,
  compatibility: 'unknown',
})
const environments = [
  entry('env-here', { kind: 'local' }),
  entry('env-mini', { kind: 'tailnet', connection: 'c-mini' }),
  entry('env-box', { kind: 'ssh', machine: 'build-box' }),
]

const listed = (chatId: string) => ({
  workspaceId: chatId,
  agentId: 'agent-1',
  title: 'Ada',
  chatTitle: 'Review the parser',
  phase: 'idle' as const,
  updatedAt: 1,
  createdAt: 1,
  providerId: 'claude-agent',
  modelId: 'opus',
  turnCount: 1,
  lastSeq: 1,
})

const source = (route: string, machineName: string, connectionId: string | null): EnvironmentChatSourceView => ({
  route,
  machineName,
  environmentId: null,
  connectionId,
  live: true,
  entry: { browse: null, loading: false, error: null, at: 1, conversations: [listed('rw1')] },
})

test('a link names another environment’s chat by its address there, and opens what that environment lists', () => {
  const sources = [source('tailnet:c-mini', 'mac-mini', 'c-mini'), source('ssh:build-box', 'build-box', null)]
  publishRemoteChatLinkTargets(environmentChatRows({ sources, environments, records: new Map() }))
  const link = (environmentId: string | null, chatId: string, agentId: string | null = null) => ({
    environmentId,
    chatId,
    agentId,
  })
  const [target] = remoteChatLinkTargets(link('env-mini', 'rw1'))
  assert.equal(target?.environmentId, 'env-mini')
  assert.equal(target?.machineName, 'mac-mini')
  assert.equal(target?.spec.connectionId, 'c-mini')
  assert.deepEqual([target?.spec.chatId, target?.spec.agent?.agentId], ['rw1', 'agent-1'])
  // An SSH machine's chat opens the same way, by its address.
  const [onBox] = remoteChatLinkTargets(link('env-box', 'rw1'))
  assert.deepEqual([onBox?.spec.route, onBox?.spec.connectionId], ['ssh:build-box', null])
  assert.deepEqual(
    remoteChatLinkTargets(link('env-other', 'rw1')),
    [],
    'another environment’s chat of that id is not it',
  )
  assert.equal(remoteChatLinkTargets(link(null, 'rw1')).length, 2, 'a link that names no environment finds each by id')
  assert.deepEqual(remoteChatLinkTargets(link('env-mini', 'rw-elsewhere')), [])
  assert.equal(remoteChatOnConnection('c-mini', 'rw1')?.chatId, 'rw1')
  assert.equal(remoteChatOnConnection('c-other', 'rw1'), null)

  // An environment the list does not name has no id to match a link by.
  publishRemoteChatLinkTargets(
    environmentChatRows({ sources, environments: environments.slice(0, 1), records: new Map() }),
  )
  assert.deepEqual(remoteChatLinkTargets(link('env-mini', 'rw1')), [])
  assert.equal(remoteChatLinkTargets(link(null, 'rw1'))[0]?.environmentId, null)

  publishRemoteChatLinkTargets([])
  assert.deepEqual(remoteChatLinkTargets(link(null, 'rw1')), [], 'a list that no longer names it opens nothing')

  // A record here of a paired chat copies the same link its machine's own row does.
  assert.equal(
    chatLinkOfWorkspace({ id: 'ws-here', remoteOrigin: { connectionId: 'c-mini', workspaceId: 'rw1' } }, environments),
    'sprintengine://chat/env-mini/rw1',
  )
  assert.equal(
    chatLinkOfWorkspace({ id: 'ws-here', remoteOrigin: null }, environments),
    'sprintengine://chat/env-here/ws-here',
  )
  assert.equal(chatLinkOfWorkspace({ id: 'ws-here' }, []), null, 'no link before this machine’s id is read')
})
