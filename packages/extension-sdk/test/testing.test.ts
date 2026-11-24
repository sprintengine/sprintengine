// `@sprintengine/extension-sdk/testing`: the fake hosts hold an extension to
// the host's rules, read what its extension.json declares, and run a ui
// entry's `mount` the way Studio does.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createElement } from 'react'
import { describe, test } from 'vitest'

import { getActivityService, getUsageService } from '../src/activity.js'
import { getBacklogService } from '../src/backlog.js'
import { getConversationService, getTextGenerationService } from '../src/conversation.js'
import { getGitHubService, getSecretsService } from '../src/brokers.js'
import {
  getCompanionAgentsService,
  getModuleStorage,
  getScheduledAgentsService,
  WorkspaceContextToken,
  WorkspaceServiceToken,
  type ScheduledAgentDraft,
} from '../src/index.js'
import { EXTENSION_HOST_SERVICES } from '../src/services.js'
import { createFakeFrameStudio, createFakeMainHost, renderToHtml } from '../src/testing.js'
import { SERVICE_FAKES } from '../src/testing-services.js'

const ROOT = '/Users/dev/projects/app'

describe('createFakeMainHost', () => {
  test('a point’s handlers run in registration order, and the disposer takes them back out', async () => {
    const fake = createFakeMainHost({
      manifest: {
        id: 'guard',
        tier: 'worker',
        main: 'dist/main.cjs',
        contributes: { hooks: [{ point: 'agent.prompt.before' }] },
      } as never,
    })
    fake.host.registerHooks({ 'agent.prompt.before': (event) => ({ change: { prompt: `${event.prompt} one` } }) })
    const second = fake.host.registerHooks({
      'agent.prompt.before': (event) =>
        event.prompt.startsWith('no') ? { deny: 'not that' } : { change: { prompt: `${event.prompt} two` } },
    })
    const event = {
      agent: null,
      where: 'chat' as const,
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      terminalId: null,
      from: 'extension' as const,
      inputKind: 'send' as const,
      prompt: 'go',
    }
    const changed = await fake.hooks.fire('agent.prompt.before', event)
    assert.equal(changed.kind === 'change' && (changed.event as { prompt: string }).prompt, 'go one two')
    assert.deepEqual(await fake.hooks.fire('agent.prompt.before', { ...event, prompt: 'no' }), {
      kind: 'deny',
      reason: 'not that',
    })
    second()
    const after = await fake.hooks.fire('agent.prompt.before', event)
    assert.equal(after.kind === 'change' && (after.event as { prompt: string }).prompt, 'go one')
  })

  test('events reach the handlers of the events extension.json lists, and one without its permission reaches nobody', async () => {
    const workspace = { workspaceId: 'ws-1', name: 'Notes', kind: 'folder' as const, folderPath: null, branch: null }
    const fake = createFakeMainHost({
      manifest: {
        id: 'watch',
        permissions: ['workspace:read'],
        contributes: { events: [{ on: 'workspace.created' }] },
      },
    })
    const heard: string[] = []
    const first = fake.host.events.on('workspace.created', (made) => void heard.push(`one ${made.name}`))
    fake.host.events.on('workspace.created', (made) => void heard.push(`two ${made.name}`))
    assert.throws(() => fake.host.events.on('workspace.removed', () => undefined), /not listed/)
    await fake.events.fire('workspace.created', workspace)
    first.dispose()
    await fake.events.fire('workspace.created', { ...workspace, name: 'Site' })
    assert.deepEqual(heard, ['one Notes', 'two Notes', 'two Site'])
    await assert.rejects(fake.events.fire('workspace.removed', workspace), /lists no event/)
    const bare = createFakeMainHost({
      manifest: { id: 'bare', contributes: { events: [{ on: 'workspace.created' }] } },
    })
    bare.host.events.on('workspace.created', () => void heard.push('bare'))
    await bare.events.fire('workspace.created', workspace)
    assert.equal(heard.includes('bare'), false)
    assert.deepEqual(bare.undeclared, [{ what: 'events.workspace.created', needs: ['workspace:read'] }])
  })

  test('a surface hears one of Studio’s events once its subscription is admitted', async () => {
    const frame = createFakeFrameStudio({
      moduleId: 'local.board',
      permissions: ['workspace:read'],
      invoker: ['workspace:read', 'extension:read'],
    })
    const studio = frame.studio({ point: 'panels', id: 'board' })
    const heard: string[] = []
    studio.on('workspace.created', (made) => void heard.push(made.name))
    studio.on('agent.status.changed', () => void heard.push('status'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    frame.studioEvent('workspace.created', {
      workspaceId: 'ws-1',
      name: 'Notes',
      kind: 'folder',
      folderPath: null,
      branch: null,
    })
    frame.studioEvent('agent.status.changed', {
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      where: 'chat',
      terminalId: null,
      title: null,
      state: 'working',
      failed: false,
      receivedAt: 1,
    })
    assert.deepEqual(heard, ['Notes'])
    assert.match(frame.logs[0]?.message ?? '', /conversation:read/)
  })

  test('has a fake for every service the SDK publishes, and nothing else', () => {
    assert.deepEqual(Object.keys(SERVICE_FAKES).sort(), EXTENSION_HOST_SERVICES.map((service) => service.key).sort())
  })

  test('storage applies the host’s key pattern, root rule and 1 MB cap', async () => {
    const fake = createFakeMainHost({
      moduleId: 'notes',
      permissions: ['storage:own'],
      storage: { global: { seeded: 1 } },
    })
    const storage = getModuleStorage(fake.host)
    assert.deepEqual(await storage.get({ key: 'seeded' }), { ok: true, value: 1, found: true })
    assert.equal((await storage.get({ key: 'Bad Key' })).ok, false)
    assert.equal(((await storage.set({ key: 'Bad Key', value: 1 })) as { code?: string }).code, 'invalid_key')
    assert.equal(((await storage.set({ key: 'con', value: 1 })) as { code?: string }).code, 'invalid_key')
    assert.equal(
      ((await storage.set({ key: 'a', value: 1, workspaceRoot: 'relative/root' })) as { code?: string }).code,
      'invalid_workspace_root',
    )
    assert.equal(
      ((await storage.set({ key: 'big', value: 'x'.repeat(1024 * 1024) })) as { code?: string }).code,
      'value_too_large',
    )
    assert.equal(((await storage.set({ key: 'undef', value: undefined })) as { code?: string }).code, 'invalid_value')

    const value = { list: [1, 2] }
    assert.deepEqual(await storage.set({ key: 'doc', value, workspaceRoot: ROOT }), { ok: true })
    value.list.push(3)
    assert.deepEqual(fake.services.storage.peek('doc', ROOT), { list: [1, 2] }, 'stored as JSON, not by reference')
    assert.deepEqual(await storage.list({ workspaceRoot: ROOT }), { ok: true, keys: ['doc'] })
    assert.deepEqual(await storage.list(), { ok: true, keys: ['seeded'] }, 'the global store is its own scope')
    assert.deepEqual(await storage.delete({ key: 'doc', workspaceRoot: ROOT }), { ok: true, deleted: true })
    assert.deepEqual(fake.undeclared, [])
  })

  test('a call its permissions do not cover is refused as the host’s gate refuses it, and reported', async () => {
    const fake = createFakeMainHost({ moduleId: 'quiet', permissions: [] })
    const stored = await getModuleStorage(fake.host).get({ key: 'doc' })
    assert.equal(!stored.ok && stored.code, 'not_permitted')
    assert.deepEqual(fake.undeclared, [{ what: 'core.module-storage.get', needs: ['storage:own'] }])

    const conversations = getConversationService(fake.host)
    const created = await conversations.create({ workspaceId: 'ws-app' })
    assert.equal(created.ok, false)
    assert.equal(!created.ok && created.code, 'not_permitted')
    assert.throws(() => conversations.list(), /was not approved for "conversation:own"/)

    const github = await getGitHubService(fake.host).request({ route: '/user' })
    assert.equal(!github.ok && github.code, 'not_permitted')
    const secret = await getSecretsService(fake.host).set('key', 'v', { allowedOrigins: ['https://api.example.com'] })
    assert.equal(!secret.ok && secret.code, 'not_permitted')
    await assert.rejects(
      () =>
        getCompanionAgentsService(fake.host).attach({
          workspaceId: 'ws-app',
          agentId: 'guide',
          name: 'Guide',
          workspaceRoot: ROOT,
          systemPrompt: 'Help.',
        }),
      /was not approved for "agents:companion"/,
    )
  })

  test('only published services resolve, and a removed provider throws as the host does', () => {
    const fake = createFakeMainHost({ moduleId: 'notes', services: { 'github.module-service': null } })
    assert.throws(
      () => fake.host.requireService({ key: 'core.terminal-runtime' }),
      /Service "core.terminal-runtime" is not available to third-party modules/,
    )
    assert.throws(
      () => fake.host.requireService({ key: 'github.module-service' }),
      /requires service "github.module-service", which no enabled module provides/,
    )
    assert.equal(fake.host.getService({ key: 'github.module-service' }), undefined)
    // A worker provides no service of its own: its process is its own.
    assert.equal('provideService' in fake.host, false)
  })

  test('declared methods need no permission, are called by access, and are refused as the host refuses', async () => {
    type Notes = {
      echo: { access: 'read'; params: { text: string }; result: { got: string } }
      save: { access: 'operate'; params: { text: string }; result: { count: number }; errors: 'empty' }
    }
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: [] })
    const text = (value: unknown) =>
      typeof (value as { text?: unknown } | undefined)?.text === 'string'
        ? { ok: true as const, params: { text: (value as { text: string }).text } }
        : { ok: false as const, message: '"text" is the note.' }
    let saved = 0
    const contexts: unknown[] = []
    const methods = {
      echo: {
        access: 'read' as const,
        params: text,
        handler: (params: { text: string }) => ({ ok: true as const, result: { got: params.text } }),
      },
      save: {
        access: 'operate' as const,
        params: text,
        handler: (params: { text: string }, context: unknown) => {
          contexts.push(context)
          if (!params.text) return { ok: false as const, code: 'empty' as const, message: 'Nothing to save.' }
          return { ok: true as const, result: { count: (saved += 1) } }
        },
      },
    }
    fake.host.registerMethods<Notes>(methods)
    assert.throws(() => fake.host.registerMethods<Notes>(methods), /already declares "echo"/)
    assert.throws(
      () => fake.host.registerMethods({ 'notes:x': methods.echo } as never),
      /"notes:x" is not a method name/,
    )
    assert.deepEqual(fake.methods.declared(), [
      { name: 'echo', access: 'read' },
      { name: 'save', access: 'operate' },
    ])

    assert.deepEqual(await fake.methods.read('echo', { text: 'hi' }), { ok: true, result: { got: 'hi' } })
    const asRead = await fake.methods.read('save', { text: 'x' })
    assert.equal(!asRead.ok && asRead.code, 'extension_method_unknown')
    const missing = await fake.methods.read('nothing', {})
    assert.equal(!missing.ok && missing.code, 'extension_method_unknown')
    const refused = await fake.methods.read('echo', { words: 'hi' })
    assert.deepEqual(refused, { ok: false, code: 'invalid_params', message: '"text" is the note.' })

    assert.deepEqual(await fake.methods.operate('save', { text: '' }), {
      ok: false,
      code: 'empty',
      message: 'Nothing to save.',
    })
    const first = await fake.methods.operate('save', { text: 'a' }, { commandId: 'c1' })
    const again = await fake.methods.operate('save', { text: 'a' }, { commandId: 'c1' })
    assert.deepEqual(again, first, 'a retry under the same id is answered with the first answer')
    assert.equal(saved, 1)
    assert.deepEqual(contexts.at(-1), { clientId: 'owner', commandId: 'owner:c1' })

    fake.host.registerMethods({
      fn: {
        access: 'read',
        params: () => ({ ok: true, params: {} }),
        handler: () => ({ ok: true, result: { run() {} } }),
      },
    })
    await assert.rejects(fake.methods.read('fn', {}), /not JSON/, 'a result the protocol cannot carry fails')
  })

  test('MCP tools need mcp:tools, and a call reaches the handler with agent metadata', async () => {
    const tools = [
      {
        name: 'notes_count',
        description: 'Count notes',
        inputSchema: { type: 'object' },
        mutates: false,
        handler: async (args: Record<string, unknown>, context?: { metadata: { workspaceId?: string } }) => ({
          content: [{ type: 'text' as const, text: `${String(args.prefix)}:${context?.metadata.workspaceId}` }],
        }),
      },
    ]
    assert.throws(
      () => createFakeMainHost({ moduleId: 'notes' }).host.registerMcpTools(tools),
      /was not approved for "tools:contribute"/,
    )
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['tools:contribute'] })
    fake.host.registerMcpTools(tools)
    assert.deepEqual(await fake.tools.call('notes_count', { prefix: 'n' }), {
      content: [{ type: 'text', text: 'n:ws-app' }],
    })
    await assert.rejects(fake.tools.call('nope'), /No MCP tool "nope"/)
  })

  test('MCP tools are the ones extension.json declares, described as it describes them', async () => {
    const handler = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
    const fake = createFakeMainHost({
      manifest: {
        id: 'notes',
        permissions: ['tools:contribute'],
        contributes: {
          mcpTools: [
            { name: 'notes_search', description: 'Search the notes.', access: 'read', inputSchema: { type: 'object' } },
            {
              name: 'notes_clear',
              description: 'Clear the notes.',
              access: 'operate',
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    })
    assert.equal(fake.host.moduleId, 'local.notes', 'a folder install names it local.<id>')
    assert.throws(
      () =>
        fake.host.registerMcpTools([
          { name: 'notes_search', description: 'x', inputSchema: {}, handler },
          { name: 'notes_secret', description: 'x', inputSchema: {}, handler },
        ]),
      /"notes_secret" is not declared in extension\.json/,
    )
    assert.deepEqual(fake.tools.list(), [], 'a refused batch registers none of it')
    fake.host.registerMcpTools([
      { name: 'notes_search', description: 'Whatever the code says', inputSchema: {}, mutates: true, handler },
      { name: 'notes_clear', description: 'Whatever the code says', inputSchema: {}, mutates: false, handler },
    ])
    assert.deepEqual(
      fake.tools.list().map((tool) => [tool.name, tool.description, tool.mutates]),
      [
        ['notes_search', 'Search the notes.', false],
        ['notes_clear', 'Clear the notes.', true],
      ],
      'the manifest’s description and access win',
    )
    assert.deepEqual(await fake.tools.call('notes_search'), { content: [{ type: 'text', text: 'ok' }] })
  })

  test('conversations: owned chats, events, presets capped, retries answered once', async () => {
    const fake = createFakeMainHost({ moduleId: 'board', permissions: ['conversation:own'] })
    const chats = getConversationService(fake.host)
    const lists: number[] = []
    chats.watch(undefined, (list) => lists.push(list.length))

    const missing = await chats.create({ workspaceId: 'nowhere' })
    assert.equal(!missing.ok && missing.code, 'unknown_workspace')
    const created = await chats.create({
      workspaceId: 'ws-app',
      prompt: 'Plan it',
      permissionPreset: 'bypass',
      commandId: 'c1',
    })
    assert.ok(created.ok)
    const again = await chats.create({ workspaceId: 'ws-app', prompt: 'Plan it', commandId: 'c1' })
    assert.ok(
      again.ok && again.conversation.agentId === created.conversation.agentId,
      'a retried create finds the first chat',
    )
    assert.equal(created.conversation.permissionPreset, 'auto', 'bypass is lowered to the auto ceiling')

    const ref = { workspaceId: created.conversation.workspaceId, agentId: created.conversation.agentId }
    const seen: string[] = []
    chats.subscribe(ref, (event) => seen.push(event.type))
    fake.services.conversations.emitEvent(ref, { type: 'turn_started' })
    fake.services.conversations.emitEvent(ref, { type: 'content_delta', payload: { text: 'Done' } })
    fake.services.conversations.emitEvent(ref, { type: 'turn_completed' })
    assert.deepEqual(seen, ['turn_started', 'content_delta', 'turn_completed'])
    assert.equal((await chats.list())[0]?.status, 'ready')
    const transcript = await chats.transcript(ref)
    assert.ok(transcript.ok)
    assert.deepEqual(
      transcript.events.map((event) => event.type),
      ['session_started', 'user_message', 'turn_started', 'content_delta', 'turn_completed'],
    )
    assert.ok(lists.length >= 3, 'watchers hear creates and status changes')

    const frames: string[] = []
    chats.follow(ref, { afterSeq: 3 }, (frame) => frames.push(frame.type))
    assert.deepEqual(frames, ['event', 'event', 'synchronized'], 'a known cursor gets only what came after it')

    fake.services.conversations.addForeign({ workspaceId: 'ws-app', agentId: 'person-chat' })
    const overheard: string[] = []
    chats.subscribe({ workspaceId: 'ws-app', agentId: 'person-chat' }, (event) => overheard.push(event.type))
    assert.throws(
      () =>
        fake.services.conversations.emitEvent(
          { workspaceId: 'ws-app', agentId: 'person-chat' },
          { type: 'turn_started' },
        ),
      /not the module's own/,
    )
    assert.deepEqual(overheard, [], 'a chat the module does not own delivers nothing')
    assert.throws(
      () => chats.subscribe({ workspaceId: '', agentId: 'x' }, () => {}),
      /needs a workspaceId and an agentId/,
    )
    const foreignSend = await chats.send({ workspaceId: 'ws-app', agentId: 'person-chat' }, { message: 'hi' })
    assert.equal(!foreignSend.ok && foreignSend.code, 'not_owned')

    assert.deepEqual(await chats.send(ref, { message: 'And then?' }), { ok: true })
    assert.deepEqual(fake.services.conversations.get(ref)?.sent, ['And then?'])
    fake.services.conversations.failNextCreate('no_cli_selected')
    const refused = await chats.create({ workspaceId: 'ws-app' })
    assert.equal(!refused.ok && refused.code, 'no_cli_selected')
  })

  test('scheduled agents: owned, validated, fired, and a one-time schedule closes after its run', async () => {
    let clock = Date.parse('2026-10-09T10:00:00Z')
    const fake = createFakeMainHost({ moduleId: 'board', permissions: ['schedules:own'], now: () => clock })
    const scheduled = getScheduledAgentsService(fake.host)
    const changes: number[] = []
    scheduled.onChanged((agents) => changes.push(agents.length))
    const draft: ScheduledAgentDraft = {
      prompt: 'Standup',
      schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' },
      folderPath: ROOT,
      hostId: 'local',
      cli: 'claude',
      cliModel: null,
      permissionPreset: null,
      skills: [],
      mcpServers: [],
      worktree: null,
    }
    const created = await scheduled.create(draft)
    assert.ok(created.ok && created.agent.ownerModuleId === 'board')
    const past = await scheduled.create({ ...draft, schedule: { ...draft.schedule, once: clock - 1 } })
    assert.deepEqual(past, { ok: false, message: 'That time has already passed.' })
    const once = await scheduled.create({ ...draft, schedule: { ...draft.schedule, once: clock + 60_000 } })
    assert.ok(once.ok)
    clock += 60_000
    const run = fake.services.scheduledAgents.fire(once.agent.id)
    assert.ok(run.ok)
    assert.deepEqual(
      (await scheduled.list()).map((agent) => agent.id),
      [created.agent.id],
    )
    assert.deepEqual(changes, [1, 2, 1])
    assert.deepEqual(await scheduled.remove('scheduled-99'), {
      ok: false,
      message: 'No scheduled agent "scheduled-99".',
    })
  })

  test('secrets go only to their origins over https, and an echoed value comes back redacted', async () => {
    const fake = createFakeMainHost({ moduleId: 'radar', permissions: ['secrets:own'] })
    const secrets = getSecretsService(fake.host)
    const http = await secrets.set('token', 'abc', { allowedOrigins: ['http://api.example.com'] })
    assert.equal(!http.ok && http.code, 'origin_not_allowed')
    assert.deepEqual(await secrets.set('token', 'abc', { allowedOrigins: ['https://api.example.com'] }), { ok: true })
    assert.equal(await secrets.has('token'), true)
    fake.services.secrets.respond((request) => ({ status: 200, body: `you sent ${request.headers.Authorization}` }))
    const elsewhere = await secrets.fetchWithSecret('token', 'https://evil.example/x', {
      placement: { header: 'Authorization' },
    })
    assert.equal(!elsewhere.ok && elsewhere.code, 'origin_not_allowed')
    const sent = await secrets.fetchWithSecret('token', 'https://api.example.com/me', {
      placement: { header: 'Authorization', scheme: 'Bearer' },
    })
    assert.deepEqual(sent, { ok: true, status: 200, headers: {}, body: 'you sent Bearer [redacted]' })
    assert.equal(fake.services.secrets.requests[0]?.headers.Authorization, 'Bearer abc')
  })

  test('GitHub answers what was scripted, 404 otherwise, and not_signed_in when signed out', async () => {
    const fake = createFakeMainHost({ moduleId: 'radar', permissions: ['github:api'] })
    const github = getGitHubService(fake.host)
    fake.services.github.respond('GET', '/repos/{owner}/{repo}/pulls', { ok: true, status: 200, data: [{ number: 1 }] })
    assert.deepEqual(
      await github.request({ route: '/repos/{owner}/{repo}/pulls', params: { owner: 'acme', repo: 'app' } }),
      {
        ok: true,
        status: 200,
        data: [{ number: 1 }],
        headers: {},
      },
    )
    const unscripted = await github.request({ route: '/user' })
    assert.equal(!unscripted.ok && unscripted.status, 404)
    fake.services.github.setSignedIn(false)
    const signedOut = await github.request({ route: '/repos/{owner}/{repo}/pulls' })
    assert.equal(!signedOut.ok && signedOut.code, 'not_signed_in')
    assert.deepEqual(await github.status(), { signedIn: false })
  })

  test('companions attach once per id and retry an invalid structured answer', async () => {
    const fake = createFakeMainHost({ moduleId: 'review', permissions: ['agents:companion'] })
    const companions = getCompanionAgentsService(fake.host)
    const spec = { workspaceId: 'ws-app', agentId: 'guide', name: 'Guide', workspaceRoot: ROOT, systemPrompt: 'Help.' }
    const handle = await companions.attach(spec)
    assert.equal(await companions.attach(spec), handle)
    assert.equal(await handle.status(), 'absent', 'attach never spawns')
    fake.services.companions.respond(({ attempt }) => (attempt === 0 ? { wrong: true } : { score: 3 }))
    const score = await handle.runStructured({
      prompt: 'Rate it',
      validate: (raw) =>
        typeof (raw as { score?: unknown }).score === 'number'
          ? { ok: true, value: (raw as { score: number }).score }
          : { ok: false, errors: ['score must be a number'] },
    })
    assert.equal(score, 3)
    assert.equal(fake.services.companions.prompts.length, 2)
  })

  test('workspaces answer null before hydration, as after launch', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['workspace:read', 'workspace:operate'] })
    const context = fake.host.requireService(WorkspaceContextToken)
    fake.services.workspaces.setHydrated(false)
    assert.equal(await context.get('ws-app'), null)
    fake.services.workspaces.setHydrated(true)
    assert.equal((await context.get('ws-app'))?.folderPath, ROOT)
    const created = await fake.host
      .requireService(WorkspaceServiceToken)
      .create({ name: 'Docs', folderPath: '/Users/dev/docs' })
    assert.ok(created.ok)
    assert.equal((await context.list()).length, 2)
  })

  test('notify and emit are validated as the host validates them; hooks run in order', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['notifications:show'] })
    fake.host.notify({ severity: 'info', title: '  Saved  ' })
    assert.deepEqual(fake.notifications, [{ severity: 'info', title: 'Saved' }])
    assert.throws(() => fake.host.notify({ severity: 'loud' as never, title: 'x' }), /severity/)
    assert.throws(() => fake.host.emit(''), /needs a topic/)
    assert.throws(() => fake.host.emit('changed', { fn() {} }), /payload\.fn is a function, which JSON cannot carry/)
    assert.throws(() => fake.host.emit('changed', { at: new Date(0) }), /payload\.at is a Date/)
    fake.host.emit('changed', { id: 1 })
    assert.deepEqual(fake.emitted, [{ topic: 'changed', payload: { id: 1 } }])
    const order: string[] = []
    fake.host.onShutdown(() => void order.push('shutdown-1'))
    fake.host.onShutdown(() => void order.push('shutdown-2'))
    fake.host.onShutdownBegin(() => void order.push('begin'))
    fake.host.onStartup(() => void order.push('startup'))
    await fake.startup()
    await fake.shutdown()
    assert.deepEqual(order, ['startup', 'begin', 'shutdown-2', 'shutdown-1'])
  })
})

