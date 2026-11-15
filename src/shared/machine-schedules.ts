import type { StudioClient } from '../../packages/client-runtime/src/public'
import { STUDIO_SCHEDULES_CAPABILITY } from '../../packages/studio-protocol/src/handshake'
import type { StudioSchedule } from '../../packages/studio-protocol/src/schedules'
import { environmentRouteOfRecord, type EnvironmentClients } from './environment-clients'

// The schedules of the machines this desktop owns (an SSH machine's, a WSL
// distribution's), as the agents' `schedule.*` tools reach them: each read
// and changed on that machine's own Studio (`schedules.*`), over the
// desktop's client of it. A schedule an agent makes for a machine's folder is
// handed to that machine (environment-migration.ts) and runs there, so the
// tools that list, run, pause, resume and delete schedules look there too,
// under the same id.

/** One of a machine's schedules, with the machine it is on. */
export type MachineSchedule = { route: string; machine: string; schedule: StudioSchedule }

export type MachineScheduleAction = 'run' | 'pause' | 'resume' | 'delete'

export type MachineSchedules = {
  /** Every machine's schedules, and each machine that could not be read, in words. */
  list(): Promise<{ schedules: MachineSchedule[]; unreachable: string[] }>
  /** One of them by its id; null where no machine read lists it. */
  find(id: string): Promise<MachineSchedule | null>
  /** Run, pause, resume or delete it there, once (one command id). */
  act(
    found: MachineSchedule,
    action: MachineScheduleAction,
  ): Promise<{ ok: true; schedule?: StudioSchedule; workspaceId?: string } | { ok: false; message: string }>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** How long a machine is waited on before it is said to be unreachable: a machine away must not hold the tool. */
const MACHINE_READ_MS = 10_000

function within<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([work, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(late()), ms)))]).finally(
    () => clearTimeout(timer),
  )
}

export function createMachineSchedules(deps: {
  clients: EnvironmentClients
  /** The routes of the machines this desktop holds chats of: where a schedule handed over lives. */
  routes: () => Iterable<string>
  commandId: () => string
  readTimeoutMs?: number
}): MachineSchedules {
  const reach = async (
    route: string,
  ): Promise<{ ok: true; client: StudioClient; name: string } | { ok: false; message: string }> => {
    const reached = await deps.clients.clientFor(route, STUDIO_SCHEDULES_CAPABILITY).catch((error: unknown) => ({
      ok: false as const,
      code: 'unavailable',
      message: messageOf(error),
    }))
    return reached.ok ? reached : { ok: false, message: reached.message }
  }
  const list: MachineSchedules['list'] = async () => {
    const routes = [...new Set(deps.routes())]
    const read = await Promise.all(
      routes.map((route): Promise<{ schedules: MachineSchedule[] } | { error: string }> =>
        within(
          (async () => {
            const reached = await reach(route)
            if (!reached.ok) return { error: reached.message }
            try {
              const listed = await reached.client.request('schedules.list', {})
              return { schedules: listed.schedules.map((schedule) => ({ route, machine: reached.name, schedule })) }
            } catch (error) {
              return { error: `${reached.name}: ${messageOf(error)}` }
            }
          })(),
          deps.readTimeoutMs ?? MACHINE_READ_MS,
          () => ({ error: `${route} did not answer in time.` }),
        ),
      ),
    )
    return {
      schedules: read.flatMap((entry) => ('schedules' in entry ? entry.schedules : [])),
      unreachable: read.flatMap((entry) => ('error' in entry ? [entry.error] : [])),
    }
  }
  return {
    list,
    async find(id) {
      return (await list()).schedules.find((entry) => entry.schedule.id === id) ?? null
    },
    async act(found, action) {
      const reached = await reach(found.route)
      if (!reached.ok) return { ok: false, message: reached.message }
      const { id } = found.schedule
      const commandId = deps.commandId()
      try {
        const { rpc } = reached.client
        switch (action) {
          case 'run':
            return { ok: true, workspaceId: (await rpc['schedules.runNow']({ id, commandId })).workspaceId }
          case 'pause':
            return { ok: true, schedule: (await rpc['schedules.pause']({ id, commandId })).schedule }
          case 'resume':
            return { ok: true, schedule: (await rpc['schedules.resume']({ id, commandId })).schedule }
          case 'delete':
            await rpc['schedules.delete']({ id, commandId })
            return { ok: true }
        }
      } catch (error) {
        return { ok: false, message: `${found.machine}: ${messageOf(error)}` }
      }
    },
  }
}

/**
 * The schedules of the machines a Studio core reaches (its SSH machines and
 * WSL distributions), at the routes of the chats it holds of them; null
 * where it reaches none.
 */
export function machineSchedulesOf(core: {
  environmentClients: EnvironmentClients | null
  workspaceRegistry: { getRecords(): ReadonlyArray<Parameters<typeof environmentRouteOfRecord>[0]> }
}): MachineSchedules | undefined {
  const clients = core.environmentClients
  if (!clients) return undefined
  return createMachineSchedules({
    clients,
    routes: () => core.workspaceRegistry.getRecords().flatMap((record) => environmentRouteOfRecord(record) ?? []),
    commandId: () => globalThis.crypto.randomUUID(),
  })
}

/** `machineSchedules` for a backends object, where there are any. */
export function withDefinedMachineSchedules(machineSchedules: MachineSchedules | undefined): {
  machineSchedules?: MachineSchedules
} {
  return machineSchedules ? { machineSchedules } : {}
}
