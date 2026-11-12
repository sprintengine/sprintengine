import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  countWorkingTerminalAgents,
  createQuitConfirmation,
  QUIT_SIGNALS,
  QUIT_UNASKED_WINDOW_MS,
  quitConfirmationDetail,
  QUIT_SIGNAL_SAME_QUIT_MS,
  registerUnaskedQuits,
  type QuitConfirmationAnswer,
  type QuitConfirmationDeps,
  type QuitStopping,
} from './quit-confirmation'

function harness(
  overrides: Partial<QuitConfirmationDeps> & { count?: number; schedules?: string[]; watches?: string[] } = {},
) {
  let enabled = true
  const asked: Array<{ stopping: QuitStopping; signal: AbortSignal }> = []
  let answer: (value: QuitConfirmationAnswer) => void = () => undefined
  const confirmation = createQuitConfirmation({
    isEnabled: () => enabled,
    stopAsking: () => {
      enabled = false
    },
    whatQuitStops: async () => ({
      agents: overrides.count ?? 2,
      schedules: overrides.schedules ?? [],
      watches: overrides.watches ?? [],
    }),
    ask: (input) => {
      asked.push(input)
      return new Promise((resolve) => {
        answer = resolve
        input.signal.addEventListener('abort', () => resolve({ quit: false, dontAskAgain: false }))
      })
    },
    ...overrides,
  })
  return {
    confirmation,
    asked,
    answer: (value: QuitConfirmationAnswer) => answer(value),
    isEnabled: () => enabled,
    setEnabled: (next: boolean) => {
      enabled = next
    },
  }
}

// The dialog is put up after the count, a microtask or two away.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test('nothing working: the quit goes straight through, unasked', async () => {
  const h = harness({ count: 0 })
  assert.equal(await h.confirmation.confirm(), 'quit')
  assert.equal(h.asked.length, 0)
})

test('the switch off: never counted, never asked', async () => {
  let counted = false
  const h = harness({
    whatQuitStops: async () => {
      counted = true
      return { agents: 3, schedules: [], watches: [] }
    },
  })
  h.setEnabled(false)
  assert.equal(await h.confirmation.confirm(), 'quit')
  assert.equal(counted, false)
  assert.equal(h.asked.length, 0)
})

test('agents working: asks with the count, and Cancel keeps the app', async () => {
  const h = harness({ count: 3 })
  const decision = h.confirmation.confirm()
  await settle()
  assert.equal(h.asked.length, 1)
  assert.equal(h.asked[0]?.stopping.agents, 3)
  h.answer({ quit: false, dontAskAgain: false })
  assert.equal(await decision, 'stay')
  // Cancelled is not settled: the next quit asks again.
  const again = h.confirmation.confirm()
  await settle()
  assert.equal(h.asked.length, 2)
  h.answer({ quit: true, dontAskAgain: false })
  assert.equal(await again, 'quit')
  assert.equal(h.isEnabled(), true)
})

test('"Don\'t ask again" on Quit turns the switch off; on Cancel it does not', async () => {
  const cancelled = harness()
  const first = cancelled.confirmation.confirm()
  await settle()
  cancelled.answer({ quit: false, dontAskAgain: true })
  assert.equal(await first, 'stay')
  assert.equal(cancelled.isEnabled(), true)

  const quit = harness()
  const second = quit.confirmation.confirm()
  await settle()
  quit.answer({ quit: true, dontAskAgain: true })
  assert.equal(await second, 'quit')
  assert.equal(quit.isEnabled(), false)
})

test('a second quit while the question is up is the same question', async () => {
  const h = harness()
  const first = h.confirmation.confirm()
  await settle()
  assert.equal(await h.confirmation.confirm(), 'pending')
  assert.equal(h.asked.length, 1)
  h.answer({ quit: true, dontAskAgain: false })
  assert.equal(await first, 'quit')
})

test('an answered Quit is settled: the before-quit after the last window closes is not asked again', async () => {
  const h = harness()
  const first = h.confirmation.confirm()
  await settle()
  h.answer({ quit: true, dontAskAgain: false })
  assert.equal(await first, 'quit')
  assert.equal(await h.confirmation.confirm(), 'quit')
  assert.equal(h.asked.length, 1)
})

