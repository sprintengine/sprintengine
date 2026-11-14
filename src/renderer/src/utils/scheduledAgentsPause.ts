// Pausing scheduled agents, as every surface in a window offers it: a
// schedule's row and its menu, the sidebar menu of a chat a schedule started,
// the schedule's editor and the command palette. One set of words and one set
// of calls, so each place says the same thing about what a pause does — a
// paused schedule starts nothing at its times, a run already going carries on,
// Run now still runs it, and nothing missed while paused is made up — and
// each confirms it the same way.

import type { ScheduledAgentView, ScheduledAgentsPause } from '../../../shared/scheduled-agents'
import { showToast } from '../store/toastStore'
import { formatTimeOfDay } from './clockFormat'
import { resolveSnoozePresets } from './workspaceSnooze'
import { schedulesApi } from '../studio/schedules'
import { pairedScheduledAgentsPauseAll } from '../studio/pairedSchedules'
import {
  ownedScheduledMachines,
  type RemoteScheduledMachine,
} from '../components/workspace/sidebar/useRemoteScheduledAgents'

/** How long "Pause all" holds: an hour, until tomorrow morning, or until the person resumes them. */
export type PauseAllChoiceId = 'hour' | 'tomorrow' | 'until-resumed'

export type PauseAllChoice = {
  id: PauseAllChoiceId
  label: string
  /** When it ends, for the menu row's second column; absent for "until I resume". */
  hint?: string
  until: number | null
}

/**
 * The three ways to pause them all, resolved against a clock so each says when
 * it ends. "Tomorrow morning" is the snooze menu's Tomorrow: 9 AM on the next
 * calendar day.
 */
export function pauseAllChoices(now: number): PauseAllChoice[] {
  const presets = resolveSnoozePresets(now)
  const hour = presets.find((preset) => preset.id === 'hour')!
  const tomorrow = presets.find((preset) => preset.id === 'tomorrow')!
  return [
    { id: 'hour', label: 'For 1 hour', hint: hour.whenLabel, until: hour.wakeAt },
    { id: 'tomorrow', label: 'Until tomorrow morning', hint: tomorrow.whenLabel, until: tomorrow.wakeAt },
    { id: 'until-resumed', label: 'Until I resume them', until: null },
  ]
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/** "3:00 PM" today, "Thu 9:00 AM" on another day. */
function whenWords(at: number, now: number): string {
  if (sameDay(at, now)) return formatTimeOfDay(at)
  return `${new Date(at).toLocaleDateString(undefined, { weekday: 'short' })} ${formatTimeOfDay(at)}`
}

/** The banner's line: "Scheduled agents paused until 3:00 PM", or "… paused" until resumed. */
export function scheduledAgentsPauseWords(pause: ScheduledAgentsPause, now: number): string {
  return pause.until === null
    ? 'Scheduled agents paused'
    : `Scheduled agents paused until ${whenWords(pause.until, now)}`
}

/** A paused schedule's status line: "Paused since 3:12 PM", "Paused since Mon 21 Sep". */
export function pausedSinceWords(pausedAt: number, now: number): string {
  if (sameDay(pausedAt, now)) return `Paused since ${formatTimeOfDay(pausedAt)}`
  return `Paused since ${new Date(pausedAt).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })}`
}

/** What pausing one does, for its confirmation. */
const PAUSE_SCHEDULE_HINT = 'It starts no run at its times until you resume it. A run already going carries on.'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Pause or resume one, and say so. True when it took. */
export async function setScheduledAgentPaused(agent: ScheduledAgentView, paused: boolean): Promise<boolean> {
  const result = await (
    paused ? schedulesApi.pauseScheduledAgent(agent.id) : schedulesApi.resumeScheduledAgent(agent.id)
  ).catch((error: unknown) => ({ ok: false as const, message: errorText(error) }))
  if (!result.ok) {
    showToast({ tone: 'error', title: paused ? 'Not paused' : 'Not resumed', description: result.message })
    return false
  }
  if (paused) {
    showToast({ tone: 'neutral', title: 'Schedule paused', description: PAUSE_SCHEDULE_HINT })
    return true
  }
  const next = result.agent.nextRunAt
  showToast({
    tone: 'neutral',
    title: 'Schedule resumed',
    description:
      next !== null
        ? `Next run ${whenWords(next, Date.now())}. Times missed while it was paused are not made up.`
        : 'It runs again once scheduled agents are no longer all paused.',
  })
  return true
}

/**
 * Ask the same of each machine this desktop owns whose schedules are listed
 * (an SSH machine, a WSL distribution): what did not take, by machine, in words.
 */
async function acrossOwnedMachines(
  machines: readonly RemoteScheduledMachine[],
  until: number | null | 'resume',
): Promise<{ done: string[]; missed: string[] }> {
  const answers = await Promise.all(
    machines.map(async (machine) => ({
      machine,
      answer: await pairedScheduledAgentsPauseAll({ route: machine.route, name: machine.machineName }, until).catch(
        (error: unknown) => ({ ok: false as const, message: errorText(error) }),
      ),
    })),
  )
  return {
    done: answers.filter(({ answer }) => answer.ok).map(({ machine }) => machine.machineName),
    missed: answers.flatMap(({ answer }) => (answer.ok ? [] : [answer.message])),
  }
}

/** "build-box", "build-box and nas", "build-box, nas and pi". */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * Pause every scheduled agent until a choice's time, and say so: this
 * device's, and those of each machine it owns that the Scheduled section
 * lists. A machine that could not be reached keeps running its own, and
 * the person is told which.
 */
export async function pauseAllScheduledAgents(choice: PauseAllChoice): Promise<boolean> {
  const result = await schedulesApi
    .pauseAllScheduledAgents(choice.until)
    .catch((error: unknown) => ({ ok: false as const, message: errorText(error) }))
  if (!result.ok) {
    showToast({ tone: 'error', title: 'Not paused', description: result.message })
    return false
  }
  const machines = await acrossOwnedMachines(ownedScheduledMachines(), choice.until)
  const where = machines.done.length ? ` Here and on ${listed(machines.done)}.` : ''
  showToast({
    tone: machines.missed.length ? 'warn' : 'neutral',
    title: scheduledAgentsPauseWords(result.pause, Date.now()),
    description: machines.missed.length
      ? `${where.trim()} Not paused: ${machines.missed.join(' ')} Its schedules keep running there.`.trim()
      : `None runs at its times until then. Runs already going carry on.${where}`,
  })
  return true
}

/**
 * End the pause of them all, here and on each machine it owns whose
 * schedules are all paused, and say so. A schedule paused on its own stays
 * paused.
 */
export async function resumeAllScheduledAgents(): Promise<boolean> {
  const result = await schedulesApi
    .resumeAllScheduledAgents()
    .catch((error: unknown) => ({ ok: false as const, message: errorText(error) }))
  if (!result.ok) {
    showToast({ tone: 'error', title: 'Not resumed', description: result.message })
    return false
  }
  const machines = await acrossOwnedMachines(
    ownedScheduledMachines().filter((machine) => machine.pausedAll !== null),
    'resume',
  )
  showToast({
    tone: machines.missed.length ? 'warn' : 'neutral',
    title: 'Scheduled agents resumed',
    description: machines.missed.length
      ? `Not resumed: ${machines.missed.join(' ')}`
      : 'Each runs next at its next time. One you paused yourself stays paused.',
  })
  return true
}
