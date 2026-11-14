import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import { STUDIO_SCHEDULES_CAPABILITY } from '../../../../packages/studio-protocol/src/public'
import type { StudioScheduleDraft, StudioSchedules } from '../../../../packages/studio-protocol/src/schedules'
import { parseCliPermissionPreset } from '../../../shared/cli-permission-preset'
import type { ScheduledAgentLastRun, ScheduledAgentView, ScheduledAgentsPause } from '../../../shared/scheduled-agents'
import type {
  MeshCreateScheduledAgentInput,
  MeshCreateScheduledAgentResult,
  MeshScheduledAgentAction,
  MeshScheduledAgentActionResult,
  MeshScheduledAgentsResult,
  MeshUpdateScheduledAgentInput,
  MeshUpdateScheduledAgentResult,
} from '../../../shared/tailnet-mesh'
import {
  askEnvironment,
  environmentCommandId,
  pairedTarget,
  type EnvironmentAnswer,
  type EnvironmentTarget,
  type PairedMachine,
} from './environmentStudio'

// A paired machine's scheduled agents, asked by this window of that machine's
// Studio itself (`schedules.*`): listed on `workspaces:read`, made, changed,
// run, paused, resumed and closed on `workspaces:operate`, each change once
// per command id, so a retried Run now starts one chat there. A schedule there
// runs on that machine, by its scheduler.

function askSchedules<T>(
  machine: PairedMachine | EnvironmentTarget,
  work: (client: StudioClient) => Promise<T>,
  timeoutMs?: number,
): Promise<EnvironmentAnswer<T>> {
  return askEnvironment(
    'route' in machine ? machine : pairedTarget(machine),
    STUDIO_SCHEDULES_CAPABILITY,
    (machineName) => ({
      code: 'scheduled_agents_unsupported',
      message: `${machineName} cannot take schedules from here yet. Update SprintEngine Studio there to use its schedules from here.`,
    }),
    work,
    timeoutMs === undefined ? {} : { timeoutMs },
  )
}

/**
 * That machine's scheduled agents, and whether it takes a schedule from here:
 * a paired desktop's by its pairing, any other environment's (an SSH
 * machine's, a WSL distribution's) by the route this window reaches it by.
 */
export async function pairedScheduledAgents(
  machine: PairedMachine | EnvironmentTarget,
): Promise<MeshScheduledAgentsResult> {
  const answer = await askSchedules(machine, (client) => client.rpc['schedules.list']({}))
  if (!answer.ok) return answer
  return { ...scheduledAgentsOf(answer.value), canCreate: true, canEdit: true }
}

