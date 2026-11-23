import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { STUDIO_EXTENSION_VERSION } from '../../../packages/extension-sdk/src/extension-manifest'
import { extensionAccess, devFolderApprovalFingerprint, type ExtensionApprovalRecord } from './extension-approvals'
import { approvalOf } from './extension-approvals.test-helper'
import type { ExtensionStandingContext } from './module-signature'
import { discoverUserModulesSync } from './user-module-registry'
import { resolveDevFolder } from './extension-dev-folders'

// Development folders: loaded where they are, after the installed extensions,
// in the order they were registered; approved for what they may do, not for
// one version of their code; and never a way to change an installed
// extension without the person.

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'se-dev-folders-')))
  made.push(dir)
  return dir
}

function writeExtension(folder: string, id: string, over: Record<string, unknown> = {}): void {
  mkdirSync(join(folder, 'src'), { recursive: true })
  writeFileSync(
    join(folder, 'extension.json'),
    JSON.stringify({
      manifestVersion: 1,
      id,
      version: '1.0.0',
      engines: { studio: `>=${STUDIO_EXTENSION_VERSION}` },
      tier: 'ui',
      name: id,
      permissions: [],
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'src/panel.ts' }] },
      ...over,
    }),
  )
  writeFileSync(
    join(folder, 'src', 'panel.ts'),
    'export function mount(root: HTMLElement) { root.textContent = "1" }\n',
  )
}

function devRecord(folder: string, permissions: string[] = []): ExtensionApprovalRecord {
  const access = extensionAccess(
    {
      permissions,
      tier: 'ui',
      contributes: { mcpTools: [], commands: [], customEditors: [], hooks: [], mcpServers: [], providers: [] },
    } as never,
    {},
  )
  return { fingerprint: devFolderApprovalFingerprint(access, folder), access, devFolder: folder }
}

test('development folders load after every installed extension, in the order they were registered', () => {
  const root = tempDir()
  writeExtension(join(root, 'local.zeta'), 'zeta')
  writeExtension(join(root, 'local.alpha'), 'alpha')
  const second = join(tempDir(), 'b')
  const first = join(tempDir(), 'a')
  writeExtension(second, 'beta')
  writeExtension(first, 'omega')
  const ctx: ExtensionStandingContext = { approvals: new Map(), devFolders: [second, first] }
  const { modules } = discoverUserModulesSync(root, ctx)
  assert.deepEqual(
    modules.map((module) => module.key),
    ['local.alpha', 'local.zeta', 'local.beta', 'local.omega'],
  )
  assert.deepEqual(
    modules.map((module) => module.development?.order ?? null),
    [null, null, 0, 1],
  )
})

test('a development folder with an installed extension’s key waits for the person; the installed one runs until then', () => {
  const root = tempDir()
  const installed = join(root, 'local.notes')
  writeExtension(installed, 'notes')
  const folder = join(tempDir(), 'notes')
  const again = join(tempDir(), 'notes-copy')
  writeExtension(folder, 'notes')
  writeExtension(again, 'notes')
  // Registered by anyone, an agent included: the installed one keeps running.
  const registered = discoverUserModulesSync(root, {
    approvals: new Map([['local.notes', approvalOf(installed)]]),
    devFolders: [folder, again],
  })
  assert.equal(registered.modules.length, 1)
  assert.equal(registered.modules[0]!.moduleRoot, installed)
  assert.equal(registered.modules[0]!.standing.approval.state, 'approved')
  assert.equal(registered.waiting?.length, 1)
  assert.equal(registered.waiting![0]!.moduleRoot, folder)
  assert.deepEqual(registered.waiting![0]!.development, { order: 0, overrides: true, waiting: true })
  assert.equal(registered.waiting![0]!.standing.approval.state, 'pending')
  assert.equal(registered.rejected.length, 1)
  assert.match(registered.rejected[0]!.issues[0]!.message, /already the development folder/)
  // Approved by the person for that folder: it stands in.
  const approved = discoverUserModulesSync(root, {
    approvals: new Map([['local.notes', devRecord(folder)]]),
    devFolders: [folder],
  })
  assert.equal(approved.modules.length, 1)
  assert.equal(approved.modules[0]!.moduleRoot, folder)
  assert.deepEqual(approved.modules[0]!.development, { order: 0, overrides: true })
  assert.equal(approved.modules[0]!.standing.approval.state, 'approved')
  assert.equal(approved.waiting, undefined)
})

test('a development folder cannot borrow the installed extension’s approval, nor give it one', () => {
  const root = tempDir()
  const installed = join(root, 'local.notes')
  writeExtension(installed, 'notes')
  const folder = join(tempDir(), 'notes')
  writeExtension(folder, 'notes')
  // Approved as installed: the development folder with its key still waits.
  const borrowed = discoverUserModulesSync(root, {
    approvals: new Map([['local.notes', approvalOf(installed)]]),
    devFolders: [folder],
  })
  assert.equal(borrowed.waiting?.[0]!.standing.approval.state, 'pending')
  // Approved as a development folder: once it is taken out, the installed one waits.
  const lent = discoverUserModulesSync(root, {
    approvals: new Map([['local.notes', devRecord(folder)]]),
    devFolders: [],
  })
  assert.equal(lent.modules[0]!.standing.approval.state, 'pending')
})