describe('createFakeMainHost: Backlog, usage and activity', () => {
  test('the Backlog checks backlog:read and backlog:operate, validates as the host does, and is shared with a frame', async () => {
    const main = createFakeMainHost({ moduleId: 'board', permissions: ['backlog:read'] })
    const backlog = getBacklogService(main.host)
    const refused = await backlog.create('ws-app', { title: 'Ship it' })
    assert.equal(!refused.ok && refused.code, 'not_permitted')
    main.permissions.add('backlog:operate')

    main.services.backlog.setKey('ws-app', 'MC')
    const created = await backlog.create('ws-app', { title: 'Ship it', body: 'Before Friday.', type: 'feature' })
    assert.ok(created.ok)
    assert.equal(created.id, 'backlog/ship-it.md')
    assert.equal(created.displayId, 'MC-1')
    assert.equal(created.path, `${ROOT}/backlog/ship-it.md`)
    const invalid = await backlog.create('ws-app', { title: 'x', type: 'chore' })
    assert.equal(!invalid.ok && invalid.code, 'invalid_input')
    const unknown = await backlog.create('nowhere', { title: 'x' })
    assert.equal(!unknown.ok && unknown.code, 'unknown_workspace')

    const studio = createFakeFrameStudio({ main }).studio({ point: 'panels', id: 'board', workspaceId: 'ws-app' })
    const fromFrame = await studio.host.call('backlog.create', {
      workspaceId: 'ws-app',
      input: { title: 'From a frame' },
    })
    assert.ok(fromFrame.ok && fromFrame.numericId === 2)
    assert.deepEqual(await backlog.updateStatus('ws-app', created.id, 'ready'), { ok: true })
    assert.equal((await backlog.updateStatus('ws-app', 'backlog/nope.md', 'ready')).ok, false)
    assert.deepEqual(
      await backlog.addLink('ws-app', created.id, {
        id: 'pr-1',
        type: 'review',
        label: 'PR #1',
        target: { kind: 'pull-request', id: '1' },
      }),
      { ok: true },
    )
    const foreign = await backlog.addLink('ws-app', created.id, {
      id: 'x',
      moduleId: 'someone-else',
      type: 'review',
      label: 'x',
      target: { kind: 'x', id: 'x' },
    })
    assert.equal(!foreign.ok && foreign.code, 'invalid_input')
    assert.deepEqual(await backlog.updateModuleMetadata('ws-app', created.id, { lane: 2 }), { ok: true })
    assert.deepEqual(await backlog.updateTriage('ws-app', created.id, { difficulty: 'm', risk: null }), { ok: true })

    const listed = await studio.host.call('backlog.list', { workspaceId: 'ws-app' })
    assert.ok(listed.ok)
    const [item] = listed.items.filter((entry) => entry.id === created.id)
    assert.equal(item?.status, 'ready')
    assert.equal(item?.difficulty, 'm')
    assert.deepEqual(item?.metadata, { board: { lane: 2 } })
    assert.equal(item?.links[0]?.moduleId, 'board', 'the host stamps the owner')
    assert.match(item?.sourceContent ?? '', /status: ready/)

    main.permissions.delete('backlog:read')
    await assert.rejects(studio.host.call('backlog.list', { workspaceId: 'ws-app' }), /approved for "backlog:read"/)
  })

  test('usage sums what was recorded over the window and the dimensions asked for, behind usage:read', async () => {
    const hour = Date.parse('2026-10-09T09:00:00Z')
    const main = createFakeMainHost({ moduleId: 'meter', permissions: [] })
    const usage = getUsageService(main.host)
    const refused = await usage.query({ from: hour, to: hour + 3_600_000 })
    assert.equal(!refused.ok && refused.code, 'not_permitted')
    assert.throws(() => usage.onChanged(() => {}), /approved for "usage:read"/)
    main.permissions.add('usage:read')

    let changes = 0
    usage.onChanged(() => (changes += 1))
    main.services.usage.record(
      { at: hour + 60_000, model: 'opus', tokens: { input: 10, output: 5 } },
      { at: hour + 120_000, model: 'opus', tokens: { input: 1 }, reportedCostUsd: 0.5 },
      { at: hour + 60_000, model: 'haiku', tokens: { output: 2 } },
      { at: hour + 7_200_000, model: 'opus', tokens: { input: 100 } },
    )
    assert.equal(changes, 1)
    const byModel = await usage.query({ from: hour, to: hour + 3_600_000, groupBy: ['model'] })
    assert.ok(byModel.ok)
    assert.deepEqual(
      byModel.rows.map((row) => [row.model, row.tokens.input + row.tokens.output, row.requests, row.reportedCostUsd]),
      [
        ['opus', 16, 2, 0.5],
        ['haiku', 2, 1, null],
      ],
    )
    const backwards = await usage.query({ from: hour, to: hour })
    assert.equal(!backwards.ok && backwards.code, 'invalid_input')
    const studio = createFakeFrameStudio({ main }).studio({ point: 'doors', id: 'meter' })
    const total = await studio.host.call('usage.query', { query: { from: hour, to: hour + 10_800_000 } })
    assert.ok(total.ok && total.rows.length === 1 && total.rows[0]?.tokens.input === 111)
  })

  test('activity lists the chats of open workspaces and the prompts in a window, newest kept', async () => {
    const main = createFakeMainHost({ moduleId: 'standup', permissions: ['conversation:read'] })
    const activity = getActivityService(main.host)
    main.services.activity.addChat({ workspaceId: 'ws-app', agentId: 'a1', title: 'Plan', updatedAt: 200 })
    main.services.activity.addChat({ workspaceId: 'ws-gone', agentId: 'a2', title: 'Closed' })
    for (const at of [100, 150, 300]) {
      main.services.activity.addPrompt({ at, workspaceId: 'ws-app', agentId: 'a1', text: `at ${at}` })
    }
    const chats = await activity.listChats()
    assert.ok(chats.ok)
    assert.deepEqual(
      chats.chats.map((chat) => chat.title),
      ['Plan'],
      'a chat in a workspace that is not open is not reachable',
    )
    const prompts = await activity.prompts({ from: 0, to: 250, limit: 1 })
    assert.ok(prompts.ok)
    assert.deepEqual(
      prompts.prompts.map((prompt) => prompt.text),
      ['at 150'],
    )
    assert.equal(prompts.truncated, true)
    const bad = await activity.prompts({ from: 0, to: 250, limit: 5000 })
    assert.equal(!bad.ok && bad.code, 'invalid_input')
    main.permissions.clear()
    const refused = await activity.listChats()
    assert.equal(!refused.ok && refused.code, 'not_permitted')
  })
})

