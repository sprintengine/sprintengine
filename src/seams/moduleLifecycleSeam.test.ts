import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, test } from 'vitest'

import { connectToStudio } from '../../packages/agent-sdk/src/node'
import type { StudioClient } from '../../packages/client-runtime/src/public'
import { validateThirdPartyModuleManifest } from '../../packages/module-sdk/src/manifest-validate'
import { generateModuleSigningKeyPair, signManifest } from '../../packages/module-sdk/src/signing'
import type { StudioModuleEvent, StudioModuleSummary } from '../../packages/studio-protocol/src/public'
import { readModuleOverridesSync } from '../main/module-host/enablement-store'
import { loadMainModules } from '../main/module-host/load-modules'
import { applyHostApiGate } from '../main/modules/host-api-gate'
import { createModuleLifecycle, liveModuleIds } from '../main/modules/module-lifecycle'
import { computeModuleFileDigestsSync } from '../main/modules/module-signature'
import { planThirdPartyMainModules } from '../main/modules/third-party-main-loader'
import { readModuleTrustContextSync } from '../main/modules/trust-context'
import { discoverUserModulesSync } from '../main/modules/user-module-registry'
import { createRendererHost } from '../renderer/src/modules/renderer-host'
import { moduleLifecycleOver } from '../renderer/src/studio/moduleLifecycle'
import { callModuleMethod } from '../renderer/src/studio/moduleMethods'
import { createStudioModuleHub } from '../server/rpc/studio-modules'
import { OWNER_TOKEN, pairFakeClient, startTestServer } from '../server/rpc/studio-rpc.test-helper'
import { HOST_API_VERSION } from '../shared/modules/host-api'
import type { CapabilityManifest } from '../shared/modules/manifest'

// An extension's whole life on its server, from a window, over the Studio
// protocol alone:
//
//   window: Settings' lifecycle calls, a module's renderer host
//     ─ owner socket ─ router ─ module hub ─ lifecycle and kernel ─ disk
//
// An extension built for host API 2 and signed by a test key (never the
// release key) is installed from a folder and trusted through the server; at
// the server's next start it runs: the window calls its declared methods and
// hears its events. Switched off, it is gone at once: its calls are refused
// `module_unavailable`, the list says it is not running and declares nothing,
// and it says nothing more. Switched on again, it answers again.
//
// The server is composed as the Studio's out-of-process one composes its
// modules (server-modules.ts) over a scratch data folder and module root:
// discovery, the trust and host-API gates, the kernel, the hub and the
// lifecycle. Only the agent runtime and the core's schedules are left out.

const scratch = mkdtempSync(join(tmpdir(), 'studio-module-lifecycle-'))
const dataDir = join(scratch, 'data')
const moduleRoot = join(scratch, 'modules')
const source = join(scratch, 'source', 'deck')
mkdirSync(dataDir, { recursive: true })
mkdirSync(moduleRoot, { recursive: true })

const cleanups: Array<() => unknown> = []
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(scratch, { recursive: true, force: true })
})

const ID = 'acme-deck'

/** The extension as its author ships it: host API 2, declared methods, an event on each card, signed by a test key. */
function writeSignedExtension(): void {
  mkdirSync(join(source, 'dist'), { recursive: true })
  writeFileSync(
    join(source, 'dist', 'main.cjs'),
    `const cards = []
exports.registerMain = (host) => {
  host.registerMethods({
    'cards.list': { access: 'read', params: () => ({ ok: true, params: {} }), handler: () => ({ ok: true, result: cards }) },
    'cards.add': {
      access: 'operate',
      params: (value) =>
        value && typeof value.title === 'string'
          ? { ok: true, params: { title: value.title } }
          : { ok: false, message: '"title" is the card\\'s title.' },
      handler: (params, context) => {
        cards.push(params.title)
        host.emit('cards.changed', { count: cards.length, commandId: context.commandId ?? null })
        return { ok: true, result: { count: cards.length } }
      },
    },
  })
}
`,
  )
  const digests = computeModuleFileDigestsSync(source)
  assert.ok(digests.ok, 'the extension’s files are digested')
  const manifest = {
    id: ID,
    displayName: 'Deck',
    version: 1,
    defaultEnabled: true,
    engines: { hostApi: HOST_API_VERSION },
    permissions: ['module:bridge'],
    entry: { main: 'dist/main.cjs' },
    files: digests.files,
  }
  // Signed as `sprintengine-module sign` signs: over the manifest as the
  // validator reads it, by a key made for this test.
  const validated = validateThirdPartyModuleManifest(manifest)
  assert.ok(validated.ok, 'the manifest is valid')
  const signer = generateModuleSigningKeyPair()
  writeFileSync(
    join(source, 'manifest.json'),
    JSON.stringify({ ...manifest, signature: signManifest(validated.manifest, signer.privateKeyPem) }),
  )
}

