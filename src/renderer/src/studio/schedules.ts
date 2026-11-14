import {
  STUDIO_SCHEDULES_CAPABILITY,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type StudioScheduleDraftMembers,
} from '../../../../packages/studio-protocol/src/public'
import type {
  ScheduledAgentDraft,
  ScheduledAgentLastRun,
  ScheduledAgentView,
  ScheduledAgentWriteResult,
  ScheduledAgentsPause,
} from '../../../shared/scheduled-agents'
import { followWindowStudioPush, rereadOnReopen } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to this machine's scheduled agents: the Studio protocol's
// `schedules.*` and its `schedules.changed` stream, over the window's own
// connection, as the phone and a paired desktop reach them. The Scheduled
// section and its menus, New chat's schedule editor, the pause controls and
// the palette call these. The members keep the names and answers the window
// has always had, so a caller changes only where it imports them from. New
// chat schedules by folder (`workspaceRoot`), which only an owner may name.

export type SchedulesApi = {
  listScheduledAgents(): Promise<ScheduledAgentView[]>
  createScheduledAgent(draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  /** Save an edit: what the editor shows is the whole of it. */
  updateScheduledAgent(id: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  removeScheduledAgent(id: string): Promise<{ ok: true } | { ok: false; message: string }>
  runScheduledAgentNow(id: string): Promise<{ ok: true; run: ScheduledAgentLastRun } | { ok: false; message: string }>
  markScheduledAgentFailureSeen(id: string): Promise<{ ok: true }>
  /** Every scheduled agent, whole, each time one moves. Returns the unsubscriber. */
  onScheduledAgentsChanged(cb: (agents: ScheduledAgentView[]) => void): () => void
  pauseScheduledAgent(id: string): Promise<ScheduledAgentWriteResult>
  resumeScheduledAgent(id: string): Promise<ScheduledAgentWriteResult>
  getScheduledAgentsPause(): Promise<ScheduledAgentsPause | null>
  pauseAllScheduledAgents(
    until: number | null,
  ): Promise<{ ok: true; pause: ScheduledAgentsPause } | { ok: false; message: string }>
  resumeAllScheduledAgents(): Promise<{ ok: true } | { ok: false; message: string }>
  /** The pause of them all, said with every change to the list. Returns the unsubscriber. */
  onScheduledAgentsPauseChanged(cb: (pause: ScheduledAgentsPause | null) => void): () => void
}

const UNSERVED = 'This Studio does not serve its scheduled agents to this window.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function call<M extends StudioMethod>(method: M, params: StudioMethodParams<M>): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_SCHEDULES_CAPABILITY)) throw new Error(UNSERVED)
  return client.request(method, params)
}

/** A write under a command id of its own, its refusal answered in words as the window's IPC answered it. */
async function act<M extends StudioMethod, R>(
  method: M,
  params: Omit<StudioMethodParams<M>, 'commandId'>,
  answer: (result: StudioMethodResult<M>) => R,
): Promise<R | { ok: false; message: string }> {
  try {
    return answer(await call(method, { ...params, commandId: randomId() } as StudioMethodParams<M>))
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** A draft as the protocol takes it: the editor's whole schedule, at its folder and machine. */
function draftOf(draft: ScheduledAgentDraft): StudioScheduleDraftMembers & { workspaceRoot: string; hostId?: string } {
  return {
    workspaceRoot: draft.folderPath,
    ...(draft.hostId ? { hostId: draft.hostId } : {}),
    ...(draft.name !== undefined ? { name: draft.name } : {}),
    prompt: draft.prompt,
    cron: draft.schedule.cron,
    timezone: draft.schedule.timezone,
    ...(draft.schedule.once !== undefined ? { once: draft.schedule.once } : {}),
    cli: draft.cli,
    // Empty clears a model an edit took off.
    model: draft.cliModel ?? '',
    ...(draft.permissionPreset ? { permissionPreset: draft.permissionPreset } : {}),
    worktree: draft.worktree !== null,
    ...(draft.worktree?.name ? { worktreeName: draft.worktree.name } : {}),
    skills: draft.skills.map(({ id, name }) => ({ id, name })),
    mcpServers: draft.mcpServers.map(({ id, name }) => ({ id, name })),
  }
}

const written = (result: { schedule: ScheduledAgentView }): ScheduledAgentWriteResult => ({
  ok: true,
  agent: result.schedule,
})

export const schedulesApi: SchedulesApi = {
  listScheduledAgents: async () => (await call('schedules.list', {})).schedules,
  createScheduledAgent: (draft) =>
    act('schedules.create', draftOf(draft) as Omit<StudioMethodParams<'schedules.create'>, 'commandId'>, written),
  updateScheduledAgent: (id, draft) =>
    act(
      'schedules.update',
      { id, ...draftOf(draft) } as Omit<StudioMethodParams<'schedules.update'>, 'commandId'>,
      written,
    ),
  removeScheduledAgent: (id) => act('schedules.delete', { id }, () => ({ ok: true as const })),
  // A run that did not start is refused, and said as the IPC said a refusal:
  // its record, the failed last run, reaches the list on `schedules.changed`.
  runScheduledAgentNow: (id) =>
    act('schedules.runNow', { id }, ({ workspaceId }) => ({
      ok: true as const,
      run: { at: Date.now(), ok: true as const, workspaceId },
    })),
  markScheduledAgentFailureSeen: async (id) => {
    await act('schedules.markSeen', { id }, () => undefined)
    return { ok: true }
  },
  onScheduledAgentsChanged: (cb) =>
    followWindowStudioPush({
      topic: 'schedules.changed',
      params: {},
      capability: STUDIO_SCHEDULES_CAPABILITY,
      onPayload: (state) => cb(state.schedules),
      reread: rereadOnReopen(
        () => call('schedules.list', {}),
        (state) => cb(state.schedules),
      ),
    }),
  pauseScheduledAgent: (id) => act('schedules.pause', { id }, written),
  resumeScheduledAgent: (id) => act('schedules.resume', { id }, written),
  getScheduledAgentsPause: async () => (await call('schedules.list', {})).pausedAll,
  pauseAllScheduledAgents: (until) =>
    act('schedules.pauseAll', { until }, ({ pausedAll }) => ({ ok: true as const, pause: pausedAll })),
  resumeAllScheduledAgents: () => act('schedules.resumeAll', {}, () => ({ ok: true as const })),
  onScheduledAgentsPauseChanged: (cb) =>
    followWindowStudioPush({
      topic: 'schedules.changed',
      params: {},
      capability: STUDIO_SCHEDULES_CAPABILITY,
      onPayload: (state) => cb(state.pausedAll),
      reread: rereadOnReopen(
        () => call('schedules.list', {}),
        (state) => cb(state.pausedAll),
      ),
    }),
}
