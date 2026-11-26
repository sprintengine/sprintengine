import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test, vi } from 'vitest'
import { terminalsDouble } from '../../studio/terminals.double'

vi.mock('../../studio/terminals', () => import('../../studio/terminals.double'))

test('WorkspaceSidebar.machineScheduled', async () => {
  // A schedule made for a project on an SSH machine is handed over to that
  // machine, whose scheduler runs it from then on. It stays in the Scheduled
  // section all the same: read from the machine's own Studio, over this
  // window's route to it, as the machine's chats are, wearing the machine's
  // mark, and run, paused and closed there. A machine forgotten in Settings ›
  // Machines takes its rows with it.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

  const createdAt = Date.now()
  terminalsDouble.listTerminals = async () => []
  terminalsDouble.onTerminalSessionsDelta = () => () => {}
  terminalsDouble.closeTerminal = async () => {}
  const local = {
    environmentId: 'env-local',
    displayName: 'This Mac',
    routes: [{ kind: 'local' }],
    machine: { kind: 'local' },
    descriptor: null,
    connection: { state: 'up', detail: null, lastReachedAt: null },
    compatibility: 'compatible',
  }
  const machine = {
    ...local,
    environmentId: 'env-box',
    displayName: 'dev@build-box',
    routes: [{ kind: 'ssh', machine: 'm1' }],
    machine: { kind: 'ssh', host: 'build-box' },
  }
  // A machine not answering is not asked: its schedules wait until it is back.
  const asleep = {
    ...machine,
    environmentId: 'env-asleep',
    displayName: 'asleep-box',
    routes: [{ kind: 'ssh', machine: 'm2' }],
    machine: { kind: 'ssh', host: 'asleep-box' },
    connection: { state: 'offline', detail: null, lastReachedAt: null },
  }
  // A paired desktop is listed the same way, by its route, whatever kind of machine it is.
  const desk = {
    ...machine,
    environmentId: 'env-desk',
    displayName: 'mac-mini',
    routes: [{ kind: 'tailnet', connection: 'c1' }],
    machine: { kind: 'paired', name: 'mac-mini' },
  }
  let environments: unknown[] = [local, machine, asleep]
  const environmentsChanged = new Set<() => void>()
  domWindow.api = {
    platform: 'darwin',
    detectProjectLogo: async () => null,
    getWorkspaceChangeSummary: async () => null,
    // Nothing of this computer's is scheduled: the desktop handed it over.
    listScheduledAgents: async () => [],
    onScheduledAgentsChanged: () => () => {},
    environmentsList: async () => environments,
    onEnvironmentsChanged: (listener: () => void) => {
      environmentsChanged.add(listener)
      return () => environmentsChanged.delete(listener)
    },
  }
  // The machine's Studio, as this window's own client of it reaches it.
  const { fakePairedStudios } = await import('../../studio/environmentStudio.double')
  const studio = fakePairedStudios(domWindow.api as object, {
    'session.list': () => ({ sessions: [] }),
    // The paired desktop holds none: the box's are what the section shows.
    'schedules.list': (_params, connectionId) =>
      connectionId === 'c1'
        ? { schedules: [], pausedAll: null }
        : {
            schedules: [
              {
                id: 'sa-box',
                prompt: 'Triage the build',
                schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' },
                folderPath: '/home/dev/proj',
                cli: 'opencode',
                createdAt,
                updatedAt: createdAt,
                nextRunAt: createdAt + 60 * 60 * 1000,
              },
            ],
            pausedAll: null,
          },
    'schedules.runNow': () => ({ workspaceId: 'run-1' }),
    'schedules.pauseAll': (params) => ({ pausedAll: { since: createdAt, until: params.until } }),
  })
  const { followEnvironmentChats } = await import('../../studio/environmentChats')

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceSidebar } = await import('./WorkspaceSidebar')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  useWorkspaceStore.setState({ chatListView: 'projects' })
  type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
  type Workspace = SidebarProps['workspaces'][number]
  // A chat on the machine: the window follows the machine's chats for it.
  const workspaces = [
    {
      id: 'w-box',
      name: 'On the box',
      mode: 'standard',
      folderPath: 'ssh://m1/home/dev/proj',
      environment: { kind: 'ssh', id: 'm1', label: 'dev@build-box' },
      createdAt,
    } as unknown as Workspace,
  ]
  followEnvironmentChats([{ route: 'ssh:m1', name: 'dev@build-box' }])

  const noop = () => {}
  const opened: Array<[string, string]> = []
  const props = {
    workspaces,
    workspaceWindowId: 'win1',
    isDetachedWindow: false,
    sidebarCollapsed: false,
    chromeSlot: null,
    residentWorkspaceIds: new Set<string>(),
    activeWorkspaceId: 'w-box',
    activityByWorkspaceId: {},
    terminalRecencyByWorkspaceId: {},
    onSelectWorkspace: noop,
    onMoveWorkspaceToNewWindow: noop,
    onMoveWorkspaceToMainWindow: noop,
    onForgetFolder: noop,
    onNewChat: noop,
    onNewChatInFolder: noop,
    onRevealFolder: noop,
    onOpenScheduledAgent: noop,
    onOpenRemoteScheduledAgent: (route: string, id: string) => opened.push([route, id]),
    onSetSidebarCollapsed: noop,
    sidebarWidth: 260,
    onSetSidebarWidth: noop,
    authState: { authenticated: false },
    authMessage: null,
    accountOpen: false,
    setAccountOpen: noop,
    startLogin: noop,
    refreshAuthState: noop,
    logout: noop,
    openSettings: noop,
    settingsOpen: false,
  } as unknown as SidebarProps

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 8; round += 1) {
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 5))
      act(() => {})
    }
  }
  const scheduledRows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-scheduled-agent]')]

  try {
    act(() => {
      root.render(React.createElement(WorkspaceSidebar, props))
    })
    await settle()

    // The machine's schedule is listed, read from the machine on its route.
    assert.deepEqual(
      scheduledRows().map((row) => row.dataset.scheduledAgent),
      ['sa-box'],
    )
    assert.ok(studio.calls.some((call) => call.connectionId === 'ssh:m1' && call.method === 'schedules.list'))
    assert.ok(
      !studio.calls.some((call) => call.connectionId === 'ssh:m2'),
      'a machine that is not answering is not asked',
    )
    const row = (): HTMLElement => scheduledRows()[0]!
    assert.match(
      row().getAttribute('aria-label') ?? '',
      /in proj on dev@build-box/u,
      'it names its project and machine',
    )

    // One the machine says it now holds (handed over from this desktop, made
    // there) shows as the machine pushes its list, with no read asked for it.
    const reads = studio.calls.filter((call) => call.method === 'schedules.list').length
    act(() => {
      studio.push('schedules.changed', {
        schedules: [
          {
            id: 'sa-box',
            prompt: 'Triage the build',
            schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' },
            folderPath: '/home/dev/proj',
            cli: 'opencode',
          },
          {
            id: 'sa-handed',
            prompt: 'Sweep the logs',
            schedule: { cron: '0 18 * * *', timezone: 'UTC' },
            folderPath: '/home/dev/proj',
            cli: 'opencode',
          },
        ],
        pausedAll: null,
      })
    })
    await settle()
    assert.deepEqual(
      scheduledRows().map((each) => each.dataset.scheduledAgent),
      ['sa-box', 'sa-handed'],
      'a schedule the machine pushes is listed at once',
    )
    assert.equal(studio.calls.filter((call) => call.method === 'schedules.list').length, reads, 'from the push itself')

    // Run now runs it on the machine.
    act(() => {
      row().dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    await settle()
    const runNow = [...dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === 'Run now',
    )
    assert.ok(runNow, 'its menu offers Run now')
    const opens = [...dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
      item.textContent?.trim(),
    )
    assert.ok(opens.includes('Open'), "a machine's schedule opens in the editor, to be saved there")
    act(() => {
      runNow.click()
    })
    await settle()
    assert.deepEqual(
      studio.writes().map(({ connectionId, method, params }) => ({ connectionId, method, params })),
      [{ connectionId: 'ssh:m1', method: 'schedules.runNow', params: { id: 'sa-box' } }],
    )
    // Opened, it is addressed to its machine by its route.
    act(() => {
      row().dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    await settle()
    act(() => {
      ;[...dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.trim() === 'Open')
        ?.click()
    })
    await settle()
    assert.ok(opened.length > 0, 'it opens')
    assert.ok(
      opened.every(([route, id]) => route === 'ssh:m1' && id === 'sa-box'),
      'opened on its machine, by its route',
    )

    // Pause all pauses the machine's schedules too, not only this device's.
    const pausedHere: Array<number | null> = []
    // The same bridge, which the machine's double stands behind.
    ;(domWindow.api as Record<string, unknown>).pauseAllScheduledAgents = async (until: number | null) => {
      pausedHere.push(until)
      return { ok: true, pause: { since: createdAt, until } }
    }
    const writesBefore = studio.writes().length
    const pauseAll = container.querySelector<HTMLElement>('[aria-label="Pause all scheduled agents"]')
    assert.ok(pauseAll, 'the section offers Pause all')
    act(() => {
      pauseAll.click()
    })
    await settle()
    const untilResumed = [...dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('Until I resume them'),
    )
    assert.ok(untilResumed, 'until resumed is offered')
    act(() => {
      untilResumed.click()
    })
    await settle()
    assert.deepEqual(pausedHere, [null], 'this device is paused')
    assert.deepEqual(
      studio.writes().slice(writesBefore),
      [{ connectionId: 'ssh:m1', method: 'schedules.pauseAll', params: { until: null } }],
      'and so is the machine it owns',
    )

    // Forgotten in Settings › Machines: its schedules go with it.
    environments = [local]
    act(() => {
      for (const listener of [...environmentsChanged]) listener()
    })
    await settle()
    assert.equal(scheduledRows().length, 0, "a forgotten machine's schedules are not listed")

    // A paired desktop that comes to answer is asked on its route, as any other machine is.
    environments = [local, desk]
    act(() => {
      for (const listener of [...environmentsChanged]) listener()
    })
    await settle()
    assert.ok(
      studio.calls.some((call) => call.connectionId === 'c1' && call.method === 'schedules.list'),
      'a paired desktop is asked on its route, as any other machine is',
    )

    // A machine whose first read did not answer, then pushes its list: it is
    // read again whole, so its rows carry what this desktop may do there.
    const late = {
      ...machine,
      environmentId: 'env-late',
      displayName: 'late-box',
      routes: [{ kind: 'ssh', machine: 'm3' }],
    }
    const answer = studio.answers['schedules.list']!
    let refused = 1
    studio.answers['schedules.list'] = (params, connectionId) => {
      if (connectionId === 'ssh:m3' && refused-- > 0) throw new Error('late-box did not answer in time.')
      return answer(params, connectionId)
    }
    environments = [local, late]
    act(() => {
      for (const listener of [...environmentsChanged]) listener()
    })
    await settle()
    const lateReads = () =>
      studio.calls.filter((call) => call.connectionId === 'ssh:m3' && call.method === 'schedules.list').length
    assert.equal(lateReads(), 1, 'asked once, and it did not answer')
    act(() => {
      studio.push('schedules.changed', { schedules: [], pausedAll: null })
    })
    await settle()
    assert.equal(lateReads(), 2, 'its push is read again whole, for what this desktop may do there')
    assert.ok(
      scheduledRows().some((row) => row.dataset.scheduledAgent === 'sa-box'),
      'and its schedules are listed from that read',
    )
  } finally {
    act(() => {
      root.unmount()
    })
    followEnvironmentChats([])
  }
})