test('an update, relaunch or OS shutdown quits without asking', async () => {
  const h = harness({ count: 5 })
  h.confirmation.quitWithoutAsking()
  assert.equal(await h.confirmation.confirm(), 'quit')
  assert.equal(h.asked.length, 0)
})

test('the OS shutting down takes a question already up down, answered as Quit', async () => {
  const h = harness()
  const decision = h.confirmation.confirm()
  await settle()
  assert.equal(h.asked[0]?.signal.aborted, false)
  h.confirmation.quitWithoutAsking()
  assert.equal(h.asked[0]?.signal.aborted, true)
  assert.equal(await decision, 'quit')
})

test('a quit nobody asked about that does not happen gives asking back', async () => {
  // A Windows logout another app cancels: `query-session-end` and nothing
  // after it, with the process still running.
  const timers: Array<{ run: () => void; ms: number; cleared: boolean; unref: () => void }> = []
  const h = harness({
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false, unref: () => undefined }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      ;(timer as (typeof timers)[number]).cleared = true
    },
  })
  h.confirmation.quitWithoutAsking()
  assert.equal(await h.confirmation.confirm(), 'quit', 'unasked inside the window')
  // A second unasked quit restarts the window rather than stacking two.
  h.confirmation.quitWithoutAsking()
  assert.equal(timers.length, 2)
  assert.equal(timers[0]?.cleared, true)
  assert.equal(timers[1]?.ms, QUIT_UNASKED_WINDOW_MS)
  timers[1]?.run()
  const decision = h.confirmation.confirm()
  await settle()
  assert.equal(h.asked.length, 1, "the person's next quit is asked again")
  h.answer({ quit: false, dontAskAgain: false })
  assert.equal(await decision, 'stay')
})

function unaskedQuits(platform: NodeJS.Platform) {
  const calls = { quitWithoutAsking: 0, quit: 0, exit: 0 }
  const clock = { now: 1_000 }
  const windowListeners = new Map<string, () => void>()
  const signals = new Map<string, () => void>()
  let systemShutdown: (() => void) | null = null
  registerUnaskedQuits({
    platform,
    quitConfirmation: {
      quitWithoutAsking: () => {
        calls.quitWithoutAsking += 1
      },
    },
    quit: () => {
      calls.quit += 1
    },
    exit: () => {
      calls.exit += 1
    },
    now: () => clock.now,
    onWindowCreated: (listener) => listener({ on: (event, run) => void windowListeners.set(event, run) }),
    onSystemShutdown: (listener) => {
      systemShutdown = listener
    },
    onSignal: (signal, listener) => void signals.set(signal, listener),
  })
  return { calls, clock, windowListeners, signals, systemShutdown: () => systemShutdown?.() }
}

test("a power-off on macOS or Linux is the OS's quit: unasked, and the quit is left to the OS", () => {
  const quits = unaskedQuits('darwin')
  quits.systemShutdown()
  assert.equal(quits.calls.quitWithoutAsking, 1)
  assert.equal(quits.calls.quit, 0)
})

test('a signal quits at once, unasked, through the ordinary quit; signals right after it join it', () => {
  const quits = unaskedQuits('linux')
  assert.deepEqual([...quits.signals.keys()], [...QUIT_SIGNALS])
  quits.signals.get('SIGTERM')?.()
  assert.equal(quits.calls.quitWithoutAsking, 1)
  assert.equal(quits.calls.quit, 1)
  // A logout sends SIGHUP and SIGTERM together: one quit.
  quits.clock.now += 50
  quits.signals.get('SIGHUP')?.()
  quits.clock.now += QUIT_SIGNAL_SAME_QUIT_MS - 50
  quits.signals.get('SIGINT')?.()
  assert.equal(quits.calls.quit, 1)
  assert.equal(quits.calls.exit, 0)
})

