// extension.json: one strict validator for the app, the CLI and the
// templates. Unknown keys are refused at every level, every path stays inside
// the extension, and a manifest asks for no more authority than its tier.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  EXTENSION_MANIFEST_SINCE,
  EXTENSION_RESERVED_POINTS,
  extensionInstallKey,
  isExtensionInstallKey,
  isReservedExtensionId,
  isReservedExtensionPublisher,
  isSafeExtensionPath,
  parseExtensionInstallKey,
  parseExtensionManifest,
  requiredExtensionTier,
  studioReadsManifest,
  validateExtensionManifest,
  type ExtensionManifestValidationOptions,
} from '../src/extension-manifest.js'

type Raw = Record<string, unknown>

/** The smallest manifest Studio accepts: a content extension that adds nothing. */
function base(extra: Raw = {}): Raw {
  return {
    manifestVersion: 1,
    id: 'notes',
    version: '1.0.0',
    engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
    tier: 'content',
    name: 'Notes',
    ...extra,
  }
}

const panel = (extra: Raw = {}) => ({ id: 'notes', title: 'Notes', entry: 'dist/notes.js', ...extra })

function issuesOf(
  raw: unknown,
  options?: ExtensionManifestValidationOptions,
): Array<{ path: string; message: string }> {
  const result = validateExtensionManifest(raw, options)
  return result.ok ? [] : result.issues
}

function refusedAt(raw: unknown, path: string, pattern?: RegExp, options?: ExtensionManifestValidationOptions): void {
  const issues = issuesOf(raw, options)
  const found = issues.find((issue) => issue.path === path)
  assert.ok(found, `expected an issue at "${path}", got ${JSON.stringify(issues)}`)
  if (pattern) assert.match(found.message, pattern)
}

function accepted(raw: unknown, options?: ExtensionManifestValidationOptions) {
  const result = validateExtensionManifest(raw, options)
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.issues))
  return result.manifest
}

test('the smallest manifest validates, with no permissions and every point empty', () => {
  const manifest = accepted(base())
  assert.deepEqual(manifest.permissions, [])
  assert.deepEqual(manifest.contributes, {
    commands: [],
    menus: [],
    topBarItems: [],
    panels: [],
    doors: [],
    settingsSections: [],
    mcpTools: [],
    hooks: [],
    events: [],
    syntaxes: [],
    customEditors: [],
    keybindings: [],
    statusBarItems: [],
    settings: [],
    skills: [],
    mcpServers: [],
    providers: [],
  })
})

test('$schema is accepted for editors, and left out of what Studio reads', () => {
  const manifest = accepted(base({ $schema: 'https://example.com/extension.schema.json' }))
  assert.equal('$schema' in manifest, false)
})

test('anything that is not a JSON object is refused', () => {
  for (const value of [null, [], 'notes', 1]) {
    assert.deepEqual(issuesOf(value), [{ path: '', message: 'extension.json must be a JSON object.' }])
  }
})

test('parseExtensionManifest says when the text is not JSON', () => {
  const result = parseExtensionManifest('{ "id": ')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.issues[0]!.message, /^extension\.json is not JSON/)
  assert.ok(parseExtensionManifest(JSON.stringify(base())).ok)
})

test('a required field that is missing is named', () => {
  for (const field of ['manifestVersion', 'id', 'version', 'engines', 'tier', 'name']) {
    const raw = base()
    delete raw[field]
    refusedAt(raw, field, /is required/)
  }
  refusedAt(base({ manifestVersion: 2 }), 'manifestVersion', /must be 1/)
  refusedAt(base({ version: '1.0' }), 'version', /semver/)
  refusedAt(base({ engines: {} }), 'engines.studio', /is required/)
  refusedAt(base({ engines: { studio: '^0.13.0' } }), 'engines.studio', />=x\.y\.z/)
})

