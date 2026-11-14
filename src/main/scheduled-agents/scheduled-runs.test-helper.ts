import { createScheduledAgentsScheduler, type ScheduledAgentsSchedulerDeps } from './scheduler'
import type { ScheduledRunRecord } from './store'

/**
 * A scheduler with runs written down in memory as the store writes them
 * (`beginRun`, `endRun`, and `recordRun` ending or advancing the record), for
 * tests whose `recordRun` is a stand-in. `records` is what is on its way.
 */
export function schedulerWithRunRecords(
  deps: Omit<ScheduledAgentsSchedulerDeps, 'beginRun' | 'endRun' | 'recordRun'> & {
    recordRun: (id: string, run: Parameters<ScheduledAgentsSchedulerDeps['recordRun']>[1]) => Promise<void>
  },
  records: Map<string, ScheduledRunRecord> = new Map(),
) {
  return createScheduledAgentsScheduler({
    ...deps,
    async beginRun(commandId, run) {
      for (const other of records.values())
        if (other.scheduledAgentId === run.scheduledAgentId && !other.chat) return false
      records.set(commandId, run)
      return true
    },
    async endRun(commandId) {
      records.delete(commandId)
    },
    async recordRun(id, run, commandId) {
      const record = records.get(commandId)
      if (record && run.ok && run.agentId)
        records.set(commandId, { ...record, chat: { workspaceId: run.workspaceId, agentId: run.agentId } })
      else records.delete(commandId)
      await deps.recordRun(id, run)
    },
  })
}
