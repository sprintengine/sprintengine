import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { parseEnvironmentRoute } from '../../../../../../packages/studio-protocol/src/environment'
import { environmentOfRoute, type EnvironmentEntry } from '../../../../../shared/environments'
import type { MachineRef } from '../../../../../shared/machine-identity'
import type { ScheduledAgentView, ScheduledAgentsPause } from '../../../../../shared/scheduled-agents'
import type { MeshConnection, MeshScheduledAgentAction } from '../../../../../shared/tailnet-mesh'
import type { TailnetScope } from '../../../../../shared/tailnet'
import { tailnetScopeGrantsAccess } from '../../../../../shared/tailnet'
import type { RemoteBrowseEntry } from '../remoteBand/remoteSessionsModel'
import {
  followedEnvironmentChats,
  followedEnvironmentTargets,
  onFollowedEnvironmentChats,
  type EnvironmentChatsSnapshot,
} from '../../../studio/environmentChats'
import {
  environmentStudioAvailable,
  pairedConnectionOf,
  pairedRoute,
  type EnvironmentTarget,
} from '../../../studio/environmentStudio'
import { pairedScheduledAgents } from '../../../studio/pairedSchedules'

// Each other machine's scheduled agents, for the sidebar's Scheduled section:
// a paired desktop's, and an SSH machine's or a WSL distribution's this window
// follows chats on. A schedule there runs on that machine, by that machine's
// scheduler (a schedule made here for a machine's folder is handed over to it,
// environment-migration.ts), so it is listed and controlled from here on that
// machine's Studio (`schedules.*`), asked by this window itself over its route:
// a paired desktop on `workspace:read` to list, `workspace:operate` to run,
// pause, resume or close one.
//
// Read on the same beat as the machine's rows: whenever its browse settles —
// the mount read, a change it pushed, a machine waking — since a run starting
// over there is a chat the change feed says it has. Plus a slow re-read, so
// "in 5m" moves on for a machine with nothing else to say.

const REMOTE_SCHEDULES_CADENCE_MS = 120_000

