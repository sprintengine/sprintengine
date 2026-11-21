import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { ExtensionManifestView, ThirdPartyRendererEntriesResult } from '../../../shared/modules/manifest'
import type { AppNotification } from '../../../shared/workspace'
import { setAppCommandRunner } from '../commands/appCommandRunner'
import { getExtensionPanels, getExtensionSurface } from './extension-surfaces'
import { createRendererHost, type ModuleMethodCall, type RendererKernel } from './renderer-host'
import {
  getThirdPartyRendererLoadState,
  loadThirdPartyRendererEntries,
  rendererEntriesForRefresh,
  type ThirdPartyEntryImporter,
} from './third-party-loader'

// The loader is the execution boundary for an extension's window code: it
// evaluates each `entry` a panel, door or settings section names, requires a
// `mount`, and registers what extension.json declares through the
// extension's scoped host, under ids its install key prefixes. One broken
// extension never blocks its neighbours, and only one that loaded cleanly
// joins the enablement universe. Bundle evaluation itself (a blob URL import)
// runs in the real app; here the importer is injected, and a bundle's "code"
// is the name of the exports the importer hands back.
//
// The loader keeps one load state per install key for the window's session,
// so every test uses keys of its own.

type Contributes = ExtensionManifestView['contributes']

function extension(id: string, contributes: Partial<Contributes> = {}, over: Partial<ExtensionManifestView> = {}) {
  return {
    manifestVersion: 1 as const,
    id,
    version: '1.0.0',
    engines: { studio: '>=0.13.0' },
    tier: 'ui' as const,
    name: `Ext ${id}`,
    permissions: [],
    contributes: {
      commands: [],
      menus: [],
      topBarItems: [],
      panels: [],
      doors: [],
      settingsSections: [],
      mcpTools: [],
      ...contributes,
    },
    ...over,
  }
}

function served(
  entries: Array<{
    key: string
    manifestId?: string
    contributes?: Partial<Contributes>
    over?: Partial<ExtensionManifestView>
    entries?: Record<string, string>
    assetOrigin?: string
  }>,
  failures: Record<string, string> = {},
): ThirdPartyRendererEntriesResult {
  return {
    entries: entries.map((entry) => {
      const id = entry.key.slice(entry.key.indexOf('.') + 1)
      return {
        id: entry.key,
        manifest: {
          id: entry.manifestId ?? entry.key,
          displayName: `Ext ${id}`,
          version: '1.0.0',
          defaultEnabled: true,
          source: 'third-party',
        },
        extension: extension(id, entry.contributes, entry.over),
        entries: entry.entries ?? {},
        ...(entry.assetOrigin ? { assetOrigin: entry.assetOrigin } : {}),
      }
    }),
    failures,
  }
}

const mount = () => undefined

/** The importer: a bundle's code names its exports in `bundles`; an Error is thrown at import. */
const importerFor =
  (bundles: Record<string, unknown>): ThirdPartyEntryImporter =>
  async (code) => {
    if (!(code in bundles)) throw new Error(`Unexpected import of "${code}"`)
    const value = bundles[code]
    if (value instanceof Error) throw value
    return value
  }

let stopRunner: (() => void) | null = null
afterEach(() => {
  stopRunner?.()
  stopRunner = null
})

/** A kernel whose method calls and toasts are recorded. */
function recordingKernel(answer: { ok: true; value: unknown } | { ok: false; code: 'failed'; message: string }) {
  const kernel = createRendererHost()
  const calls: ModuleMethodCall[] = []
  const toasts: string[] = []
  kernel.setModuleMethodCaller(async (call) => {
    calls.push(call)
    return answer as never
  })
  kernel.setToastSink((input) => {
    toasts.push(input.message)
    return () => undefined
  })
  return { kernel, calls, toasts }
}

