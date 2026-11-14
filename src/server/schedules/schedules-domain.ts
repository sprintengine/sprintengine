import type {
  StudioSchedule,
  StudioScheduleChange,
  StudioScheduleDraft,
  StudioSchedules,
} from '../../../packages/studio-protocol/src/schedules'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import {
  scheduledAgentScheduleWords,
  type ScheduledAgentView,
  type ScheduledAgentsPause,
} from '../../shared/scheduled-agents'
import {
  scheduleChangeOf,
  scheduleDraftOf,
  type ScheduleRequestDeps,
  type ScheduleRequestRefusal,
} from '../../main/scheduled-agents/schedule-requests'
import type { ScheduledAgentsService } from '../../main/scheduled-agents/service'
import { refuseScheduledAgentRun } from '../../main/automation/launch-permission-cap'

// A Studio's scheduled agents as the protocol serves them (`schedules.*`):
// the core's own scheduled agents service, which every server runs
// (`server/core/studio-scheduled-agents.ts`), so the phone and a paired
// desktop reach the schedules of whichever Studio they ask. Making and
// changing one reads the request by the same rules as the gateway's
// `schedule.create` and `schedule.update` tools (`schedule-requests.ts`).
//
// Who may ask is the router's grant check, made before this is reached; the
// preset a schedule may run on is held to the asking grant's ceiling.

export type StudioSchedulesRefusal = {
  ok: false
  code:
    | 'not_found'
    | 'unknown_workspace'
    | 'workspace_folder_missing'
    | 'no_cli_selected'
    | 'invalid_params'
    | 'conversation_start_failed'
    | 'unavailable'
  message: string
}

type Code = StudioSchedulesRefusal['code']
/** An answer, or a refusal in one of the codes its method declares. */
export type StudioSchedulesAnswer<T, C extends Code = Code> =
  { ok: true; value: T } | (StudioSchedulesRefusal & { code: C })
type Answer<T, C extends Code = Code> = StudioSchedulesAnswer<T, C>
type Writing = 'not_found' | 'unknown_workspace' | 'workspace_folder_missing' | 'no_cli_selected' | 'invalid_params'
type OnOne = 'not_found' | 'invalid_params'

export type StudioSchedulesDomain = {
  list(): StudioSchedules
  create(draft: StudioScheduleDraft, ceiling: CliPermissionPreset): Promise<Answer<StudioSchedule, Writing>>
  update(change: StudioScheduleChange, ceiling: CliPermissionPreset): Promise<Answer<StudioSchedule, Writing>>
  pause(id: string): Promise<Answer<StudioSchedule, OnOne>>
  resume(id: string, ceiling: CliPermissionPreset): Promise<Answer<StudioSchedule, OnOne>>
  runNow(
    id: string,
    ceiling: CliPermissionPreset,
  ): Promise<Answer<{ workspaceId: string }, OnOne | 'conversation_start_failed'>>
  remove(id: string): Promise<Answer<{ removed: string }, 'not_found'>>
  markSeen(id: string): Promise<Answer<StudioSchedule, 'not_found'>>
  pauseAll(until: number | null): Promise<Answer<{ pausedAll: ScheduledAgentsPause }, 'invalid_params'>>
  /**
   * Lift the pause on every schedule. Refused, and nothing lifted, when one it
   * would start again runs on a preset above `ceiling`: one schedule at a
   * time, that one could not be resumed under it either.
   */
  resumeAll(ceiling: CliPermissionPreset): Promise<Answer<{ pausedAll: null }, 'invalid_params'>>
  onChanged(listener: (schedules: StudioSchedules) => void): () => void
}

/** One schedule as the protocol answers it: its view, and its schedule in words. */
export function studioScheduleOf(agent: ScheduledAgentView): StudioSchedule {
  return { ...agent, scheduleWords: scheduledAgentScheduleWords(agent.schedule) }
}

function refused<C extends Code>(code: C, message: string): StudioSchedulesRefusal & { code: C } {
  return { ok: false, code, message }
}

