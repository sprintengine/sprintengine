import type { IpcMain } from 'electron'

import { isRecord } from '../../shared/records'
import { SCHEDULED_AGENTS_IPC } from '../../shared/scheduled-agents'
import type { ScheduledAgentsService } from './service'

// The Schedules window's channels, registered once with the server's other
// domains (`registerServerDomainIpc`): on main's `ipcMain` in process, on the
// server's tunnel out of process. The scheduled-agents module provides the
// service; while it is switched off there is none, and every call is refused
// with that said, as a call to a channel nobody registered was before. The
// channels themselves never come and go with the module.

/** What a call to a Schedules channel is refused with while the module is off. */
export const SCHEDULED_AGENTS_OFF_MESSAGE = 'Scheduled agents is switched off.'

type IpcRegistryLike = Pick<IpcMain, 'handle'>

export function registerScheduledAgentsIpc(
  ipc: IpcRegistryLike,
  deps: {
    /** The module's service, or null while the module is off; asked on every call. */
    service: () => ScheduledAgentsService | null
  },
): void {
  const live = (): ScheduledAgentsService => {
    const service = deps.service()
    if (!service) throw new Error(SCHEDULED_AGENTS_OFF_MESSAGE)
    return service
  }
  const idOf = (input: unknown): string => (isRecord(input) && typeof input.id === 'string' ? input.id : '')
  const draftOf = (input: unknown): unknown => (isRecord(input) ? input.draft : undefined)

  // The channels can be called before the scheduler's sidecar reads the file;
  // the reads wait for that read (the store's own), so an early list is not
  // empty and an early write does not replace the file with only its own entry.
  ipc.handle(SCHEDULED_AGENTS_IPC.list, async () => {
    const service = live()
    await service.loaded()
    return service.list()
  })
  ipc.handle(SCHEDULED_AGENTS_IPC.create, async (_event, input: unknown) => live().create(draftOf(input)))
  ipc.handle(SCHEDULED_AGENTS_IPC.update, async (_event, input: unknown) => live().update(idOf(input), draftOf(input)))
  ipc.handle(SCHEDULED_AGENTS_IPC.remove, async (_event, input: unknown) => live().remove(idOf(input)))
  ipc.handle(SCHEDULED_AGENTS_IPC.runNow, async (_event, input: unknown) => live().runNow(idOf(input)))
  ipc.handle(SCHEDULED_AGENTS_IPC.markSeen, async (_event, input: unknown) => {
    await live().markFailureSeen(idOf(input))
    return { ok: true }
  })
  ipc.handle(SCHEDULED_AGENTS_IPC.pause, async (_event, input: unknown) => live().pause(idOf(input)))
  ipc.handle(SCHEDULED_AGENTS_IPC.resume, async (_event, input: unknown) => live().resume(idOf(input)))
  ipc.handle(SCHEDULED_AGENTS_IPC.pauseState, async () => {
    const service = live()
    await service.loaded()
    return service.pausedAll()
  })
  ipc.handle(SCHEDULED_AGENTS_IPC.pauseAll, async (_event, input: unknown) =>
    // Checked by the service: a time to come, or null for until resumed.
    live().pauseAll((isRecord(input) ? (input.until ?? null) : null) as number | null),
  )
  ipc.handle(SCHEDULED_AGENTS_IPC.resumeAll, async () => live().resumeAll())
}
