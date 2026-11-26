import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { STUDIO_SCHEDULES_CAPABILITY } from '../../../../../../packages/studio-protocol/src/public'
import { environmentStatus } from '../../../../../../packages/client-runtime/src/environments/environmentStatus'
import { environmentRouteOf, type EnvironmentEntry } from '../../../../../shared/environments'
import type { MachineRef } from '../../../../../shared/machine-identity'
import type { ScheduledAgentView, ScheduledAgentsPause } from '../../../../../shared/scheduled-agents'
import type { MeshScheduledAgentAction } from '../../../../../shared/tailnet-mesh'
import {
  environmentStudioAvailable,
  pairedConnectionOf,
  type EnvironmentTarget,
} from '../../../studio/environmentStudio'
import { pairedScheduledAgents, scheduledAgentsOf } from '../../../studio/pairedSchedules'
import { environmentConversationTransport } from '../../panels/agentChat/environmentChat'

// Each other machine's scheduled agents, for the sidebar's Scheduled section
// (design-environments PR 4): every environment in the environment list that
// is answering, whatever kind of machine it is. A schedule there runs on that
// machine, by that machine's scheduler (a schedule made here for a machine's
// folder is handed over to it, environment-migration.ts), so it is listed and
// controlled from here on that machine's Studio (`schedules.*`), asked by this
// window itself over its route, as this computer's own are on the window's
// own Studio: listed once it answers, kept current by its `schedules.changed`
// push, and driven as far as this desktop's grant there allows
// (`workspaces:operate` to run, pause, resume or close one).
//
// Plus a slow re-read, so "in 5m" moves on for a machine with nothing else
// to say.

const REMOTE_SCHEDULES_CADENCE_MS = 120_000

export type RemoteScheduledMachine = {
  /** The route this window asks it by (`formatEnvironmentRoute`). */
  route: string
  /**
   * Its pairing here, for a paired desktop; null for another environment's
   * (an SSH machine's). Either's schedules open in New chat's editor, which
   * saves them there.
   */
  connectionId: string | null
  machineName: string
  /** How its rows draw the machine's mark. */
  machine: MachineRef
  agents: ScheduledAgentView[]
  pausedAll: ScheduledAgentsPause | null
  /** The pairing may run, pause, resume and close its schedules (`workspace:operate`). */
  operable: boolean
}

/** What a toast says of an action that went through. */
export function remoteScheduleActionWords(action: MeshScheduledAgentAction, machineName: string): string {
  switch (action) {
    case 'run':
      return `Its chat is starting on ${machineName}.`
    case 'pause':
      return `It starts no runs on ${machineName} until resumed.`
    case 'resume':
      return `It runs on ${machineName} at its next time.`
    case 'delete':
      return `It will not run on ${machineName} again.`
  }
}

// What the Scheduled section last read of each machine, for the editor a
// paired machine's schedule opens in: it follows the row, so a pause or a
// save shows there as it does on the row.
let publishedMachines: readonly RemoteScheduledMachine[] = []
const publishedListeners = new Set<() => void>()

function publishRemoteScheduledMachines(machines: readonly RemoteScheduledMachine[]): void {
  publishedMachines = machines
  for (const listener of publishedListeners) listener()
}

function subscribePublishedMachines(listener: () => void): () => void {
  publishedListeners.add(listener)
  return () => {
    publishedListeners.delete(listener)
  }
}

/**
 * The machines this desktop owns (its SSH machines and WSL distributions, not
 * a paired desktop) whose schedules the Scheduled section lists now: what
 * Pause all and Resume all cover beside this device.
 */
export function ownedScheduledMachines(): readonly RemoteScheduledMachine[] {
  return publishedMachines.filter((machine) => machine.connectionId === null)
}

/** One of another machine's schedules as the Scheduled section holds it now, with its machine, by its route. */
export function remoteScheduledAgentNow(
  route: string,
  id: string,
): { agent: ScheduledAgentView; machine: RemoteScheduledMachine } | null {
  const machine = publishedMachines.find((candidate) => candidate.route === route)
  const agent = machine?.agents.find((candidate) => candidate.id === id)
  return machine && agent ? { agent, machine } : null
}

/**
 * One of another machine's schedules as the Scheduled section last read it, by its route.
 * `machine` null is a machine not read just now (asleep, off the tailnet),
 * which says nothing of the schedule; `agent` null under a machine that was
 * read is a schedule gone from it.
 */