/** A request the shared rules refused, in the protocol's codes. */
function requestRefusal(refusal: ScheduleRequestRefusal): StudioSchedulesRefusal & { code: Writing } {
  switch (refusal.code) {
    case 'unknown_workspace':
    case 'workspace_folder_missing':
    case 'no_cli_selected':
      return refused(refusal.code, refusal.message)
    // A prompt that reads as an option, or a preset looser than the asker's
    // ceiling: the request is one this Studio will not store.
    case 'prompt_reads_as_option':
    case 'permission_escalation':
      return refused('invalid_params', refusal.message)
  }
}

const missing = (id: string) => refused('not_found', `No scheduled agent "${id}".`)

export function createStudioSchedulesDomain(
  deps: ScheduleRequestDeps & {
    service: ScheduledAgentsService
    /** Why none runs now though none is paused; null while they run. */
    held?: () => string | null
  },
): StudioSchedulesDomain {
  const { service } = deps
  const state = (agents: readonly ScheduledAgentView[]): StudioSchedules => {
    const held = deps.held?.() ?? null
    return {
      schedules: agents.map(studioScheduleOf),
      pausedAll: service.pausedAll(),
      ...(held ? { held } : {}),
    }
  }
  const written = (
    result: { ok: true; agent: ScheduledAgentView } | { ok: false; message: string },
  ): Answer<StudioSchedule, 'invalid_params'> =>
    result.ok ? { ok: true, value: studioScheduleOf(result.agent) } : refused('invalid_params', result.message)

  return {
    list: () => state(service.list()),
    async create(draft, ceiling) {
      const read = scheduleDraftOf(draft, deps, ceiling)
      if (!read.ok) return requestRefusal(read)
      return written(await service.create(read.value))
    },
    async update(change, ceiling) {
      const existing = service.get(change.id)
      if (!existing) return missing(change.id)
      const read = scheduleChangeOf(existing, change, deps, ceiling)
      if (!read.ok) return requestRefusal(read)
      return written(await service.update(change.id, read.value))
    },
    async pause(id) {
      if (!service.get(id)) return missing(id)
      return written(await service.pause(id))
    },
    async resume(id, ceiling) {
      const agent = service.get(id)
      if (!agent) return missing(id)
      // Resumed, it starts runs on its own preset with nobody watching.
      const escalation = refuseScheduledAgentRun(agent.permissionPreset, ceiling)
      if (escalation) return refused('invalid_params', escalation.message)
      return written(await service.resume(id))
    },
    async runNow(id, ceiling) {
      const agent = service.get(id)
      if (!agent) return missing(id)
      const escalation = refuseScheduledAgentRun(agent.permissionPreset, ceiling)
      if (escalation) return refused('invalid_params', escalation.message)
      const ran = await service.runNow(id)
      if (!ran.ok) return refused('conversation_start_failed', ran.message)
      if (!ran.run.ok) return refused('conversation_start_failed', ran.run.message)
      return { ok: true, value: { workspaceId: ran.run.workspaceId } }
    },
    async remove(id) {
      const removed = await service.remove(id)
      return removed.ok ? { ok: true, value: { removed: id } } : refused('not_found', removed.message)
    },
    async markSeen(id) {
      if (!service.get(id)) return missing(id)
      await service.markFailureSeen(id)
      const seen = service.get(id)
      return seen ? { ok: true, value: studioScheduleOf(seen) } : missing(id)
    },
    async pauseAll(until) {
      const paused = await service.pauseAll(until)
      return paused.ok ? { ok: true, value: { pausedAll: paused.pause } } : refused('invalid_params', paused.message)
    },
    async resumeAll(ceiling) {
      // Those paused on their own stay paused; every other one starts on its own preset again.
      for (const agent of service.list()) {
        if (agent.pausedAt !== undefined) continue
        const escalation = refuseScheduledAgentRun(agent.permissionPreset, ceiling)
        if (escalation) return refused('invalid_params', `${agent.name || agent.id}: ${escalation.message}`)
      }
      const resumed = await service.resumeAll()
      return resumed.ok ? { ok: true, value: { pausedAll: null } } : refused('invalid_params', resumed.message)
    },
    onChanged: (listener) => service.onChanged((agents) => listener(state(agents))),
  }
}
