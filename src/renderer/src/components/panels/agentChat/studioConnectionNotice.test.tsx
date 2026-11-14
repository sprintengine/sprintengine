import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'

import { installStudioLoopback, type StudioLoopback } from '../../../../../../tests/studio-chat-loopback'

// A chat on the Studio protocol says, in words, that its window's connection
// is being made again, and only once the drop has outlasted a blip; it says
// nothing once the connection is back, and nothing at all on the IPC.

afterEach(() => vi.unstubAllEnvs())

// Each step is its own `act`, so React draws what changed before the next look.
const until = async (check: () => boolean, what: string) => {
  const { act } = await import('react')
  for (let tries = 0; !check() && tries < 400; tries++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

type Ticket = () => Promise<{ url: string; token: string }>

test('a dropped connection is told in words after a moment, and the words go once it is back', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.assign(dom.window, { api: {} })
  const win = dom.window as unknown as { api: Record<string, unknown> }
  const loopback = installStudioLoopback(win) as StudioLoopback
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { StudioConnectionNotice } = await import('./studioConnectionNotice')
  const { windowStudioClient } = await import('../../../studio/windowStudioClient')
  const host = document.createElement('div')
  const root = createRoot(host)
  const client = await windowStudioClient(win.api as never)
  const parkedWords = 'This window lost its connection to Studio. It tries again the next time you use the chat.'
  try {
    await act(async () => root.render(createElement(StudioConnectionNotice, { graceMs: 150 })))
    expect(host.textContent).toBe('')

    // Studio stops answering: after the grace, the chat says it is reconnecting.
    const connect = win.api.studioWindowTicket as Ticket
    win.api.studioWindowTicket = async () => {
      throw new Error('Studio server is not running yet, so this window cannot reach its chats yet.')
    }
    await act(async () => loopback.drop())
    expect(host.textContent, 'a blip says nothing').toBe('')
    await until(() => host.textContent !== '', 'the reconnecting row')
    expect(host.textContent).toBe('Reconnecting to Studio… The chat picks up where it left off.')
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    // Back: the row goes.
    win.api.studioWindowTicket = connect
    await until(() => host.textContent === '', 'the row to go')

    // A ticket Studio refuses parks the window until it is next used, and says so.
    win.api.studioWindowTicket = async () => ({ ...(await connect()), token: 'seticket_not_the_ticket_000000' })
    await act(async () => loopback.drop())
    // It reconnects with the refused ticket first, then parks.
    await until(() => host.textContent === parkedWords, 'the parked row')
  } finally {
    // Nothing of this window is left to wake or draw once the test is done.
    await act(async () => root.unmount())
    client.close()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a page with no connection, or one that is open or still connecting, draws nothing', async () => {
  const { studioConnectionWords } = await import('./studioConnectionNotice')
  expect(studioConnectionWords(null)).toBeNull()
  expect(studioConnectionWords('open')).toBeNull()
  expect(studioConnectionWords('connecting')).toBeNull()
})

test('a window that could not reach Studio says when it tries again, not that it is reconnecting', async () => {
  const { studioConnectionWords } = await import('./studioConnectionNotice')
  expect(studioConnectionWords('unavailable')).toBe(
    'This window could not reach Studio. It tries again the next time you use the chat.',
  )
})

// A chat an SSH machine holds says how that machine stands, from the
// environment list, while this window's client of it is away: its message
// waits, it is not "Thinking…" at nobody.
test("a machine's chat says the machine is away and that a message waits, and says nothing once it is back", async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  type Connection = {
    state: 'up' | 'connecting' | 'offline' | 'signed-out' | 'unknown'
    detail: null
    lastReachedAt: null
  }
  const local = {
    environmentId: 'env-local',
    displayName: 'This Mac',
    routes: [{ kind: 'local' }],
    machine: { kind: 'local' },
    descriptor: null,
    connection: { state: 'up', detail: null, lastReachedAt: null },
    compatibility: 'compatible',
  }
  const machineEntry = (connection: Connection['state']) => ({
    ...local,
    environmentId: 'env-box',
    displayName: 'dev@build-box',
    routes: [{ kind: 'ssh', machine: 'm1' }],
    connection: { state: connection, detail: null, lastReachedAt: null },
  })
  let listed: unknown[] = [local, machineEntry('up')]
  const changed = new Set<() => void>()
  const relist = (next: unknown[]) => {
    listed = next
    for (const listener of [...changed]) listener()
  }
  Object.assign(dom.window, {
    api: {
      environmentsTicket: async () => ({ ok: false, code: 'unavailable', message: 'Not in this test.' }),
      environmentsList: async () => listed,
      onEnvironmentsChanged: (listener: () => void) => {
        changed.add(listener)
        return () => changed.delete(listener)
      },
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { StudioConnectionNotice } = await import('./studioConnectionNotice')
  const { createEnvironmentChatSource, followEnvironmentChats } = await import('../../../studio/environmentChats')
  const { resetEnvironmentsForTests } = await import('../../../hooks/useEnvironments')

  // The machine's Studio as this window's client reaches it.
  const states = new Set<(state: 'open' | 'reconnecting') => void>()
  const client = {
    state: 'open',
    welcome: { environment: { id: 'env-box' } },
    supports: () => true,
    request: async () => ({ ok: true, sessions: [] }),
    subscribe: () => () => undefined,
    closed: new Promise<void>(() => undefined),
  }
  const move = (state: 'open' | 'reconnecting') => {
    client.state = state
    for (const listener of [...states]) listener(state)
  }
  followEnvironmentChats([{ route: 'ssh:m1', name: 'dev@build-box' }], (target) =>
    createEnvironmentChatSource(target, {
      settleMs: 1,
      hold: () => ({
        client: Promise.resolve(client as never),
        onState: (listener) => {
          states.add(listener)
          return () => states.delete(listener)
        },
        release: () => undefined,
      }),
    }),
  )
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        createElement(StudioConnectionNotice, {
          graceMs: 20,
          environment: { route: 'ssh:m1', label: 'dev@build-box' },
        }),
      ),
    )
    await until(() => host.textContent === '', 'the machine to answer')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)))
    expect(host.textContent, 'a machine that answers says nothing').toBe('')

    // The machine drops: reconnecting, then not answering.
    await act(async () => {
      relist([local, machineEntry('connecting')])
      move('reconnecting')
    })
    await until(() => host.textContent !== '', 'the reconnecting row')
    expect(host.textContent).toBe('Connecting to dev@build-box… A message you send waits and goes once it answers.')
    await act(async () => relist([local, machineEntry('offline')]))
    await until(() => host.textContent?.startsWith('dev@build-box cannot') ?? false, 'the unreachable row')
    expect(host.textContent).toBe('dev@build-box cannot be reached. A message you send waits and goes once it is back.')

    // Its server stopped by hand: it waits for a connect.
    await act(async () => relist([local, machineEntry('unknown')]))
    await until(() => host.textContent?.includes('is not connected') ?? false, 'the not-connected row')
    expect(host.textContent).toBe(
      'dev@build-box is not connected. A message you send waits until it is connected again in Settings › Machines.',
    )

    // Forgotten: nothing waits for it any more.
    await act(async () => relist([local]))
    await until(() => host.textContent?.includes('no longer saved') ?? false, 'the forgotten row')
    expect(host.textContent).toBe(
      'dev@build-box is no longer saved in Settings › Machines, so this chat cannot reach it.',
    )

    // Back: the row goes.
    await act(async () => {
      relist([local, machineEntry('up')])
      move('open')
    })
    await until(() => host.textContent === '', 'the row to go')
  } finally {
    await act(async () => root.unmount())
    followEnvironmentChats([])
    resetEnvironmentsForTests()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('the words for each way a machine is away', async () => {
  const { environmentReachOf, environmentReachWords } = await import('../../../hooks/useEnvironmentReach')
  expect(environmentReachOf([], 'ssh:m1', 'box'), 'the list not read yet says nothing').toBeNull()
  expect(environmentReachOf([{ routes: [{ kind: 'local' }] } as never], null, 'box')).toBeNull()
  expect(
    environmentReachWords({ kind: 'up', name: 'box' }, false, 'box'),
    'a client that is open says nothing',
  ).toBeNull()
  expect(environmentReachWords({ kind: 'offline', name: 'box' }, false, 'box')).toBeNull()
  expect(environmentReachWords(null, true, 'box')).toBe(
    'Connecting to box… A message you send waits and goes once it answers.',
  )
  expect(environmentReachWords({ kind: 'signed-out', name: 'box' }, true, 'box')).toBe(
    'box turned this computer away. A message you send waits until it is let in again in Settings › Machines.',
  )
})