export function useRemoteScheduledAgent(ref: { route: string; id: string } | null): {
  machine: RemoteScheduledMachine | null
  agent: ScheduledAgentView | null
} {
  const machines = useSyncExternalStore(subscribePublishedMachines, () => publishedMachines)
  const route = ref?.route ?? null
  const id = ref?.id ?? null
  return useMemo(() => {
    const machine = route ? (machines.find((candidate) => candidate.route === route) ?? null) : null
    return { machine, agent: machine?.agents.find((candidate) => candidate.id === id) ?? null }
  }, [machines, route, id])
}

export function useRemoteScheduledAgents({
  enabled,
  environments,
}: {
  enabled: boolean
  /** The machines to list (`useEnvironments`, less any whose route is switched off here). */
  environments: readonly EnvironmentEntry[]
}): {
  machines: RemoteScheduledMachine[]
  /** Read one machine's list again now, by its route. */
  refresh: (route: string) => void
} {
  const [lists, setLists] = useState<
    ReadonlyMap<string, { agents: ScheduledAgentView[]; pausedAll: ScheduledAgentsPause | null; operate: boolean }>
  >(() => new Map())
  const bridge = environmentStudioAvailable()
  // Every other machine that answers now; one that comes back is read again.
  const readable = useMemo(() => {
    if (!enabled || !bridge) return []
    return environments.flatMap((entry) => {
      const route = environmentRouteOf(entry)
      if (route === 'local' || environmentStatus(entry).kind !== 'ready') return []
      return [
        {
          target: { route, name: entry.displayName } as EnvironmentTarget,
          connectionId: pairedConnectionOf(route),
          machine: entry.machine,
        },
      ]
    })
  }, [bridge, enabled, environments])
  const asking = useRef(new Set<string>())
  const targetsRef = useRef(new Map<string, EnvironmentTarget>())
  targetsRef.current = new Map(readable.map(({ target }) => [target.route, target]))
  const read = useCallback((route: string) => {
    const target = targetsRef.current.get(route)
    if (!target || asking.current.has(route)) return
    asking.current.add(route)
    void pairedScheduledAgents(target)
      .then((result) => {
        // A machine that did not answer keeps what it last said, as its rows do.
        if (!result.ok) return
        setLists((current) =>
          new Map(current).set(route, { agents: result.agents, pausedAll: result.pausedAll, operate: result.operate }),
        )
      })
      .catch(() => undefined)
      .finally(() => asking.current.delete(route))
  }, [])
  // Each machine's list as it changes there (`schedules.changed`, the push
  // this window's own Scheduled section follows on its Studio): a schedule
  // made from New chat, handed over to it, run, paused or closed there shows
  // at once.
  const pushedRoutes = readable.map(({ target }) => `${target.route}\u0001${target.name}`).join('\u0000')
  useEffect(() => {
    if (!pushedRoutes) return
    const stops = pushedRoutes.split('\u0000').map((entry) => {
      const [route, name] = entry.split('\u0001') as [string, string]
      const { followPush } = environmentConversationTransport({ route, name }).services
      return (
        followPush?.({
          topic: 'schedules.changed',
          params: {},
          capability: STUDIO_SCHEDULES_CAPABILITY,
          onPayload: (state) => {
            const { agents, pausedAll } = scheduledAgentsOf(state)
            setLists((current) =>
              new Map(current).set(route, { agents, pausedAll, operate: current.get(route)?.operate ?? false }),
            )
          },
        }) ?? (() => undefined)
      )
    })
    return () => {
      for (const stop of stops) stop()
    }
  }, [pushedRoutes])
  const readableRoutes = readable.map(({ target }) => target.route).join('\u0000')
  // Read as each machine comes to answer; the push keeps it current after.
  useEffect(() => {
    if (!readableRoutes) return
    for (const route of readableRoutes.split('\u0000')) read(route)
  }, [read, readableRoutes])
  useEffect(() => {
    if (!readableRoutes) return
    const timer = window.setInterval(() => {
      for (const route of readableRoutes.split('\u0000')) read(route)
    }, REMOTE_SCHEDULES_CADENCE_MS)
    return () => window.clearInterval(timer)
  }, [read, readableRoutes])

  const machines = useMemo(
    () =>
      readable.flatMap(({ target, connectionId, machine }) => {
        const list = lists.get(target.route)
        if (!list || list.agents.length === 0) return []
        return [
          {
            route: target.route,
            connectionId,
            machineName: target.name,
            machine,
            agents: list.agents,
            pausedAll: list.pausedAll,
            operable: list.operate,
          },
        ]
      }),
    [lists, readable],
  )
  useEffect(() => publishRemoteScheduledMachines(machines), [machines])
  return { machines, refresh: read }
}
