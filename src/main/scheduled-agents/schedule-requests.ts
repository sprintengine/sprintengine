import type {
  StudioScheduleAttachment,
  StudioScheduleChange,
  StudioScheduleDraft,
  StudioSchedulePlace,
} from '../../../packages/studio-protocol/src/schedules'
import { LAUNCH_PROMPT_READS_AS_OPTION_MESSAGE, launchPromptReadsAsOption } from '../../shared/agent-launch'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { ScheduledAgentDraft, ScheduledAgentView } from '../../shared/scheduled-agents'
import { capScheduledAgentPreset } from '../automation/launch-permission-cap'

// What making or changing a scheduled agent asks, read into what the service
// stores: the one set of rules the gateway's `schedule.create` and
// `schedule.update` tools and the Studio protocol's `schedules.create` and
// `schedules.update` follow, so an agent on MCP, the phone and a paired
// desktop make the same schedule from the same request.
//
// A workspace names the project and the machine each run starts on: a
// worktree's workspace schedules into its project, since each run makes its
// own. An owner (the desktop's own New chat) may name the folder and its
// machine instead, which the router allows no one else. A prompt the CLI would read as an option is refused now rather than at
// every run, and the preset is held to the caller's ceiling, since a run
// launches later with nobody watching.

/** A workspace as a schedule reads it: its folder, its worktree's project, its machine. */
export type ScheduleWorkspace = {
  folderPath?: string | null
  worktree?: { repoRoot?: string } | null
  hostId?: ExecutionHostId | null
}

export type ScheduleRequestDeps = {
  findWorkspace(workspaceId: string): ScheduleWorkspace | null
  /** The CLI last picked on this machine, for a schedule that names none. */
  defaultCli(): string | null
}

/** Why a request was refused, in codes both the tools and the protocol name. */
export type ScheduleRequestRefusal = {
  ok: false
  code:
    | 'unknown_workspace'
    | 'workspace_folder_missing'
    | 'no_cli_selected'
    | 'prompt_reads_as_option'
    | 'permission_escalation'
  message: string
}

type Read<T> = { ok: true; value: T } | ScheduleRequestRefusal

function refusal(code: ScheduleRequestRefusal['code'], message: string): ScheduleRequestRefusal {
  return { ok: false, code, message }
}

function promptRefusal(prompt: string | undefined): ScheduleRequestRefusal | null {
  return prompt !== undefined && launchPromptReadsAsOption(prompt)
    ? refusal('prompt_reads_as_option', LAUNCH_PROMPT_READS_AS_OPTION_MESSAGE)
    : null
}

