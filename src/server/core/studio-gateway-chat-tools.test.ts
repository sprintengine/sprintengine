import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { StudioError, type StudioClient } from '../../../packages/client-runtime/src/public'
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
// here could reach before addresses either, is refused in words. A chat is
// started, settled, starred and the rest there too: the machine's own record
// is what changes, never a copy here.

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

const stops: Array<() => Promise<void>> = []
/** Shut a core down once every test here is done, before the platform goes. */
const stopLater = (stop: () => Promise<void>) => stops.push(stop)
afterAll(async () => {
  for (const stop of stops) await stop()
})

const SSH_ROUTE = 'ssh:build-box'
const SSH_ROOT = 'ssh://build-box/home/dev/repo'

/** The SSH machine's Studio, as this desktop's client of it answers, with its own record of its chat. */
function sshMachine() {
  const asked: Array<{ method: string; params: Record<string, unknown> }> = []
  const capabilities: Array<string | null> = []
  const record: Record<string, unknown> = { settledAt: null, lastVisitedAt: 0, starred: false, color: null }
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      asked.push({ method, params })
      if (method.startsWith('conversation.') && 'workspaceId' in params && params.workspaceId !== 'ws-deploy')
        throw new StudioError('not_found', `No chat "${String(params.workspaceId)}".`)
      if (method === 'conversation.settle') {
        record.settledAt = params.settled === false ? null : 1234
        return { settledAt: record.settledAt }
      }
      if (method === 'conversation.visit') {
        record.lastVisitedAt = params.visitedAt ?? 99
        return { lastVisitedAt: record.lastVisitedAt }
      }
      if (method === 'conversation.markUnread') {
        record.lastVisitedAt = 7
        return { lastVisitedAt: 7 }
      }
      if (method === 'conversation.snooze') {
        record.snoozedUntil = params.until
        return { snoozedUntil: params.until }
      }
      if (method === 'conversation.highlight') {
        if (params.starred !== undefined) record.starred = params.starred
        if (params.color !== undefined) record.color = params.color
        return { starred: record.starred, color: record.color }
      }
      if (method === 'conversation.setAutoSettle') {
        record.autoSettle = params.enabled
        return { enabled: params.enabled }
      }
      if (method === 'conversation.create')
        return {
          conversation: {
            workspaceId: params.noProject ? 'ws-loose' : 'ws-new',
            agentId: 'agent-9',
            name: 'Started there',
            cli: 'claude-code',
            providerId: 'claude-agent',
            modelId: 'default',
            sessionId: 's-9',
          },
        }
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
    clientFor: async (route, capability) => {
      capabilities.push(capability ?? null)
      return route === SSH_ROUTE
        ? { ok: true, client, name: 'build-box' }
        : { ok: false, code: 'unavailable', message: 'That machine cannot be reached from this computer.' }
    },
    onConnected: () => () => undefined,
  }
  return { clients, asked, record, capabilities }
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
    assert.equal(body(byRecord).error.code, 'unavailable')
    assert.match(body(byRecord).error.message, /paired desktop/u)

    // This Studio's own address is this core: no route is asked for.
    const asked = routesAsked.length
    const own = await call('conversation.read', { chat: `${readStudioEnvironmentId(dataDir)}:ws-nope` })
    assert.equal(body(own).error.code, 'unknown_workspace')
    assert.match(body(own).error.message, /this machine/u)
    assert.equal(routesAsked.length, asked)
  } finally {
    // Shut once the file is done: what the core starts (its hand-over plan)
    // must not be cut short by a shutdown, nor log after the platform goes.
    stopLater(async () => {
      await gateway.shutdown()
      await core.shutdown()
    })
  }
})