test('an extension’s surfaces register under its install key, each drawn by the mount its entry exports', async () => {
  const kernel = createRendererHost()
  const panelMount = () => undefined
  const doorMount = () => undefined
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.notes',
        assetOrigin: 'studio-module://' + 'a'.repeat(64),
        contributes: {
          panels: [{ id: 'notes', title: 'Notes', icon: 'notes', entry: 'dist/panel.js' }],
          doors: [{ id: 'board', title: 'Board', entry: 'dist/door.js' }],
          settingsSections: [{ id: 'prefs', title: 'Notes', entry: 'dist/panel.js' }],
          commands: [{ id: 'notes.open', title: 'Open Backlog', action: 'panel.backlog.toggle' }],
          topBarItems: [
            { id: 'open-board', title: 'Open the board', door: 'board' },
            { id: 'run', title: 'Open Backlog', command: 'notes.open' },
          ],
        },
        entries: { 'dist/panel.js': 'panel', 'dist/door.js': 'door' },
      },
    ]),
    importerFor({ panel: { mount: panelMount }, door: { mount: doorMount } }),
  )
  assert.deepEqual(
    loaded.map((manifest) => manifest.id),
    ['acme.notes'],
  )
  assert.deepEqual(getThirdPartyRendererLoadState('acme.notes'), { status: 'loaded' })

  assert.equal(getExtensionSurface('acme.notes', 'panels', 'notes')?.mount, panelMount)
  assert.equal(getExtensionSurface('acme.notes', 'doors', 'board')?.mount, doorMount)
  assert.equal(getExtensionSurface('acme.notes', 'settingsSections', 'prefs')?.mount, panelMount)
  assert.ok(getExtensionPanels().some((surface) => surface.key === 'acme.notes'))
  assert.equal(
    getExtensionPanels((moduleId) => moduleId !== 'acme.notes').some((surface) => surface.key === 'acme.notes'),
    false,
    'a panel of an extension that is off is not offered',
  )

  const door = kernel.getGlobalSurface('acme.notes:board')
  assert.equal(door?.moduleId, 'acme.notes')
  assert.equal(door?.label, 'Board')
  const section = kernel.getSettingsSections().find((candidate) => candidate.id === 'acme.notes:prefs')
  assert.equal(section?.moduleId, 'acme.notes')
  assert.equal(section?.description, 'Ext notes')
  assert.deepEqual(
    kernel
      .getTopBarItems()
      .filter((item) => item.moduleId === 'acme.notes')
      .map((item) => item.id),
    ['acme.notes:open-board', 'acme.notes:run'],
  )
  assert.equal(kernel.getModuleCommand('acme.notes.notes.open')?.category, 'Ext notes')
  assert.equal(
    kernel.hostFor('acme.notes').getAssetUrl('img/logo.png'),
    'studio-module://' + 'a'.repeat(64) + '/img/logo.png',
  )
})

test('a command without an action calls the worker method of its id; one with an action runs the Studio command', async () => {
  const { kernel, calls, toasts } = recordingKernel({ ok: true, value: null })
  const ran: string[] = []
  stopRunner = setAppCommandRunner((commandId) => {
    ran.push(commandId)
    return commandId !== 'git.fetch'
  })
  await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.cmds',
        over: { tier: 'worker', main: 'dist/main.cjs' },
        contributes: {
          commands: [
            { id: 'notes.clear', title: 'Clear notes', when: 'workspace' },
            { id: 'notes.backlog', title: 'Show Backlog', action: 'panel.backlog.toggle' },
            { id: 'notes.fetch', title: 'Fetch', action: 'git.fetch' },
          ],
        },
      },
    ]),
    importerFor({}),
  )
  const clear = kernel.getModuleCommand('acme.cmds.notes.clear')!
  assert.deepEqual(clear.availability, ['activeWorkspace'], 'a workspace command waits for a workspace')
  await clear.run({ activeWorkspaceId: 'ws-1', activeWorkspaceMode: null })
  assert.deepEqual(calls, [
    {
      moduleId: 'acme.cmds',
      method: 'notes.clear',
      access: 'operate',
      params: { where: 'palette', workspaceId: 'ws-1' },
    },
  ])

  await kernel.getModuleCommand('acme.cmds.notes.backlog')!.run({ activeWorkspaceId: null, activeWorkspaceMode: null })
  assert.deepEqual(ran, ['panel.backlog.toggle'])
  assert.equal(calls.length, 1, 'an action command runs no extension code')
  assert.deepEqual(toasts, [])

  await kernel.getModuleCommand('acme.cmds.notes.fetch')!.run({ activeWorkspaceId: null, activeWorkspaceMode: null })
  assert.deepEqual(toasts, ['Fetch is not available here.'], 'a Studio command nothing ran says so')
})

test('a worker method that refuses is said in a toast', async () => {
  const { kernel, toasts } = recordingKernel({ ok: false, code: 'failed', message: 'No notes yet.' })
  await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.refuses',
        over: { tier: 'worker', main: 'dist/main.cjs' },
        contributes: { commands: [{ id: 'notes.clear', title: 'Clear notes' }] },
      },
    ]),
    importerFor({}),
  )
  await kernel.getModuleCommand('acme.refuses.notes.clear')!.run({ activeWorkspaceId: null, activeWorkspaceMode: null })
  assert.deepEqual(toasts, ['Clear notes did not run.'])
})

