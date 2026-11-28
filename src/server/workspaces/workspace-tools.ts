import { homedir } from 'node:os'

import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import type { Workspace } from '../../shared/workspace'
import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import type { WorkspaceCreateRequest, WorkspaceCreateResult } from '../../main/workspace-registry-service'
import type { WorkspaceMutationActor } from '../../main/workspace-sync-service'
import { workspaceStoresRoot } from '../../main/workspace-store'
import { refuseWorkspaceFolder } from '../../main/automation/workspace-folder-guard'
import { isThisMachinesChat, workspaceRecordView, type StudioWorkspaceList } from './studio-workspace-list'
import type { StudioWorkspaceReads } from './studio-workspace-reads'

// The agents' `workspace.*` tools: the workspaces this Studio holds, read and
// made in its own registry, and a project's checkout and extensions read where
// its folder is. Every Studio serves them from its own core (studio-gateway.ts),
// a WSL distribution's and an SSH machine's included, so an agent asking about
// its workspaces hears about the machine it runs on. `workspaces.list`,
// `workspaces.checkout` and `workspaces.extensions` on the Studio protocol
// read the same core methods.

type Created = { ok: true; result: WorkspaceCreateResult } | { ok: false; reason: string; message: string }

export type WorkspaceToolsDeps = {
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  /** The chats this Studio holds: the core's own list (`studio-workspace-list.ts`), as `workspaces.list` answers. */
  listWorkspaces: StudioWorkspaceList['list']
  /** This Studio's terminals, for each agent's liveness in `workspace.status`. None where no pty runs. */
  listTerminalSessions(): TerminalSessionSnapshot[]
  /**
   * Mint a workspace in this Studio's registry, through the extensions'
   * `workspace.create` hooks. Synchronous authority: the id comes back from
   * the call that committed it.
   */
  createWorkspace(
    input: WorkspaceCreateRequest,
    actor: WorkspaceMutationActor,
    /** The calling connection, for extensions' hooks to run as. */
    context?: McpConnectionContext,
  ): Created | Promise<Created>
  /** Whether a paired device may name this folder: inside one of this machine's own projects. */
  deviceMayName(folder: string): Promise<boolean>
  /**
   * Studio's own data folders here, which `workspace.create` will not open,
   * nor anything above or inside them. The workspace stores are added to them.
   */
  studioDataDirs(): readonly string[]
  /** A project's checkout facts: the core's own read (`studio-workspace-reads.ts`), as `workspaces.checkout` answers. */
  workspaceCheckout: StudioWorkspaceReads['checkout']
  /** A project's skills and a CLI's MCP servers there: the core's own read, as `workspaces.extensions` answers. */
  workspaceExtensions: StudioWorkspaceReads['extensions']
}

const DEVICE_FOLDER_REFUSED =
  'A paired device names only folders inside the projects this machine has open. Open that project on this machine first.'