/** A core and gateway whose environment registry knows the SSH machine and a paired desktop. */
function machineGateway() {
  const dataDir = join(scratch, 'data-tidy')
  const machine = sshMachine()
  const core = createStudioCore(createNodeStudioPlatform({ dataDir, packaged: false, version: '0.0.0-test' }), {
    role: 'server',
    environmentClients: machine.clients,
  })
  const gateway = createStudioGateway(core, {
    environmentRoutes: async (environmentId) =>
      environmentId === 'env-ssh' ? [SSH_ROUTE] : environmentId === 'env-paired' ? ['tailnet:conn-1'] : [],
  })
  const call = (tool: string, args: Record<string, unknown>, context: McpConnectionContext = script) =>
    gateway
      .ownTools()
      .find((each) => each.name === tool)!
      .handler(args, context) as Promise<McpToolResult>
  return { core, gateway, machine, call }
}

// One core for the tests below, up from the start of the file to its end.
let shared: ReturnType<typeof machineGateway> | null = null
beforeAll(() => {
  const built = (shared = machineGateway())
  stopLater(async () => {
    await built.gateway.shutdown()
    await built.core.shutdown()
  })
})
const tidy = () => {
  if (!shared) throw new Error('the core is built before the tests')
  return shared
}

test("each lifecycle tool given an SSH machine's chat by address changes the machine's own record", async () => {
  const { machine, call } = tidy()
  machine.asked.length = 0
  const chat = 'env-ssh:ws-deploy'
  const starred = await call('conversation.highlight', { chat, starred: true, color: 'blue' })
  assert.equal(starred.isError, undefined, JSON.stringify(body(starred)))
  assert.deepEqual(body(starred), { ok: true, workspaceId: 'ws-deploy', starred: true, color: 'blue' })

  const settled = await call('conversation.settle', { chat: 'sprintengine://chat/env-ssh/ws-deploy' })
  assert.equal(settled.isError, undefined, JSON.stringify(body(settled)))
  assert.equal(body(settled).settledAt, 1234)

  const visited = await call('conversation.visit', { chat, visitedAt: 50 })
  assert.equal(body(visited).lastVisitedAt, 50)
  const unread = await call('conversation.mark_unread', { chat })
  assert.equal(body(unread).lastVisitedAt, 7)
  const until = Date.now() + 60_000
  const snoozed = await call('conversation.snooze', { chat, until })
  assert.equal(body(snoozed).snoozedUntil, until)
  const auto = await call('conversation.auto_settle', { chat, enabled: true })
  assert.deepEqual(body(auto), { ok: true, workspaceId: 'ws-deploy', autoSettle: true })

  // The machine's own record is what changed.
  assert.deepEqual(machine.record, {
    settledAt: 1234,
    lastVisitedAt: 7,
    starred: true,
    color: 'blue',
    snoozedUntil: until,
    autoSettle: true,
  })
  const methods = machine.asked.map((entry) => entry.method)
  assert.deepEqual(methods, [
    'conversation.highlight',
    'conversation.settle',
    'conversation.visit',
    'conversation.markUnread',
    'conversation.snooze',
    'conversation.setAutoSettle',
  ])
  for (const entry of machine.asked) assert.equal(entry.params.workspaceId, 'ws-deploy')
  // The row menu's own methods are asked of a machine that offers them.
  assert.ok(machine.capabilities.includes('chat-lifecycle'))

  // A chat the machine does not hold is said so in its words.
  const missing = await call('conversation.settle', { chat: 'env-ssh:ws-nope' })
  assert.equal(body(missing).error.code, 'unknown_workspace')
  assert.match(body(missing).error.message, /build-box/u)

  // A paired desktop's chat, and a paired device asking for a machine's, are refused in words.
  const paired = await call('conversation.highlight', { chat: 'env-paired:ws-p', starred: true })
  assert.equal(body(paired).error.code, 'unavailable')
  assert.match(body(paired).error.message, /paired desktop/u)
  const device: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'dev-1' } } as never
  const relayed = await call('conversation.settle', { chat }, device)
  assert.equal(body(relayed).error.code, 'tailnet_local_only')
  assert.equal(machine.asked.filter((entry) => entry.params.workspaceId === 'ws-deploy').length, 6)

  const both = await call('conversation.settle', { chat, workspaceId: 'ws-deploy' })
  assert.equal(body(both).error.code, 'invalid_arguments')
})