test('menu items run their command with what they were picked on, under ids the install key prefixes', async () => {
  const { kernel, calls } = recordingKernel({ ok: true, value: null })
  const contributes: Partial<Contributes> = {
    commands: [{ id: 'notes.attach', title: 'Attach a note' }],
    menus: [
      { where: 'backlog.item', command: 'notes.attach' },
      { where: 'file', command: 'notes.attach' },
      { where: 'notification', command: 'notes.attach' },
    ],
  }
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([
      { key: 'acme.menus', over: { tier: 'worker', main: 'm.cjs' }, contributes },
      // Another extension with the same command id: its items are its own.
      { key: 'other.menus', over: { tier: 'worker', main: 'm.cjs' }, contributes },
    ]),
    importerFor({}),
  )
  assert.deepEqual(
    loaded.map((manifest) => manifest.id),
    ['acme.menus', 'other.menus'],
    'the same command id in two extensions does not collide',
  )

  const backlog = kernel.getBacklogItemActions().find((action) => action.id === 'acme.menus:notes.attach')!
  assert.equal(backlog.moduleId, 'acme.menus')
  assert.equal(backlog.label, 'Attach a note')
  await backlog.run({
    workspaceId: 'ws-1',
    item: { id: 'item-3' },
    selection: { items: [{ id: 'item-1' }, { id: 'item-3' }] },
  } as never)

  const file = kernel.getFileActions().find((action) => action.id === 'acme.menus:notes.attach')!
  await file.run({
    workspaceId: 'ws-1',
    workspaceRoot: '/Users/dev/acme-app',
    entries: [{ path: '/Users/dev/acme-app/src/index.ts' }, { path: '/elsewhere/notes.md' }] as never,
  })

  const provider = kernel.getNotificationActionProviders().find((candidate) => candidate.source === 'acme.menus')!
  const notification = {
    id: 'module:1',
    timestamp: '2026-10-09T12:00:00.000Z',
    level: 'info',
    source: 'module',
    title: 'Note saved',
    message: 'In notes.md',
    workspaceId: 'ws-2',
    read: false,
  } as AppNotification
  const [action] = provider.resolveActions({ notification, revealWorkspace: () => {} })
  assert.equal(action?.label, 'Attach a note')
  await action!.run({ notification, revealWorkspace: () => {} })

  assert.deepEqual(
    calls.map((call) => [call.moduleId, call.method, call.params]),
    [
      [
        'acme.menus',
        'notes.attach',
        { where: 'backlog.item', workspaceId: 'ws-1', backlogItemIds: ['item-1', 'item-3'] },
      ],
      [
        'acme.menus',
        'notes.attach',
        { where: 'file', workspaceId: 'ws-1', filePaths: ['src/index.ts', '/elsewhere/notes.md'] },
      ],
      [
        'acme.menus',
        'notes.attach',
        {
          where: 'notification',
          workspaceId: 'ws-2',
          notification: { title: 'Note saved', body: 'In notes.md', emittedAt: Date.UTC(2026, 9, 9, 12) },
        },
      ],
    ],
  )
})

test('a served extension whose manifest names another key is refused without evaluation', async () => {
  let imported = 0
  const loaded = await loadThirdPartyRendererEntries(
    createRendererHost(),
    served([{ key: 'acme.mismatch', manifestId: 'acme.other', entries: { 'a.js': 'a' } }]),
    async () => {
      imported += 1
      return { mount }
    },
  )
  assert.deepEqual(loaded, [])
  assert.equal(imported, 0)
  const state = getThirdPartyRendererLoadState('acme.mismatch')
  assert.equal(state?.status, 'error')
  assert.match(state.status === 'error' ? state.message : '', /does not match its install key/)
})

test('an entry without a mount, or a surface whose entry was not served, is a load error', async () => {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.no-mount',
        contributes: { panels: [{ id: 'p', title: 'P', entry: 'dist/p.js' }] },
        entries: { 'dist/p.js': 'nomount' },
      },
      {
        key: 'acme.unserved',
        contributes: { doors: [{ id: 'd', title: 'D', entry: 'dist/d.js' }] },
      },
    ]),
    importerFor({ nomount: { render: () => {} } }),
  )
  assert.deepEqual(loaded, [])
  assert.deepEqual(getThirdPartyRendererLoadState('acme.no-mount'), {
    status: 'error',
    message: 'dist/p.js must export mount(root, studio).',
  })
  assert.deepEqual(getThirdPartyRendererLoadState('acme.unserved'), {
    status: 'error',
    message: 'dist/d.js was not served.',
  })
  assert.equal(kernel.getGlobalSurface('acme.unserved:d'), undefined, 'nothing of it registers')
})

