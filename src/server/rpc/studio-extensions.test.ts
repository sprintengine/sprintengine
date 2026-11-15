import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import {
  STUDIO_EXTENSIONS_METHODS,
  STUDIO_METHOD_ACCESS,
  type HostedCardFeedReadResult,
  type StudioScope,
} from '../../../packages/studio-protocol/src/public'
import type { StudioExtensions } from '../extensions/extensions-domain'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// The extensions family over the owner socket, under an owner's grant and a
// pairing given every scope: what fetches, approves, installs or removes code
// and what writes a new project here is an owner's; the rest reaches a client
// by its scope. An install is carried out once per command id. The domain is a
// stub; what it decides is studio-marketplace.test.ts's and the scaffold's.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Method = keyof typeof STUDIO_EXTENSIONS_METHODS

/** Each method with params its validator takes. */
const CALLS: Record<Method, Record<string, unknown>> = {
  'marketplace.read': {},
  'marketplace.updateStates': { forceRefresh: true },
  'marketplace.verify': { id: 'pr-radar' },
  'marketplace.install': { commandId: 'c-install', id: 'pr-radar', trustToken: 't' },
  'marketplace.update': { commandId: 'c-update', id: 'pr-radar' },
  'marketplace.uninstall': { commandId: 'c-uninstall', pluginId: 'pr-radar' },
  'marketplace.resolveGithub': { url: 'https://github.com/acme/notes-ext' },
  'marketplace.installGithub': { commandId: 'c-github', trustToken: 't', trustCode: true },
  'cliPlugins.list': {},
  'cliPlugins.availability': {},
  'cliPlugins.launchPreview': { cli: 'codex' },
  'studioPlugin.status': { workspaceFolder: null },
  'extensionScaffold.home': {},
  'extensionScaffold.target': { id: 'pr-radar' },
  'extensionScaffold.create': { commandId: 'c-create', id: 'pr-radar' },
  'cardFeed.get': {},
  'sourcesFeed.get': {},
}

function stub() {
  const asked: Array<[string, unknown]> = []
  const cardListeners = new Set<(result: HostedCardFeedReadResult) => void>()
  const failed = { ok: false as const, message: 'stub' }
  const note =
    <R>(name: string, answer: R) =>
    async (input?: unknown) => {
      asked.push([name, input])
      return answer
    }
  const extensions: StudioExtensions = {
    marketplace: {
      read: note('read', { ok: false, state: 'offline', registryUrl: '', stale: false, message: 'stub' }) as never,
      updateStates: note('updateStates', failed),
      verify: note('verify', { classification: 'invalid', permissions: [], sourceUrl: '' }),
      install: note('install', failed),
      update: note('update', failed),
      uninstall: note('uninstall', failed),
      resolveGithub: note('resolveGithub', failed),
      installGithub: note('installGithub', failed),
      cardMarketplace: {} as never,
    },
    scaffold: {
      home: () => '/Users/dev/Documents/SprintEngine/Extensions',
      target: () => ({ state: 'free', folder: '/Users/dev/Documents/SprintEngine/Extensions/pr-radar' }),
      create: note('create', { ok: true, folder: '/Users/dev/x', existing: false }),
    } as never,
    feeds: {
      cardFeed: async () => ({ ok: false, state: 'offline', feedUrl: '', message: 'stub' }),
      sourcesFeed: async () => ({ ok: false, state: 'offline', feedUrl: '', message: 'stub' }),
      refresh: async () => undefined,
      onCardFeedChanged: (listener) => {
        cardListeners.add(listener)
        return () => void cardListeners.delete(listener)
      },
    },
    cliPlugins: () => ({ ok: true, plugins: [] }),
    cliAvailability: note('availability', { ok: true, availability: {} }),
    launchPreview: () => ({ ok: false, message: 'stub' }),
    studioPluginStatus: (workspaceRoot) => {
      asked.push(['studioPluginStatus', workspaceRoot])
      return Promise.resolve({
        bundledVersion: '1',
        installedVersion: '',
        skillDirNames: [],
        claudePluginKey: '',
        hooksAcknowledgedAt: '',
      })
    },
    cardFeed: async () => ({ ok: false, state: 'offline', feedUrl: '', message: 'stub' }),
    sourcesFeed: async () => ({ ok: false, state: 'offline', feedUrl: '', message: 'stub' }),
  }
  const changed = (result: HostedCardFeedReadResult) => cardListeners.forEach((listener) => listener(result))
  return { extensions, asked, changed }
}

