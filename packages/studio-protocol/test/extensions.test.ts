import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  STUDIO_EXTENSIONS_METHODS,
  STUDIO_EXTENSIONS_TOPICS,
  STUDIO_MARKETPLACE_OWNER,
  STUDIO_SCAFFOLD_OWNER,
} from '../src/extensions'
import { STUDIO_EXTENSIONS_CAPABILITY, STUDIO_MODULES_CAPABILITY } from '../src/handshake'
import { STUDIO_METHODS, STUDIO_TOPICS, authorizeStudioMethod, parseStudioMethodParams } from '../src/methods'
import { STUDIO_MODULES_METHODS, STUDIO_MODULES_REPORT_OWNER, STUDIO_MODULES_TOPICS } from '../src/modules'
import { STUDIO_SCOPES } from '../src/scopes'

const refusal = (parsed: { ok: boolean; code?: string }) => (parsed.ok ? null : parsed.code)

test('what fetches, approves, installs or removes an extension’s code, and a new project on this disk, is an owner’s', () => {
  const owned = {
    'marketplace.verify': STUDIO_MARKETPLACE_OWNER,
    'marketplace.install': STUDIO_MARKETPLACE_OWNER,
    'marketplace.update': STUDIO_MARKETPLACE_OWNER,
    'marketplace.uninstall': STUDIO_MARKETPLACE_OWNER,
    'marketplace.resolveGithub': STUDIO_MARKETPLACE_OWNER,
    'marketplace.installGithub': STUDIO_MARKETPLACE_OWNER,
    'extensionScaffold.home': STUDIO_SCAFFOLD_OWNER,
    'extensionScaffold.target': STUDIO_SCAFFOLD_OWNER,
    'extensionScaffold.create': STUDIO_SCAFFOLD_OWNER,
  } as const
  for (const [method, spec] of Object.entries(STUDIO_EXTENSIONS_METHODS)) {
    assert.equal(spec.capability, STUDIO_EXTENSIONS_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method as keyof typeof STUDIO_METHODS], spec, `${method} is in the merged table`)
    assert.equal(spec.owner, owned[method as keyof typeof owned], `${method}'s owner rule`)
  }
  // The installs are commands under the client's id; a review issues a fresh approval each time.
  for (const method of [
    'marketplace.install',
    'marketplace.update',
    'marketplace.uninstall',
    'marketplace.installGithub',
  ] as const)
    assert.equal(STUDIO_EXTENSIONS_METHODS[method].mutation, true, method)
  for (const method of ['marketplace.verify', 'marketplace.resolveGithub'] as const)
    assert.equal(STUDIO_EXTENSIONS_METHODS[method].mutation, false, method)
})

test('reading what could be installed and what can run is the narrowest read each needs', () => {
  for (const method of [
    'marketplace.read',
    'marketplace.updateStates',
    'cliPlugins.list',
    'cliPlugins.availability',
    'cliPlugins.launchPreview',
    'cardFeed.get',
    'sourcesFeed.get',
  ] as const)
    assert.equal(STUDIO_EXTENSIONS_METHODS[method].scope, 'providers:read', method)
  assert.equal(STUDIO_EXTENSIONS_METHODS['studioPlugin.status'].scope, 'files:read')
  assert.equal(STUDIO_EXTENSIONS_TOPICS['cardFeed.changed'].scope, 'providers:read')
  assert.equal(STUDIO_TOPICS['cardFeed.changed'], STUDIO_EXTENSIONS_TOPICS['cardFeed.changed'])
})