describe('createFakeMainHost: settings, workspaces, storage, GitHub and skills', () => {
  test('storage lists by prefix, reads many at once, and its watch hears own writes and outside changes', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['storage:own'] })
    const storage = getModuleStorage(fake.host)
    const heard: string[][] = []
    const stop = storage.watch({ workspaceRoot: ROOT }, (change) => heard.push(change.keys))
    assert.throws(() => storage.watch({ workspaceRoot: 'relative' }, () => {}), /absolute path/)
    await storage.set({ key: 'decision.1', value: 'a', workspaceRoot: ROOT })
    await storage.set({ key: 'decision.2', value: 'b', workspaceRoot: ROOT })
    await storage.set({ key: 'index', value: [], workspaceRoot: ROOT })
    await storage.delete({ key: 'never-set', workspaceRoot: ROOT })
    await storage.set({ key: 'elsewhere', value: 1 })
    fake.services.storage.changeExternally('decision.3', 'c', ROOT)
    assert.deepEqual(heard, [['decision.1'], ['decision.2'], ['index'], ['decision.3']])
    stop()
    assert.deepEqual(await storage.list({ workspaceRoot: ROOT, prefix: 'decision.' }), {
      ok: true,
      keys: ['decision.1', 'decision.2', 'decision.3'],
    })
    assert.deepEqual(await storage.getMany({ keys: ['decision.1', 'missing'], workspaceRoot: ROOT }), {
      ok: true,
      values: { 'decision.1': 'a' },
    })
    const tooMany = await storage.getMany({ keys: Array.from({ length: 1001 }, (_, index) => `k${index}`) })
    assert.equal(!tooMany.ok && tooMany.code, 'invalid_key')
  })

  test('GitHub keeps the readable headers, answers 304 to a matching etag, refuses a mutation and downloads', async () => {
    const fake = createFakeMainHost({ moduleId: 'radar', permissions: ['github:api'] })
    const github = getGitHubService(fake.host)
    fake.services.github.respond('GET', '/repos/{owner}/{repo}/pulls', {
      ok: true,
      data: [],
      headers: { ETag: '"abc"', 'X-RateLimit-Remaining': '42', 'Content-Type': 'application/json' },
    })
    const first = await github.request({ route: '/repos/{owner}/{repo}/pulls' })
    assert.deepEqual(first, {
      ok: true,
      status: 200,
      data: [],
      headers: { etag: '"abc"', 'x-ratelimit-remaining': '42' },
    })
    const again = await github.request({ route: '/repos/{owner}/{repo}/pulls', ifNoneMatch: '"abc"' })
    assert.ok(again.ok && again.status === 304 && again.data === null)
    const badAccept = await github.request({ route: '/user', accept: 'text/html' as never })
    assert.equal(!badAccept.ok && badAccept.code, 'invalid_route')

    const mutation = await github.graphql('mutation { addStar(input: {}) { clientMutationId } }')
    assert.equal(!mutation.ok && mutation.code, 'invalid_query')
    assert.equal(fake.services.github.graphqlRequests.length, 0, 'a refused query is never sent')
    fake.services.github.respondGraphql(({ variables }) => ({ ok: true, data: { data: { viewer: variables } } }))
    const viewer = await github.graphql('query($login: String!) { user(login: $login) { name } }', { login: 'dev' })
    assert.ok(viewer.ok)
    assert.deepEqual(viewer.data, { data: { viewer: { login: 'dev' } } })

    fake.services.github.respondDownload('/repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
      ok: true,
      body: 'step 1\nstep 2',
      contentType: 'text/plain',
    })
    const logs = await github.download({ route: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs' })
    assert.ok(logs.ok && logs.data === 'step 1\nstep 2' && logs.encoding === 'utf8')
    const encoded = await github.download({
      route: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
      encoding: 'base64',
    })
    assert.ok(encoded.ok && Buffer.from(encoded.data, 'base64').toString('utf8') === 'step 1\nstep 2')
    const unscripted = await github.download({ route: '/repos/acme/app/zipball' })
    assert.equal(!unscripted.ok && unscripted.status, 404)
  })

  test('workspaces keep a closed history and answer git info, behind workspace:read', async () => {
    let clock = 1_000
    const main = createFakeMainHost({
      moduleId: 'vcs',
      permissions: [],
      now: () => clock,
      workspaces: [
        { id: 'ws-app', name: 'App', folderPath: ROOT, mode: 'standard' },
        { id: 'ws-docs', name: 'Docs', folderPath: '/Users/dev/projects/docs', mode: 'standard' },
      ],
    })
    const context = main.host.requireService(WorkspaceContextToken)
    await assert.rejects(context.list(), /approved for "workspace:read"/)
    const refused = await main.host.getWorkspaceGitInfo('ws-app')
    assert.equal(!refused.ok && refused.code, 'not_permitted')
    assert.deepEqual(main.undeclared.at(-1), { what: 'getWorkspaceGitInfo', needs: ['workspace:read'] })
    main.permissions.add('workspace:read')
    main.services.workspaces.close('ws-docs')
    clock = 2_000
    assert.deepEqual(await context.list(), [
      { id: 'ws-app', name: 'App', folderPath: ROOT, mode: 'standard', open: true },
    ])
    assert.deepEqual(
      (await context.list({ includeClosed: true })).map((entry) => [entry.id, entry.open, entry.closedAt]),
      [
        ['ws-app', true, undefined],
        ['ws-docs', false, 1_000],
      ],
    )

    const plain = await main.host.getWorkspaceGitInfo('ws-app')
    assert.equal(!plain.ok && plain.code, 'not_a_repository')
    main.services.workspaces.setGitInfo('ws-app', {
      branch: 'main',
      remotes: [{ name: 'origin', url: 'git@github.com:acme/app.git', github: 'acme/app' }],
    })
    const info = await main.host.getWorkspaceGitInfo('ws-app')
    assert.ok(info.ok && info.branch === 'main' && info.remotes[0]?.github === 'acme/app')
    const closed = await main.host.getWorkspaceGitInfo('ws-docs')
    assert.equal(!closed.ok && closed.code, 'unknown_workspace')
  })

  test('Settings values are a frame’s to set and the worker’s to read; a data dir, asset paths and skill status', async () => {
    const fake = createFakeMainHost({
      moduleId: 'pulse',
      permissions: ['storage:own', 'settings:own', 'workspace:read', 'workspace:operate'],
      appState: { pollMinutes: 15 },
    })
    assert.equal(await fake.host.getModuleAppState('pollMinutes'), 15)
    const heard: unknown[] = []
    fake.host.watchModuleAppState((values) => heard.push(values.pollMinutes))
    assert.deepEqual(heard, [], 'main hears changes, not the current value')
    const studio = createFakeFrameStudio({ main: fake }).studio({ point: 'settingsSections', id: 'pulse' })
    await studio.host.call('settings.set', { key: 'pollMinutes', value: 5 })
    fake.setAppState('pollMinutes', 30)
    assert.deepEqual(heard, [5, 30])
    assert.deepEqual(await studio.host.call('settings.get', {}), { pollMinutes: 30 })

    const dir = fake.host.getModuleDataDir()
    assert.ok(existsSync(dir) && dir.endsWith('pulse'))
    assert.equal(fake.host.getModuleDataDir(), dir)
    fake.dispose()
    assert.equal(existsSync(dir), false, 'dispose removes the temporary folder')
    assert.throws(
      () =>
        createFakeMainHost({
          moduleId: 'pulse',
          permissions: ['storage:own'],
          services: { 'core.module-storage': null },
        }).host.getModuleDataDir(),
      /no storage service is provided/,
    )

    const root = join(process.cwd(), 'packages', 'extension-sdk')
    const assets = createFakeMainHost({ moduleId: 'pulse', moduleRoot: root, verifiedFiles: ['package.json'] })
    assert.equal(assets.host.getAssetPath('package.json'), join(root, 'package.json'))
    assert.throws(() => assets.host.getAssetPath('README.md'), /not among module "pulse"'s verified files/)
    assert.throws(() => assets.host.getAssetPath('../package.json'), /module-relative file path/)

    const skilled = createFakeMainHost({
      moduleId: 'pulse',
      permissions: ['workspace:read', 'workspace:operate'],
      builtinSkills: ['pulse-guide'],
    })
    assert.deepEqual(await skilled.host.getSkillStatus(ROOT, 'pulse-guide'), { ok: false, status: 'missing' })
    assert.deepEqual(await skilled.host.ensureSkillInstalled(ROOT, 'pulse-guide'), { ok: true, status: 'installed' })
    assert.deepEqual(await skilled.host.getSkillStatus(ROOT, 'pulse-guide'), { ok: true, status: 'installed' })
    skilled.skills.setStatus(ROOT, 'pulse-guide', 'update-available')
    assert.deepEqual(await skilled.host.ensureSkillInstalled(ROOT, 'pulse-guide'), { ok: true, status: 'updated' })
    skilled.skills.setStatus(ROOT, 'pulse-guide', 'modified')
    assert.deepEqual(await skilled.host.ensureSkillInstalled(ROOT, 'pulse-guide'), { ok: true, status: 'modified' })
    assert.equal((await skilled.host.getSkillStatus(ROOT, 'nobody')).status, 'unknown-skill')
  })

  test('notify keeps a valid target, refuses a malformed one and clips as the host clips', () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['notifications:show'] })
    fake.host.notify({ severity: 'info', title: 'x'.repeat(250), target: { surfaceId: ' notes ', viewId: 'inbox' } })
    assert.equal(fake.notifications[0]?.title.length, 200)
    assert.deepEqual(fake.notifications[0]?.target, { surfaceId: 'notes', viewId: 'inbox' })
    assert.throws(() => fake.host.notify({ severity: 'info', title: 'x', target: { surfaceId: '' } }), /surfaceId/)
  })

  test('the fakes support every capability HostCapability names', () => {
    const source = readFileSync(join(process.cwd(), 'packages', 'extension-sdk', 'src', 'host-api.ts'), 'utf8')
    const union = source.slice(source.indexOf('export type HostCapability'))
    const named = [...union.matchAll(/^\s*\|\s*'([^']+)'/gm)].map((match) => match[1]!)
    assert.ok(named.length > 30, `found only ${named.length} capabilities; is the scan broken?`)
    const main = createFakeMainHost({ moduleId: 'probe' }).host
    assert.deepEqual(
      named.filter((capability) => !main.supports(capability)),
      [],
      'add the capability to KNOWN_CAPABILITIES in testing.ts (and fake what it gates)',
    )
  })
})