async function serve(withExtensions = true) {
  const domain = stub()
  const started = await startTestServer(withExtensions ? { extensions: domain.extensions } : {})
  cleanups.push(() => started.dispose())
  return { started, ...domain }
}

async function client(path: string, token: string) {
  const line = await connectLineClient(path)
  cleanups.push(() => line.close())
  line.send(hello({ token }))
  const welcome = await line.next((frame) => frame.t === 'welcome')
  let seq = 0
  return {
    line,
    welcome,
    async request(method: string, params: unknown) {
      const id = `r${++seq}`
      line.send({ t: 'req', id, method, params })
      return line.next((frame) => frame.t === 'res' && frame.id === id)
    },
    async subscribe(topic: string, params: unknown = {}) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params })
      return id
    },
  }
}

const codeOf = (frame: { t: string; ok?: boolean; error?: { code: string } }) =>
  frame.t === 'res' && !frame.ok ? (frame.error?.code ?? null) : null

test('every method of the family has a call here', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_EXTENSIONS_METHODS).sort())
})

test('a Studio advertises extensions only where it holds them, and refuses them otherwise', async () => {
  const none = await serve(false)
  const owner = await client(none.started.path, OWNER_TOKEN)
  const advertised = owner.welcome.t === 'welcome' ? owner.welcome.capabilities : []
  assert.equal(advertised.includes('extensions'), false)
  assert.equal(codeOf(await owner.request('marketplace.read', {})), 'unavailable')

  const held = await serve()
  const window = await client(held.started.path, OWNER_TOKEN)
  assert.ok(window.welcome.t === 'welcome' && window.welcome.capabilities.includes('extensions'))
})

test('an owner reaches every method; an install under one command id is carried out once', async () => {
  const { started, asked } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, codeOf(await owner.request(method, params))], [method, null])
  const before = asked.filter(([name]) => name === 'install').length
  await owner.request('marketplace.install', CALLS['marketplace.install'])
  assert.equal(asked.filter(([name]) => name === 'install').length, before, 'a retry is answered from the first')
  assert.deepEqual(
    asked.find(([name]) => name === 'install'),
    ['install', { id: 'pr-radar', trustToken: 't' }],
    'the domain is handed the install without the command id',
  )
})

test('a pairing given every scope reaches the reads, and is refused what installs or writes code here', async () => {
  const { started, asked } = await serve()
  const scopes: StudioScope[] = [
    'providers:read',
    'files:read',
    'files:write',
    'environment:maintain',
    'settings:write',
    'modules:read',
    'modules:operate',
  ]
  const app = await client(started.path, pairFakeClient(started.auth, 'app', scopes))
  for (const [method, params] of Object.entries(CALLS)) {
    const access = STUDIO_METHOD_ACCESS[method as Method]
    const expected = 'permissions' in access && access.owner !== undefined ? 'owner_required' : null
    assert.deepEqual([method, codeOf(await app.request(method, params))], [method, expected])
  }
  assert.equal(
    asked.some(([name]) =>
      ['verify', 'install', 'update', 'uninstall', 'resolveGithub', 'installGithub', 'create'].includes(name),
    ),
    false,
    'nothing an owner’s reached the domain',
  )
  // Studio's plugin is read only in a folder Studio knows, for a client that is not an owner.
  assert.equal(
    codeOf(await app.request('studioPlugin.status', { workspaceFolder: '/Users/dev/elsewhere' })),
    'not_found',
  )
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  assert.equal(codeOf(await reader.request('marketplace.read', {})), 'scope_required')
})

test('a project is made on this Studio’s own disk: a folder on an SSH machine is answered in words', async () => {
  const { started, asked } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const made = await owner.request('extensionScaffold.create', {
    commandId: 'c-ssh',
    id: 'pr-radar',
    parentDir: 'ssh://build-box/home/dev',
  })
  assert.equal(made.t === 'res' && made.ok && (made.result as { code?: string }).code, 'no_parent')
  const target = await owner.request('extensionScaffold.target', { id: 'pr-radar', folder: 'ssh://build-box/x' })
  assert.deepEqual(target.t === 'res' && target.ok && target.result, { target: null })
  assert.equal(
    asked.some(([name]) => name === 'create'),
    false,
  )
})

test('a follower of the card feed hears each read that changed it', async () => {
  const { started, changed } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const sub = await owner.subscribe('cardFeed.changed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  changed({ ok: false, state: 'offline', feedUrl: 'https://example.invalid/cards.json', message: 'changed' })
  const pushed = await owner.line.next((frame) => frame.t === 'push' && frame.sub === sub)
  assert.equal(pushed.t === 'push' && (pushed.payload as { message: string }).message, 'changed')
})