export function createWorkspaceTools(deps: WorkspaceToolsDeps): McpToolRegistration[] {
  // A paired device reaches this machine's own workspaces, never this
  // desktop's copies of the chats another environment holds.
  function findWorkspace(workspaceId: string, context?: McpConnectionContext): Workspace | null {
    const workspace =
      deps.getWorkspaceSyncSnapshot().state.workspaces.find((candidate) => candidate.id === workspaceId) ?? null
    return workspace && (!isPairedDevice(context) || isThisMachinesChat(workspace)) ? workspace : null
  }

  function workspaceProjection(workspace: Workspace): Record<string, unknown> {
    return workspaceRecordView(workspace, deps.getWorkspaceSyncSnapshot().state.workspaceWindows)
  }

  const agentProjection = (workspace: Workspace, agentId: string) =>
    workspaceAgentView(workspace, agentId, deps.listTerminalSessions())

  const workspaceList: McpToolRegistration = {
    name: 'workspace.list',
    description:
      'List the workspaces visible to the user in the running SprintEngine instance, with window assignment and agent ids. ' +
      'Workspaces that survived a restart are listed like any other: main owns the registry, so their name, ' +
      'folder, mode, and agents are real whether or not a window is open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    // A paired device is not listed this desktop's copies of another
    // environment's chats: it reaches those on that machine, not through here.
    handler: async (_args, context) => success(await deps.listWorkspaces({ ownOnly: isPairedDevice(context) })),
  }

  const workspaceStatus: McpToolRegistration = {
    name: 'workspace.status',
    description: 'Read one workspace from the main process store, including its agents and their terminal liveness.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list or workspace.create.' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const workspace = findWorkspace(workspaceId, context)
      if (!workspace) return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
      return success({
        workspace: workspaceProjection(workspace),
        agents: Object.keys(workspace.agents).map((agentId) => agentProjection(workspace, agentId)),
      })
    },
  }

  const workspaceCreate: McpToolRegistration = {
    name: 'workspace.create',
    description:
      'Create a workspace in the running SprintEngine instance. The main process owns the registry, so this ' +
      'succeeds with no window open and the returned workspace is immediately addressable by every other tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workspace display name.' },
        folderPath: { type: 'string', description: 'Absolute folder to open in the workspace.' },
        templateId: { type: 'string', description: 'Layout template id; defaults to the standard template.' },
      },
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const invalid = firstInvalidOptionalString(args, ['name', 'folderPath', 'templateId'])
      if (invalid) return invalid
      // Held to project folders, whoever asks; a paired device further to
      // folders inside the projects this machine already has open.
      const folderPath = optionalString(args.folderPath)
      if (folderPath && isPairedDevice(context) && !(await deps.deviceMayName(folderPath)))
        return failure('folder_refused', DEVICE_FOLDER_REFUSED)
      if (folderPath) {
        const refused = await refuseWorkspaceFolder(folderPath, {
          platform: process.platform,
          homeDir: homedir(),
          dataDirs: [workspaceStoresRoot(), ...(deps.studioDataDirs?.() ?? [])],
        })
        if (refused) {
          return failure('folder_refused', `${refused} Open the project's own folder instead.`)
        }
      }
      // Synchronous authority: the id comes back from the same call that
      // committed it, which is what retired the delegate-to-renderer round trip
      // and its 7s bus-confirmation poll.
      const outcome = await deps.createWorkspace(
        {
          name: optionalString(args.name),
          folderPath: optionalString(args.folderPath),
          templateId: optionalString(args.templateId),
        },
        'gateway',
        context,
      )
      if (!outcome.ok) return failure(outcome.reason, outcome.message)
      return success({ workspace: workspaceProjection(outcome.result.workspace) })
    },
  }

  // The checkout facts behind a remote launch's checkout · branch segments
  // (checkout-and-branch-on-remote-create). A read, on `workspace:read`, so a
  // paired Studio can show where a chat would run before asking for it; the
  // worktree itself is minted by `agent.launch` (workspace:operate), never
  // here — scopes stay a function of the tool's NAME (tailnet-scopes.ts).
  const workspaceCheckout: McpToolRegistration = {
    name: 'workspace.checkout',
    description:
      "Read a workspace's git checkout: whether its folder is a repository, the branch it is on, the trunk, " +
      "every local branch, and the worktrees the repository holds. Pair it with agent.launch's " +
      '"worktree.baseRef" to start an agent on a fresh worktree branched from one of the listed branches.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const read = await deps.workspaceCheckout(workspaceId, { ownOnly: isPairedDevice(context) })
      return read.ok ? success(read.checkout) : failure(read.code, read.message)
    },
  }

  // What a paired machine's composer offers a chat here: the project's skills
  // (installed, and the built-ins a pick installs) and the MCP servers the
  // chat's CLI is configured with, each with the connection it last reported.
  // A read, on `workspace:read` like `workspace.checkout`; attaching one is
  // `conversation.create`'s `skills`, under its own grant.
  const workspaceExtensions: McpToolRegistration = {
    name: 'workspace.extensions',
    description:
      "List what a chat in a workspace's folder can use: `skills` (id, name, description, whether it is " +
      'installed there or a built-in a chat installs on first use, and the GitHub repository it came from when ' +
      'a skill source installed it) and, with `cli`, `servers`: the MCP servers that CLI is configured with, ' +
      'each with its `status` (connected, pending, needs-auth, failed, disabled) once a chat on it here has ' +
      "reported one. Pass the skill ids to conversation.create's `skills`.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Workspace id from workspace.list.' },
        cli: { type: 'string', description: 'The agent CLI plugin id whose MCP servers to list.' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const workspaceId = requireString(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const invalid = firstInvalidOptionalString(args, ['cli'])
      if (invalid) return invalid
      const read = await deps.workspaceExtensions(workspaceId, optionalString(args.cli) ?? null, {
        ownOnly: isPairedDevice(context),
      })
      return read.ok ? success(read.extensions) : failure(read.code, read.message)
    },
  }

  return [workspaceCheckout, workspaceExtensions, workspaceCreate, workspaceList, workspaceStatus]
}

/** The agent terminal this Studio runs for an agent, by its workspace and agent or its CLI session. */
export function agentTerminalSession(
  sessions: readonly TerminalSessionSnapshot[],
  workspaceId: string,
  agentId: string,
  cliSessionId?: string,
): TerminalSessionSnapshot | null {
  return (
    sessions.find(
      (session) =>
        session.kind === 'agent' &&
        session.workspaceId === workspaceId &&
        (session.agentId === agentId || (cliSessionId !== undefined && session.sessionId === cliSessionId)),
    ) ?? null
  )
}

/** One agent of a workspace as `workspace.status`, `agent.status` and `agent.launch` answer it: its record and its terminal. */
export function workspaceAgentView(
  workspace: Workspace,
  agentId: string,
  sessions: readonly TerminalSessionSnapshot[],
): Record<string, unknown> {
  const agent = workspace.agents[agentId]
  const session = agentTerminalSession(sessions, workspace.id, agentId, agent?.cliSessionId)
  return {
    workspaceId: workspace.id,
    agentId,
    name: agent?.name ?? null,
    cli: agent?.cli ?? null,
    cliStartRequested: agent?.cliStartRequested ?? false,
    cliHasLaunched: agent?.cliHasLaunched ?? false,
    cliSessionId: agent?.cliSessionId ?? null,
    terminal: session
      ? {
          sessionId: session.sessionId,
          processAlive: session.processAlive,
          startedAt: session.startedAt,
          lastOutputAt: session.lastOutputAt,
          phase: session.agentState?.phase ?? null,
        }
      : null,
  }
}

function isPairedDevice(context: McpConnectionContext | undefined): boolean {
  return context?.metadata?.kind === 'remote-tailnet'
}

function success(structured: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

function failure(code: string, message: string): McpToolResult {
  const structured = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

function requireString(args: Record<string, unknown>, key: string): string | McpToolResult {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    return failure('invalid_arguments', `"${key}" must be a non-empty string.`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function firstInvalidOptionalString(args: Record<string, unknown>, keys: string[]): McpToolResult | null {
  for (const key of keys) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      return failure('invalid_arguments', `"${key}" must be a string when provided.`)
    }
  }
  return null
}
