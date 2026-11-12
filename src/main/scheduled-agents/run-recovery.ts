// What a start does with the scheduled runs the last process left on their way
// (`ScheduledRunRecord`, written before a run makes anything and gone once its
// first message is answered). Run before the scheduler starts, so a one-time
// schedule is due or done by the time it is looked at.
//
// - **No chat.** The process stopped before the run's chat was made (none
//   carries the run's command id as its `launchCommandId`): nothing was sent.
//   A one-time schedule is still due, and runs once now, late rather than
//   never. A repeating one is recorded as cut off and runs at its next time;
//   the time it missed is not made up, as no missed time is.
// - **A chat.** The run made its chat, and its first message may or may not
//   have gone. The run's start is recorded if it was not, and that message is
//   sent again under the run's command id through the chat's ordinary send
//   (which resumes a chat at rest). A message that went before the stop is
//   answered from the chat's receipt and runs no second turn; one that never
//   went goes now. Either way the run is finished once.
//
// The record names everything the run needs, so a run is finished even when
// its schedule has closed or been deleted since.

import type { ScheduledAgentLastRun } from '../../shared/scheduled-agents'
import type { ScheduledRunOutcomes } from './run-outcomes'
import type { ScheduledAgentsStore, ScheduledRunRecord } from './store'

/** What a repeating schedule's run says when the process stopped before its chat was made. */
export const RUN_CUT_OFF =
  'Studio stopped before this run could start its chat. Nothing was sent; the schedule runs again at its next time.'

export type ScheduledRunChat = { workspaceId: string; agentId: string }

export type ScheduledRunRecoveryDeps = {
  store: Pick<ScheduledAgentsStore, 'runs' | 'get' | 'recordRun' | 'endRun'>
  outcomes: Pick<ScheduledRunOutcomes, 'onRan' | 'firstSendFailed'>
  /** The chat a launch stamped with this command id (`AgentState.launchCommandId`); null when none was made. */
  findChat: (commandId: string) => ScheduledRunChat | null
  /**
   * Send a chat a message through its ordinary send, which resumes a chat at
   * rest, under `commandId`. Answered as a send is: when its turn ends, or
   * from the chat's receipt when that id was carried out before.
   */
  send: (
    chat: ScheduledRunChat,
    commandId: string,
    message: { prompt: string; skills: string[] },
  ) => Promise<{ ok: true } | { ok: false; message: string }>
  warn: (message: string) => void
}

/**
 * Settles every run left on its way. Resolves once each run's record says what
 * became of it (so the scheduler can start); `finishing` resolves once every
 * first message sent again has been answered.
 */
export async function recoverScheduledRuns(deps: ScheduledRunRecoveryDeps): Promise<{ finishing: Promise<void> }> {
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const sends: Promise<void>[] = []
  for (const [commandId, record] of Object.entries(deps.store.runs())) {
    try {
      const chat = record.chat ?? deps.findChat(commandId)
      if (!chat) await settleChatless(deps, commandId, record)
      else sends.push((await finish(deps, commandId, record, chat, describe)).answered)
    } catch (error) {
      deps.warn(`A scheduled run cut off by the last stop could not be settled: ${describe(error)}`)
    }
  }
  return { finishing: Promise.all(sends).then(() => undefined) }
}

async function settleChatless(
  deps: ScheduledRunRecoveryDeps,
  commandId: string,
  record: ScheduledRunRecord,
): Promise<void> {
  const agent = deps.store.get(record.scheduledAgentId)
  // A one-time schedule's last run stays as it was, so it is still due; a
  // closed or deleted one has nothing to run.
  if (!agent || agent.schedule.once !== undefined) {
    await deps.store.endRun(commandId)
    return
  }
  const run: ScheduledAgentLastRun = { at: record.startedAt, ok: false, message: RUN_CUT_OFF }
  await deps.store.recordRun(agent.id, run, commandId)
  deps.outcomes.onRan(agent, run)
}

async function finish(
  deps: ScheduledRunRecoveryDeps,
  commandId: string,
  record: ScheduledRunRecord,
  chat: ScheduledRunChat,
  describe: (error: unknown) => string,
): Promise<{ answered: Promise<void> }> {
  const agent = deps.store.get(record.scheduledAgentId)
  // A record that names no chat yet is a run whose start was never recorded:
  // recorded now, at the time it began, and the record names its chat.
  if (!record.chat) {
    const run: ScheduledAgentLastRun = { at: record.startedAt, ok: true, ...chat }
    await deps.store.recordRun(record.scheduledAgentId, run, commandId)
    if (agent) deps.outcomes.onRan(agent, run)
  }
  const answered = deps
    .send(chat, commandId, { prompt: record.prompt, skills: record.skills ?? [] })
    .catch((error: unknown) => ({ ok: false as const, message: describe(error) }))
    .then(async (sent) => {
      if (!sent.ok)
        deps.outcomes.firstSendFailed(
          record.scheduledAgentId,
          chat.workspaceId,
          `The first message of a run cut off by Studio stopping could not be sent: ${sent.message}`,
        )
      await deps.store.endRun(commandId)
    })
    .catch((error: unknown) => deps.warn(`A scheduled run could not be finished: ${describe(error)}`))
  return { answered }
}
