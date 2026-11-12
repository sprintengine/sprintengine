// When scheduled agents run. One timer, armed for the soonest next run across
// every scheduled agent, re-armed after each run and whenever the list changes.
//
// Missed runs: a schedule that came round while the app was closed is not
// replayed — the next run is counted from start-up. One that came round while
// the computer slept, with the app open, runs once on waking: the timer was
// armed for it, and a run late by the length of a nap is still the run the
// person asked for. Several missed times of the same schedule run once, not
// once each.
//
// Runs never overlap. A run is skipped, scheduled or asked for, while the
// schedule's previous run is still starting or its chat is still working: a
// schedule that comes round faster than its runs finish would otherwise stack
// chats doing the same job on the same checkout. A skipped time is not queued —
// the next one counts on from it, as a missed one does.
//
// A run is written down before it makes anything, under the command id its
// first message goes under (`ScheduledRunRecord`, in the store), and its
// outcome is recorded in the same write that says what became of it. The
// store, not this process's memory, says a run is still starting: a time that
// comes round then is skipped as `starting`. What a start does with a run the
// last process left on its way is `run-recovery.ts`'s.
//
// A one-time schedule is the exception to "missed runs are not replayed": it
// is one message the person asked to have sent, and late is closer to that
// than never, so one whose time passed while the app was closed runs once the
// app is open. It runs once — the scheduler never arms it again after firing.
// For the same reason a one-time schedule is never skipped: one that comes due
// while a run of it is still starting or working (a Run now pressed before its
// time) waits, and is looked at again every little while until that run's chat
// rests, then runs.
//
// A paused schedule — paused on its own (`pausedAt`), or with all the others
// (`pausedAll`) — has no due time. Its timer is let go of when the pause comes,
// not checked when it fires, so a computer waking from a sleep finds nothing
// of it due. Resumed, it counts from then, as a changed schedule does: the
// times that passed while it was paused are not made up, however many there
// were, and it runs next at its first time after the resume. (A one-time
// schedule whose time passed while it was paused is the exception above once
// more: it runs once on resuming, late rather than never.) Run now runs a
// paused schedule, because a person asked for that run; and a run already
// going when the pause comes carries on, because pausing is about the times
// still to come.
//
// A schedule this machine cannot run now waits (`waitingFor`: a CLI not signed
// in here, an extension that owns it absent). Its time is skipped as `waiting`,
// which is not a failed run: nothing was tried. A one-time schedule waits
// instead, looked at again every little while, and runs once it can.
//
// A pause of everything until a time ends at that time. The timer is armed for
// it as for a run, and the time is read from the store, so one that ends while
// the app is closed has ended by the next start.

import { randomUUID } from 'node:crypto'

import type { ScheduledRunRecord } from './store'
import {
  nextScheduledAgentRun,
  scheduledAgentOnceDue,
  type ScheduledAgent,
  scheduledAgentsPauseHolds,
  type ScheduledAgentLastRun,
  type ScheduledAgentsPause,
} from '../../shared/scheduled-agents'

// A timer longer than this is re-armed rather than trusted: a changed clock or
// a long sleep moves what "the soonest run" means, and setTimeout's own limit
// is about 24.8 days.
const MAX_TIMER_MS = 60 * 60 * 1000
// How often a one-time schedule waiting on its earlier run is looked at again.
const ONCE_WAIT_MS = 30 * 1000

/**
 * Why a run did not start at all: it was never tried, so it is not a failed
 * run. `stopped`: the scheduler stopped (the app is quitting) while the run
 * was on its way, and it was called off before its chat started.
 */
export type ScheduledAgentRunRefusal = 'unknown' | 'starting' | 'still_working' | 'stopped' | 'waiting'

export type ScheduledAgentFireResult =
  | { ok: true; run: ScheduledAgentLastRun }
  /** `waiting` names what the machine lacks, in words. */
  | { ok: false; refused: ScheduledAgentRunRefusal; waiting?: string }