test('the installed extensions are listed and loaded under modules:read; what a window sets is a write', () => {
  assert.equal(STUDIO_MODULES_METHODS['module.installed'].scope, 'modules:read')
  assert.equal(STUDIO_MODULES_METHODS['module.rendererEntries'].scope, 'modules:read')
  assert.equal(STUDIO_MODULES_METHODS['module.setAppState'].scope, 'settings:write')
  for (const method of ['module.installed', 'module.rendererEntries', 'module.setAppState'] as const) {
    assert.equal(STUDIO_MODULES_METHODS[method].owner, undefined, method)
    assert.equal(STUDIO_MODULES_METHODS[method].capability, STUDIO_MODULES_CAPABILITY, method)
  }
  // The window's own report of the modules it resolved: an owner's, with its reason.
  const report = STUDIO_MODULES_METHODS['module.reportRegistry']
  assert.equal(report.scope, null)
  assert.equal(report.owner, STUDIO_MODULES_REPORT_OWNER)
  assert.match(STUDIO_MODULES_REPORT_OWNER, /this Studio’s own window/)
  assert.equal(report.capability, STUDIO_MODULES_CAPABILITY)
  assert.equal(authorizeStudioMethod({ owner: false, scopes: [...STUDIO_SCOPES] }, 'module.reportRegistry').ok, false)
  assert.equal(authorizeStudioMethod({ owner: true, scopes: [] }, 'module.reportRegistry').ok, true)
  assert.equal(STUDIO_MODULES_TOPICS['module.changed'].scope, 'modules:read')
})

test('an install names its entry and the approval its review issued, never the entry itself', () => {
  const parsed = parseStudioMethodParams('marketplace.install', {
    commandId: 'c1',
    id: 'pr-radar',
    trustToken: 'token',
    entry: { id: 'smuggled' },
    workspaceRoot: '/Users/dev/project',
    skillHarnesses: ['claude'],
  })
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.deepEqual(parsed.params, {
      commandId: 'c1',
      id: 'pr-radar',
      trustToken: 'token',
      workspaceRoot: '/Users/dev/project',
      skillHarnesses: ['claude'],
    })
  }
  assert.equal(refusal(parseStudioMethodParams('marketplace.install', { id: 'pr-radar' })), 'invalid_params')
  assert.equal(refusal(parseStudioMethodParams('marketplace.install', { commandId: 'c', id: '' })), 'invalid_params')
  assert.equal(
    refusal(parseStudioMethodParams('marketplace.install', { commandId: 'c', id: 'x', mcpSettings: 'all' })),
    'invalid_params',
  )
  assert.equal(
    refusal(parseStudioMethodParams('marketplace.installGithub', { commandId: 'c', trustCode: true })),
    'invalid_params',
    'a GitHub install without its approval',
  )
  const github = parseStudioMethodParams('marketplace.installGithub', {
    commandId: 'c',
    trustToken: 't',
    trustCode: 'yes',
  })
  assert.equal(refusal(github), 'invalid_params', '"I trust this code" is a yes or a no')
  assert.equal(refusal(parseStudioMethodParams('marketplace.uninstall', { commandId: 'c' })), 'invalid_params')
  assert.equal(refusal(parseStudioMethodParams('marketplace.resolveGithub', { url: '   ' })), 'invalid_params')
  assert.equal(refusal(parseStudioMethodParams('marketplace.read', { forceRefresh: 'yes' })), 'invalid_params')
})

test('a scaffold names an id and, at most, a folder; a module app state is namespaces of values', () => {
  const create = parseStudioMethodParams('extensionScaffold.create', {
    commandId: 'c',
    id: 'pr-radar',
    parentDir: '/Users/dev/Extensions',
    ideaMarkdown: '# Idea',
    templateId: 'everything',
  })
  assert.equal(create.ok, true)
  if (create.ok)
    assert.deepEqual(create.params, {
      commandId: 'c',
      id: 'pr-radar',
      parentDir: '/Users/dev/Extensions',
      ideaMarkdown: '# Idea',
    })
  assert.equal(refusal(parseStudioMethodParams('extensionScaffold.target', { id: 'x', folder: '' })), 'invalid_params')
  assert.equal(
    refusal(parseStudioMethodParams('module.setAppState', { commandId: 'c', state: { 'module:a': 1 } })),
    'invalid_params',
  )
  assert.equal(
    parseStudioMethodParams('module.setAppState', { commandId: 'c', state: { 'module:a': { on: true } } }).ok,
    true,
  )
  assert.equal(
    refusal(parseStudioMethodParams('module.reportRegistry', { commandId: 'c', snapshot: [] })),
    'invalid_params',
  )
})
