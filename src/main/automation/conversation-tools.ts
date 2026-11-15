import { createProjectlessChatFolder } from '../projectless-chat-folders'
import {
  toolError,
  toolSuccess,
  type McpConnectionContext,
  type McpToolRegistration,
} from '../../shared/modules/mcp-tools'
import type { WorkspaceRegistryActor } from '../../shared/workspace-registry'
import type { ConversationLifecycle } from './conversation-lifecycle'
import type { ConversationMove } from './conversation-move'
import { parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import type { CliPermissionModeSpec } from '../../shared/cli-permission-mode'
import { conversationPermissionModes } from '../../shared/conversation-harness'
import {
  CONVERSATION_HIGHLIGHT_COLORS as HIGHLIGHT_COLORS,
  isConversationHighlightColor,
} from '../../../packages/conversation-protocol/src/public'
import type { ConversationLaunchService } from '../conversation-launch-service'
import type { WorktreeDependencyInstallView } from '../../shared/ipc/worktree-pool'
import {
  launchingAgentOf,
  NOT_TOLD_NOT_AN_AGENT,
  NOT_TOLD_UNAVAILABLE,
  type LaunchedAgentLink,
  type LaunchLinkResult,
} from '../agent-launch-notices'
import {
  capLaunchPermissionPreset,
  launchPermissionCeiling,
  resolveNamedPermissionMode,
  type AgentPermissionResolver,
} from './launch-permission-cap'

/**
 * Starting a chat is a mutation: audited, and on the tailnet it needs
 * `conversation:operate` — the grant that already lets a paired device send
 * into, stop and approve this machine's chats (tailnet-scopes.ts maps the
 * `conversation.` family by this classification). Settling one, saying it was
 * looked at and marking it unread write the desktop's own record of the chat,
 * so they need the same grant. A visit is left out of the audit all the same
 * (`isAuditedCall`): one is stamped every few seconds while a chat is on screen.
 */
export const CONVERSATION_MUTATION_TOOL_NAMES: readonly string[] = [
  'conversation.create',
  'conversation.settle',
  'conversation.visit',
  'conversation.mark_unread',
  'conversation.snooze',
  'conversation.highlight',
  'conversation.auto_settle',
  'conversation.change_project',
]

const EFFORT_ID = /^[a-z0-9_-]{1,40}$/i
// A skill's directory name, as the chat runtime accepts one (conversation-skills.ts).
const SKILL_ID = /^[\w.-]{1,200}(?::[\w.-]{1,200})?$/
const MAX_CREATE_SKILLS = 32

export type ConversationToolsDeps = {
  /** Makes the folder a chat with no project runs in. Absent, the one on this machine's disk. */
  makeProjectlessFolder?: (prompt: string | null) => Promise<string>
  /**
   * Starts the chat. Handed the caller, so a launch that would leave this
   * machine (a workspace another environment holds) can refuse a paired
   * device (environment-chat-calls.ts).
   */
  launch: (
    request: Parameters<ConversationLaunchService['launch']>[0],
    caller?: McpConnectionContext,
  ) => ReturnType<ConversationLaunchService['launch']>
  /** The calling agent's own preset, which a chat it starts may not exceed (launch-permission-cap.ts). */
  resolveAgentPermissionPreset: AgentPermissionResolver
  /** A CLI's permission modes as `cli.runtime.list` gives them, for a caller that names one. */
  permissionModesOf?: (cli: string) => readonly CliPermissionModeSpec[]
  /** A chat's rest and visit clock, written to the desktop's own record (conversation-lifecycle.ts). */
  lifecycle: Pick<ConversationLifecycle, 'settle' | 'visit' | 'markUnread' | 'snooze' | 'highlight' | 'setAutoSettle'>
  /**
   * Moving a chat to another folder, and the project it is in
   * (conversation-move.ts). Absent where this process cannot move a chat's
   * history (a Studio server out of process), and the tool says so.
   */
  moveChat?: ConversationMove['move']
  /**
   * Whether a paired device may name this folder: inside one of this
   * machine's own workspaces' folders, as the Studio protocol holds a device
   * to them. Absent, a device names none.
   */
  deviceMayName?: (folder: string) => Promise<boolean>
  /**
   * Remember that the calling agent started this chat, so the caller is told
   * when its turn ends or it waits on someone (agent-launch-notices.ts).
   * Answers whether the caller will be told. Absent where this process cannot
   * type into the caller (a Studio server out of process), and the result says
   * so.
   */
  linkLaunchedAgent?: (link: LaunchedAgentLink) => LaunchLinkResult
}

/**
 * Who a lifecycle write came through, for the registry's record of it: a
 * paired device over the tailnet, or the local socket's own callers.
 */
function lifecycleActor(context: McpConnectionContext | undefined): WorkspaceRegistryActor {
  return context?.metadata.kind === 'remote-tailnet' ? 'mobile' : 'gateway'
}

/**
 * A worktree's dependency install as a caller is told about it: where it is,
 * with no path on this machine (the caller may be a paired device).
 */
export function installProjection(view: WorktreeDependencyInstallView): Record<string, unknown> {
  return {
    state: view.state,
    command: view.command,
    reason: view.reason,
    startedAt: view.startedAt,
    endedAt: view.endedAt,
    lastLine: view.lastLine,
    exitCode: view.exitCode,
  }
}

export function createConversationTools(deps: ConversationToolsDeps): McpToolRegistration[] {
  return [
    {
      name: 'conversation.create',
      description:
        'Start a chat agent in a workspace: the CLI runs as a conversation (the chat view, not a terminal). ' +
        'The chat is added to the workspace, its session is started, and `prompt` is sent as its first ' +
        'message; the call returns once the session is up, without waiting for the reply. Follow it with ' +
        'the conversation stream by its workspaceId and agentId. Called by an agent of this app, the caller is ' +
        'told when the chat finishes a turn (with the end of its reply, quoted), fails or closes: a short notice ' +
        'from Studio arrives as a new message once the caller is idle, never in the middle of its turn. That the ' +
        "chat waits on the person for an answer or an approval rides along with the next notice. The result's " +
        '"notifyParent" says whether the caller will be told, and "notifyParentReason" why not. A new worktree ' +
        "whose project installs its dependencies first (an opt-in in this machine's Settings) answers while the " +
        'install runs, with "dependencyInstall" saying so: the chat and its session are there, and `prompt` is ' +
        'sent once the install ends, however it ends.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
          noProject: {
            type: 'boolean',
            description:
              'Start a new chat in a folder of its own, under no project, as New chat\'s "No project" does. Takes ' +
              'the place of workspaceId, and takes no worktree: there is no checkout to cut one from.',
          },
          newChat: {
            type: 'boolean',
            description:
              'Start a new chat of its own in the folder of workspaceId, rather than adding one to that ' +
              "workspace's chat. The new chat's workspaceId is returned; its first message titles it.",
          },
          worktree: {
            type: 'boolean',
            description:
              'With newChat, start the new chat in a git worktree of its own, cut the way New chat on this ' +
              "machine cuts one with Worktree on: from this machine's worktree pool, on the project's default " +
              'branch, as a branch `<prefix>/chat-<id>` (the branch prefix set in Settings ▸ Worktrees, `agent` ' +
              'unless changed); the chat is listed under the project it was cut from. A ' +
              'project that is not a git repository (or a folder on an SSH machine) is refused with ' +
              '"worktree_unavailable", never started in the checkout. Omitted or false, the chat works in the ' +
              "project's own folder.",
          },
          worktreeName: {
            type: 'string',
            description:
              "With worktree, what the new worktree is named from, as typed into New chat's Worktree field: its " +
              "branch is `<prefix>/<name>-<suffix>`, the short suffix keeping each chat's branch its own. A made-up " +
              '`chat-<suffix>` when omitted or blank.',
          },
          inWorktree: {
            type: 'string',
            description:
              'With newChat, start the new chat in a worktree the project already has: its path, one of the ' +
              '`worktrees` workspace.checkout lists for workspaceId. The chat is listed under the project. A ' +
              'path the repository does not list is refused with "worktree_unavailable"; the main worktree ' +
              "is the project's own folder. Not with worktree.",
          },
          cli: {
            type: 'string',
            description:
              'Agent CLI plugin id the chat drives; defaults to the last selected CLI. Only CLIs with a chat ' +
              'provider can start as a chat.',
          },
          cliModel: { type: 'string', description: "The CLI's model id; the CLI's own default when omitted." },
          effort: {
            type: 'string',
            description:
              "The reasoning effort the chat runs at: one of the CLI's `reasoningLevels` (cli.runtime.list); " +
              'another is refused with "unsupported_effort". The chat keeps it as New chat here keeps its ' +
              "effort pick, and every turn runs at it where the CLI's chat runtime takes that level: Claude Code " +
              "and Codex do (Codex's chat runs low to xhigh; a higher level runs at its default). A CLI that " +
              "declares no levels (Cursor, OpenCode, Grok) ignores it. Omitted, the CLI's own default.",
          },
          permissionPreset: {
            type: 'string',
            enum: ['bypass', 'auto', 'manual', 'none'],
            description:
              'Tool permissions: "bypass" skips the CLI\'s prompts; "auto" runs the CLI\'s own auto mode, which ' +
              'runs what it judges safe; "manual" asks before every edit, command and outside call; "none" lets ' +
              "the CLI's configuration decide. Prompts surface as approvals. Omitted, the preset chosen for that " +
              'CLI on this machine, else "auto". ' +
              "Called by an agent of this app, the chat runs no looser than that agent's own preset: a looser " +
              'one is refused with "permission_escalation", and an omitted one takes the stricter of the two.',
          },
          permissionMode: {
            type: 'string',
            description:
              "One of the CLI's own modes by id, from `permissionModes` in cli.runtime.list, where a chat runs " +
              'it: Claude Code\'s "acceptEdits" and "dontAsk", say. Needs "cli". Refused with ' +
              '"unknown_permission_mode" otherwise. It runs at its own level, held to the same limit as ' +
              '"permissionPreset". For a read-only chat use "mode".',
          },
          mode: {
            type: 'string',
            enum: ['default', 'plan', 'ask'],
            description:
              'The mode every turn of the chat runs in, the first included, whoever sends it. "ask" answers ' +
              'and "plan" plans; neither changes anything. Kept on the chat. A chat that cannot run it (Codex, ' +
              'Grok, Kimi Code) is refused with "unsupported_mode"; it never runs writable in its place. ' +
              'Omitted, "default".',
          },
          prompt: { type: 'string', description: "The chat's first message." },
          skills: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Skill ids to attach, as New chat's skill chips attach them: each is installed into the chat's " +
              'folder before its session starts, run with the first message, and kept on the chat. An id no ' +
              'skill on this machine answers to is refused with "unknown_skill".',
          },
          name: { type: 'string', description: 'Agent display name; one from the name pool when omitted.' },
          notifyParent: {
            type: 'boolean',
            description:
              'Tell the calling agent when the chat finishes a turn, fails or closes, with a short notice that ' +
              'arrives as a new message once the caller is idle. Defaults to true.',
          },
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const noProject = args.noProject === true
        const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
        if (noProject && workspaceId) {
          return toolError('invalid_arguments', '"noProject" takes the place of "workspaceId": name one of them.')
        }
        if (noProject && (args.worktree === true || args.worktreeName !== undefined || args.inWorktree !== undefined)) {
          return toolError('invalid_arguments', 'A chat with no project has no checkout to take a worktree from.')
        }
        if (!noProject && !workspaceId) return toolError('invalid_arguments', '"workspaceId" is required.')
        for (const key of [
          'cli',
          'cliModel',
          'prompt',
          'name',
          'permissionPreset',
          'permissionMode',
          'effort',
          'worktreeName',
          'inWorktree',
        ] as const) {
          if (args[key] !== undefined && typeof args[key] !== 'string') {
            return toolError('invalid_arguments', `"${key}" must be a string when provided.`)
          }
        }
        if (
          args.skills !== undefined &&
          (!Array.isArray(args.skills) ||
            args.skills.length > MAX_CREATE_SKILLS ||
            !args.skills.every((skill) => typeof skill === 'string' && SKILL_ID.test(skill)))
        ) {
          return toolError('invalid_arguments', `"skills" must be a list of at most ${MAX_CREATE_SKILLS} skill ids.`)
        }
        for (const key of ['newChat', 'worktree', 'notifyParent'] as const) {
          if (args[key] !== undefined && typeof args[key] !== 'boolean') {
            return toolError('invalid_arguments', `"${key}" must be a boolean when provided.`)
          }
        }
        // A worktree is where a new chat is born; a chat joining a workspace
        // works in that workspace's folder, which already is what it is.
        if (args.worktree === true && args.newChat !== true) {
          return toolError('invalid_arguments', '"worktree" starts a new chat in a worktree: set "newChat" with it.')
        }
        if (typeof args.worktreeName === 'string' && args.worktree !== true) {
          return toolError('invalid_arguments', '"worktreeName" names a new worktree: set "worktree" with it.')
        }
        if (typeof args.inWorktree === 'string' && args.newChat !== true) {
          return toolError('invalid_arguments', '"inWorktree" starts a new chat in a worktree: set "newChat" with it.')
        }
        if (typeof args.inWorktree === 'string' && args.worktree === true) {
          return toolError('invalid_arguments', 'Ask for a new worktree or name one in "inWorktree", not both.')
        }
        // The same shape a window's turn may name an effort in
        // (conversation-ipc-inputs.ts); whether the CLI has the level is the
        // launch's to say.
        if (typeof args.effort === 'string' && !EFFORT_ID.test(args.effort.trim())) {
          return toolError('invalid_arguments', '"effort" must be an effort level id, such as "high".')
        }
        const permissionPreset =
          args.permissionPreset === undefined ? undefined : parseCliPermissionPreset(args.permissionPreset)
        if (permissionPreset === null) {
          return toolError('invalid_arguments', '"permissionPreset" must be "bypass", "auto", "manual" or "none".')
        }
        if (args.mode !== undefined && args.mode !== 'default' && args.mode !== 'plan' && args.mode !== 'ask') {
          return toolError('invalid_arguments', '"mode" must be "default", "plan" or "ask".')
        }
        let namedMode: ReturnType<typeof resolveNamedPermissionMode> | null = null
        if (typeof args.permissionMode === 'string') {
          if (typeof args.cli !== 'string') {
            return toolError('invalid_arguments', '"permissionMode" is one CLI\'s own mode: name the "cli" with it.')
          }
          // Only the modes a chat runs: the rest are its terminal's, and a chat
          // would quietly fall back to the preset's own mode.
          const inChat = conversationPermissionModes(args.cli)
          namedMode = resolveNamedPermissionMode(
            (deps.permissionModesOf?.(args.cli) ?? []).filter(
              (mode) => parseCliPermissionPreset(mode.id) !== null || inChat.includes(mode.id),
            ),
            args.cli,
            args.permissionMode,
            permissionPreset,
          )
          if (!namedMode.ok) return toolError(namedMode.code, namedMode.message)
        }
        const capped = capLaunchPermissionPreset(
          namedMode?.ok ? namedMode.permissionPreset : permissionPreset,
          launchPermissionCeiling(context, deps.resolveAgentPermissionPreset),
        )
        if ('refused' in capped) return toolError(capped.refused.code, capped.refused.message)
        // Made last, so a call refused above leaves no empty folder behind.
        let projectlessFolder: string | null = null
        if (noProject) {
          try {
            const prompt = typeof args.prompt === 'string' ? args.prompt : null
            projectlessFolder = await (deps.makeProjectlessFolder ?? createProjectlessChatFolder)(prompt)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return toolError('launch_failed', `The chat's folder could not be made: ${message}`)
          }
        }
        const launched = await deps.launch(
          {
            ...(projectlessFolder
              ? { newChatIn: { folderPath: projectlessFolder } }
              : { workspaceId, ...(args.newChat === true ? { newChat: true } : {}) }),
            ...(args.worktree === true ? { newWorktree: true } : {}),
            ...(typeof args.worktreeName === 'string' && args.worktreeName.trim()
              ? { worktreeName: args.worktreeName.trim() }
              : {}),
            ...(typeof args.inWorktree === 'string' && args.inWorktree.trim()
              ? { existingWorktreePath: args.inWorktree.trim() }
              : {}),
            ...(typeof args.effort === 'string' ? { reasoningEffort: args.effort.trim() } : {}),
            ...(typeof args.cli === 'string' ? { cli: args.cli } : {}),
            ...(typeof args.cliModel === 'string' ? { cliModel: args.cliModel } : {}),
            ...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
            ...(Array.isArray(args.skills) && args.skills.length > 0 ? { skills: args.skills as string[] } : {}),
            ...(typeof args.name === 'string' ? { name: args.name } : {}),
            ...(capped.permissionPreset ? { permissionPreset: capped.permissionPreset } : {}),
            ...(namedMode?.ok && namedMode.permissionMode ? { permissionMode: namedMode.permissionMode } : {}),
            ...(args.mode === 'plan' || args.mode === 'ask' ? { mode: args.mode } : {}),
          },
          context,
        )
        if (!launched.ok) return toolError(launched.code, launched.message)
        const parent = launchingAgentOf(context)
        const linked: LaunchLinkResult | null =
          args.notifyParent === false
            ? null
            : !parent
              ? { linked: false, reason: NOT_TOLD_NOT_AN_AGENT }
              : !deps.linkLaunchedAgent
                ? { linked: false, reason: NOT_TOLD_UNAVAILABLE }
                : deps.linkLaunchedAgent({
                    parent,
                    child: {
                      workspaceId: launched.workspaceId,
                      agentId: launched.agentId,
                      sessionId: launched.sessionId,
                      transport: 'conversation',
                      name: launched.name,
                    },
                  })
        return toolSuccess({
          conversation: {
            workspaceId: launched.workspaceId,
            agentId: launched.agentId,
            name: launched.name,
            cli: launched.cli,
            providerId: launched.providerId,
            modelId: launched.modelId,
            sessionId: launched.sessionId,
          },
          notifyParent: linked?.linked === true,
          ...(linked && !linked.linked ? { notifyParentReason: linked.reason } : {}),
          ...(launched.dependencyInstall ? { dependencyInstall: installProjection(launched.dependencyInstall) } : {}),
          // Where the chat runs, when that is a worktree: a paired machine's
          // pane names the branch, and its row the worktree, from this.
          ...(launched.worktree ? { worktree: launched.worktree } : {}),
        })
      },
    },
    {
      name: 'conversation.settle',
      description:
        "Settle a chat on this machine, as its row menu's Settle does: it leaves the chat list, its agents' " +
        'processes end, and the next message to it resumes it. With settled: false it is brought back, and ' +
        'held out of the automatic settle until it sees new activity. Refused with "working" while an agent ' +
        'in the chat is working, with one exception: an agent settling its own chat, while its own turn is ' +
        'the only work there, is answered settlesWhenTurnEnds: true, and the chat settles once that turn ' +
        'completes. It stays as it is if the turn fails or is stopped, if a message reaches the chat first, ' +
        'or if another agent there is working by then. Settling a chat already settled, or bringing back one ' +
        'that is not, changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: "The chat's workspaceId, from the conversation list." },
          settled: { type: 'boolean', description: 'false brings a settled chat back. Defaults to true.' },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.workspaceId !== 'string' || !args.workspaceId.trim()) {
          return toolError('invalid_arguments', '"workspaceId" is required.')
        }
        if (args.settled !== undefined && typeof args.settled !== 'boolean') {
          return toolError('invalid_arguments', '"settled" must be a boolean when provided.')
        }
        const settled = deps.lifecycle.settle(
          args.workspaceId.trim(),
          args.settled !== false,
          lifecycleActor(context),
          launchingAgentOf(context),
        )
        if (!settled.ok) return toolError(settled.code, settled.message)
        if ('settlesWhenTurnEnds' in settled)
          return toolSuccess({
            ...settled,
            note: 'This chat settles once your current turn completes. Finish your reply as usual; it stays as it is if the turn fails or is stopped, or if a message reaches the chat first.',
          })
        return toolSuccess(settled)
      },
    },
    {
      name: 'conversation.visit',
      description:
        'Say that a person has a chat on this machine on screen, so its "finished, unseen" mark clears on ' +
        "every device. Moves the chat's lastVisitedAt forward to visitedAt (now when omitted, and never past " +
        'now); an earlier time changes nothing. It is not activity: the chat keeps its place in the list and ' +
        'a settled chat stays settled.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: "The chat's workspaceId, from the conversation list." },
          visitedAt: {
            type: 'number',
            description: 'When the person had it on screen, in epoch milliseconds. Defaults to now.',
          },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.workspaceId !== 'string' || !args.workspaceId.trim()) {
          return toolError('invalid_arguments', '"workspaceId" is required.')
        }
        if (
          args.visitedAt !== undefined &&
          !(typeof args.visitedAt === 'number' && Number.isFinite(args.visitedAt) && args.visitedAt >= 0)
        ) {
          return toolError('invalid_arguments', '"visitedAt" must be a time in epoch milliseconds when provided.')
        }
        const visited = deps.lifecycle.visit(
          args.workspaceId.trim(),
          args.visitedAt as number | undefined,
          lifecycleActor(context),
        )
        if (!visited.ok) return toolError(visited.code, visited.message)
        return toolSuccess(visited)
      },
    },
    {
      name: 'conversation.mark_unread',
      description:
        'Mark a chat on this machine unread, as its row menu\'s Mark unread does: its "finished, unseen" mark ' +
        "comes back on every device, and the next opening's divider sits above its latest reply. Moves the " +
        "chat's lastVisitedAt BACK, to its latest finish less a millisecond; the one call that moves it back. " +
        'A chat already unread from further back is left as it is. Refused with "nothing_finished" when no ' +
        'agent in the chat has finished anything.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: "The chat's workspaceId, from the conversation list." },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.workspaceId !== 'string' || !args.workspaceId.trim()) {
          return toolError('invalid_arguments', '"workspaceId" is required.')
        }
        const marked = await deps.lifecycle.markUnread(args.workspaceId.trim(), lifecycleActor(context))
        if (!marked.ok) return toolError(marked.code, marked.message)
        return toolSuccess(marked)
      },
    },
    {
      name: 'conversation.snooze',
      description:
        "Snooze a chat on this machine, as its row menu's Snooze does: it leaves the chat list for its " +
        "project's Snoozed shelf until `until`, and its agents' processes are paused. With until: null it " +
        'wakes now, as Wake now does. Refused with "working" while an agent in the chat is working, and ' +
        'with "settled" for a settled chat. Waking a chat that is awake changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: "The chat's workspaceId, from the conversation list." },
          until: {
            type: ['number', 'null'],
            description: 'When it wakes, in epoch milliseconds and still ahead; null wakes it now.',
          },
        },
        required: ['workspaceId', 'until'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.workspaceId !== 'string' || !args.workspaceId.trim()) {
          return toolError('invalid_arguments', '"workspaceId" is required.')
        }
        if (args.until !== null && !(typeof args.until === 'number' && Number.isFinite(args.until))) {
          return toolError('invalid_arguments', '"until" must be a time in epoch milliseconds, or null to wake.')
        }
        const snoozed = deps.lifecycle.snooze(args.workspaceId.trim(), args.until, lifecycleActor(context))
        if (!snoozed.ok) return toolError(snoozed.code, snoozed.message)
        return toolSuccess(snoozed)
      },
    },
    {
      name: 'conversation.highlight',
      description:
        "Star a chat on this machine, or give its row a highlight color, as its row menu's Star and " +
        'Highlight color do. A starred chat is listed in the Starred section. Name either or both; one left ' +
        'out stays as it is. color: null clears the color.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: "The chat's workspaceId, from the conversation list." },
          starred: { type: 'boolean', description: 'true stars the chat, false unstars it.' },
          color: {
            type: ['string', 'null'],
            enum: [...HIGHLIGHT_COLORS, null],
            description: "The row's highlight color, or null for none.",
          },
        },
        required: ['workspaceId'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.workspaceId !== 'string' || !args.workspaceId.trim()) {
          return toolError('invalid_arguments', '"workspaceId" is required.')
        }
        if (args.starred !== undefined && typeof args.starred !== 'boolean') {
          return toolError('invalid_arguments', '"starred" must be a boolean when provided.')
        }
        if (args.color !== undefined && args.color !== null && !isConversationHighlightColor(args.color)) {
          return toolError('invalid_arguments', `"color" must be one of ${HIGHLIGHT_COLORS.join(', ')}, or null.`)
        }
        if (args.starred === undefined && args.color === undefined) {
          return toolError('invalid_arguments', 'Name "starred", "color", or both.')
        }
        const marked = deps.lifecycle.highlight(
          args.workspaceId.trim(),
          {
            ...(args.starred !== undefined ? { starred: args.starred } : {}),
            ...(args.color !== undefined ? { color: args.color } : {}),
          },
          lifecycleActor(context),
        )
        if (!marked.ok) return toolError(marked.code, marked.message)
        return toolSuccess(marked)
      },
    },
    {
      name: 'conversation.auto_settle',
      description:
        "Switch Auto-settle on or off for a chat on this machine, as its row menu's Auto-settle does. With it " +
        'on, the chat settles by itself after the quiet days set in Settings (three unless changed), or once ' +
        'its pull requests land. Off by ' +
        'default. Settles nothing at once.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: "The chat's workspaceId, from the conversation list." },
          enabled: { type: 'boolean', description: 'true switches it on, false off.' },
        },
        required: ['workspaceId', 'enabled'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.workspaceId !== 'string' || !args.workspaceId.trim()) {
          return toolError('invalid_arguments', '"workspaceId" is required.')
        }
        if (typeof args.enabled !== 'boolean') {
          return toolError('invalid_arguments', '"enabled" must be a boolean.')
        }
        const set = deps.lifecycle.setAutoSettle(args.workspaceId.trim(), args.enabled, lifecycleActor(context))
        if (!set.ok) return toolError(set.code, set.message)
        return toolSuccess(set)
      },
    },
    {
      name: 'conversation.change_project',
      description:
        'Move a chat on this machine to another folder, and so to the project that folder is in: the sidebar ' +
        'files it under that project on every device, its Changes and files are read there, and its agent runs ' +
        'there from its next turn, resuming the same conversation. Call it on your own chat (leave out ' +
        '`workspaceId`) once you have made a new project, or moved your work into a folder of its own, and want ' +
        'the chat to follow; not for a folder you are only looking at or working on from where you are. Asked ' +
        'mid-turn of your own chat, the move is made once your turn completes (movesWhenTurnEnds: true): finish ' +
        'your reply as usual, and expect your next turn to start in the new folder. The chat stays where it is ' +
        'if the turn fails or is stopped, or a message reaches the chat first. Refused with "not_movable" for a ' +
        'chat in a worktree or on another machine, and with "working" while any other agent in the chat works.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: "The folder's absolute path on this machine: the project's root, or a folder in it.",
          },
          workspaceId: {
            type: 'string',
            description: "The chat's workspaceId, from the conversation list. Defaults to your own chat.",
          },
        },
        required: ['folder'],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        if (typeof args.folder !== 'string' || !args.folder.trim()) {
          return toolError('invalid_arguments', '"folder" is required.')
        }
        if (args.workspaceId !== undefined && (typeof args.workspaceId !== 'string' || !args.workspaceId.trim())) {
          return toolError('invalid_arguments', '"workspaceId" must be a chat\'s id when provided.')
        }
        const caller = launchingAgentOf(context)
        const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : caller?.workspaceId
        if (!workspaceId) return toolError('invalid_arguments', 'Name the chat to move: "workspaceId".')
        if (!deps.moveChat) return toolError('unavailable', 'This machine cannot move its chats from here.')
        if (context?.metadata.kind === 'remote-tailnet' && !(await deps.deviceMayName?.(args.folder)))
          return toolError(
            'folder_refused',
            'A paired device moves a chat only to a folder inside the projects this machine has open.',
          )
        const moved = await deps.moveChat(workspaceId, args.folder, lifecycleActor(context), caller)
        if (!moved.ok) return toolError(moved.code, moved.message)
        if (moved.movesWhenTurnEnds)
          return toolSuccess({
            ...moved,
            note: 'This chat moves once your current turn completes, and your next turn starts in the new folder. Finish your reply as usual.',
          })
        return toolSuccess(moved)
      },
    },
  ]
}