export type ScheduledAgentsSchedulerDeps = {
  list: () => ScheduledAgent[]
  /**
   * Start a run under `commandId`, the id it was written down under. `signal`
   * aborts when the scheduler stops: a run not yet launched is called off.
   */
  run: (agent: ScheduledAgent, signal: AbortSignal, commandId: string) => Promise<ScheduledAgentLastRun>
  /**
   * A run begins: written down under its command id before it makes anything.
   * False when a run of the same schedule is still starting.
   */
  beginRun: (commandId: string, run: ScheduledRunRecord) => Promise<boolean>
  /** A run called off before it tried anything: its record goes, and nothing is recorded for it. */
  endRun: (commandId: string) => Promise<void>
  /** A run's outcome, written with what became of its record (`ScheduledAgentsStore.recordRun`). */
  recordRun: (id: string, run: ScheduledAgentLastRun, commandId: string) => Promise<void>
  onRan?: (agent: ScheduledAgent, run: ScheduledAgentLastRun) => void
  /**
   * Whether the chat a run started is still working — a turn open, or one
   * waiting on a person. Absent, a run that has started is taken as done.
   */
  isRunWorking?: (workspaceId: string) => boolean
  /**
   * Why this machine cannot run the schedule now, in words ("Codex is not
   * signed in on build-box"); null when it can. Absent, every schedule can.
   */
  waitingFor?: (agent: ScheduledAgent) => string | null
  /** A time came round and its run was skipped, and why (`detail`: what it waits for). */
  onSkipped?: (
    agent: ScheduledAgent,
    reason: Exclude<ScheduledAgentRunRefusal, 'unknown' | 'stopped'>,
    detail?: string,
  ) => void
  /** Something went wrong around a run that has no caller to tell: recording it, or saying it ran. */
  log?: (message: string) => void
  /** Every scheduled agent paused at once, and until when; absent or null, none is. */
  pausedAll?: () => ScheduledAgentsPause | null
  /** That pause came to its until: whoever keeps it lets it go. Said once for each. */
  onPauseAllEnded?: (pause: ScheduledAgentsPause) => void
  now?: () => number
  /** The command id a run goes under. Injected so tests get stable ids. */
  newCommandId?: () => string
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type ScheduledAgentsScheduler = {
  start(): void
  stop(): void
  /** The list changed, or the computer woke: work out the due times again. */
  refresh(): void
  /** When each scheduled agent runs next, as the scheduler will fire it. */
  nextRunAt(id: string): number | null
  isRunning(): boolean
  runNow(id: string): Promise<ScheduledAgentFireResult>
}

export function createScheduledAgentsScheduler(deps: ScheduledAgentsSchedulerDeps): ScheduledAgentsScheduler {
  const now = deps.now ?? Date.now
  const newCommandId = deps.newCommandId ?? (() => `scheduled-run:${randomUUID()}`)
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let running = false
  let timer: unknown = null
  // Each agent's due time, counted forward from when it was last scheduled —
  // never recomputed from "now" on a refresh, or a run due during a sleep
  // would be skipped the moment the computer woke and refreshed.
  const dueAt = new Map<
    string,
    { at: number | null; cron: string; timezone: string; once: number | undefined; paused: boolean }
  >()
  // Aborted by stop: a run on its way when the app quits starts no chat.
  let stopping = new AbortController()
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

  const dueFor = (agent: ScheduledAgent, after: number): number | null =>
    agent.schedule.once !== undefined ? scheduledAgentOnceDue(agent) : nextScheduledAgentRun(agent.schedule, after)
  const pausedAll = (): ScheduledAgentsPause | null => deps.pausedAll?.() ?? null
  const isPaused = (agent: ScheduledAgent, at: number): boolean =>
    agent.pausedAt !== undefined || scheduledAgentsPauseHolds(pausedAll(), at)
  // The until of the pause last said to have ended, so it is said once.
  let endedUntil: number | null = null
  const endPauseIfDue = (at: number): void => {
    const pause = pausedAll()
    if (!pause || pause.until === null || pause.until > at || endedUntil === pause.until) return
    endedUntil = pause.until
    deps.onPauseAllEnded?.(pause)
  }

  const reconcile = (): void => {
    const agents = deps.list()
    const ids = new Set(agents.map((agent) => agent.id))
    for (const id of [...dueAt.keys()]) if (!ids.has(id)) dueAt.delete(id)
    const at = now()
    for (const agent of agents) {
      const known = dueAt.get(agent.id)
      const paused = isPaused(agent, at)
      // A new agent, one whose schedule changed, or one just resumed, counts
      // from now; one just paused has no due time at all.
      if (
        !known ||
        known.cron !== agent.schedule.cron ||
        known.timezone !== agent.schedule.timezone ||
        known.once !== agent.schedule.once ||
        known.paused !== paused
      ) {
        dueAt.set(agent.id, {
          at: paused ? null : dueFor(agent, at),
          cron: agent.schedule.cron,
          timezone: agent.schedule.timezone,
          once: agent.schedule.once,
          paused,
        })
      }
    }
  }

  const arm = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (!running) return
    let soonest: number | null = null
    for (const entry of dueAt.values()) {
      if (entry.at !== null && (soonest === null || entry.at < soonest)) soonest = entry.at
    }
    // A pause of everything that ends is woken for like a run: at its end the
    // schedules count on from then.
    const until = pausedAll()?.until ?? null
    if (until !== null && until > now() && (soonest === null || until < soonest)) soonest = until
    if (soonest === null) return
    const delay = Math.max(0, Math.min(soonest - now(), MAX_TIMER_MS))
    timer = setTimer(tick, delay)
  }

  const fire = async (agent: ScheduledAgent): Promise<ScheduledAgentFireResult> => {
    const waiting = deps.waitingFor?.(agent) ?? null
    if (waiting) return { ok: false, refused: 'waiting', waiting }
    const previous = agent.lastRun
    if (previous?.ok && deps.isRunWorking?.(previous.workspaceId)) return { ok: false, refused: 'still_working' }
    // Written down before anything is made, with what its first message says,
    // so a start after a crash can finish it. A store that cannot be written
    // is said, and the run goes as it would have: only its record is lost.
    const commandId = newCommandId()
    const skills = agent.skills.map((skill) => skill.id)
    const begun = await deps
      .beginRun(commandId, {
        scheduledAgentId: agent.id,
        startedAt: now(),
        prompt: agent.prompt,
        ...(skills.length > 0 ? { skills } : {}),
      })
      .catch((error: unknown) => {
        deps.log?.(`A scheduled agent's run could not be written down as started: ${describe(error)}`)
        return true
      })
    if (!begun) return { ok: false, refused: 'starting' }
    const signal = stopping.signal
    const run = await deps.run(agent, signal, commandId).catch((error: unknown): ScheduledAgentLastRun => ({
      at: now(),
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))
    // Called off by the stop before its chat started: nothing was tried, so
    // nothing is recorded, and a one-time schedule runs at the next start.
    if (signal.aborted && !run.ok) {
      await deps.endRun(commandId).catch((error: unknown) => {
        deps.log?.(`A scheduled agent's called-off run could not be let go of: ${describe(error)}`)
      })
      return { ok: false, refused: 'stopped' }
    }
    // The run happened whether or not it could be written down. A scheduled
    // agent closed while its run was starting is gone; the store records
    // nothing against it, and keeps the run's own record to its end.
    await deps.recordRun(agent.id, run, commandId).catch((error: unknown) => {
      deps.log?.(`A scheduled agent's run could not be recorded: ${describe(error)}`)
    })
    deps.onRan?.(agent, run)
    return { ok: true, run }
  }

  /**
   * A one-time schedule refused because a run of it is still starting or
   * working, or because this machine cannot run it yet, is due again shortly, not never: the entry is its own until the
   * schedule is changed, paused or closed, and reconcile replaces it then.
   */
  const waitOnEarlierRun = (id: string, entry: NonNullable<ReturnType<typeof dueAt.get>>): void => {
    if (!running || dueAt.get(id) !== entry || entry.at !== null) return
    entry.at = now() + ONCE_WAIT_MS
    arm()
  }

  function tick(): void {
    timer = null
    if (!running) return
    reconcile()
    const at = now()
    endPauseIfDue(at)
    for (const agent of deps.list()) {
      const entry = dueAt.get(agent.id)
      if (!entry || entry.at === null || entry.at > at) continue
      // The next time counts from now, so every time missed in a long sleep
      // collapses into the one run below. A one-time schedule has no next.
      const once = agent.schedule.once !== undefined
      entry.at = once ? null : dueFor(agent, at)
      // Nobody awaits a timed run: whatever goes wrong around it is logged,
      // never left as an unhandled rejection.
      void fire(agent)
        .then((fired) => {
          if (fired.ok || fired.refused === 'unknown' || fired.refused === 'stopped') return
          if (once) waitOnEarlierRun(agent.id, entry)
          else deps.onSkipped?.(agent, fired.refused, fired.waiting)
        })
        .catch((error: unknown) => deps.log?.(`A scheduled agent's run went wrong: ${describe(error)}`))
    }
    arm()
  }

  return {
    start() {
      if (running) return
      running = true
      if (stopping.signal.aborted) stopping = new AbortController()
      dueAt.clear()
      reconcile()
      // Ended while the app was closed: let go of it now, not at the first run.
      endPauseIfDue(now())
      arm()
    },
    stop() {
      running = false
      stopping.abort()
      if (timer !== null) clearTimer(timer)
      timer = null
    },
    refresh() {
      if (!running) return
      // The armed timer is for the old list: let go of it before re-arming.
      if (timer !== null) clearTimer(timer)
      timer = null
      reconcile()
      // Anything already due (the computer just woke) runs now.
      tick()
    },
    nextRunAt(id) {
      const entry = dueAt.get(id)
      if (entry) return entry.at
      const agent = deps.list().find((candidate) => candidate.id === id)
      return agent && !isPaused(agent, now()) ? dueFor(agent, now()) : null
    },
    isRunning: () => running,
    async runNow(id) {
      const agent = deps.list().find((candidate) => candidate.id === id)
      return agent ? fire(agent) : { ok: false, refused: 'unknown' }
    },
  }
}
