import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { extensionManifest, HELLO_MOUNT_SOURCE, writeExtensionFolder } from '../../../tests/extension-folder'
import { loadMainModules } from '../module-host/load-modules'
import { extensionContentSync } from './module-signature'
import { planThirdPartyMainModules } from './third-party-main-loader'
import { discoverUserModulesSync } from './user-module-registry'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PING_WORKER =
  "exports.activate = (studio) => studio.registerMethods({ ping: { access: 'read', params: (v) => ({ ok: true, params: v }), handler: () => ({ ok: true, result: 'pong' }) } })\n"

// A worker extension installed from a folder (`local.<id>`). Its worker
// declares a method, so a load shows up in what the kernel holds.
function writeExtension(
  id: string,
  options: { main?: string; manifest?: Record<string, unknown>; files?: Record<string, string> } = {},
): { root: string; moduleRoot: string; key: string } {
  const root = mkdtempSync(join(tmpdir(), 'mc-main-loader-'))
  temps.push(root)
  const key = `local.${id}`
  const moduleRoot = writeExtensionFolder(join(root, key), {
    manifest: options.manifest ?? extensionManifest({ id, permissions: ['module:bridge'] }),
    files: options.files ?? { 'dist/main.cjs': options.main ?? PING_WORKER },
  })
  return { root, moduleRoot, key }
}

// The grant Settings → Extensions records: the folder's content fingerprint.
function grantFor(moduleRoot: string, key: string): ReadonlyMap<string, string> {
  const content = extensionContentSync(moduleRoot)
  assert.ok(content.ok)
  return new Map([[key, content.fingerprint]])
}

function planFor(root: string, trustedModules: ReadonlyMap<string, string>) {
  return planThirdPartyMainModules(discoverUserModulesSync(root, { trustedModules }))
}

test('a trusted extension whose files are unchanged loads its worker', () => {
  const { root, moduleRoot, key } = writeExtension('steady')
  const planned = planFor(root, grantFor(moduleRoot, key))
  assert.deepEqual(planned.moduleRoots, { [key]: moduleRoot })
  assert.deepEqual(Object.keys(planned.verifiedFiles[key] ?? {}), ['dist/main.cjs', 'extension.json'])
  const { report, kernel } = loadMainModules({ modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, [key])
  assert.deepEqual(kernel.declaredMethods(key), [{ name: 'ping', access: 'read' }])
})

test('activate may be the default export', () => {
  const { root, moduleRoot, key } = writeExtension('default-export', {
    main: PING_WORKER.replace('exports.activate =', 'module.exports.default ='),
  })
  const planned = planFor(root, grantFor(moduleRoot, key))
  const { report, kernel } = loadMainModules({ modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, [key])
  assert.deepEqual(kernel.declaredMethods(key), [{ name: 'ping', access: 'read' }])
})

test('a worker that exports no activate fails to load, by name', () => {
  const { root, moduleRoot, key } = writeExtension('no-activate', { main: 'exports.registerMain = () => {}\n' })
  const planned = planFor(root, grantFor(moduleRoot, key))
  const { report } = loadMainModules({ modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, [])
  assert.match(report.errors.find((error) => error.id === key)?.message ?? '', /must export activate/)
})

test('an untrusted extension is planned ineligible and its worker never runs', () => {
  const { root, key } = writeExtension('untrusted', { main: 'throw new Error("ran")\n' })
  const planned = planFor(root, new Map())
  assert.equal(planned.ineligible[key], 'untrusted')
  assert.deepEqual(planned.verifiedFiles, {})
  const { report } = loadMainModules({ modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, [])
  assert.equal(
    report.errors.some((error) => /ran/.test(error.message)),
    false,
  )
})

test('an extension below the worker tier is listed with no worker to run', () => {
  const { root, moduleRoot, key } = writeExtension('panel', {
    manifest: extensionManifest({
      id: 'panel',
      tier: 'ui',
      main: undefined,
      contributes: { panels: [{ id: 'board', title: 'Board', entry: 'dist/board.js' }] },
    }),
    files: { 'dist/board.js': HELLO_MOUNT_SOURCE },
  })
  const planned = planFor(root, grantFor(moduleRoot, key))
  assert.equal(planned.modules.length, 1)
  assert.equal(planned.modules[0]?.registerMain, undefined)
  assert.equal(planned.ineligible[key], undefined)
})

test('the plan carries each extension’s declared MCP tools', () => {
  const tools = [{ name: 'notes_search', description: 'Search the notes.', access: 'read' }]
  const { root, key } = writeExtension('notes', {
    manifest: extensionManifest({ id: 'notes', permissions: ['mcp:tools'], contributes: { mcpTools: tools } }),
  })
  const planned = planFor(root, new Map())
  assert.deepEqual(planned.mcpTools, { [key]: tools })
})

test('folders discovery rejected become launch errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-main-loader-'))
  temps.push(root)
  writeExtensionFolder(join(root, 'not-a-key'))
  const planned = planFor(root, new Map())
  assert.equal(planned.modules.length, 0)
  assert.equal(planned.launchErrors.length, 1)
  assert.match(planned.launchErrors[0]?.message ?? '', /not an install key/)
})

test('an entry swapped between discovery and load is refused, not run', () => {
  const { root, moduleRoot, key } = writeExtension('swapped')
  const planned = planFor(root, grantFor(moduleRoot, key))
  // Discovery verified the files; the swap lands before activate runs.
  writeFileSync(join(moduleRoot, 'dist', 'main.cjs'), PING_WORKER.replace("'pong'", "'pwned'"))

  const { report, kernel } = loadMainModules({ modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, [])
  assert.deepEqual(kernel.declaredMethods(key), [])
  assert.equal(report.errors[0]?.id, key)
  assert.match(report.errors[0]?.message ?? '', /changed after they were verified/)
  assert.match(report.errors[0]?.message ?? '', /files\.dist\/main\.cjs/)
})

test('a file added beside the entry between discovery and load is refused too', () => {
  const { root, moduleRoot, key } = writeExtension('added')
  const planned = planFor(root, grantFor(moduleRoot, key))
  writeFileSync(join(moduleRoot, 'dist', 'chunk.cjs'), 'module.exports = 1\n')

  const { report } = loadMainModules({ modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, [])
  assert.match(report.errors[0]?.message ?? '', /files\.dist\/chunk\.cjs: is not listed/)
})

test("an async activate's rejection reaches the loader, which drops the extension", async () => {
  const { root, moduleRoot, key } = writeExtension('async-fails', {
    main: 'exports.activate = async () => { throw new Error("boot failed") }\n',
  })
  const planned = planFor(root, grantFor(moduleRoot, key))
  const loaded = loadMainModules({ modules: planned.modules, ineligible: planned.ineligible })
  await loaded.ready
  assert.equal(loaded.report.loaded.includes(key), false)
  assert.match(loaded.report.errors.find((error) => error.id === key)?.message ?? '', /boot failed/)
})