describe('createFakeMainHost: agents, conversations and scheduled agents', () => {
  test('text generation needs agents:generate, answers what was scripted, and refuses as the host does', async () => {
    const fake = createFakeMainHost({ moduleId: 'digest', permissions: [] })
    const text = getTextGenerationService(fake.host)
    const refused = await text.generate({ prompt: 'Summarise' })
    assert.equal(!refused.ok && refused.code, 'not_permitted')
    fake.permissions.add('agents:generate')

    const unscripted = await text.generate({ prompt: 'Summarise' })
    assert.equal(!unscripted.ok && unscripted.code, 'invalid_output')
    fake.services.textGeneration.respond(({ input, cli }) =>
      input.json ? 'Here you go:\n```json\n{"score": 3}\n```' : { text: `on ${cli}`, usage: { outputTokens: 4 } },
    )
    assert.deepEqual(await text.generate({ prompt: 'Summarise' }), {
      ok: true,
      text: 'on claude-code',
      usage: { outputTokens: 4 },
      model: 'claude-haiku-5-5',
    })
    const codex = await text.generate({ prompt: 'Summarise', cli: 'codex' })
    assert.ok(codex.ok && codex.model === 'gpt-5.6-luna' && codex.text === 'on codex')
    const json = await text.generate({ prompt: 'Rate it', json: true })
    assert.ok(json.ok && json.text === '{"score":3}')
    const cursor = await text.generate({ prompt: 'x', cli: 'cursor' })
    assert.equal(!cursor.ok && cursor.code, 'unsupported')
    const tooLong = await text.generate({ prompt: 'x', maxOutputTokens: 64_001 })
    assert.equal(!tooLong.ok && tooLong.code, 'invalid_input')

    // Two run, eight wait, and the eleventh is told the lane is full.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    fake.services.textGeneration.respond(async () => {
      await held
      return 'done'
    })
    const pending = Array.from({ length: 10 }, () => text.generate({ prompt: 'wait' }))
    const busy = await text.generate({ prompt: 'one more' })
    assert.equal(!busy.ok && busy.code, 'busy')
    release()
    assert.ok((await Promise.all(pending)).every((answer) => answer.ok))
    assert.equal(fake.services.textGeneration.calls.at(-1)?.input.prompt, 'wait')
  })

  test('companion runs deny tools by default, refuse auto without conversation:bypass, and leave ask to the person', async () => {
    const fake = createFakeMainHost({ moduleId: 'review', permissions: ['agents:companion'] })
    const handle = await getCompanionAgentsService(fake.host).attach({
      workspaceId: 'ws-app',
      agentId: 'guide',
      name: 'Guide',
      workspaceRoot: ROOT,
      systemPrompt: 'Help.',
    })
    const companions = fake.services.companions
    const validate = (raw: unknown) => ({ ok: true as const, value: raw })

    companions.respond(async ({ tools }) => ({ tools, asked: await companions.requestApproval('ws-app', 'guide') }))
    assert.deepEqual(await handle.runStructured({ prompt: 'Read the log', validate }), { tools: 'none', asked: 'deny' })
    assert.match(companions.prompts[0]?.prompt ?? '', /You have no tools for this task/)
    await assert.rejects(
      handle.runStructured({ prompt: 'Fix it', validate, tools: 'auto' }),
      /approved for "conversation:bypass"/,
    )
    fake.permissions.add('conversation:bypass')
    assert.deepEqual(await handle.runStructured({ prompt: 'Fix it', validate, tools: 'auto' }), {
      tools: 'auto',
      asked: 'once',
    })

    // `ask`: the request reaches onEvent and waits for the person's answer.
    handle.onEvent((event) => {
      if (event.type !== 'approval_requested') return
      const requestId = String(event.payload?.requestId)
      void handle.respondToApproval({ requestId, decision: 'once' }).then(async (allowed) => {
        assert.match(allowed.ok ? '' : allowed.message, /approved for "conversation:own"/)
        await handle.respondToApproval({ requestId, decision: 'deny' })
      })
    })
    assert.deepEqual(await handle.runStructured({ prompt: 'Ask first', validate, tools: 'ask' }), {
      tools: 'ask',
      asked: 'deny',
    })
    assert.deepEqual(await handle.respondToApproval({ requestId: 'nope', decision: 'deny' }), {
      ok: false,
      message: 'No approval request "nope" is waiting on this companion.',
    })
    assert.deepEqual(
      companions.approvals.map((approval) => [approval.decision, approval.by]),
      [
        ['deny', 'host'],
        ['once', 'host'],
        ['deny', 'module'],
      ],
    )
  })

  test('conversations: reply reads a turn’s text, a worktree chat gets a workspace of its own, and a follow waits for a chat', async () => {
    const fake = createFakeMainHost({ moduleId: 'board', permissions: ['conversation:own'] })
    const chats = getConversationService(fake.host)
    const created = await chats.create({ workspaceId: 'ws-app', prompt: 'Plan it' })
    assert.ok(created.ok)
    const ref = { workspaceId: created.conversation.workspaceId, agentId: created.conversation.agentId }
    assert.equal(created.conversation.cli, 'claude-code')
    const none = await chats.reply(ref)
    assert.equal(!none.ok && none.code, 'no_reply')
    fake.services.conversations.emitEvent(ref, { type: 'turn_started' })
    fake.services.conversations.emitEvent(ref, { type: 'content_delta', payload: { text: 'Thinking… ' } })
    const done = fake.services.conversations.emitEvent(ref, {
      type: 'turn_completed',
      payload: { text: 'Ship Friday.', usage: { inputTokens: 10, outputTokens: 3 } },
    })
    const turnId = String(done.payload?.turnId)
    assert.deepEqual(await chats.reply(ref), { ok: true, turnId, text: 'Ship Friday.' })
    const unknownTurn = await chats.reply(ref, 'turn-99')
    assert.equal(!unknownTurn.ok && unknownTurn.code, 'no_reply')

    const notRepo = await chats.create({ workspaceId: 'ws-app', worktree: { name: 'fix-ci' } })
    assert.equal(!notRepo.ok && notRepo.code, 'worktree_unavailable')
    fake.services.workspaces.setGitInfo('ws-app', { branch: 'main', remotes: [] })
    const isolated = await chats.create({ workspaceId: 'ws-app', worktree: { name: 'fix-ci' } })
    assert.ok(isolated.ok && isolated.conversation.workspaceId !== 'ws-app')
    fake.permissions.add('workspace:read')
    const git = await fake.host.getWorkspaceGitInfo(isolated.conversation.workspaceId)
    assert.ok(git.ok && git.branch?.startsWith('agent/fix-ci-'))

    // At launch a saved chat's workspace may not be loaded yet.
    const saved = { workspaceId: 'ws-app', agentId: 'saved-chat' }
    const frames: string[] = []
    const events: string[] = []
    chats.follow(saved, undefined, (frame) => frames.push(frame.type))
    chats.subscribe(saved, (event) => events.push(event.type))
    assert.deepEqual(frames, [])
    fake.services.conversations.restore({ ...saved, events: [{ type: 'user_message', payload: { text: 'Hi' } }] })
    fake.services.conversations.emitEvent(saved, { type: 'turn_started' })
    assert.deepEqual(frames, ['snapshot', 'synchronized', 'event'])
    assert.deepEqual(events, ['turn_started'])
  })

  test('scheduled agents carry name and tag, a run starts a chat the module owns, and onRun hears it', async () => {
    let clock = Date.parse('2026-10-09T10:00:00Z')
    const fake = createFakeMainHost({
      moduleId: 'board',
      permissions: ['schedules:own', 'conversation:own'],
      now: () => clock,
    })
    const scheduled = getScheduledAgentsService(fake.host)
    const draft: ScheduledAgentDraft = {
      name: 'Standup',
      tag: 'card-42',
      prompt: 'Write the standup',
      schedule: { cron: '0 9 * * 1-5', timezone: 'UTC', once: clock + 60_000 },
      folderPath: ROOT,
      hostId: 'local',
      cli: 'claude-code',
      cliModel: null,
      permissionPreset: null,
      skills: [],
      mcpServers: [],
      worktree: null,
    }
    const tooLong = await scheduled.create({ ...draft, tag: 'x'.repeat(201) })
    assert.equal(tooLong.ok, false)
    const created = await scheduled.create(draft)
    assert.ok(created.ok && created.agent.name === 'Standup' && created.agent.tag === 'card-42')
    const { name: _name, ...unnamed } = draft
    const kept = await scheduled.update(created.agent.id, unnamed)
    assert.ok(kept.ok && kept.agent.name === 'Standup', 'a draft without a name keeps the one there')

    const runs: Array<[string | undefined, string]> = []
    scheduled.onRun((agent, run) => runs.push([agent.tag, run.agentId]))
    clock += 60_000
    const lastRun = fake.services.scheduledAgents.fire(created.agent.id)
    assert.ok(lastRun.ok && lastRun.agentId)
    assert.deepEqual(runs, [['card-42', lastRun.agentId]], 'a one-time schedule is heard before it closes')
    const [chat] = await getConversationService(fake.host).list({ workspaceId: lastRun.workspaceId })
    assert.equal(chat?.scheduledAgentId, created.agent.id)
    assert.equal(chat?.scheduledAgentTag, 'card-42')
    assert.deepEqual(await scheduled.list(), [])
  })

  test('listChatRuntimes answers runtime ids, and the test can change them', async () => {
    const fake = createFakeMainHost({ moduleId: 'board', permissions: ['providers:read'] })
    assert.deepEqual(
      (await fake.host.listChatRuntimes()).map((runtime) => runtime.id),
      ['claude-code', 'codex'],
    )
    fake.setChatRuntimes([{ id: 'codex', label: 'Codex', available: true, models: [], lastSelected: true }])
    assert.equal((await fake.host.listChatRuntimes())[0]?.id, 'codex')
  })
})