function placeOf(
  deps: ScheduleRequestDeps,
  workspaceId: string,
): Read<{ folderPath: string; hostId: ExecutionHostId | null }> {
  const workspace = deps.findWorkspace(workspaceId)
  if (!workspace) return refusal('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
  if (!workspace.folderPath)
    return refusal(
      'workspace_folder_missing',
      `Workspace "${workspaceId}" has no usable folder path in this app session; open it in the app first.`,
    )
  return {
    ok: true,
    value: { folderPath: workspace.worktree?.repoRoot ?? workspace.folderPath, hostId: workspace.hostId ?? null },
  }
}

function capped(
  requested: CliPermissionPreset | null,
  ceiling: CliPermissionPreset | null,
): Read<CliPermissionPreset | null> {
  const held = capScheduledAgentPreset(requested, ceiling)
  return 'refused' in held
    ? refusal('permission_escalation', held.refused.message)
    : { ok: true, value: held.permissionPreset }
}

/** Where a request says it runs: its workspace's place, or the folder and machine an owner named. */
function placeFrom(
  deps: ScheduleRequestDeps,
  place: StudioSchedulePlace,
): Read<{ folderPath: string; hostId: ExecutionHostId | null }> | null {
  if (place.workspaceId) return placeOf(deps, place.workspaceId)
  if (place.workspaceRoot) return { ok: true, value: { folderPath: place.workspaceRoot, hostId: place.hostId ?? null } }
  return null
}

const attachmentOf = (entry: StudioScheduleAttachment) =>
  typeof entry === 'string' ? { id: entry, name: entry } : { id: entry.id, name: entry.name || entry.id }
const attachmentsOf = (entries: readonly StudioScheduleAttachment[] | undefined) => (entries ?? []).map(attachmentOf)

/** What `create` stores for a new schedule, or why not. */
export function scheduleDraftOf(
  request: StudioScheduleDraft,
  deps: ScheduleRequestDeps,
  ceiling: CliPermissionPreset | null,
): Read<ScheduledAgentDraft> {
  const dashed = promptRefusal(request.prompt)
  if (dashed) return dashed
  const place = placeFrom(deps, request)
  if (!place) return refusal('unknown_workspace', 'Name the workspace each run starts in.')
  if (!place.ok) return place
  const preset = capped(request.permissionPreset ?? null, ceiling)
  if (!preset.ok) return preset
  const cli = request.cli?.trim() || deps.defaultCli()
  if (!cli) return refusal('no_cli_selected', 'Name a "cli": no agent CLI has been picked on this computer yet.')
  const worktreeName = request.worktreeName?.trim() ?? ''
  return {
    ok: true,
    value: {
      ...(request.name !== undefined ? { name: request.name } : {}),
      prompt: request.prompt,
      schedule: {
        cron: request.cron,
        timezone: request.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(request.once !== undefined ? { once: request.once } : {}),
      },
      folderPath: place.value.folderPath,
      hostId: place.value.hostId,
      cli,
      cliModel: request.model || null,
      permissionPreset: preset.value,
      skills: attachmentsOf(request.skills),
      mcpServers: attachmentsOf(request.mcpServers),
      worktree: request.worktree === true || worktreeName ? { name: worktreeName } : null,
    },
  }
}

/** What `update` stores for a change to `existing`: what is named changes, the rest stays. */
export function scheduleChangeOf(
  existing: ScheduledAgentView,
  request: StudioScheduleChange,
  deps: ScheduleRequestDeps,
  ceiling: CliPermissionPreset | null,
): Read<ScheduledAgentDraft> {
  const dashed = promptRefusal(request.prompt)
  if (dashed) return dashed
  let place = { folderPath: existing.folderPath, hostId: existing.hostId }
  const moved = placeFrom(deps, request)
  if (moved && !moved.ok) return moved
  if (moved) place = moved.value
  // The preset it will run on, held to the caller's own ceiling whether it
  // was named here or kept: a new prompt on a looser preset is a new launch.
  const preset = capped(request.permissionPreset ?? existing.permissionPreset, ceiling)
  if (!preset.ok) return preset
  const cron = request.cron
  const timezone = request.timezone?.trim() || existing.schedule.timezone
  const schedule =
    request.once !== undefined
      ? { cron: cron ?? existing.schedule.cron, timezone, once: request.once }
      : cron !== undefined
        ? { cron, timezone }
        : { ...existing.schedule, timezone }
  // An attachment takes the name it is sent with, else keeps the one it was
  // saved with; a new one sent by id alone is named by its id.
  const attachments = (sent: readonly StudioScheduleAttachment[] | undefined, kept: ScheduledAgentView['skills']) =>
    sent
      ? sent.map((entry) =>
          typeof entry === 'string'
            ? (kept.find((attachment) => attachment.id === entry) ?? { id: entry, name: entry })
            : attachmentOf(entry),
        )
      : kept
  const worktreeName = request.worktreeName?.trim() ?? ''
  const worktree = worktreeName
    ? { name: worktreeName }
    : request.worktree === true
      ? { name: '' }
      : request.worktree === false
        ? null
        : existing.worktree
  const name = request.name !== undefined ? request.name.trim() : existing.name
  return {
    ok: true,
    value: {
      ...(name ? { name } : {}),
      ...(existing.tag ? { tag: existing.tag } : {}),
      prompt: request.prompt ?? existing.prompt,
      schedule,
      folderPath: place.folderPath,
      hostId: place.hostId,
      cli: request.cli?.trim() || existing.cli,
      cliModel: request.model !== undefined ? request.model.trim() || null : existing.cliModel,
      permissionPreset: preset.value,
      skills: attachments(request.skills, existing.skills),
      mcpServers: attachments(request.mcpServers, existing.mcpServers),
      worktree,
    },
  }
}