/** Run now, pause, resume or close one of them there. */
export async function pairedScheduledAgentAction(
  machine: PairedMachine | EnvironmentTarget,
  id: string,
  action: MeshScheduledAgentAction,
): Promise<MeshScheduledAgentActionResult> {
  if (!id) return { ok: false, code: 'invalid_arguments', message: 'Name the scheduled agent.' }
  if (!SCHEDULED_AGENT_ACTIONS.has(action))
    return { ok: false, code: 'invalid_arguments', message: 'Run, pause, resume or delete it.' }
  const commandId = environmentCommandId()
  const answer = await askSchedules<unknown>(
    machine,
    (client) =>
      action === 'run'
        ? client.rpc['schedules.runNow']({ id, commandId })
        : action === 'pause'
          ? client.rpc['schedules.pause']({ id, commandId })
          : action === 'resume'
            ? client.rpc['schedules.resume']({ id, commandId })
            : client.rpc['schedules.delete']({ id, commandId }),
    // A run waits on the chat starting over there, a CLI and all.
    action === 'run' ? 60_000 : undefined,
  )
  return answer.ok ? { ok: true, id, action } : answer
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** Schedule an agent there, in one of its projects. */
export async function createPairedScheduledAgent(
  machine: PairedMachine,
  input: Partial<MeshCreateScheduledAgentInput>,
): Promise<MeshCreateScheduledAgentResult> {
  const workspaceId = text(input.workspaceId)
  const prompt = text(input.prompt)
  const cron = text(input.cron)
  const cli = text(input.cli)
  if (!workspaceId || !prompt || !cron || !cli) {
    return { ok: false, code: 'invalid_arguments', message: 'A schedule needs a project, a prompt, a time and a CLI.' }
  }
  const draft = { workspaceId, ...scheduleDraftOf(input, { prompt, cron, cli }) }
  const commandId = environmentCommandId()
  const answer = await askSchedules(machine, (client) => client.rpc['schedules.create']({ ...draft, commandId }))
  if (!answer.ok) return answer
  const agent = scheduledAgentViewOf(answer.value.schedule)
  return agent
    ? { ok: true, agent }
    : { ok: false, code: 'unreadable_result', message: 'That machine scheduled it, in a shape this build cannot read.' }
}

/** Save an edit to one of them there. What the editor shows is the whole of it. */
export async function updatePairedScheduledAgent(
  machine: PairedMachine,
  input: Partial<MeshUpdateScheduledAgentInput>,
): Promise<MeshUpdateScheduledAgentResult> {
  const id = text(input.id)
  const prompt = text(input.prompt)
  const cron = text(input.cron)
  const cli = text(input.cli)
  if (!id || !prompt || !cron || !cli) {
    return { ok: false, code: 'invalid_arguments', message: 'A schedule needs a prompt, a time and a CLI.' }
  }
  const workspaceId = text(input.workspaceId)
  const change = {
    id,
    ...(workspaceId ? { workspaceId } : {}),
    ...scheduleDraftOf(input, { prompt, cron, cli }),
    // A model, a worktree, a skill or a server taken off there is taken off, not kept.
    model: text(input.model) ?? '',
    ...(input.worktreeName === null || input.worktreeName === undefined ? { worktree: false } : {}),
    skills: scheduleIds(input.skills),
    mcpServers: scheduleIds(input.mcpServers),
  }
  const commandId = environmentCommandId()
  const answer = await askSchedules(machine, (client) => client.rpc['schedules.update']({ ...change, commandId }))
  if (!answer.ok) return answer
  const agent = scheduledAgentViewOf(answer.value.schedule)
  return agent
    ? { ok: true, agent }
    : { ok: false, code: 'unreadable_result', message: 'That machine saved it, in a shape this build cannot read.' }
}

const SCHEDULED_AGENT_ACTIONS: ReadonlySet<MeshScheduledAgentAction> = new Set(['run', 'pause', 'resume', 'delete'])

/** An ISO instant (or epoch ms) as epoch ms; null for anything else. */
function instantOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

function attachmentsOf(value: unknown): Array<{ id: string; name: string }> {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const attachment = entry as Record<string, unknown>
    if (typeof attachment.id !== 'string' || !attachment.id) return []
    return [{ id: attachment.id, name: typeof attachment.name === 'string' ? attachment.name : attachment.id }]
  })
}

function scheduleIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
}

/**
 * What `schedules.create` and `schedules.update` both take of a schedule saved
 * from here, besides its project: the prompt, the time, the engine and what
 * each run is started with.
 */
function scheduleDraftOf(
  input: Partial<MeshCreateScheduledAgentInput | MeshUpdateScheduledAgentInput>,
  required: { prompt: string; cron: string; cli: string },
): Omit<StudioScheduleDraft, 'workspaceId'> {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const preset = input.permissionPreset ? parseCliPermissionPreset(input.permissionPreset) : null
  const once = typeof input.once === 'number' && Number.isSafeInteger(input.once) && input.once >= 0 ? input.once : null
  const timezone = text(input.timezone)
  const model = text(input.model)
  return {
    prompt: required.prompt,
    cron: required.cron,
    ...(timezone ? { timezone } : {}),
    ...(once !== null ? { once } : {}),
    cli: required.cli,
    ...(model ? { model } : {}),
    ...(preset ? { permissionPreset: preset } : {}),
    ...(typeof input.worktreeName === 'string'
      ? input.worktreeName.trim()
        ? { worktreeName: input.worktreeName.trim() }
        : { worktree: true }
      : {}),
    ...(scheduleIds(input.skills).length > 0 ? { skills: scheduleIds(input.skills) } : {}),
    ...(scheduleIds(input.mcpServers).length > 0 ? { mcpServers: scheduleIds(input.mcpServers) } : {}),
  }
}