/** One start of the server: what is on disk now, loaded, and served on a socket of its own. */
async function startServer() {
  const thirdParty = planThirdPartyMainModules(
    discoverUserModulesSync(moduleRoot, readModuleTrustContextSync(dataDir)),
    { electronMain: false },
  )
  applyHostApiGate(thirdParty.ineligible, thirdParty.modules)
  const hub = createStudioModuleHub()
  const load = loadMainModules({
    modules: thirdParty.modules,
    overrides: readModuleOverridesSync(dataDir),
    moduleRoots: thirdParty.moduleRoots,
    moduleVerifiedFiles: thirdParty.verifiedFiles,
    ineligible: thirdParty.ineligible,
    launchErrors: thirdParty.launchErrors,
    deliverModuleEvent: (event) => hub.deliverEvent(event),
    electronMain: false,
  })
  await load.ready
  const manifests = thirdParty.modules.map((module) => module.manifest)
  hub.serveCallsFrom((request) => load.kernel.callModuleMethod(request))
  hub.serveHostServicesFrom((moduleId) => load.kernel.hostServicesFor(moduleId))
  hub.serveLifecycleFrom(
    createModuleLifecycle({
      dataDir,
      moduleRoot: () => moduleRoot,
      changed: () => undefined,
      applyEnablement: async (overrides) => {
        await load.applyEnablement(overrides, {
          liveModuleIds: liveModuleIds(Object.keys(thirdParty.moduleRoots), load.report.errors),
        })
        return { ok: true }
      },
      view: () => {
        const overrides = readModuleOverridesSync(dataDir)
        return {
          manifests: () => manifests,
          enabled: (id) => overrides[id] ?? manifests.find((manifest) => manifest.id === id)?.defaultEnabled ?? false,
          running: (id) => load.isRunning(id),
          ineligible: (id) => thirdParty.ineligible[id],
          loadError: (id) => load.report.errors.find((error) => error.id === id)?.message,
          declaredMethods: (id) => load.kernel.declaredMethods(id),
        }
      },
    }),
  )
  const started = await startTestServer({ modules: hub })
  const stop = async () => {
    await started.dispose()
    await load.kernel.runShutdown()
  }
  cleanups.push(stop)
  return { path: started.path, auth: started.auth, stop }
}

/** A window's connection to that server, as its owner. */
async function windowOn(path: string, token = OWNER_TOKEN): Promise<StudioClient> {
  const client = await connectToStudio({ name: 'window', token, socketPath: path })
  cleanups.push(() => client.close())
  return client
}

async function listed(client: StudioClient): Promise<StudioModuleSummary | undefined> {
  return (await client.request('module.list', {})).modules.find((module) => module.id === ID)
}