test('a broken bundle is isolated from its neighbours, and an absolute path never reaches Settings', async () => {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.broken',
        contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.js' }] },
        entries: { 'p.js': 'broken' },
      },
      {
        key: 'acme.leaky',
        contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.js' }] },
        entries: { 'p.js': 'leaky' },
      },
      {
        key: 'acme.healthy',
        contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.js' }] },
        entries: { 'p.js': 'ok' },
      },
    ]),
    importerFor({
      broken: new Error('boom at import time'),
      leaky: new Error('ENOENT: /Users/dev/.sprintengine/extensions/acme.leaky/p.js'),
      ok: { mount },
    }),
  )
  assert.deepEqual(
    loaded.map((manifest) => manifest.id),
    ['acme.healthy'],
  )
  assert.deepEqual(getThirdPartyRendererLoadState('acme.broken'), { status: 'error', message: 'boom at import time' })
  const leaky = getThirdPartyRendererLoadState('acme.leaky')
  assert.equal(leaky?.status, 'error')
  assert.doesNotMatch(leaky.status === 'error' ? leaky.message : '', /\/Users\//)
  assert.ok(getExtensionSurface('acme.healthy', 'panels', 'p'))
})

test('a registration that fails halfway keeps the extension out of the enablement universe', async () => {
  const kernel: RendererKernel = createRendererHost()
  // Something already holds the id its second door would register under.
  kernel.hostFor('squatter').registerGlobalSurface({ id: 'acme.half:second', Component: () => null })
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.half',
        contributes: {
          doors: [
            { id: 'first', title: 'First', entry: 'd.js' },
            { id: 'second', title: 'Second', entry: 'd.js' },
          ],
        },
        entries: { 'd.js': 'door' },
      },
      {
        key: 'acme.after',
        contributes: { doors: [{ id: 'x', title: 'X', entry: 'd.js' }] },
        entries: { 'd.js': 'door' },
      },
    ]),
    importerFor({ door: { mount } }),
  )
  assert.deepEqual(
    loaded.map((manifest) => manifest.id),
    ['acme.after'],
    'the neighbour registered after the failure still loads',
  )
  const state = getThirdPartyRendererLoadState('acme.half')
  assert.equal(state?.status, 'error')
  assert.match(state.status === 'error' ? state.message : '', /already registered by module "squatter"/)
  assert.equal(kernel.getGlobalSurface('acme.half:second')?.moduleId, 'squatter')
})

test('serving failures are recorded, and a duplicate key keeps its first definition', async () => {
  const kernel = createRendererHost()
  await loadThirdPartyRendererEntries(
    kernel,
    served([], { 'acme.unservable': 'The window entry p.js is missing.' }),
    importerFor({}),
  )
  assert.deepEqual(getThirdPartyRendererLoadState('acme.unservable'), {
    status: 'error',
    message: 'The window entry p.js is missing.',
  })

  const evaluated: string[] = []
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.dupe',
        contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.js' }] },
        entries: { 'p.js': 'first' },
      },
      {
        key: 'acme.dupe',
        contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.js' }] },
        entries: { 'p.js': 'second' },
      },
    ]),
    async (code) => {
      evaluated.push(code)
      return { mount }
    },
  )
  assert.deepEqual(
    loaded.map((manifest) => manifest.id),
    ['acme.dupe'],
  )
  assert.deepEqual(evaluated, ['first'])
  assert.deepEqual(getThirdPartyRendererLoadState('acme.dupe'), { status: 'loaded' })
})

test('a live refresh adds only extensions this window has not evaluated, and none with a worker', async () => {
  const kernel = createRendererHost()
  const newlyInstalled = served([
    {
      key: 'acme.refresh-ui',
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.js' }] },
      entries: { 'p.js': 'ok' },
    },
    { key: 'acme.refresh-worker', over: { tier: 'worker', main: 'm.cjs' } },
    {
      key: 'acme.refresh-broken',
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.js' }] },
      entries: { 'p.js': 'bad' },
    },
  ])
  const eligible = rendererEntriesForRefresh(newlyInstalled)
  assert.deepEqual(
    eligible.entries.map((entry) => entry.id),
    ['acme.refresh-ui', 'acme.refresh-broken'],
    'a worker’s methods load only at the server’s next start',
  )
  let evaluations = 0
  const importFresh: ThirdPartyEntryImporter = async (code) => {
    evaluations += 1
    if (code === 'bad') throw new Error('broken window code')
    return { mount }
  }
  const fresh = await loadThirdPartyRendererEntries(kernel, eligible, importFresh)
  assert.deepEqual(
    fresh.map((manifest) => manifest.id),
    ['acme.refresh-ui'],
  )
  await loadThirdPartyRendererEntries(kernel, rendererEntriesForRefresh(newlyInstalled), importFresh)
  assert.equal(evaluations, 2, 'neither a loaded nor a failed extension is evaluated again')
  assert.deepEqual(
    rendererEntriesForRefresh({ entries: [], failures: { 'acme.refresh-ui': 'updated file missing' } }).failures,
    {},
    'an update failure cannot overwrite the state of code already running',
  )
})