test('conversation.create starts a chat on an SSH machine by its environment, and by a copy of its project', async () => {
  const { core, machine, call } = tidy()
  const started = await call('conversation.create', {
    environment: 'env-ssh',
    workspaceId: 'ws-deploy',
    newChat: true,
    prompt: 'Go',
    notifyParent: false,
  })
  assert.equal(started.isError, undefined, JSON.stringify(body(started)))
  assert.equal(body(started).conversation.workspaceId, 'ws-new')
  const create = machine.asked.find((entry) => entry.method === 'conversation.create')
  assert.ok(create)
  assert.equal(create.params.workspaceId, 'ws-deploy')
  assert.equal(create.params.newChat, true)
  assert.equal(create.params.prompt, 'Go')

  // A link names the machine as well; with no project, the folder is made there.
  const loose = await call('conversation.create', {
    environment: 'sprintengine://chat/env-ssh/ws-deploy',
    noProject: true,
    notifyParent: false,
  })
  assert.equal(body(loose).conversation.workspaceId, 'ws-loose')
  assert.equal(machine.asked.at(-1)?.params.noProject, true)
  assert.equal(machine.asked.at(-1)?.params.workspaceId, undefined)

  // A plan chat would run writable there: refused, never started.
  const asked = machine.asked.length
  const planned = await call('conversation.create', { environment: 'env-ssh', workspaceId: 'ws-deploy', mode: 'plan' })
  assert.equal(body(planned).error.code, 'unsupported_mode')
  assert.equal(machine.asked.length, asked)

  // Until the copies go, a copy's workspace id still starts the chat on its machine.
  const windowId = core.workspaceSyncService.getSnapshot().state.primaryWorkspaceWindowId
  const copied = core.workspaceSyncService.dispatch({
    sourceWindowId: windowId,
    command: {
      type: 'workspace.created',
      payload: {
        workspace: {
          id: 'ws-deploy',
          name: 'Deploy fix',
          mode: 'standard',
          folderPath: SSH_ROOT,
          templateId: 'standard',
          layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
          agents: { 'agent-1': { id: 'agent-1', runtimeKind: 'conversation', cli: 'claude' } },
          worktreeState: { containerPath: null, entries: {}, updatedAt: null },
          editorState: { openFiles: [], activeFilePath: null },
          environment: { kind: 'ssh', id: 'build-box' },
        },
        windowId,
        insert: { kind: 'folder_head', folderPath: SSH_ROOT },
        activate: false,
      },
    },
  } as never)
  assert.equal(copied.ok, true, JSON.stringify(copied))
  const byCopy = await call('conversation.create', { workspaceId: 'ws-deploy', prompt: 'Again', notifyParent: false })
  assert.equal(byCopy.isError, undefined, JSON.stringify(body(byCopy)))
  assert.equal(machine.asked.at(-1)?.method, 'conversation.create')
  assert.equal(machine.asked.at(-1)?.params.prompt, 'Again')
  // And a lifecycle tool given the copy's id changes the machine's record, not the copy.
  const starred = await call('conversation.highlight', { workspaceId: 'ws-deploy', starred: true })
  assert.equal(starred.isError, undefined, JSON.stringify(body(starred)))
  assert.equal(machine.asked.at(-1)?.method, 'conversation.highlight')
  assert.equal(core.workspaceRegistry.getRecord('ws-deploy')?.highlight, undefined)

  const unknown = await call('conversation.create', { environment: 'env-gone', workspaceId: 'ws-deploy' })
  assert.equal(body(unknown).error.code, 'unknown_environment')
  const paired = await call('conversation.create', { environment: 'env-paired', workspaceId: 'ws-p' })
  assert.equal(body(paired).error.code, 'unavailable')
  const bad = await call('conversation.create', { environment: 'not an id', workspaceId: 'ws-deploy' })
  assert.equal(body(bad).error.code, 'invalid_arguments')
})
