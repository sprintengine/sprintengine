import assert from 'node:assert/strict'

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
    testAppModulesStartBeforeEveryExtension()
    testThrowingModuleIsIsolated()
    testDuplicateMethodIsReportedNotFatal()
    testLifecycleAndSidecarsCollected()
    await testAsyncRegisterMainIsAwaitedByReady()
    await testAsyncRegisterMainRejectionUnregistersTheModule()
    await testAsyncRegisterMainTimeoutUnregistersTheModule()
    await testApplyEnablementAwaitsAsyncRegisterMain()
    await testRunStartupAndShutdownInvokeHooks()
    await testRunShutdownBeginRunsBeginHooksInRegistrationOrderBeforeShutdown()

    console.log('module-host tests passed')
  }

  // An extension declares no dependencies, and its install key sorts before
  // a built-in id like `scheduled-agents`; its activate may still resolve a
  // service any of the app's modules provides.
  function testAppModulesStartBeforeEveryExtension(): void {
    const token = createServiceToken<{ list(moduleId: string): string }>('scheduled-agents.module-service')
    const order: string[] = []
    const provider: CapabilityModule = {
      manifest: { id: 'zz-scheduled', displayName: 'Provider', version: 1, defaultEnabled: true },
      registerMain: (host) => {
        order.push('zz-scheduled')
        host.provideService(token, () => ({ list: (moduleId: string) => `pong ${moduleId}` }))
      },
    }
    let answer = ''
    const extension: CapabilityModule = {
      manifest: {
        id: 'local.aaa',
        displayName: 'Aaa',
        version: '1.0.0',
        defaultEnabled: true,
        source: 'third-party',
        permissions: ['schedules:own'],
      },
      registerMain: (host) => {
        order.push('local.aaa')
        answer = host.requireService(token).list(host.moduleId)
      },
    }
    const { report } = loadMainModules({ modules: [extension, provider] })
    assert.deepEqual(report.errors, [])
    assert.deepEqual(order, ['zz-scheduled', 'local.aaa'])
    assert.equal(answer, 'pong local.aaa')
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
        permissions: [],
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

  const suiteRun = main()

  await suiteRun
})