test('every development folder asks once, even one that asks for nothing', () => {
  const root = tempDir()
  const folder = join(tempDir(), 'notes')
  writeExtension(folder, 'notes')
  const first = discoverUserModulesSync(root, { approvals: new Map(), devFolders: [folder] }).modules[0]!
  assert.equal(first.standing.approval.state, 'pending')
  const approved = discoverUserModulesSync(root, {
    approvals: new Map([['local.notes', devRecord(folder)]]),
    devFolders: [folder],
  }).modules[0]!
  assert.equal(approved.standing.approval.state, 'approved')
})

test('a folder swapped for a link since it was registered is not loaded; nor is one inside Studio’s folders', () => {
  const root = tempDir()
  const parent = tempDir()
  const folder = join(parent, 'notes')
  writeExtension(folder, 'notes')
  const elsewhere = join(tempDir(), 'elsewhere')
  writeExtension(elsewhere, 'notes')
  const ctx: ExtensionStandingContext = {
    approvals: new Map([['local.notes', devRecord(folder)]]),
    devFolders: [folder],
  }
  assert.equal(discoverUserModulesSync(root, ctx).modules[0]!.standing.approval.state, 'approved')
  rmSync(folder, { recursive: true })
  symlinkSync(elsewhere, folder)
  const swapped = discoverUserModulesSync(root, ctx)
  assert.equal(swapped.modules.length, 0)
  assert.match(swapped.rejected[0]!.issues[0]!.message, /now leads to/)
  const dataDir = tempDir()
  const inData = join(dataDir, 'notes')
  writeExtension(inData, 'notes')
  const inside = discoverUserModulesSync(root, { approvals: new Map(), devFolders: [inData], dataDir })
  assert.equal(inside.modules.length, 0)
  assert.match(inside.rejected[0]!.issues[0]!.message, /keeps for itself/)
  assert.equal(resolveDevFolder(inData, [root, dataDir]).ok, false)
  assert.equal(resolveDevFolder(elsewhere, [root, dataDir]).ok, true)
})

test('an approval names its folder: another folder with the same extension is not approved by it', () => {
  const root = tempDir()
  const folder = join(tempDir(), 'one')
  const other = join(tempDir(), 'two')
  writeExtension(folder, 'notes')
  writeExtension(other, 'notes')
  const { modules } = discoverUserModulesSync(root, {
    approvals: new Map([['local.notes', devRecord(folder)]]),
    devFolders: [other],
  })
  assert.equal(modules[0]!.standing.approval.state, 'pending')
})

test('a save keeps the approval; asking for more asks again, and asking for less keeps it', () => {
  const root = tempDir()
  const folder = join(tempDir(), 'notes')
  writeExtension(folder, 'notes', { permissions: ['storage:own'] })
  const ctx: ExtensionStandingContext = {
    approvals: new Map([['local.notes', devRecord(folder, ['storage:own'])]]),
    devFolders: [folder],
  }
  const before = discoverUserModulesSync(root, ctx).modules[0]!.standing
  assert.equal(before.approval.state, 'approved')
  writeFileSync(
    join(folder, 'src', 'panel.ts'),
    'export function mount(root: HTMLElement) { root.textContent = "2" }\n',
  )
  const saved = discoverUserModulesSync(root, ctx).modules[0]!.standing
  assert.equal(saved.approval.state, 'approved', 'its code is the working copy')
  assert.notEqual(saved.contentDigest, before.contentDigest, 'and its identity moved, so it loads again')
  writeExtension(folder, 'notes', { permissions: ['storage:own', 'workspace:read'] })
  const grown = discoverUserModulesSync(root, ctx).modules[0]!.standing.approval
  assert.equal(grown.state, 'pending')
  assert.deepEqual(grown.state === 'pending' ? grown.growth : [], ['the "workspace:read" permission'])
  writeExtension(folder, 'notes', { permissions: [] })
  assert.equal(discoverUserModulesSync(root, ctx).modules[0]!.standing.approval.state, 'approved')
})

test('an installed extension’s files changed on disk still wait for the person', () => {
  const root = tempDir()
  const installed = join(root, 'local.notes')
  writeExtension(installed, 'notes')
  const ctx: ExtensionStandingContext = { approvals: new Map([['local.notes', approvalOf(installed)]]) }
  assert.equal(discoverUserModulesSync(root, ctx).modules[0]!.standing.approval.state, 'approved')
  writeFileSync(join(installed, 'src', 'panel.ts'), 'export function mount() { /* changed */ }\n')
  assert.equal(discoverUserModulesSync(root, ctx).modules[0]!.standing.approval.state, 'pending')
})

test('a development folder leaves out node_modules, .git and dotted folders, and links', () => {
  const root = tempDir()
  const folder = join(tempDir(), 'notes')
  writeExtension(folder, 'notes')
  mkdirSync(join(folder, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(folder, 'node_modules', 'x', 'index.js'), '')
  mkdirSync(join(folder, '.sprintengine', 'shots'), { recursive: true })
  writeFileSync(join(folder, '.sprintengine', 'shots', 'a.png'), '')
  const { modules } = discoverUserModulesSync(root, { approvals: new Map(), devFolders: [folder] })
  assert.deepEqual(Object.keys(modules[0]!.standing.verifiedFiles ?? {}).sort(), ['extension.json', 'src/panel.ts'])
})
