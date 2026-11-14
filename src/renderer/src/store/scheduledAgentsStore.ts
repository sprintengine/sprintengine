// The scheduled agents, as every surface in this window reads them: one fetch,
// then the Studio's `schedules.changed` after every change — a write from any window, an
// extension or an agent, and each run's outcome. Main owns the list; this is
// its mirror. Beside it, the same for the pause of every scheduled agent at
// once, and for why none runs though none is paused, which main says with
// every change to the list.

import { useSyncExternalStore } from 'react'

import type { ScheduledAgentView, ScheduledAgentsPause } from '../../../shared/scheduled-agents'
import { schedulesApi } from '../studio/schedules'

const EMPTY: ScheduledAgentView[] = []
let agents: ScheduledAgentView[] = EMPTY
let pausedAll: ScheduledAgentsPause | null = null
let held: string | null = null
let started = false
// Whether a broadcast has landed: main sends the whole list on every change,
// so one that arrives before the first fetch answers is newer than that answer.
let broadcastSeen = false
let pauseBroadcastSeen = false
let heldBroadcastSeen = false
const listeners = new Set<() => void>()

function publish(next: unknown): void {
  // Anything but a list is no list: an older main, or a stubbed bridge.
  agents = Array.isArray(next) ? (next as ScheduledAgentView[]) : EMPTY
  for (const listener of listeners) listener()
}

function publishPause(next: unknown): void {
  // Anything but a pause is none: an older main says nothing of one.
  const pause = next as Partial<ScheduledAgentsPause> | null | undefined
  pausedAll =
    pause && typeof pause.since === 'number' && (pause.until === null || typeof pause.until === 'number')
      ? { since: pause.since, until: pause.until }
      : null
  for (const listener of listeners) listener()
}

function publishHeld(next: unknown): void {
  held = typeof next === 'string' && next ? next : null
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  // The Studio's `schedules.list` and `schedules.changed`, over the window's
  // own connection. A window with no Studio hears nothing and lists none.
  const bridge = schedulesApi
  bridge.onScheduledAgentsChanged((next) => {
    broadcastSeen = true
    publish(next)
  })
  void bridge
    .listScheduledAgents()
    .then((listed) => {
      if (!broadcastSeen) publish(listed)
    })
    .catch(() => undefined)
  bridge.onScheduledAgentsPauseChanged((next) => {
    pauseBroadcastSeen = true
    publishPause(next)
  })
  void bridge
    .getScheduledAgentsPause()
    .then((pause) => {
      if (!pauseBroadcastSeen) publishPause(pause)
    })
    .catch(() => undefined)
  bridge.onScheduledAgentsHeldChanged((next) => {
    heldBroadcastSeen = true
    publishHeld(next)
  })
  void bridge
    .getScheduledAgentsHeld()
    .then((reason) => {
      if (!heldBroadcastSeen) publishHeld(reason)
    })
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useScheduledAgents(): ScheduledAgentView[] {
  return useSyncExternalStore(subscribe, () => agents)
}

/** Every scheduled agent paused at once, and until when; null when they are not. */
export function useScheduledAgentsPause(): ScheduledAgentsPause | null {
  return useSyncExternalStore(subscribe, () => pausedAll)
}

/**
 * Why no scheduled agent runs now though none is paused (the hand-over's
 * journal could not be read); null while they run.
 */
export function useScheduledAgentsHeld(): string | null {
  return useSyncExternalStore(subscribe, () => held)
}

/** Test seam: forget the mirror and its subscription. */
export function resetScheduledAgentsStoreForTests(): void {
  agents = EMPTY
  pausedAll = null
  held = null
  started = false
  broadcastSeen = false
  pauseBroadcastSeen = false
  heldBroadcastSeen = false
  listeners.clear()
}
