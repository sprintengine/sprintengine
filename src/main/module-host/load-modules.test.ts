import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeModuleFileDigestsSync } from '../../../packages/extension-sdk/src/signing'
import {
  capabilityManifestOf,
  parseExtensionManifest,
  type ExtensionManifest,
} from '../../shared/modules/third-party-manifest'
import { extensionManifest } from '../../../tests/extension-folder'
import { planThirdPartyMainModules } from '../modules/third-party-main-loader'
import type { InstalledModule } from '../modules/user-module-registry'
import { loadMainModules, type CapabilityModule } from './load-modules'
import { createServiceToken } from './main-host'
import { test } from 'vitest'

/** A read method answering `result`, for a module that needs something to declare. */
const answering = (result: unknown) => ({
  access: 'read' as const,
  params: (value: unknown) => ({ ok: true as const, params: value }),
  handler: () => ({ ok: true as const, result }),
})

test('load-modules', async () => {
  async function main(): Promise<void> {
    testEnabledModulesRegisterInDependencyOrder()
    testDisabledModuleNeverRegisters()
    testProvideServicesSeedsBeforeModules()
    testCrossModuleServiceWiring()
    testThrowingModuleIsIsolated()
    testDuplicateMethodIsReportedNotFatal()
    testLifecycleAndSidecarsCollected()
    await testAsyncRegisterMainIsAwaitedByReady()
    await testAsyncRegisterMainRejectionUnregistersTheModule()
    await testAsyncRegisterMainTimeoutUnregistersTheModule()
    await testApplyEnablementAwaitsAsyncRegisterMain()
    await testRunStartupAndShutdownInvokeHooks()
    await testRunShutdownBeginRunsBeginHooksInRegistrationOrderBeforeShutdown()
    await testTrustedThirdPartyMainRegistersThroughHost()
    await testUntrustedAndInvalidThirdPartyMainNeverImports()
    await testThirdPartyPathSafetyAndBadEntriesAreLaunchErrors()
    testRejectedThirdPartyManifestIsLaunchError()
    await testTrustedThirdPartyRegistrationThrowIsIsolated()
    await testThirdPartyWorkerServesOnlyItsDeclaredMcpTools()

    console.log('module-host tests passed')
  }

  function testEnabledModulesRegisterInDependencyOrder(): void {
    const order: string[] = []
    const runtime: CapabilityModule = {
      manifest: { id: 'runtime', displayName: 'Runtime', version: 1, defaultEnabled: true, core: true },
      registerMain: () => {
        order.push('runtime')
      },
    }
    const feature: CapabilityModule = {
      manifest: {
        id: 'feature',
        displayName: 'Feature',
        version: 1,
        defaultEnabled: true,
        dependsOn: ['runtime'],
      },
      registerMain: () => {
        order.push('feature')
      },
    }

    const { report } = loadMainModules({ modules: [feature, runtime] })

    assert.deepEqual(order, ['runtime', 'feature'])
    assert.deepEqual(report.loaded, ['runtime', 'feature'])
    assert.deepEqual(report.errors, [])
  }

  function testDisabledModuleNeverRegisters(): void {
    let registered = false
    const off: CapabilityModule = {
      manifest: { id: 'off', displayName: 'Off', version: 1, defaultEnabled: false },
      registerMain: () => {
        registered = true
      },
    }

    const { report } = loadMainModules({ modules: [off] })

    assert.equal(registered, false, 'disabled module must not register')
    assert.deepEqual(report.loaded, [])
    assert.deepEqual(report.manifestOnly, [])
    assert.deepEqual(report.disabled, ['off'])
  }

  function testProvideServicesSeedsBeforeModules(): void {
    const token = createServiceToken<{ name: string }>('seeded.service')
    let seen: { name: string } | null = null
    const consumer: CapabilityModule = {
      manifest: { id: 'consumer', displayName: 'Consumer', version: 1, defaultEnabled: true },
      registerMain: (host) => {
        seen = host.requireService(token)
      },
    }

    const { report } = loadMainModules({
      modules: [consumer],
      provideServices: (host) => host.provideService(token, () => ({ name: 'seeded' })),
    })

    assert.deepEqual(report.errors, [])
    assert.deepEqual(seen, { name: 'seeded' })
  }

  function testCrossModuleServiceWiring(): void {
    const token = createServiceToken<{ value: number }>('test.service')
    let received: { value: number } | null = null

    const provider: CapabilityModule = {
      manifest: { id: 'provider', displayName: 'Provider', version: 1, defaultEnabled: true },
      registerMain: (host) => {
        host.provideService(token, () => ({ value: 42 }))
      },
    }
    const consumer: CapabilityModule = {
      manifest: {
        id: 'consumer',
        displayName: 'Consumer',
        version: 1,
        defaultEnabled: true,
        dependsOn: ['provider'],
      },
      registerMain: (host) => {
        received = host.requireService(token)
      },
    }

    const { report } = loadMainModules({ modules: [consumer, provider] })

    assert.deepEqual(report.errors, [])
    assert.deepEqual(received, { value: 42 })
  }

  function testThrowingModuleIsIsolated(): void {
    const bad: CapabilityModule = {
      manifest: { id: 'bad', displayName: 'Bad', version: 1, defaultEnabled: true },
      registerMain: () => {
        throw new Error('boom')
      },
    }
    const good: CapabilityModule = {
      manifest: { id: 'good', displayName: 'Good', version: 1, defaultEnabled: true },
      registerMain: (host) => host.registerMethods({ ping: answering('pong') }),
    }
    const { report } = loadMainModules({ modules: [bad, good] })

    assert.deepEqual(report.loaded, ['good'], 'a throwing module must not abort the others')
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0].id, 'bad')
  }

  function testDuplicateMethodIsReportedNotFatal(): void {
    const first: CapabilityModule = {
      manifest: { id: 'first', displayName: 'First', version: 1, defaultEnabled: true },
      registerMain: (host) => host.registerMethods({ list: answering(1) }),
    }
    // Method names are each module's own: another module may use the same one.
    const second: CapabilityModule = {
      manifest: { id: 'second', displayName: 'Second', version: 1, defaultEnabled: true },
      registerMain: (host) => host.registerMethods({ list: answering(2) }),
    }
    const twice: CapabilityModule = {
      manifest: { id: 'twice', displayName: 'Twice', version: 1, defaultEnabled: true },
      registerMain: (host) => {
        host.registerMethods({ list: answering(3) })
        host.registerMethods({ list: answering(4) })
      },
    }

    const { report, kernel } = loadMainModules({ modules: [first, second, twice] })

    assert.deepEqual(report.loaded, ['first', 'second'])
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0].id, 'twice')
    assert.deepEqual(kernel.declaredMethods('first'), [{ name: 'list', access: 'read' }])
    assert.deepEqual(kernel.declaredMethods('second'), [{ name: 'list', access: 'read' }])
  }

  function testLifecycleAndSidecarsCollected(): void {
    const mod: CapabilityModule = {
      manifest: { id: 'svc', displayName: 'Svc', version: 1, defaultEnabled: true },
      registerMain: (host) => {
        host.onStartup(() => undefined)
        host.onShutdown(() => undefined)
        host.registerSidecar({ id: 'svc-daemon', kind: 'process', module: 'svc-core' })
      },
    }

    const { kernel, report } = loadMainModules({ modules: [mod] })

    assert.equal(kernel.startupHooks().length, 1)
    assert.equal(kernel.shutdownHooks().length, 1)
    assert.deepEqual(report.sidecars, [{ id: 'svc-daemon', kind: 'process', module: 'svc-core' }])
  }

  async function testAsyncRegisterMainIsAwaitedByReady(): Promise<void> {
    const token = createServiceToken<string>('svc.late')
    const mod: CapabilityModule = {
      manifest: { id: 'svc', displayName: 'Svc', version: 1, defaultEnabled: true },
      registerMain: async (host) => {
        await Promise.resolve()
        host.provideService(token, () => 'late')
        host.onStartup(() => {})
      },
    }

    const { kernel, report, ready } = loadMainModules({ modules: [mod] })
    assert.equal(kernel.startupHooks().length, 0, 'nothing has registered before the await')
    await ready
    assert.deepEqual(report.loaded, ['svc'])
    assert.deepEqual(report.errors, [])
    assert.equal(kernel.hostFor('@host').getService(token), 'late')
    assert.equal(kernel.startupHooks().length, 1)
  }

  async function testAsyncRegisterMainRejectionUnregistersTheModule(): Promise<void> {
    const mod: CapabilityModule = {
      manifest: {
        id: 'flaky',
        displayName: 'Flaky',
        version: 1,
        defaultEnabled: true,
        source: 'third-party',
        permissions: ['module:bridge'],
      },
      registerMain: async (host) => {
        host.registerMethods({ ping: answering('pong') })
        await Promise.resolve()
        throw new Error('async boom')
      },
    }
    const other: CapabilityModule = {
      manifest: { id: 'steady', displayName: 'Steady', version: 1, defaultEnabled: true },
      registerMain: (host) => host.registerMethods({ ping: answering('pong') }),
    }

    const { kernel, report, ready } = loadMainModules({ modules: [mod, other] })
    assert.equal(kernel.declaredMethods('flaky').length, 1, 'sync registrations land before the await')
    await ready
    assert.deepEqual(report.loaded, ['steady'])
    assert.deepEqual(report.errors, [{ id: 'flaky', message: 'async boom' }])
    assert.deepEqual(kernel.declaredMethods('flaky'), [], 'the failed module leaves nothing behind')
    assert.equal(kernel.declaredMethods('steady').length, 1)
    assert.ok(
      kernel.recentNotifications().some((n) => n.sourceModuleId === 'flaky' && n.severity === 'error'),
      'a third-party async failure is surfaced under its identity',
    )
  }

  async function testAsyncRegisterMainTimeoutUnregistersTheModule(): Promise<void> {
    let registeredHook = false
    const mod: CapabilityModule = {
      manifest: { id: 'hung', displayName: 'Hung', version: 1, defaultEnabled: true },
      registerMain: (host) => {
        host.onStartup(() => {
          registeredHook = true
        })
        return new Promise<void>(() => {})
      },
    }

    const { kernel, report, ready } = loadMainModules({ modules: [mod], registerTimeoutMs: 5 })
    await ready
    assert.deepEqual(report.loaded, [])
    assert.equal(report.errors.length, 1)
    assert.match(report.errors[0]!.message, /^Extension "hung" did not finish starting within 0.005s\.$/)
    assert.equal(kernel.startupHooks().length, 0)
    await kernel.runStartup()
    assert.equal(registeredHook, false)
  }

  async function testApplyEnablementAwaitsAsyncRegisterMain(): Promise<void> {
    let settled = false
    const good: CapabilityModule = {
      manifest: { id: 'live-good', displayName: 'Live good', version: 1, defaultEnabled: false },
      registerMain: async (host) => {
        await Promise.resolve()
        host.registerMethods({ ping: answering('pong') })
        settled = true
      },
    }
    const bad: CapabilityModule = {
      manifest: { id: 'live-bad', displayName: 'Live bad', version: 1, defaultEnabled: false },
      registerMain: async (host) => {
        host.registerMethods({ ping: answering('pong') })
        throw new Error('live boom')
      },
    }

    const { kernel, applyEnablement } = loadMainModules({ modules: [good, bad] })
    const live = await applyEnablement(
      { 'live-good': true, 'live-bad': true },
      { liveModuleIds: ['live-good', 'live-bad'] },
    )
    assert.equal(settled, true)
    assert.deepEqual(live.loaded, ['live-good'])
    assert.deepEqual(live.errors, [{ id: 'live-bad', message: 'live boom' }])
    assert.deepEqual(kernel.declaredMethods('live-bad'), [])
  }

  async function testRunStartupAndShutdownInvokeHooks(): Promise<void> {
    const order: string[] = []
    const mod: CapabilityModule = {
      manifest: { id: 'svc', displayName: 'Svc', version: 1, defaultEnabled: true },
      registerMain: (host) => {
        host.onStartup(() => {
          order.push('start')
        })
        host.onShutdown(() => {
          throw new Error('shutdown boom')
        })
        host.onShutdown(async () => {
          order.push('stop')
        })
      },
    }

    const { kernel } = loadMainModules({ modules: [mod] })

    await kernel.runStartup()
    await kernel.runShutdown()

    // Startup ran; shutdown ran in reverse registration order and isolated the
    // throwing hook so the later-registered hook still ran.
    assert.deepEqual(order, ['start', 'stop'])
  }

  async function testRunShutdownBeginRunsBeginHooksInRegistrationOrderBeforeShutdown(): Promise<void> {
    const order: string[] = []
    const mod: CapabilityModule = {
      manifest: { id: 'svc', displayName: 'Svc', version: 1, defaultEnabled: true },
      registerMain: (host) => {
        host.onShutdownBegin(() => {
          order.push('begin-1')
        })
        host.onShutdownBegin(() => {
          throw new Error('begin boom')
        })
        host.onShutdownBegin(async () => {
          order.push('begin-3')
        })
        host.onShutdown(() => {
          order.push('stop')
        })
      },
    }

    const { kernel } = loadMainModules({ modules: [mod] })

    await kernel.runShutdownBegin()

    // Begin hooks run in registration order (not reversed), the throwing hook is
    // isolated so the later-registered begin hook still runs, and the begin phase
    // does not fire onShutdown hooks — the late drain stays separate.
    assert.deepEqual(order, ['begin-1', 'begin-3'])

    await kernel.runShutdown()
    assert.deepEqual(order, ['begin-1', 'begin-3', 'stop'])
  }

  async function testTrustedThirdPartyMainRegistersThroughHost(): Promise<void> {
    const moduleRoot = await createThirdPartyModuleRoot('trusted')
    await writeFile(
      join(moduleRoot, 'main.cjs'),
      "exports.activate = (host) => host.registerMethods({ ping: { access: 'read', params: (v) => ({ ok: true, params: v }), handler: () => ({ ok: true, result: 'pong' }) } })\n",
    )
    const defaultRoot = await createThirdPartyModuleRoot('default')
    await writeFile(
      join(defaultRoot, 'main.cjs'),
      "module.exports.default = (host) => host.registerMethods({ ping: { access: 'read', params: (v) => ({ ok: true, params: v }), handler: () => ({ ok: true, result: 'pong' }) } })\n",
    )
    const planned = planThirdPartyMainModules({
      modules: [
        installedThirdPartyModule({ id: 'trusted', moduleRoot, trust: 'trusted', main: 'main.cjs' }),
        installedThirdPartyModule({ id: 'default', moduleRoot: defaultRoot, trust: 'trusted', main: 'main.cjs' }),
      ],
      rejected: [],
    })
    const { report } = loadMainModules({ modules: planned.modules, ineligible: planned.ineligible })

    assert.deepEqual(report.loaded, ['local.default', 'local.trusted'])
    assert.deepEqual(report.manifestOnly, [])
    assert.deepEqual(report.errors, [])
  }

  async function testUntrustedAndInvalidThirdPartyMainNeverImports(): Promise<void> {
    const unsignedRoot = await createThirdPartyModuleRoot('unsigned')
    const signedRoot = await createThirdPartyModuleRoot('signed')
    const invalidRoot = await createThirdPartyModuleRoot('invalid')
    await Promise.all(
      [unsignedRoot, signedRoot, invalidRoot].map((moduleRoot) =>
        writeFile(join(moduleRoot, 'main.cjs'), "throw new Error('entry must not import')\n"),
      ),
    )
    const planned = planThirdPartyMainModules({
      modules: [
        installedThirdPartyModule({ id: 'unsigned', moduleRoot: unsignedRoot, trust: 'unsigned', main: 'main.cjs' }),
        installedThirdPartyModule({ id: 'signed', moduleRoot: signedRoot, trust: 'signed', main: 'main.cjs' }),
        installedThirdPartyModule({ id: 'invalid', moduleRoot: invalidRoot, trust: 'invalid', main: 'main.cjs' }),
      ],
      rejected: [],
    })

    const { report } = loadMainModules({ modules: planned.modules, ineligible: planned.ineligible })

    assert.deepEqual(report.loaded, [])
    assert.deepEqual(report.manifestOnly, [])
    assert.deepEqual(
      report.errors.map((error) => ({ id: error.id, message: error.message })),
      [
        { id: 'local.invalid', message: 'Extension "local.invalid" has an invalid signature and will not load.' },
        {
          id: 'local.signed',
          message: 'Extension "local.signed" is not trusted yet; trust it in Settings → Extensions to enable.',
        },
        {
          id: 'local.unsigned',
          message: 'Extension "local.unsigned" is not trusted yet; trust it in Settings → Extensions to enable.',
        },
      ],
    )
  }

  async function testThirdPartyPathSafetyAndBadEntriesAreLaunchErrors(): Promise<void> {
    const codeFreeRoot = await createThirdPartyModuleRoot('code-free')
    const escapedRoot = await createThirdPartyModuleRoot('escaped')
    const badExportRoot = await createThirdPartyModuleRoot('bad-export')
    const importFailureRoot = await createThirdPartyModuleRoot('import-failure')
    await writeFile(join(badExportRoot, 'main.cjs'), 'exports.activate = 42\n')
    await writeFile(join(importFailureRoot, 'main.cjs'), "require('./missing.cjs')\n")
    const good: CapabilityModule = {
      manifest: { id: 'good', displayName: 'Good', version: 1, defaultEnabled: true },
      registerMain: (host) => host.registerMethods({ ping: answering('pong') }),
    }
    const planned = planThirdPartyMainModules({
      modules: [
        installedThirdPartyModule({ id: 'code-free', moduleRoot: codeFreeRoot, trust: 'trusted' }),
        installedThirdPartyModule({ id: 'escaped', moduleRoot: escapedRoot, trust: 'trusted', main: '../outside.cjs' }),
        installedThirdPartyModule({ id: 'bad-export', moduleRoot: badExportRoot, trust: 'trusted', main: 'main.cjs' }),
        installedThirdPartyModule({
          id: 'import-failure',
          moduleRoot: importFailureRoot,
          trust: 'trusted',
          main: 'main.cjs',
        }),
      ],
      rejected: [],
    })
    const { report } = loadMainModules({
      modules: [...planned.modules, good],
      ineligible: planned.ineligible,
    })

    assert.deepEqual(report.loaded, ['good'])
    assert.deepEqual(report.manifestOnly, ['local.code-free'])
    assert.equal(report.errors.length, 3)
    assert.equal(
      report.errors.find((error) => error.id === 'local.escaped')?.message,
      'main must resolve inside the module root.',
    )
    assert.equal(
      report.errors.find((error) => error.id === 'local.bad-export')?.message,
      'main must export activate(studio), as a named export or its default.',
    )
    assert.match(
      report.errors.find((error) => error.id === 'local.import-failure')?.message ?? '',
      /Cannot find module/,
    )
  }

  function testRejectedThirdPartyManifestIsLaunchError(): void {
    const planned = planThirdPartyMainModules({
      modules: [],
      rejected: [
        {
          path: 'local.broken/extension.json',
          issues: [{ path: 'main', message: 'is required by the worker tier.' }],
        },
      ],
    })

    const { report } = loadMainModules({
      modules: planned.modules,
      launchErrors: planned.launchErrors,
    })

    assert.deepEqual(report.loaded, [])
    assert.deepEqual(report.manifestOnly, [])
    assert.deepEqual(report.errors, [
      {
        id: 'local.broken/extension.json',
        message: 'main: is required by the worker tier.',
      },
    ])
  }

  async function testTrustedThirdPartyRegistrationThrowIsIsolated(): Promise<void> {
    const badRoot = await createThirdPartyModuleRoot('bad')
    await writeFile(join(badRoot, 'main.cjs'), "exports.activate = () => { throw new Error('boom') }\n")
    const good: CapabilityModule = {
      manifest: { id: 'good', displayName: 'Good', version: 1, defaultEnabled: true },
      registerMain: (host) => host.registerMethods({ ping: answering('pong') }),
    }
    const planned = planThirdPartyMainModules({
      modules: [installedThirdPartyModule({ id: 'bad', moduleRoot: badRoot, trust: 'trusted', main: 'main.cjs' })],
      rejected: [],
    })
    const { report } = loadMainModules({ modules: [...planned.modules, good] })

    assert.deepEqual(report.loaded, ['good'])
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0].id, 'local.bad')
    assert.equal(report.errors[0].message, 'boom')
  }

  // The plan carries each extension's declared MCP tools to the kernel: a
  // worker serves those, described as its extension.json describes them, and
  // one that registers anything else fails to start.
  async function testThirdPartyWorkerServesOnlyItsDeclaredMcpTools(): Promise<void> {
    const registering = (name: string) =>
      `exports.activate = (host) => host.registerMcpTools([{ name: '${name}', description: 'from code', mutates: false, inputSchema: { type: 'object' }, handler: async () => ({ content: [] }) }])\n`
    const declaredRoot = await createThirdPartyModuleRoot('declared')
    const undeclaredRoot = await createThirdPartyModuleRoot('undeclared')
    await writeFile(join(declaredRoot, 'main.cjs'), registering('notes_write'))
    await writeFile(join(undeclaredRoot, 'main.cjs'), registering('notes_secret'))
    const mcpTools = [{ name: 'notes_write', description: 'Writes a note.', access: 'operate' as const }]
    const planned = planThirdPartyMainModules({
      modules: [
        installedThirdPartyModule({
          id: 'declared',
          moduleRoot: declaredRoot,
          trust: 'trusted',
          main: 'main.cjs',
          mcpTools,
        }),
        installedThirdPartyModule({
          id: 'undeclared',
          moduleRoot: undeclaredRoot,
          trust: 'trusted',
          main: 'main.cjs',
          mcpTools,
        }),
      ],
      rejected: [],
    })
    assert.deepEqual(planned.mcpTools, { 'local.declared': mcpTools, 'local.undeclared': mcpTools })
    const { kernel, report } = loadMainModules({
      modules: planned.modules,
      ineligible: planned.ineligible,
      moduleMcpTools: planned.mcpTools,
    })

    assert.deepEqual(report.loaded, ['local.declared'])
    assert.deepEqual(report.errors, [
      {
        id: 'local.undeclared',
        message:
          'MCP tool "notes_secret" from extension "local.undeclared" is not declared in its extension.json (contributes.mcpTools).',
      },
    ])
    assert.deepEqual(
      kernel.mcpToolRegistrations().map((entry) => ({
        owner: entry.moduleId,
        name: entry.registration.name,
        description: entry.registration.description,
        mutates: entry.registration.mutates,
      })),
      [{ owner: 'local.declared', name: 'notes_write', description: 'Writes a note.', mutates: true }],
    )
  }

  async function createThirdPartyModuleRoot(id: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `mc-third-party-${id}-`))
  }

  // An extension installed from a folder as `local.<id>`: a worker when it
  // names a main, a code-free declarative one otherwise.
  function installedThirdPartyModule(options: {
    id: string
    moduleRoot: string
    trust: InstalledModule['trust']['status']
    main?: string
    mcpTools?: ExtensionManifest['contributes']['mcpTools']
  }): InstalledModule {
    const source = options.main
      ? extensionManifest({
          id: options.id,
          main: options.main,
          permissions: options.mcpTools ? ['module:bridge', 'mcp:tools'] : ['module:bridge'],
          ...(options.mcpTools ? { contributes: { mcpTools: options.mcpTools } } : {}),
        })
      : extensionManifest({ id: options.id, tier: 'declarative', permissions: undefined, main: undefined })
    // The validator would refuse a main like `../outside.cjs`; the loader's own
    // containment is what is under test, so the main is set after validation.
    const parsed = parseExtensionManifest(JSON.stringify({ ...source, ...(options.main ? { main: 'main.cjs' } : {}) }))
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
    const extension: ExtensionManifest = options.main ? { ...parsed.manifest, main: options.main } : parsed.manifest
    const key = `local.${options.id}`
    // A trusted extension is one whose files were verified; the loader holds
    // the folder to those digests again before it requires the worker.
    const scan = computeModuleFileDigestsSync(options.moduleRoot)
    return {
      key,
      publisher: 'local',
      manifest: capabilityManifestOf(key, 'local', extension),
      extension,
      moduleRoot: options.moduleRoot,
      trust:
        options.trust === 'trusted'
          ? { status: 'trusted', via: 'grant', verifiedFiles: scan.files }
          : { status: options.trust },
    }
  }

  const suiteRun = main()

  await suiteRun
})