test('an unknown key is refused at the top level', () => {
  refusedAt(base({ displayName: 'Notes' }), 'displayName', /not a field Studio knows/)
  refusedAt(base({ entry: { main: 'main.js' } }), 'entry', /not a field Studio knows/)
})

test('an unknown key is refused inside engines and contributes', () => {
  refusedAt(base({ engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}`, hostApi: 3 } }), 'engines.hostApi')
  refusedAt(base({ contributes: { workspaceTypes: [] } }), 'contributes.workspaceTypes', /not a field Studio knows/)
})

test('an unknown key is refused inside every point’s items', () => {
  const worker = { tier: 'worker', main: 'dist/main.cjs', permissions: ['tools:contribute'] }
  const cases: Array<[Raw, string]> = [
    [{ commands: [{ id: 'notes.clear', title: 'Clear', run: 'x' }] }, 'contributes.commands[0].run'],
    [
      { commands: [{ id: 'notes.clear', title: 'Clear' }], menus: [{ where: 'file', command: 'notes.clear', x: 1 }] },
      'contributes.menus[0].x',
    ],
    [{ topBarItems: [{ id: 'timer', title: 'Timer', door: 'timer', order: 1 }] }, 'contributes.topBarItems[0].order'],
    [{ panels: [panel({ Component: 'x' })] }, 'contributes.panels[0].Component'],
    [{ doors: [panel({ railPlacement: 'inline' })] }, 'contributes.doors[0].railPlacement'],
    [{ settingsSections: [panel({ description: 'x' })] }, 'contributes.settingsSections[0].description'],
    [
      { mcpTools: [{ name: 'notes_search', description: 'Search', access: 'read', mutates: false }] },
      'contributes.mcpTools[0].mutates',
    ],
  ]
  for (const [contributes, path] of cases) {
    refusedAt(base({ ...worker, contributes }), path, /not a field Studio knows/)
  }
})

test('__proto__, constructor and prototype are refused as keys', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const raw = JSON.parse(
      `{"manifestVersion":1,"id":"notes","version":"1.0.0","engines":{"studio":">=${EXTENSION_MANIFEST_SINCE}"},"tier":"content","name":"Notes","${key}":{}}`,
    )
    refusedAt(raw, key, /reserved name/)
    const nested = JSON.parse(`{"studio":">=${EXTENSION_MANIFEST_SINCE}","${key}":1}`)
    refusedAt(base({ engines: nested }), `engines.${key}`, /reserved name/)
  }
})

test('constructor and prototype are refused as ids', () => {
  for (const id of ['constructor', 'prototype']) {
    refusedAt(base({ id }), 'id', /reserved name/)
    refusedAt(base({ tier: 'ui', contributes: { panels: [panel({ id })] } }), 'contributes.panels[0].id', /reserved/)
  }
  refusedAt(base({ id: 'Notes' }), 'id', /kebab-case/)
  refusedAt(base({ id: 'notes--app' }), 'id', /kebab-case/)
})

test('a path that leaves the extension, or means something else on another platform, is refused', () => {
  const unsafe = [
    '../dist/main.js',
    'dist/../../main.js',
    '/dist/main.js',
    'dist\\main.js',
    'C:/dist/main.js',
    'C:main.js',
    'dist/CON.js',
    'con.js',
    'dist/./main.js',
    'dist//main.js',
    'dist./main.js',
    'dist /main.js',
  ]
  for (const path of unsafe) {
    assert.equal(isSafeExtensionPath(path), false, path)
    refusedAt(base({ tier: 'worker', main: path }), 'main', /relative path inside the extension/)
    refusedAt(base({ tier: 'ui', contributes: { panels: [panel({ entry: path })] } }), 'contributes.panels[0].entry')
  }
  for (const icon of ['../icon.png', '/icon.png', 'assets\\icon.png', 'C:/icon.png', 'aux.png']) {
    refusedAt(base({ icon }), 'icon', /relative path inside the extension/)
  }
  assert.equal(isSafeExtensionPath('dist/console.js'), true, 'a name that only starts like a device name is fine')
})

test('a ui entry is a module Studio loads as written: JavaScript, TypeScript or JSX; a worker no JSX', () => {
  const ui = (entry: string) => base({ tier: 'ui', contributes: { panels: [panel({ entry })] } })
  for (const entry of [
    'src/notes.js',
    'src/notes.mjs',
    'src/notes.ts',
    'src/notes.mts',
    'src/notes.tsx',
    'src/notes.jsx',
  ])
    accepted(ui(entry))
  refusedAt(ui('src/notes.cjs'), 'contributes.panels[0].entry', /must end in \.js, \.mjs/)
  for (const main of ['src/main.js', 'src/main.mjs', 'src/main.cjs', 'src/main.ts', 'src/main.mts', 'src/main.cts']) {
    accepted(base({ tier: 'worker', main }))
  }
  refusedAt(base({ tier: 'worker', main: 'src/main.tsx' }), 'main', /must end in \.js, \.mjs, \.cjs/)
  refusedAt(base({ icon: 'assets/icon.gif' }), 'icon', /must end in/)
})

test('a point above the tier fails, naming the tier it needs', () => {
  refusedAt(
    base({ tier: 'content', contributes: { commands: [{ id: 'open', title: 'Open', action: 'chat.new' }] } }),
    'tier',
    /needs "declarative"/,
  )
  refusedAt(base({ tier: 'declarative', contributes: { panels: [panel()] } }), 'tier', /needs "ui"/)
  refusedAt(base({ tier: 'declarative', contributes: { doors: [panel()] } }), 'tier', /needs "ui"/)
  refusedAt(base({ tier: 'declarative', contributes: { settingsSections: [panel()] } }), 'tier', /needs "ui"/)
  refusedAt(
    base({
      tier: 'ui',
      permissions: ['tools:contribute'],
      contributes: {
        mcpTools: [{ name: 'notes_search', description: 'Search', access: 'read', inputSchema: { type: 'object' } }],
      },
    }),
    'tier',
    /needs "worker"/,
  )
  // A higher tier carries everything below it.
  accepted(base({ tier: 'ui', contributes: { commands: [{ id: 'open', title: 'Open', action: 'chat.new' }] } }))
})

test('permissions on a content or declarative extension fail', () => {
  refusedAt(base({ tier: 'content', permissions: ['storage:own'] }), 'tier', /needs "ui"/)
  refusedAt(base({ tier: 'declarative', permissions: ['storage:own'] }), 'tier', /needs "ui"/)
  assert.deepEqual(accepted(base({ tier: 'ui', permissions: ['storage:own'] })).permissions, ['storage:own'])
  refusedAt(base({ tier: 'ui', permissions: ['root'] }), 'permissions[0]', /must be one of/)
  refusedAt(base({ tier: 'ui', permissions: ['storage:own', 'storage:own'] }), 'permissions[1]', /duplicate permission/)
})

test('the worker tier needs main, and main or background need the worker tier', () => {
  refusedAt(base({ tier: 'worker' }), 'main', /required by the worker tier/)
  refusedAt(base({ tier: 'ui', main: 'dist/main.cjs' }), 'tier', /needs "worker"/)
  refusedAt(base({ tier: 'ui', background: true }), 'tier', /needs "worker"/)
  const manifest = accepted(base({ tier: 'worker', main: 'dist/main.cjs', background: true }))
  assert.equal(manifest.background, true)
})

test('a command without an action runs worker code, so it needs the worker tier', () => {
  const command = { id: 'notes.clear', title: 'Clear notes' }
  refusedAt(base({ tier: 'ui', contributes: { commands: [command] } }), 'tier', /needs "worker"/)
  accepted(
    base({
      tier: 'worker',
      main: 'dist/main.cjs',
      permissions: [],
      contributes: { commands: [command] },
    }),
  )
  refusedAt(
    base({ tier: 'declarative', contributes: { commands: [{ ...command, action: 'not.a.command' }] } }),
    'contributes.commands[0].action',
    /must be one of/,
  )
  refusedAt(
    base({ tier: 'declarative', contributes: { commands: [{ id: 'Notes', title: 'x', action: 'chat.new' }] } }),
    'contributes.commands[0].id',
    /lower-case words/,
  )
})

test('a worker command may replace one of Studio’s actions, once, and only a worker command', () => {
  const worker = (commands: unknown[]) => base({ tier: 'worker', main: 'dist/main.cjs', contributes: { commands } })
  const back = { id: 'notes.back', title: 'Back through notes', replaces: 'workspace.history.back' }
  const manifest = accepted(worker([back]))
  assert.equal(manifest.contributes.commands[0].replaces, 'workspace.history.back')
  refusedAt(worker([{ ...back, replaces: 'git.fetch' }]), 'contributes.commands[0].replaces', /must be one of/)
  // A declarative command runs no code to take the action over with.
  refusedAt(worker([{ ...back, action: 'chat.new' }]), 'contributes.commands[0].replaces', /cannot go with action/)
  // A ui extension has no worker to run in place of the action.
  refusedAt(
    base({ tier: 'ui', contributes: { commands: [back], panels: [panel()] } }),
    'contributes.commands[0].replaces',
    /needs a worker/,
  )
  refusedAt(
    base({ tier: 'declarative', contributes: { commands: [{ ...back, action: 'chat.new' }] } }),
    'contributes.commands[0].replaces',
    /needs a worker|cannot go with action/,
  )
  refusedAt(
    worker([back, { ...back, id: 'notes.back-again' }]),
    'contributes.commands[1].replaces',
    /already replaced by another command of this extension: workspace\.history\.back/,
  )
  accepted(worker([back, { id: 'notes.forward', title: 'Forward', replaces: 'workspace.history.forward' }]))
})

test('a menu item runs a command the extension contributes', () => {
  const commands = [{ id: 'notes.add', title: 'Add to notes', action: 'chat.new' }]
  accepted(base({ tier: 'declarative', contributes: { commands, menus: [{ where: 'file', command: 'notes.add' }] } }))
  refusedAt(
    base({ tier: 'declarative', contributes: { commands, menus: [{ where: 'file', command: 'notes.other' }] } }),
    'contributes.menus[0].command',
    /names no contributed command: notes\.other/,
  )
  refusedAt(
    base({ tier: 'declarative', contributes: { commands, menus: [{ where: 'editor', command: 'notes.add' }] } }),
    'contributes.menus[0].where',
    /must be one of: backlog\.item, file, notification/,
  )
  refusedAt(
    base({
      tier: 'declarative',
      contributes: {
        commands,
        menus: [
          { where: 'file', command: 'notes.add' },
          { where: 'file', command: 'notes.add' },
        ],
      },
    }),
    'contributes.menus[1]',
    /duplicate menu item/,
  )
})

test('a top bar item runs a contributed command or opens a contributed door, exactly one', () => {
  const commands = [{ id: 'notes.add', title: 'Add', action: 'chat.new' }]
  const doors = [panel({ id: 'timer' })]
  const item = (extra: Raw) => ({ id: 'timer', title: 'Timer', ...extra })
  accepted(base({ tier: 'ui', contributes: { doors, topBarItems: [item({ door: 'timer' })] } }))
  accepted(base({ tier: 'declarative', contributes: { commands, topBarItems: [item({ command: 'notes.add' })] } }))
  refusedAt(
    base({
      tier: 'ui',
      contributes: { commands, doors, topBarItems: [item({ door: 'timer', command: 'notes.add' })] },
    }),
    'contributes.topBarItems[0]',
    /exactly one of command and door/,
  )
  refusedAt(
    base({ tier: 'declarative', contributes: { topBarItems: [item({})] } }),
    'contributes.topBarItems[0]',
    /exactly one of command and door/,
  )
  refusedAt(
    base({ tier: 'ui', contributes: { doors, topBarItems: [item({ door: 'elsewhere' })] } }),
    'contributes.topBarItems[0].door',
    /names no contributed door: elsewhere/,
  )
  refusedAt(
    base({ tier: 'declarative', contributes: { commands, topBarItems: [item({ command: 'notes.gone' })] } }),
    'contributes.topBarItems[0].command',
    /names no contributed command: notes\.gone/,
  )
})

test('MCP tools need the mcp:tools permission', () => {
  const contributes = {
    mcpTools: [
      { name: 'notes_search', description: 'Search the notes.', access: 'read', inputSchema: { type: 'object' } },
    ],
  }
  refusedAt(
    base({ tier: 'worker', main: 'dist/main.cjs', contributes }),
    'contributes.mcpTools',
    /needs the "tools:contribute" permission/,
  )
  const manifest = accepted(
    base({ tier: 'worker', main: 'dist/main.cjs', permissions: ['tools:contribute'], contributes }),
  )
  assert.deepEqual(manifest.contributes.mcpTools, contributes.mcpTools)
  refusedAt(
    base({
      tier: 'worker',
      main: 'dist/main.cjs',
      permissions: ['tools:contribute'],
      contributes: {
        mcpTools: [{ name: 'Notes-Search', description: 'x', access: 'read', inputSchema: { type: 'object' } }],
      },
    }),
    'contributes.mcpTools[0].name',
    /lower-case letters, digits and underscores/,
  )
})

test('every MCP tool names its parameters, as a JSON Schema for an object', () => {
  const worker = (tool: Raw) =>
    base({
      tier: 'worker',
      main: 'dist/main.cjs',
      permissions: ['tools:contribute'],
      contributes: { mcpTools: [tool] },
    })
  const tool = { name: 'notes_search', description: 'Search the notes.', access: 'read' }
  refusedAt(worker(tool), 'contributes.mcpTools[0].inputSchema', /is required/)
  refusedAt(
    worker({ ...tool, inputSchema: { type: 'string' } }),
    'contributes.mcpTools[0].inputSchema',
    /must describe an object/,
  )
  const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  assert.deepEqual(accepted(worker({ ...tool, inputSchema: schema })).contributes.mcpTools[0]?.inputSchema, schema)
})

test('ids are unique within a point', () => {
  refusedAt(
    base({ tier: 'ui', contributes: { panels: [panel(), panel({ entry: 'dist/other.js' })] } }),
    'contributes.panels[1]',
    /duplicate id: notes/,
  )
  // The same id in two points is fine: each point is its own namespace.
  accepted(base({ tier: 'ui', contributes: { panels: [panel()], doors: [panel()] } }))
})

test('display text may not carry control or text-direction characters', () => {
  refusedAt(base({ name: 'Notes\u202e' }), 'name', /control or text-direction/)
  refusedAt(base({ name: 'Notes\n' }), 'name', /control or text-direction/)
  refusedAt(base({ name: '' }), 'name', /must not be empty/)
  accepted(base({ description: '' }))
})

test('engines.studio below the first Studio that reads extension.json always fails', () => {
  for (const options of [{}, { authoring: true }]) {
    refusedAt(base({ engines: { studio: '>=0.12.9' } }), 'engines.studio', /at least >=0\.13\.0/, options)
  }
})

test('authoring holds engines.studio to the newest “since” used; Studio reads up to its own version', () => {
  accepted(base(), { authoring: true })
  accepted(base({ engines: { studio: '>=0.14.0' } }), { authoring: true })
  // Studio accepts it as a manifest, and says separately that it cannot run it.
  const newer = accepted(base({ engines: { studio: '>=99.0.0' } }))
  assert.deepEqual(studioReadsManifest(accepted(base())), { ok: true })
  const refused = studioReadsManifest(newer)
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.message, /needs Studio 99\.0\.0 or newer/)
})

test('a reserved point must be empty for now', () => {
  for (const point of Object.keys(EXTENSION_RESERVED_POINTS)) {
    accepted(base({ contributes: { [point]: [] } }))
    refusedAt(
      base({ contributes: { [point]: [{ id: 'x' }] } }),
      `contributes.${point}`,
      /reserved for .* must be empty/,
    )
    refusedAt(base({ contributes: { [point]: {} } }), `contributes.${point}`, /must be empty/)
  }
  const manifest = accepted(base({ contributes: { themes: [] } }))
  assert.equal('themes' in manifest.contributes, false, 'a reserved point is not carried into the result')
})

test('requiredExtensionTier is the least tier a manifest’s contents need', () => {
  const empty = { commands: [], menus: [], topBarItems: [], panels: [], doors: [], settingsSections: [], mcpTools: [] }
  const tier = (extra: Partial<Parameters<typeof requiredExtensionTier>[0]>) =>
    requiredExtensionTier({ permissions: [], contributes: empty, ...extra })
  assert.equal(tier({}), 'content')
  assert.equal(
    tier({ contributes: { ...empty, commands: [{ id: 'a', title: 'A', action: 'chat.new' }] } }),
    'declarative',
  )
  assert.equal(tier({ permissions: ['storage:own'] }), 'ui')
  assert.equal(tier({ contributes: { ...empty, panels: [panel()] } }), 'ui')
  assert.equal(tier({ contributes: { ...empty, commands: [{ id: 'a', title: 'A' }] } }), 'worker')
  assert.equal(tier({ main: 'dist/main.cjs' }), 'worker')
  assert.equal(tier({ background: false }), 'worker')
})

test('an install key is <publisher>.<id>, and only a well-formed one parses', () => {
  assert.equal(extensionInstallKey('local', 'notes'), 'local.notes')
  assert.deepEqual(parseExtensionInstallKey('acme.notes'), { publisher: 'acme', id: 'notes' })
  assert.deepEqual(parseExtensionInstallKey('acme.notes-app'), { publisher: 'acme', id: 'notes-app' })
  for (const key of ['notes', '.notes', 'acme.', 'Acme.notes', 'acme.Notes', 'acme.notes.x', 'acme.constructor']) {
    assert.equal(parseExtensionInstallKey(key), null, key)
    assert.equal(isExtensionInstallKey(key), false, key)
  }
  assert.equal(parseExtensionInstallKey(`${'a'.repeat(40)}.notes`), null, 'a publisher is at most 39 characters')
  assert.equal(isExtensionInstallKey('local.notes'), true)
  assert.equal(isExtensionInstallKey(42), false)
})

test('reserved ids and publishers are Studio’s own', () => {
  assert.equal(isReservedExtensionId('studio-notes'), true)
  assert.equal(isReservedExtensionId('sprintengine-notes'), true)
  assert.equal(isReservedExtensionId('notes'), false)
  assert.equal(isReservedExtensionId('my-studio-notes'), false)
  for (const publisher of ['sprintengine', 'official', 'local', 'studio', 'studio-labs']) {
    assert.equal(isReservedExtensionPublisher(publisher), true, publisher)
  }
  assert.equal(isReservedExtensionPublisher('acme'), false)
})

test('a command without an action runs its worker method, which needs no permission', () => {
  const worker = {
    tier: 'worker',
    main: 'dist/main.cjs',
    contributes: { commands: [{ id: 'notes.clear', title: 'Clear' }] },
  }
  accepted(base(worker))
  accepted(base({ ...worker, permissions: [] }))
  for (const retired of ['module:bridge', 'ipc:invoke', 'network', 'storage'])
    refusedAt(base({ ...worker, permissions: [retired] }), 'permissions[0]', /must be one of/)
  // A command that runs a Studio action declares no method.
  accepted(base({ tier: 'declarative', contributes: { commands: [{ id: 'a', title: 'A', action: 'chat.new' }] } }))
})

test('version is semver: a numeric prerelease identifier has no leading zero', () => {
  for (const version of ['1.0.0', '1.0.0-0', '1.0.0-alpha.1', '1.0.0-0a', '1.0.0+001']) accepted(base({ version }))
  for (const version of ['1.0.0-01', '1.0.0-alpha.01', '01.0.0', '1.0'])
    refusedAt(base({ version }), 'version', /semver/)
})

test('events are the worker tier’s, at most five, each once, each with the permission it needs', () => {
  const worker = (events: unknown, permissions: string[] = ['workspace:read', 'conversation:read']) =>
    base({ tier: 'worker', main: 'dist/main.cjs', permissions, contributes: { events } })
  const manifest = accepted(worker([{ on: 'workspace.created' }, { on: 'agent.status.changed' }]))
  assert.deepEqual(manifest.contributes.events, [{ on: 'workspace.created' }, { on: 'agent.status.changed' }])
  refusedAt(
    base({ tier: 'ui', permissions: ['workspace:read'], contributes: { events: [{ on: 'workspace.created' }] } }),
    'tier',
    /needs "worker"/,
  )
  // An event tells what its permission reads.
  refusedAt(
    worker([{ on: 'workspace.created' }], []),
    'contributes.events[0].on',
    /needs the "workspace:read" permission/,
  )
  refusedAt(
    worker([{ on: 'agent.status.changed' }], ['workspace:read']),
    'contributes.events[0].on',
    /needs the "conversation:read" permission/,
  )
  refusedAt(worker([{ on: 'workspace.exploded' }]), 'contributes.events[0].on')
  // The window's own typography is a surface's alone.
  refusedAt(worker([{ on: 'editor.typography.changed' }]), 'contributes.events[0].on')
  refusedAt(
    worker([{ on: 'workspace.created' }, { on: 'workspace.created' }]),
    'contributes.events[1]',
    /duplicate event/,
  )
  refusedAt(worker(Array.from({ length: 6 }, () => ({ on: 'workspace.created' }))), 'contributes.events', /at most 5/)
})

test('the terminal permissions are the worker tier’s: no surface has a way to a terminal', () => {
  for (const permission of ['terminals:send', 'terminals:read']) {
    refusedAt(
      base({ tier: 'ui', permissions: [permission], contributes: { panels: [panel()] } }),
      'tier',
      /needs "worker"/,
    )
    accepted(base({ tier: 'worker', main: 'dist/main.cjs', permissions: [permission] }))
  }
})

test('hooks are the worker tier’s, a point at most once, from the points Studio has, failing by pass or deny', () => {
  const worker = (hooks: unknown, extra: Raw = {}) =>
    base({ tier: 'worker', main: 'dist/main.cjs', contributes: { hooks }, ...extra })
  const manifest = accepted(worker([{ point: 'agent.tool.before', onError: 'deny' }, { point: 'agent.tool.after' }]))
  assert.deepEqual(manifest.contributes.hooks, [
    { point: 'agent.tool.before', onError: 'deny' },
    { point: 'agent.tool.after' },
  ])
  refusedAt(base({ tier: 'ui', contributes: { hooks: [{ point: 'agent.tool.before' }] } }), 'tier', /needs "worker"/)
  refusedAt(worker([{ point: 'agent.tool.during' }]), 'contributes.hooks[0].point')
  refusedAt(worker([{ point: 'agent.tool.before', onError: 'retry' }]), 'contributes.hooks[0].onError')
  refusedAt(
    worker([{ point: 'agent.tool.before' }, { point: 'agent.tool.before' }]),
    'contributes.hooks[1]',
    /duplicate point/,
  )
  refusedAt(worker([{ point: 'agent.tool.before', timeoutMs: 5000 }]), 'contributes.hooks[0].timeoutMs')
})
