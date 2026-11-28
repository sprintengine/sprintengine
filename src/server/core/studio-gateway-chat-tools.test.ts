import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import type { StudioClient } from '../../../packages/client-runtime/src/public'
import type { McpConnectionContext, McpToolResult } from '../../shared/modules/mcp-tools'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { createNodeStudioPlatform, resetStudioPlatform } from '../platform/platform'
import { readStudioEnvironmentId } from '../environment/environment-id'
import { createStudioCore } from './studio-core'
import { createStudioGateway } from './studio-gateway'

// The agents' chat tools take a chat's address or link, wherever the chat is:
// an SSH machine's chat is found and driven on that machine's Studio, routed
// by the environment registry the shell keeps (not by a record here); this
// Studio's own address is this core; a paired desktop's chat, which no tool
// here could reach before addresses either, is refused in words.

let scratch = ''
let savedHome: string | undefined
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'se-gateway-chat-tools-')))
  savedHome = process.env.HOME
  process.env.HOME = join(scratch, 'home')
  await mkdir(process.env.HOME, { recursive: true })
})
afterAll(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  resetStudioPlatform()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

const SSH_ROUTE = 'ssh:build-box'
const SSH_ROOT = 'ssh://build-box/home/dev/repo'

/** The SSH machine's Studio, as this desktop's client of it answers. */
function sshMachine() {
  const asked: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      asked.push({ method, params })
      if (method === 'workspaces.list')
        return {
          workspaces: [{ id: 'ws-deploy', name: 'Deploy fix', folderPath: SSH_ROOT, agentIds: ['agent-1'] }],
        }
      if (method === 'session.list')
        return {
          ok: true,
          sessions: [
            {
              sessionId: 's-1',
              workspaceId: 'ws-deploy',
              agentId: 'agent-1',
              status: 'ready',
              phase: 'completed',
              permissionPreset: 'auto',
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        }
      if (method === 'conversation.send') return {}
      throw new Error(`unexpected ${method}`)
    },
    conversations: {
      async loadEarlier(ref: unknown, before: number, turns: number) {
        asked.push({ method: 'conversation.loadEarlier', params: { ref, before, turns } })
        return { ok: true, page: { events: [], hasMore: false, beforeCursor: null } }
      },
    },
  } as unknown as StudioClient
  const clients: EnvironmentClients = {
    clientFor: async (route) =>
      route === SSH_ROUTE
        ? { ok: true, client, name: 'build-box' }
        : { ok: false, code: 'unavailable', message: 'That machine cannot be reached from this computer.' },
    onConnected: () => () => undefined,
  }
  return { clients, asked }
}

const script: McpConnectionContext = { metadata: { kind: 'external-local' } }
const body = (result: McpToolResult) => result.structuredContent as Record<string, any>

test("a tool given a link to an SSH machine's chat drives it there; a paired desktop's is refused in words", async () => {
  const dataDir = join(scratch, 'data')
  const machine = sshMachine()
  const core = createStudioCore(createNodeStudioPlatform({ dataDir, packaged: false, version: '0.0.0-test' }), {
    role: 'server',
    environmentClients: machine.clients,
  })
  const routesAsked: string[] = []
  const gateway = createStudioGateway(core, {
    environmentRoutes: async (environmentId) => {
      routesAsked.push(environmentId)
      if (environmentId === 'env-ssh') return [SSH_ROUTE]
      if (environmentId === 'env-paired') return ['tailnet:conn-1']
      // Paired and saved over SSH: the SSH route is the one this server holds.
      if (environmentId === 'env-both') return ['tailnet:conn-2', SSH_ROUTE]
      return []
    },
  })
  try {
    const tool = (name: string) => gateway.ownTools().find((each) => each.name === name)!
    const call = (name: string, args: Record<string, unknown>) =>
      tool(name).handler(args, script) as Promise<McpToolResult>

    const sent = await call('conversation.send', { chat: 'sprintengine://chat/env-ssh/ws-deploy', message: 'Ship it.' })
    assert.equal(sent.isError, undefined, JSON.stringify(body(sent)))
    assert.equal(body(sent).workspaceId, 'ws-deploy')
    const send = machine.asked.find((entry) => entry.method === 'conversation.send')
    assert.ok(send, 'the message went to the machine')
    assert.deepEqual(send.params.key, { workspaceId: 'ws-deploy', agentId: 'agent-1', workspaceRoot: SSH_ROOT })
    assert.equal(send.params.message, 'Ship it.')

    const read = await call('conversation.read', { chat: 'env-both:ws-deploy' })
    assert.equal(read.isError, undefined, JSON.stringify(body(read)))
    assert.equal(body(read).title, 'Deploy fix')
    assert.ok(machine.asked.some((entry) => entry.method === 'conversation.loadEarlier'))

    const paired = await call('conversation.read', { chat: 'env-paired:ws-p' })
    assert.equal(body(paired).error.code, 'unavailable')
    assert.match(body(paired).error.message, /paired desktop/u)

    const unknown = await call('conversation.read', { chat: 'env-gone:ws-p' })
    assert.equal(body(unknown).error.code, 'unknown_environment')

    const missing = await call('conversation.read', { chat: 'env-ssh:ws-nope' })
    assert.equal(body(missing).error.code, 'unknown_workspace')
    assert.match(body(missing).error.message, /build-box/u)

    // A paired desktop's chat was never reachable by its attached record here
    // either: the record names a chat this core does not run.
    const windowId = core.workspaceSyncService.getSnapshot().state.primaryWorkspaceWindowId
    const project = join(scratch, 'home', 'repo')
    await mkdir(project, { recursive: true })
    const attached = core.workspaceSyncService.dispatch({
      sourceWindowId: windowId,
      command: {
        type: 'workspace.created',
        payload: {
          workspace: {
            id: 'ws-attached',
            name: 'Attached',
            mode: 'standard',
            folderPath: project,
            templateId: 'standard',
            layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
            agents: { 'agent-1': { id: 'agent-1', runtimeKind: 'conversation', cli: 'claude' } },
            worktreeState: { containerPath: null, entries: {}, updatedAt: null },
            editorState: { openFiles: [], activeFilePath: null },
            remoteOrigin: {
              connectionId: 'conn-1',
              machineName: 'desk-b',
              workspaceId: 'ws-p',
              workspaceName: 'Attached',
              workspaceRoot: '/Users/dev/repo',
            },
          },
          windowId,
          insert: { kind: 'folder_head', folderPath: project },
          activate: false,
        },
      },
    } as never)
    assert.equal(attached.ok, true, JSON.stringify(attached))
    const byRecord = await call('conversation.read', { workspaceId: 'ws-attached' })
    assert.equal(body(byRecord).error.code, 'unknown_workspace')

    // This Studio's own address is this core: no route is asked for.
    const asked = routesAsked.length
    const own = await call('conversation.read', { chat: `${readStudioEnvironmentId(dataDir)}:ws-nope` })
    assert.equal(body(own).error.code, 'unknown_workspace')
    assert.match(body(own).error.message, /this machine/u)
    assert.equal(routesAsked.length, asked)
  } finally {
    await gateway.shutdown()
  }
})
