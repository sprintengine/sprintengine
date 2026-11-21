import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { ExtensionContributionsResult, ExtensionManifestView } from '../../../shared/modules/manifest'
import type { AppNotification } from '../../../shared/workspace'
import { setAppCommandRunner } from '../commands/appCommandRunner'
import { getExtensionPanels, getExtensionSurface } from './extension-surfaces'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'
import { createRendererHost, type ModuleMethodCall, type RendererKernel } from './renderer-host'
import {
  contributionsForRefresh,
  getExtensionContributionsState as getThirdPartyRendererLoadState,
  loadExtensionContributions,
  reconcileExtensionContributions as reconcileThirdPartyRendererEntries,
} from './extension-contributions'

// The window registers what each approved extension's extension.json declares
// through the extension's scoped host, under ids its install key prefixes,
// and runs none of its code: its panels, doors and settings sections are drawn
// in frames. One broken extension never blocks its neighbours, and only one
// registered cleanly joins the enablement universe.
//
// The registrar keeps one state per install key for the window's session, so
// every test uses keys of its own.

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
  }>,
  failures: Record<string, string> = {},
): ExtensionContributionsResult {
  return {
    extensions: entries.map((entry) => {
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
      }
    }),
    failures,
  }
}

/** Register what is served, where the Studio draws frames unless told otherwise. */
async function loadThirdPartyRendererEntries(
  kernel: RendererKernel,
  contributions: ExtensionContributionsResult,
  drawsFrames = true,
) {
  return loadExtensionContributions(kernel, contributions, drawsFrames)
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

test('an extension’s surfaces register under its install key, to be drawn in frames', async () => {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.notes',
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
      },
    ]),
  )
  assert.deepEqual(
    loaded.map((manifest) => manifest.id),
    ['acme.notes'],
  )
  assert.deepEqual(getThirdPartyRendererLoadState('acme.notes'), { status: 'loaded' })

  assert.equal(getExtensionSurface('acme.notes', 'panels', 'notes')?.contribution.entry, 'dist/panel.js')
  assert.equal(getExtensionSurface('acme.notes', 'doors', 'board')?.contribution.entry, 'dist/door.js')
  assert.equal(getExtensionSurface('acme.notes', 'settingsSections', 'prefs')?.contribution.title, 'Notes')
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
})

test('where the Studio draws no frames, an extension adds its commands and no surface', async () => {
  const kernel = createRendererHost()
  await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.frameless',
        contributes: {
          panels: [{ id: 'p', title: 'P', entry: 'p.js' }],
          doors: [{ id: 'd', title: 'D', entry: 'd.js' }],
          commands: [{ id: 'go', title: 'Go', action: 'panel.backlog.toggle' }],
          topBarItems: [{ id: 'open', title: 'Open', door: 'd' }],
        },
      },
    ]),
    false,
  )
  assert.equal(getExtensionSurface('acme.frameless', 'panels', 'p'), undefined)
  assert.equal(kernel.getGlobalSurface('acme.frameless:d'), undefined)
  assert.ok(kernel.getModuleCommand('acme.frameless.go'))
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

test('a served extension whose manifest names another key is refused', async () => {
  const loaded = await loadThirdPartyRendererEntries(
    createRendererHost(),
    served([{ key: 'acme.mismatch', manifestId: 'acme.other' }]),
  )
  assert.deepEqual(loaded, [])
  const state = getThirdPartyRendererLoadState('acme.mismatch')
  assert.equal(state?.status, 'error')
  assert.match(state.status === 'error' ? state.message : '', /does not match its install key/)
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
      },
      {
        key: 'acme.after',
        contributes: { doors: [{ id: 'x', title: 'X', entry: 'd.js' }] },
      },
    ]),
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
  await loadThirdPartyRendererEntries(kernel, served([], { 'acme.unservable': 'The window entry p.js is missing.' }))
  assert.deepEqual(getThirdPartyRendererLoadState('acme.unservable'), {
    status: 'error',
    message: 'The window entry p.js is missing.',
  })

  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([
      {
        key: 'acme.dupe',
        contributes: { panels: [{ id: 'p', title: 'First', entry: 'p.js' }] },
      },
      {
        key: 'acme.dupe',
        contributes: { panels: [{ id: 'p', title: 'Second', entry: 'p.js' }] },
      },
    ]),
  )
  assert.deepEqual(
    loaded.map((manifest) => manifest.id),
    ['acme.dupe'],
  )
  assert.equal(getExtensionSurface('acme.dupe', 'panels', 'p')?.contribution.title, 'First')
  assert.deepEqual(getThirdPartyRendererLoadState('acme.dupe'), { status: 'loaded' })
})