describe('createFakeFrameStudio', () => {
  const surface = { point: 'doors', id: 'notes' } as const

  test('a mount draws into the root it is given, says ready once, and its cleanup is handed back', async () => {
    const frame = createFakeFrameStudio({ manifest: { id: 'notes' } })
    const drawn: string[] = []
    const close = await frame.mount(
      {
        mount: (root, studio) => {
          drawn.push(String(root))
          studio.ready()
          studio.ready()
          return () => drawn.push('closed')
        },
      },
      surface,
      'root' as unknown as HTMLElement,
    )
    assert.deepEqual(frame.readied, [surface])
    close()
    assert.deepEqual(drawn, ['root', 'closed'])
  })

  test('a call the manifest’s permissions do not cover is refused as Studio refuses it, and reported', async () => {
    const frame = createFakeFrameStudio({ manifest: { id: 'notes', permissions: ['workspace:read'] } })
    const studio = frame.studio(surface)
    assert.equal((await studio.host.call('workspace.list', {})).length, 1)
    await assert.rejects(
      studio.host.call('files.read', { workspaceId: 'ws-app', path: 'a.md' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'not_permitted')
        return true
      },
    )
    assert.deepEqual(frame.undeclared, [{ what: 'files.read', needs: ['workspace-files:read'] }])
    await assert.rejects(studio.host.call('shell.run' as never, {} as never), /not a host method/)
    assert.equal(studio.host.has('files.read'), true)
    assert.equal(studio.host.has('shell.run'), false)
  })

  test('whoever opened the surface is held to what they hold themselves', async () => {
    const frame = createFakeFrameStudio({
      manifest: { id: 'notes', permissions: ['workspace-files:write'] },
      invoker: ['extension:read', 'filesystem:read'],
      files: { 'ws-app': { 'notes.md': 'hi' } },
    })
    await assert.rejects(
      frame.studio(surface).host.call('files.write', { workspaceId: 'ws-app', path: 'notes.md', content: 'x' }),
      /filesystem:write/,
    )
    assert.equal(frame.file('ws-app', 'notes.md'), 'hi')
  })

  test('files stay inside the workspace; a create refuses a file that exists', async () => {
    const frame = createFakeFrameStudio({
      manifest: { id: 'notes', permissions: ['workspace-files:read', 'workspace-files:write'] },
      files: { 'ws-app': { 'docs/a.md': 'A' } },
    })
    const studio = frame.studio(surface)
    assert.deepEqual(await studio.host.call('files.read', { workspaceId: 'ws-app', path: 'docs/a.md' }), {
      content: 'A',
      size: 1,
      sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
    })
    await assert.rejects(
      studio.host.call('files.read', { workspaceId: 'ws-app', path: '../x' }),
      /inside the workspace/,
    )
    assert.deepEqual(await studio.host.call('files.search', { workspaceId: 'ws-app', query: 'A.MD' }), {
      paths: ['docs/a.md'],
      truncated: false,
    })
    await assert.rejects(
      studio.host.call('files.write', { workspaceId: 'ws-app', path: 'docs/a.md', content: 'B', create: true }),
      /already exists/,
    )
    await studio.host.call('files.write', { workspaceId: 'ws-app', path: 'docs/a.md', content: 'B' })
    assert.equal(frame.file('ws-app', 'docs/a.md'), 'B')
  })

  test('the worker’s methods, its events, toasts, drafts and doors', async () => {
    const main = createFakeMainHost({ moduleId: 'local.notes', permissions: ['chat:draft'] })
    main.host.registerMethods({
      count: {
        access: 'read',
        params: (value) => ({ ok: true, params: value }),
        handler: async () => ({ ok: true, result: 3 }),
      },
    })
    const frame = createFakeFrameStudio({
      main,
      manifest: { id: 'notes', permissions: ['chat:draft'], contributes: { doors: [{ id: 'board' }] } },
    })
    const studio = frame.studio(surface)
    assert.deepEqual(await studio.methods().read('count', {}), { ok: true, result: 3 })
    const unknown = await studio.methods().read('nope', {})
    assert.equal(unknown.ok, false)
    const pushes: unknown[] = []
    studio.on('push', (push) => pushes.push(push))
    main.host.emit('changed', { n: 1 })
    assert.deepEqual(pushes, [{ topic: 'changed', payload: { n: 1 } }])
    await studio.host.call('toast', { tone: 'good', message: 'Saved' })
    await studio.host.call('chat.draft', { workspaceId: 'ws-app', prompt: 'Look at this' })
    assert.deepEqual(await studio.host.call('doors.open', { id: 'board' }), { opened: true })
    assert.deepEqual(await studio.host.call('doors.open', { id: 'elsewhere' }), { opened: false })
    assert.deepEqual(frame.toasts, [{ tone: 'good', message: 'Saved' }])
    assert.deepEqual(frame.drafts, [{ workspaceId: 'ws-app', prompt: 'Look at this' }])
    const themes: unknown[] = []
    studio.on('theme', (theme) => themes.push(theme))
    frame.setColorScheme('dark')
    assert.deepEqual(themes, [{ colorScheme: 'dark' }])
    assert.equal(studio.theme.colorScheme, 'dark')
  })

  test('renderToHtml draws a React surface in Node, and a component that throws fails it', async () => {
    assert.equal(await renderToHtml(createElement('p', null, 'Hello ', 'there')), '<p>Hello there</p>')
    const Broken = () => {
      throw new Error('broken surface')
    }
    await assert.rejects(renderToHtml(createElement(Broken)), /broken surface/)
  })
})