/**
 * One scheduled agent as a paired machine's `schedules.list` serves it, read
 * member by member into the shape this machine's own list has: what another
 * machine sends is read, not trusted. Null for one without what a row needs —
 * an id, a prompt, a cron.
 */
export function scheduledAgentViewOf(value: unknown): ScheduledAgentView | null {
  if (!value || typeof value !== 'object') return null
  const agent = value as Record<string, unknown>
  const schedule =
    agent.schedule && typeof agent.schedule === 'object' ? (agent.schedule as Record<string, unknown>) : null
  if (typeof agent.id !== 'string' || !agent.id || typeof agent.prompt !== 'string') return null
  if (!schedule || typeof schedule.cron !== 'string') return null
  const once = instantOf(schedule.once)
  const lastRunRecord =
    agent.lastRun && typeof agent.lastRun === 'object' ? (agent.lastRun as Record<string, unknown>) : null
  const lastRunAt = instantOf(lastRunRecord?.at)
  let lastRun: ScheduledAgentLastRun | null = null
  if (lastRunRecord && lastRunAt !== null) {
    if (lastRunRecord.ok === true && typeof lastRunRecord.workspaceId === 'string') {
      lastRun = {
        at: lastRunAt,
        ok: true,
        workspaceId: lastRunRecord.workspaceId,
        ...(typeof lastRunRecord.agentId === 'string' ? { agentId: lastRunRecord.agentId } : {}),
      }
    } else if (lastRunRecord.ok === false) {
      lastRun = {
        at: lastRunAt,
        ok: false,
        message: typeof lastRunRecord.message === 'string' ? lastRunRecord.message : 'The run did not start.',
      }
    }
  }
  const pausedAt = instantOf(agent.pausedAt)
  const text = (entry: unknown) => (typeof entry === 'string' && entry ? entry : undefined)
  return {
    id: agent.id,
    ...(text(agent.name) ? { name: text(agent.name) } : {}),
    prompt: agent.prompt,
    schedule: {
      cron: schedule.cron,
      timezone: typeof schedule.timezone === 'string' ? schedule.timezone : 'UTC',
      ...(once !== null ? { once } : {}),
    },
    folderPath: typeof agent.folderPath === 'string' ? agent.folderPath : '',
    // A machine there (one of its WSL distributions) names nothing here.
    hostId: null,
    cli: typeof agent.cli === 'string' ? agent.cli : '',
    cliModel: text(agent.cliModel) ?? null,
    permissionPreset: agent.permissionPreset ? parseCliPermissionPreset(agent.permissionPreset) : null,
    skills: attachmentsOf(agent.skills),
    mcpServers: attachmentsOf(agent.mcpServers),
    worktree:
      agent.worktree && typeof agent.worktree === 'object'
        ? { name: text((agent.worktree as Record<string, unknown>).name) ?? '' }
        : null,
    ownerModuleId: text(agent.ownerModuleId) ?? null,
    createdAt: instantOf(agent.createdAt) ?? 0,
    updatedAt: instantOf(agent.updatedAt) ?? 0,
    lastRun,
    lastFailureSeenAt: instantOf(agent.lastFailureSeenAt),
    ...(pausedAt !== null ? { pausedAt } : {}),
    nextRunAt: instantOf(agent.nextRunAt),
    // Why that machine cannot run it now, in its words: a time that passes
    // there without a run is not a failure.
    ...(typeof agent.waiting === 'string' && agent.waiting ? { waiting: agent.waiting.slice(0, 500) } : {}),
  }
}

/** A machine's `schedules.list` answer (or `schedules.changed` push), kept to the rows this build can read. */
export function scheduledAgentsOf(value: StudioSchedules | Record<string, unknown>): {
  ok: true
  agents: ScheduledAgentView[]
  pausedAll: ScheduledAgentsPause | null
} {
  const rows: unknown = (value as Record<string, unknown>).schedules
  const agents = (Array.isArray(rows) ? rows : []).slice(0, 500).flatMap((entry) => scheduledAgentViewOf(entry) ?? [])
  const paused: unknown = (value as Record<string, unknown>).pausedAll
  const pause = paused && typeof paused === 'object' ? (paused as Record<string, unknown>) : null
  const since = instantOf(pause?.since)
  return { ok: true, agents, pausedAll: pause && since !== null ? { since, until: instantOf(pause.until) } : null }
}