test('a live refresh adds only extensions this window has not registered, and none with a worker', async () => {
  const kernel = createRendererHost()
  const newlyInstalled = served([
    {
      key: 'acme.refresh-ui',
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.js' }] },
    },
    { key: 'acme.refresh-worker', over: { tier: 'worker', main: 'm.cjs' } },
  ])
  const eligible = contributionsForRefresh(newlyInstalled)
  assert.deepEqual(
    eligible.extensions.map((entry) => entry.id),
    ['acme.refresh-ui'],
    'a worker’s methods load only at the server’s next start',
  )
  const fresh = await loadThirdPartyRendererEntries(kernel, eligible)
  assert.deepEqual(
    fresh.map((manifest) => manifest.id),
    ['acme.refresh-ui'],
  )
  assert.deepEqual(
    contributionsForRefresh(newlyInstalled).extensions,
    [],
    'a registered extension is not registered again',
  )
  assert.deepEqual(
    contributionsForRefresh({ extensions: [], failures: { 'acme.refresh-ui': 'updated file missing' } }).failures,
    {},
    'an update failure cannot overwrite the state of an extension already registered',
  )
})

test('an extension switched off and then uninstalled is offered nowhere and draws nothing, and comes back only as it was', async () => {
  const kernel = createRendererHost()
  const shipped = served([
    {
      key: 'local.gone',
      contributes: {
        panels: [{ id: 'notes', title: 'Notes', entry: 'dist/panel.js' }],
        commands: [{ id: 'gone.open', title: 'Open Backlog', action: 'panel.backlog.toggle' }],
      },
    },
  ])
  const loaded = await loadThirdPartyRendererEntries(kernel, shipped)
  assert.deepEqual(
    loaded.map((manifest) => manifest.id),
    ['local.gone'],
  )
  assert.ok(getExtensionSurface('local.gone', 'panels', 'notes'))

  // Switched off, then uninstalled: the uninstall forgets the switch, and the
  // default is on, so only leaving the universe keeps it away.
  const enabledIn = (universe: typeof loaded) => (id: string) =>
    new Set(resolveModuleEnablement(universe, {}).order).has(id)
  const offered = (universe: typeof loaded) => enabledIn(universe)('local.gone')
  assert.equal(new Set(resolveModuleEnablement(loaded, { 'local.gone': false }).order).has('local.gone'), false)
  const kept = reconcileThirdPartyRendererEntries(loaded, served([]))
  assert.deepEqual(kept, [])
  assert.equal(offered(kept), false, 'its default does not bring it back')
  assert.equal(getExtensionSurface('local.gone', 'panels', 'notes'), undefined, 'its panel is not drawn')
  assert.deepEqual(
    getExtensionPanels().filter((panel) => panel.key === 'local.gone'),
    [],
  )
  assert.deepEqual(
    kernel.getModuleCommands(enabledIn(kept)).map((command) => command.moduleId),
    [],
    'its command is not offered',
  )

  // Served again exactly as it was (trusted again): it comes back without registering twice.
  const back = reconcileThirdPartyRendererEntries(kept, shipped)
  assert.deepEqual(
    back.map((manifest) => manifest.id),
    ['local.gone'],
  )
  assert.ok(getExtensionSurface('local.gone', 'panels', 'notes'))
  // Served changed (a new version): it waits for the window to reload.
  reconcileThirdPartyRendererEntries(back, served([]))
  const changed = served([{ key: 'local.gone', over: { version: '2.0.0' } }])
  assert.deepEqual(reconcileThirdPartyRendererEntries([], changed), [])
})

test('trust revoked: its top bar button is gone, and running its command or action does nothing', async () => {
  const { kernel, calls } = recordingKernel({ ok: true, value: null })
  const ran: string[] = []
  stopRunner = setAppCommandRunner((commandId) => {
    ran.push(commandId)
    return true
  })
  const shipped = served([
    {
      key: 'local.revoked',
      over: { tier: 'worker', main: 'dist/main.cjs' },
      contributes: {
        commands: [
          { id: 'revoked.run', title: 'Run it' },
          { id: 'revoked.backlog', title: 'Show Backlog', action: 'panel.backlog.toggle' },
        ],
        topBarItems: [{ id: 'button', title: 'Show Backlog', command: 'revoked.backlog' }],
      },
    },
  ])
  const loaded = await loadThirdPartyRendererEntries(kernel, shipped)
  const enabledIn = (universe: typeof loaded) => (id: string) =>
    new Set(resolveModuleEnablement(universe, {}).order).has(id)
  assert.deepEqual(
    kernel.getTopBarItems(enabledIn(loaded)).map((item) => item.id),
    ['local.revoked:button'],
  )

  const kept = reconcileThirdPartyRendererEntries(loaded, served([]))
  assert.deepEqual(kernel.getTopBarItems(enabledIn(kept)), [], 'its button is gone')
  // A palette, menu or button drawn before the revocation still holds the
  // command; running it now runs nothing.
  await kernel
    .getModuleCommand('local.revoked.revoked.backlog')!
    .run({ activeWorkspaceId: null, activeWorkspaceMode: null })
  await kernel
    .getModuleCommand('local.revoked.revoked.run')!
    .run({ activeWorkspaceId: null, activeWorkspaceMode: null })
  assert.deepEqual(ran, [])
  assert.deepEqual(calls, [])
})