export type RemoteScheduledMachine = {
  /** The route this window asks it by (`formatEnvironmentRoute`). */
  route: string
  /**
   * Its pairing here, for a paired desktop, whose schedules open in New chat's
   * editor; null for another environment's (an SSH machine's), whose rows run,
   * pause, resume and close them there.
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

/** Whether a machine's browse says this pairing may list its schedules, and drive them. */
export function remoteScheduleAccess(entry: RemoteBrowseEntry | undefined): { read: boolean; operate: boolean } {
  const browse = entry?.browse
  if (!browse?.reachable || browse.unauthorized) return { read: false, operate: false }
  const granted = new Set<TailnetScope>(browse.scopes)
  return {
    read: tailnetScopeGrantsAccess(granted, 'workspace:read'),
    operate: tailnetScopeGrantsAccess(granted, 'workspace:operate'),
  }
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

// A schedule made on a paired machine from New chat changes nothing the
// machine's browse says, so the door says it here and the section re-reads.
const changeListeners = new Set<(connectionId: string) => void>()

export function announceRemoteScheduledChange(connectionId: string): void {
  for (const listener of changeListeners) listener(connectionId)
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

/** One of a paired machine's schedules as the Scheduled section holds it now, with its machine. */
export function remoteScheduledAgentNow(
  connectionId: string,
  id: string,
): { agent: ScheduledAgentView; machine: RemoteScheduledMachine } | null {
  const machine = publishedMachines.find((candidate) => candidate.connectionId === connectionId)
  const agent = machine?.agents.find((candidate) => candidate.id === id)
  return machine && agent ? { agent, machine } : null
}

/**
 * One of a paired machine's schedules as the Scheduled section last read it.
 * `machine` null is a machine not read just now (asleep, off the tailnet),
 * which says nothing of the schedule; `agent` null under a machine that was
 * read is a schedule gone from it.
 */
export function useRemoteScheduledAgent(ref: { connectionId: string; id: string } | null): {
  machine: RemoteScheduledMachine | null
  agent: ScheduledAgentView | null
} {
  const machines = useSyncExternalStore(subscribePublishedMachines, () => publishedMachines)
  const connectionId = ref?.connectionId ?? null
  const id = ref?.id ?? null
  return useMemo(() => {
    const machine = connectionId
      ? (machines.find((candidate) => candidate.connectionId === connectionId) ?? null)
      : null
    return { machine, agent: machine?.agents.find((candidate) => candidate.id === id) ?? null }
  }, [machines, connectionId, id])
}

/** What moves when an environment's chat list does: a chat more or fewer, one that moved, the client away or back. */
function listBeat(snapshot: EnvironmentChatsSnapshot): string {
  const latest = snapshot.sessions.reduce((at, session) => Math.max(at, session.updatedAt), 0)
  return `${snapshot.sessions.length}:${latest}:${snapshot.stale}`
}

/**
 * The environments other than a paired desktop whose schedules the section
 * lists: every one this window follows chats on (an SSH machine, a WSL
 * distribution: `useFollowWindowEnvironments`) that the environment list
 * still holds, read on its own route like its chats. Each with a beat that
 * moves whenever its chat list does, since a run starting there is a chat it
 * lists. A route a paired desktop is listed by is that machine's, read by its
 * pairing above.
 */
function followedScheduleSources(
  environments: readonly EnvironmentEntry[],
  pairedRoutes: ReadonlySet<string>,
): Array<{ target: EnvironmentTarget; machine: MachineRef; beat: string }> {
  const sources = new Map(followedEnvironmentChats().map((source) => [source.route, source]))
  return followedEnvironmentTargets().flatMap((target) => {
    if (pairedRoutes.has(target.route)) return []
    const route = parseEnvironmentRoute(target.route)
    const entry = route ? environmentOfRoute(environments, route) : null
    if (!entry) return []
    const snapshot = sources.get(target.route)?.snapshot()
    return [
      {
        target: { route: target.route, name: entry.displayName || target.name },
        machine: entry.machine,
        beat: snapshot ? listBeat(snapshot) : '',
      },
    ]
  })
}

export function useRemoteScheduledAgents({
  enabled,
  connections,
  browses,
  environments = [],
}: {
  enabled: boolean
  connections: readonly MeshConnection[]
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  /** The environment list (`useEnvironments`), which names the other environments followed and says which are gone. */
  environments?: readonly EnvironmentEntry[]
}): {
  machines: RemoteScheduledMachine[]
  /** Read one machine's list again now, by its route. */
  refresh: (route: string) => void
} {
  const [lists, setLists] = useState<
    ReadonlyMap<string, { agents: ScheduledAgentView[]; pausedAll: ScheduledAgentsPause | null }>
  >(() => new Map())
  const bridge = environmentStudioAvailable()
  // The other environments' beat: whatever this window follows of them.
  const followedBeat = useSyncExternalStore(
    onFollowedEnvironmentChats,
    () =>
      followedEnvironmentChats()
        .map((source) => {
          const snapshot = source.snapshot()
          return `${source.route}:${listBeat(snapshot)}`
        })
        .join('|'),
    () => '',
  )
  // The machines that may be asked, and when each was last browsed or listed: the beat.
  const readable = useMemo(() => {
    if (!enabled || !bridge) return []
    const paired = connections.flatMap((connection) => {
      const entry = browses.get(connection.id)
      const access = remoteScheduleAccess(entry)
      const route = pairedRoute(connection.id)
      return access.read
        ? [
            {
              target: { route, name: connection.machineName },
              connectionId: connection.id as string | null,
              machine: { kind: 'paired', name: connection.machineName } as MachineRef,
              beat: `${entry?.at ?? 0}`,
              operate: access.operate,
            },
          ]
        : []
    })
    const others = followedScheduleSources(
      environments,
      new Set(connections.map((connection) => pairedRoute(connection.id))),
    ).map((source) => ({ ...source, connectionId: null, operate: true }))
    return [...paired, ...others]
    // `followedBeat` is the followed sources' state, read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, browses, connections, enabled, environments, followedBeat])
  const asking = useRef(new Set<string>())
  const targetsRef = useRef(new Map<string, EnvironmentTarget>())
  targetsRef.current = new Map(readable.map(({ target }) => [target.route, target]))
  const read = useCallback((route: string) => {
    const target = targetsRef.current.get(route)
    if (!target || asking.current.has(route)) return
    asking.current.add(route)
    const connectionId = pairedConnectionOf(route)
    void pairedScheduledAgents(connectionId ? { id: connectionId, machineName: target.name } : target)
      .then((result) => {
        // A machine that did not answer keeps what it last said, as its rows do.
        if (!result.ok) return
        setLists((current) => new Map(current).set(route, { agents: result.agents, pausedAll: result.pausedAll }))
      })
      .catch(() => undefined)
      .finally(() => asking.current.delete(route))
  }, [])
  useEffect(() => {
    const announced = (connectionId: string) => read(pairedRoute(connectionId))
    changeListeners.add(announced)
    return () => {
      changeListeners.delete(announced)
    }
  }, [read])
  const beat = readable.map(({ target, beat: at }) => `${target.route}@${at}`).join('|')
  useEffect(() => {
    for (const { target } of readable) read(target.route)
    // On the beat alone: the list's identity moves with every browse map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat, read])
  const readableRoutes = readable.map(({ target }) => target.route).join('\u0000')
  useEffect(() => {
    if (!readableRoutes) return
    const timer = window.setInterval(() => {
      for (const route of readableRoutes.split('\u0000')) read(route)
    }, REMOTE_SCHEDULES_CADENCE_MS)
    return () => window.clearInterval(timer)
  }, [read, readableRoutes])

  const machines = useMemo(
    () =>
      readable.flatMap(({ target, connectionId, machine, operate }) => {
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
            operable: operate,
          },
        ]
      }),
    [lists, readable],
  )
  useEffect(() => publishRemoteScheduledMachines(machines), [machines])
  return { machines, refresh: read }
}
