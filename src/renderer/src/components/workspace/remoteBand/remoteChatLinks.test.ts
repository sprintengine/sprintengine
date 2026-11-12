import assert from 'node:assert/strict'
import { test } from 'vitest'

import { publishRemoteChatLinkTargets, remoteChatLinkTargets, remoteChatOnConnection } from './remoteChatLinks'
import { buildRemoteBand } from './remoteSessionsModel'
import type { MeshConnection } from '../../../../../shared/tailnet-mesh'
import type { EnvironmentEntry } from '../../../../../shared/environments'
import { UNKNOWN_CONNECTION } from '../../../../../shared/environments'
import { chatLinkOfRemoteChat, chatLinkOfWorkspace } from '../../../../../shared/environment-keys'

const entry = (environmentId: string, route: EnvironmentEntry['routes'][number]): EnvironmentEntry => ({
  environmentId,
  displayName: environmentId,
  routes: [route],
  machine: { kind: 'local' },
  descriptor: null,
  connection: UNKNOWN_CONNECTION,
  compatibility: null,
})
const environments = [
  entry('env-here', { kind: 'local' }),
  entry('env-mini', { kind: 'tailnet', connection: 'c-mini' }),
]

test('a link names a paired machine’s chat by its address there, and opens what that machine lists', () => {
  const connection = {
    id: 'c-mini',
    machineName: 'mac-mini',
    endpoint: 'mac-mini.tail1234.ts.net:8471',
    deviceId: 'tnd_mini',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read', 'conversation:operate'] as MeshConnection['scopes'],
    pairedAt: '2026-09-05T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request' as const,
  }
  const groups = buildRemoteBand({
    connections: [connection],
    browses: new Map([
      [
        connection.id,
        {
          browse: null,
          loading: false,
          error: null,
          at: 1,
          conversations: [
            {
              workspaceId: 'rw1',
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
            },
          ],
        },
      ],
    ]),
    environments: [],
    workspaces: [],
  })
  publishRemoteChatLinkTargets(groups, environments)
  const link = (environmentId: string | null, chatId: string, agentId: string | null = null) => ({
    environmentId,
    chatId,
    agentId,
  })
  const [target] = remoteChatLinkTargets(link('env-mini', 'rw1'))
  assert.equal(target?.environmentId, 'env-mini')
  assert.equal(target?.machineName, 'mac-mini')
  assert.equal(target?.spec.connectionId, 'c-mini')
  assert.deepEqual(target?.spec.conversation, { workspaceId: 'rw1', agentId: 'agent-1' })
  assert.deepEqual(
    remoteChatLinkTargets(link('env-other', 'rw1')),
    [],
    'another environment’s chat of that id is not it',
  )
  assert.equal(remoteChatLinkTargets(link(null, 'rw1')).length, 1, 'a link that names no environment finds it by id')
  assert.deepEqual(remoteChatLinkTargets(link('env-mini', 'rw-elsewhere')), [])
  assert.deepEqual(remoteChatOnConnection('c-mini', 'rw1')?.conversation, { workspaceId: 'rw1', agentId: 'agent-1' })
  assert.equal(remoteChatOnConnection('c-other', 'rw1'), null)

  // Until the machine has said its id, its chats are found only by links that name none.
  publishRemoteChatLinkTargets(groups, environments.slice(0, 1))
  assert.deepEqual(remoteChatLinkTargets(link('env-mini', 'rw1')), [])
  assert.equal(remoteChatLinkTargets(link(null, 'rw1'))[0]?.environmentId, null)

  publishRemoteChatLinkTargets([], environments)
  assert.deepEqual(remoteChatLinkTargets(link(null, 'rw1')), [], 'a list that no longer names it opens nothing')

  // A row opened here from it copies the same link its machine's own row does.
  const theirs = chatLinkOfRemoteChat('c-mini', 'rw1', environments)
  assert.equal(theirs, 'sprintengine://chat/env-mini/rw1')
  assert.equal(
    chatLinkOfWorkspace({ id: 'ws-here', remoteOrigin: { connectionId: 'c-mini', workspaceId: 'rw1' } }, environments),
    theirs,
  )
  assert.equal(
    chatLinkOfWorkspace({ id: 'ws-here', remoteOrigin: null }, environments),
    'sprintengine://chat/env-here/ws-here',
  )
  assert.equal(chatLinkOfWorkspace({ id: 'ws-here' }, []), null, 'no link before this machine’s id is read')
  assert.equal(
    chatLinkOfRemoteChat('c-unknown', 'rw1', environments),
    null,
    'nor for a machine that has not said its id',
  )
})