/** What `count` events have been heard so far, waiting a little for one still on its way. */
async function heard(events: StudioModuleEvent[], count: number): Promise<StudioModuleEvent[]> {
  for (let tries = 0; events.length < count && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  return events
}

test('an extension is installed, trusted, called, heard, switched off and on again through its server', async () => {
  writeSignedExtension()

  // ── Installed and trusted through the server ────────────────────────────
  const first = await startServer()
  const settings = await windowOn(first.path)
  const lifecycle = moduleLifecycleOver(async () => settings)
  const installed = await lifecycle.install(source)
  assert.deepEqual(installed, { ok: true, moduleId: ID, trust: 'signed' }, 'a test key is not a trusted publisher')
  assert.deepEqual(await lifecycle.setTrust(ID, true), { ok: true })
  assert.equal(await listed(settings), undefined, 'what is installed loads at the next start')
  await first.stop()

  // ── At the next start it runs, and a window calls it and hears it ───────
  const second = await startServer()
  const client = await windowOn(second.path)
  const running = await listed(client)
  assert.deepEqual(running && { enabled: running.enabled, running: running.running, methods: running.methods }, {
    enabled: true,
    running: true,
    methods: [
      { name: 'cards.list', access: 'read' },
      { name: 'cards.add', access: 'operate' },
    ],
  })
  assert.equal(running?.source, 'third-party')

  const events: StudioModuleEvent[] = []
  client.subscribe('module.events', { moduleId: ID }, { onPayload: (event) => events.push(event) })
  // The window's renderer half of the extension, calling its own server.
  const renderer = createRendererHost()
  renderer.setModuleMethodCaller((call) => callModuleMethod(client, call))
  const manifest = { id: ID, displayName: 'Deck', version: 1, defaultEnabled: true, source: 'third-party' }
  const deck = renderer.hostFor(ID, manifest as CapabilityManifest).methods<{
    'cards.list': { access: 'read'; params: Record<string, never>; result: string[] }
    'cards.add': { access: 'operate'; params: { title: string }; result: { count: number } }
  }>()
  // The stream is up once a first event comes through it.
  for (let tries = 0; events.length === 0 && tries < 50; tries++) {
    await deck.operate('cards.add', { title: `Warm-up ${tries}` })
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(events.length > 0, 'the window hears the extension’s events')
  const before = (await deck.read('cards.list', {})) as { ok: true; result: string[] }
  assert.equal(before.ok, true)

  const added = await deck.operate('cards.add', { title: 'Ship it' }, { commandId: 'add-ship-it' })
  assert.deepEqual(added, { ok: true, result: { count: before.result.length + 1 } })
  const afterAdd = await heard(events, events.length + 1)
  const last = afterAdd.at(-1)!
  assert.equal(last.sourceModuleId, ID)
  assert.equal(last.topic, 'cards.changed')
  assert.deepEqual(last.payload, { count: before.result.length + 1, commandId: 'owner:add-ship-it' })
  const refused = await deck.operate('cards.add', { name: 'x' } as unknown as { title: string })
  assert.equal(!refused.ok && refused.code, 'invalid_params', 'its own validator reads the params')

  // ── Switched off: gone at once ──────────────────────────────────────────
  const off = await moduleLifecycleOver(async () => client).setEnabled(ID, false)
  assert.equal(off.ok, true, off.ok ? '' : off.message)
  assert.deepEqual(off.ok && off.module && { enabled: off.module.enabled, running: off.module.running }, {
    enabled: false,
    running: false,
  })
  const gone = await listed(client)
  assert.deepEqual(gone && { enabled: gone.enabled, running: gone.running, methods: gone.methods }, {
    enabled: false,
    running: false,
    methods: [],
  })
  const unavailable = await deck.read('cards.list', {})
  assert.equal(!unavailable.ok && unavailable.code, 'module_unavailable')
  const quiet = events.length
  assert.equal(!(await deck.operate('cards.add', { title: 'Nobody' })).ok, true)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(events.length, quiet, 'a switched-off extension says nothing')
  assert.deepEqual(readModuleOverridesSync(dataDir), { [ID]: false }, 'the choice is kept for the next start')

  // ── Switched on again: it answers again ─────────────────────────────────
  const on = await moduleLifecycleOver(async () => client).setEnabled(ID, null)
  assert.equal(on.ok && on.module?.running, true)
  const again = await deck.read('cards.list', {})
  assert.equal(again.ok, true)
  assert.deepEqual(readModuleOverridesSync(dataDir), {}, 'null is back to its default')
})

test('only an owner changes what runs: a paired client granted modules may list, and is refused the rest', async () => {
  const { path, auth } = await startServer()
  const paired = await windowOn(path, pairFakeClient(auth, 'tablet', ['modules:operate']))
  const modules = (await paired.request('module.list', {})).modules
  assert.equal(
    modules.find((module) => module.id === ID)?.running,
    true,
    'it lists what runs, the extension switched back on above',
  )
  const lifecycle = moduleLifecycleOver(async () => paired)
  for (const refused of [
    await lifecycle.setEnabled(ID, false),
    await lifecycle.setTrust(ID, false),
    await lifecycle.uninstall(ID),
    await lifecycle.install(source),
  ]) {
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.message, /owner|Studio’s own/i)
  }
  assert.deepEqual(readModuleOverridesSync(dataDir), {}, 'nothing it asked for was written')
})