test('a signal sent again after the shutdown has had its moment exits at once', () => {
  const quits = unaskedQuits('darwin')
  quits.signals.get('SIGINT')?.()
  assert.equal(quits.calls.quit, 1)
  // The shutdown hangs, and Ctrl+C is pressed again.
  quits.clock.now += QUIT_SIGNAL_SAME_QUIT_MS + 1
  quits.signals.get('SIGINT')?.()
  assert.equal(quits.calls.exit, 1)
  assert.equal(quits.calls.quit, 1, 'not a second ordered shutdown')
  quits.signals.get('SIGTERM')?.()
  assert.equal(quits.calls.exit, 2)
})

test('Windows has no signals to listen for, and says a logout on every window', () => {
  const quits = unaskedQuits('win32')
  assert.equal(quits.signals.size, 0)
  quits.windowListeners.get('query-session-end')?.()
  quits.windowListeners.get('session-end')?.()
  assert.equal(quits.calls.quitWithoutAsking, 2)
  assert.equal(quits.calls.quit, 0)
})

test('a count or a dialog that fails never keeps the person in the app', async () => {
  const noCount = harness({
    whatQuitStops: async () => {
      throw new Error('server gone')
    },
  })
  assert.equal(await noCount.confirmation.confirm(), 'quit')

  const noDialog = harness({ ask: async () => Promise.reject(new Error('no display')) })
  assert.equal(await noDialog.confirmation.confirm(), 'quit')
})

test('terminal agents count while a turn is under way or waiting on the person', () => {
  const agent = (extra: Record<string, unknown>) => ({
    kind: 'agent' as const,
    processAlive: true,
    suspended: false,
    activity: { kind: 'idle' as const, since: 1 },
    ...extra,
  })
  const phase = (value: string) => ({ agentState: { phase: value, since: 1, source: 'hook' } })
  const sessions = [
    agent(phase('thinking')),
    agent(phase('tool_use')),
    agent(phase('awaiting_input')),
    agent(phase('starting')),
    // A finished turn, a dead process, a parked one, a plain shell: nothing to stop.
    agent(phase('idle')),
    agent({ ...phase('thinking'), processAlive: false }),
    agent({ ...phase('thinking'), suspended: true }),
    { ...agent({}), kind: 'terminal' as const, activity: { kind: 'working' as const, since: 1 } },
    // A CLI with no hooks: its activity is the only word on it.
    agent({ activity: { kind: 'working', since: 1 } }),
    agent({}),
  ]
  assert.equal(countWorkingTerminalAgents(sessions as never), 5)
})

test('the question says how many', () => {
  const agents = (count: number) => ({ agents: count, schedules: [], watches: [] })
  assert.equal(quitConfirmationDetail(agents(1)), '1 agent is still working. Quitting stops it.')
  assert.equal(quitConfirmationDetail(agents(3)), '3 agents are still working. Quitting stops them.')
})

test('nothing working, but schedules or watches would stop: asked, naming them (owner ruling)', async () => {
  const h = harness({ count: 0, schedules: ['Nightly triage'], watches: ['Fix the login (WSL: Ubuntu)'] })
  void h.confirmation.confirm()
  await settle()
  assert.deepEqual(h.asked[0]?.stopping, {
    agents: 0,
    schedules: ['Nightly triage'],
    watches: ['Fix the login (WSL: Ubuntu)'],
  })
  h.answer({ quit: true, dontAskAgain: false })
})

test('the question names the schedules and watches that stop, and how many more', () => {
  assert.equal(
    quitConfirmationDetail({ agents: 0, schedules: ['Nightly triage'], watches: [] }),
    'Quitting also stops the schedule “Nightly triage” until SprintEngine Studio opens again.',
  )
  assert.equal(
    quitConfirmationDetail({
      agents: 2,
      schedules: ['Triage, then report', 'Standup'],
      watches: ['Fix the login', 'Bump deps', 'Docs', 'Release notes'],
    }),
    '2 agents are still working. Quitting stops them.\n\n' +
      'Quitting also stops the schedules “Triage, then report” and “Standup” and the watches on ' +
      '“Fix the login”, “Bump deps”, “Docs” and 1 more until SprintEngine Studio opens again.',
  )
})
