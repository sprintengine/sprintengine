import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { standIn } from '../../tests/stand-in'
import { test, vi } from 'vitest'

test('app-lifecycle', async () => {
  // The quit path, with Electron replaced. Nothing here opens a window or reaches
  // the app's `ready` event: `whenReady()` never resolves, so only the legs
  // registered before it run — which is all the shutdown ordering needs.

  type Handler = (...args: unknown[]) => unknown

  const appEvents = new Map<string, Handler[]>()
  let exitCalls: number[] = []
  // The app's paths, logs among them: a quit that gives up on a leg says so there.
  const appPath = mkdtempSync(join(tmpdir(), 'sprintengine-lifecycle-test-'))

  const mockApp = {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on(event: string, handler: Handler) {
      const handlers = appEvents.get(event) ?? []
      handlers.push(handler)
      appEvents.set(event, handlers)
      return mockApp
    },
    once(event: string, handler: Handler) {
      return mockApp.on(event, handler)
    },
    // Never resolves: the ready leg creates windows and pollers, and none of that
    // is what this test is about.
    whenReady: () => new Promise<void>(() => {}),
    quit: () => undefined,
    // The update path's fallback, should the installer never quit the app.
    relaunch: () => undefined,
    exit: (code: number) => {
      exitCalls.push(code)
    },
    getPath: () => appPath,
    getAppPath: () => appPath,
    setAppLogsPath: () => undefined,
    setAppUserModelId: () => undefined,
    setAsDefaultProtocolClient: () => true,
  }

  const mockElectron = {
    app: mockApp,
    BrowserWindow: { getAllWindows: () => [] as unknown[] },
    ipcMain: { on: () => undefined, once: () => undefined, handle: () => undefined },
    Menu: { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) },
    net: { isOnline: () => false },
    Tray: class {},
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    shell: { openExternal: async () => undefined },
    dialog: {},
    session: { defaultSession: { webRequest: { onHeadersReceived: () => undefined } } },
    nativeTheme: { on: () => undefined, shouldUseDarkColors: false },
    powerSaveBlocker: { start: () => 0, stop: () => undefined, isStarted: () => false },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
  }

  const restoreModules = standIn({ electron: mockElectron })

  async function main(): Promise<void> {
    const { registerAppLifecycle } = await import('./app-lifecycle')

    // The server a lifecycle drains at quit; `gone` lets it exit.
    function serverDouble(record: string[]) {
      let gone: () => void = () => undefined
      const budgets: number[] = []
      return {
        budgets,
        gone: () => gone(),
        server: {
          start: () => undefined,
          log: { note: () => undefined },
          onAttentionPhase: () => undefined,
          detectClis: async () => 0,
          refreshCliVersions: async () => undefined,
          shutdown: (options: { budgetMs: number }) => {
            record.push('server.shutdown')
            budgets.push(options.budgetMs)
            return new Promise<'exited'>((resolve) => {
              gone = () => {
                record.push('server.exited')
                resolve('exited')
              }
            })
          },
        },
      }
    }

    const order: string[] = []
    type LegReport = { name: string; done: number; total: number; failed: boolean }
    let prepareForInstall: ((report?: (leg: LegReport) => void) => Promise<void>) | null = null
    const first = serverDouble(order)
    registerAppLifecycle({
      diagnosticsEnabled: false,
      refreshHostedFeeds: async () => undefined,
      checkPluginSourceUpdates: async () => undefined,
      allowMultipleInstances: true,
      // A leg that fails must not cost the legs after it.
      canvasService: {
        dispose: async () => {
          order.push('canvas.dispose')
          throw new Error('canvas worker gone')
        },
      },
      // A recording an agent started is saved, with its length, before the
      // canvas's last write.
      browserRecorder: {
        stopAll: async () => {
          order.push('browserRecorder.stopAll')
        },
      },
      // The shell's client of its server closes before the server drains, so
      // the server's goodbye is not one it answers by reconnecting.
      desktopShell: { stop: () => void order.push('desktopShell.stop') },
      agentStateService: {
        shutdown: async () => {
          order.push('agentState.shutdown')
        },
      },
      analytics: {
        shutdown: async () => {
          order.push('analytics.shutdown')
        },
      },
      // A plain quit's, once no agent the app launched is left to run what it
      // takes out; never an update's.
      removeSessionIntegrations: async () => {
        order.push('integrations.remove')
      },
      server: first.server,
      updateService: {
        checkForUpdates: async () => undefined,
        setPrepareForInstall: (prepare: (report?: (leg: LegReport) => void) => Promise<void>) => {
          prepareForInstall = prepare
        },
      } as unknown as Parameters<typeof registerAppLifecycle>[0]['updateService'],
      handleAuthCallback: () => undefined,
    })

    const beforeQuit = appEvents.get('before-quit') ?? []
    assert.equal(beforeQuit.length, 1, 'quit is handled exactly once')

    // "Restart to update": the whole ordered shutdown runs before the installer
    // is started, and the app is not exited yet — the updater's quit does that.
    assert.ok(prepareForInstall, 'the lifecycle hands the update service its shutdown')
    const reports: LegReport[] = []
    const prepared = (prepareForInstall as (report?: (leg: LegReport) => void) => Promise<void>)((leg) =>
      reports.push(leg),
    )
    for (let pass = 0; pass < 50 && !order.includes('agentState.shutdown'); pass += 1)
      await new Promise((resolve) => setImmediate(resolve))
    // The chats, terminals, registry, pool and modules are the server's: it
    // drains them itself, while the shell's legs run.
    assert.deepEqual(order, [
      'browserRecorder.stopAll',
      'canvas.dispose',
      'desktopShell.stop',
      'server.shutdown',
      'agentState.shutdown',
    ])
    assert.ok((first.budgets[0] ?? 0) <= 6_000, "an update's drain fits inside its 10 s")
    first.gone()
    await prepared
    assert.deepEqual(exitCalls, [], 'the installer, not the shutdown, ends the process')
    // Every leg reports as it finishes, in order, which is what moves the
    // update progress window's bar; a leg that throws still reports, as failed.
    assert.deepEqual(
      reports.map((leg) => leg.done),
      reports.map((_, index) => index + 1),
    )
    assert.ok(reports.every((leg) => leg.total === reports.length))
    assert.deepEqual(
      reports.filter((leg) => leg.failed).map((leg) => leg.name),
      ['canvas'],
    )
    // Not the integrations' removal: the new build writes them straight back.
    assert.deepEqual(order.slice(5), ['server.exited', 'analytics.shutdown'])

    let prevented = 0
    beforeQuit[0]({
      preventDefault: () => {
        prevented += 1
      },
    })
    assert.equal(prevented, 1, 'the quit is held while the shutdown legs run')
    for (let pass = 0; pass < 50 && exitCalls.length === 0; pass += 1)
      await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(exitCalls, [0], 'the app still exits once every leg has run')
    assert.equal(
      order.filter((entry) => entry === 'server.shutdown').length,
      1,
      'the updater’s quit joins the shutdown already run instead of running it again',
    )

    // A plain quit: the shell's own legs run while the server drains, and the
    // integrations wait for the server to be gone.
    appEvents.clear()
    exitCalls = []
    const split: string[] = []
    const second = serverDouble(split)
    registerAppLifecycle({
      diagnosticsEnabled: false,
      allowMultipleInstances: true,
      refreshHostedFeeds: async () => undefined,
      checkPluginSourceUpdates: async () => undefined,
      desktopShell: { stop: () => void split.push('desktopShell.stop') },
      agentStateService: {
        shutdown: async () => {
          split.push('agentState.shutdown')
        },
      },
      removeSessionIntegrations: async () => {
        split.push('integrations.remove')
      },
      server: second.server,
      updateService: {
        checkForUpdates: async () => undefined,
        setPrepareForInstall: () => undefined,
      } as unknown as Parameters<typeof registerAppLifecycle>[0]['updateService'],
      handleAuthCallback: () => undefined,
    })
    const splitQuit = appEvents.get('before-quit') ?? []
    splitQuit[0]({ preventDefault: () => undefined })
    for (let pass = 0; pass < 50 && !split.includes('agentState.shutdown'); pass += 1)
      await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(split, ['desktopShell.stop', 'server.shutdown', 'agentState.shutdown'])
    assert.deepEqual(second.budgets, [8_000])
    assert.deepEqual(exitCalls, [], 'the app waits for the server')
    second.gone()
    for (let pass = 0; pass < 50 && exitCalls.length === 0; pass += 1)
      await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(split.slice(3), ['server.exited', 'integrations.remove'])
    assert.deepEqual(exitCalls, [0])

    // Leaving for an update, the drain's budget counts from the shutdown's
    // start, so its kill lands inside the update's 10 s.
    const { serverUpdateDrainBudgetMs } = await import('./app-lifecycle')
    assert.equal(serverUpdateDrainBudgetMs(0), 6_000)
    assert.equal(serverUpdateDrainBudgetMs(4_000), 4_500)
    assert.equal(serverUpdateDrainBudgetMs(30_000), 500)

    // A leg that never settles does not keep the app from quitting: past the
    // quit's budget it exits, and the diagnostics name the leg it left.
    appEvents.clear()
    exitCalls = []
    const { QUIT_SHUTDOWN_BUDGET_MS } = await import('./app-lifecycle')
    let hung = false
    const third = serverDouble([])
    registerAppLifecycle({
      diagnosticsEnabled: false,
      allowMultipleInstances: true,
      refreshHostedFeeds: async () => undefined,
      checkPluginSourceUpdates: async () => undefined,
      desktopShell: { stop: () => undefined },
      agentStateService: {
        shutdown: () => {
          hung = true
          return new Promise<void>(() => {})
        },
      },
      server: third.server,
      updateService: {
        checkForUpdates: async () => undefined,
        setPrepareForInstall: () => undefined,
      } as unknown as Parameters<typeof registerAppLifecycle>[0]['updateService'],
      handleAuthCallback: () => undefined,
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      appEvents.get('before-quit')?.[0]?.({ preventDefault: () => undefined })
      for (let pass = 0; pass < 50 && !hung; pass += 1) await new Promise((resolve) => setImmediate(resolve))
      assert.ok(hung, 'the agent-state leg is running')
      vi.advanceTimersByTime(QUIT_SHUTDOWN_BUDGET_MS - 1)
      for (let pass = 0; pass < 20; pass += 1) await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(exitCalls, [], 'the quit waits for the leg within its budget')
      vi.advanceTimersByTime(1)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => assert.deepEqual(exitCalls, [0], 'past the budget the app exits anyway'))
    const { getDiagnosticsLogDirectory } = await import('./diagnostics-service')
    const notes = readdirSync(getDiagnosticsLogDirectory())
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => readFileSync(join(getDiagnosticsLogDirectory(), name), 'utf8').trim().split('\n'))
      .map((line) => JSON.parse(line) as { title: string; message: string })
    assert.ok(
      notes.some((note) => note.message.includes('"agent state" shutdown step still running')),
      'the diagnostics name the leg the quit left running',
    )
  }

  const suiteRun = main()
    .then(() => console.log('app-lifecycle: all assertions passed'))
    .finally(() => {
      restoreModules()
      rmSync(appPath, { recursive: true, force: true })
    })

  await suiteRun
})
