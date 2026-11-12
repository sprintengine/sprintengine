import {
  studioNoParams,
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParamsRefusal,
} from './contract.js'
import { STUDIO_WORKSPACES_CAPABILITY } from './handshake.js'

// What a client reads before it starts a chat on a Studio: the projects it has
// open, the CLIs a chat may run and their models, where a project's folder
// stands in git, and the skills and MCP servers a chat there can use. The
// phone's New and a paired desktop's New chat read these; so may any client
// that starts chats.
//
// Each answers what the Studio's gateway tools of the same purpose answer
// (`workspace.list`, `cli.runtime.list`, `workspace.checkout`,
// `workspace.extensions`), from the same services, so a client on the protocol
// and an agent on MCP read one thing. A row carries the members named here and
// may carry more; a client reads what it knows and passes over the rest.
//
// Reads, on `workspaces:read`, behind the `workspaces` capability. A workspace
// or CLI the Studio does not hold is refused `not_found`.

/** The repository a folder is a clone of: what makes every clone and worktree of it one project. */
export type StudioWorkspaceRepository = { canonicalKey: string; remoteUrl: string; name: string }

/** One workspace this Studio holds. */
export type StudioWorkspace = {
  id: string
  name: string
  folderPath: string | null
  hostId?: string
  /** `chat` for a chat of its own, or the window's mode. */
  mode?: string | null
  agentIds?: string[]
  /** When the chat was settled, ms epoch; null while it is in the list. */
  settledAt?: number | null
  repository?: StudioWorkspaceRepository | null
  /** The project's hue, as this Studio's sidebar paints it; null for no folder. */
  projectHue?: number | null
  /** How much this Studio has used the folder's project for new chats; New lists projects by it. */
  projectFrecency?: number
  /** The latest new chat in the folder, ISO time; null for never. */
  projectLastUsedAt?: string | null
  [member: string]: unknown
}

/** One model a CLI offers. */
export type StudioCliRuntimeModel = { id: string; label?: string; [member: string]: unknown }

/**
 * One agent CLI this Studio can start, as its registry holds it: declared,
 * not probed. Only a row with `agentSelectable` starts as an agent, and only
 * one with `conversational` as a chat.
 */
export type StudioCliRuntime = {
  id: string
  displayName?: string
  agentSelectable?: boolean
  conversational?: boolean
  supportsModelSelection?: boolean
  models?: StudioCliRuntimeModel[]
  permissionPresets?: string[]
  reasoningLevels?: unknown[]
  defaultReasoningLevel?: string | null
  /** What the model picker here offers for the CLI. */
  catalog?: Record<string, unknown>
  [member: string]: unknown
}

/** One worktree a repository holds. */
export type StudioWorktree = { path: string; branch: string | null; isMain?: boolean; [member: string]: unknown }

/** Where a workspace's folder stands in git; `git: false` for a folder that is not a repository. */
export type StudioWorkspaceCheckout = {
  workspaceId: string
  git: boolean
  branch?: string | null
  defaultBranch?: string | null
  branches?: string[]
  worktrees?: StudioWorktree[]
  [member: string]: unknown
}

/** What a chat in a workspace's folder can use: its skills, and with a CLI, that CLI's MCP servers. */
export type StudioWorkspaceExtensions = {
  workspaceId: string
  skills: Array<{ id: string; name?: string; description?: string; [member: string]: unknown }>
  servers?: Array<{ id?: string; name: string; status?: string; [member: string]: unknown }>
  [member: string]: unknown
}

export type StudioWorkspacesMethodMap = {
  'workspaces.list': { params: Record<string, never>; result: { workspaces: StudioWorkspace[] } }
  /** The CLIs a chat may run, or the one named. */
  'providers.runtimes': { params: { cli?: string }; result: { clis: StudioCliRuntime[] }; errors: 'not_found' }
  'workspaces.checkout': { params: { workspaceId: string }; result: StudioWorkspaceCheckout; errors: 'not_found' }
  'workspaces.extensions': {
    params: { workspaceId: string; cli?: string }
    result: StudioWorkspaceExtensions
    errors: 'not_found'
  }
}

export type StudioWorkspacesMethod = keyof StudioWorkspacesMethodMap

// ── Validation ──────────────────────────────────────────────────────────────

const refuse = (message: string): StudioParamsRefusal => studioParamsRefused(message)

function id(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}
const WORKSPACE_ID = '"workspaceId" names a workspace from workspaces.list.'
const CLI_ID = '"cli", when given, is a CLI id from providers.runtimes.'

const read = { scope: 'workspaces:read', mutation: false, capability: STUDIO_WORKSPACES_CAPABILITY } as const

export const STUDIO_WORKSPACES_METHODS: StudioMethodTable<StudioWorkspacesMethodMap> = {
  'workspaces.list': { ...read, params: studioNoParams },
  'providers.runtimes': {
    ...read,
    params: (value) => {
      if (value.cli !== undefined && !id(value.cli)) return refuse(CLI_ID)
      return studioParams(value.cli === undefined ? {} : { cli: (value.cli as string).trim() })
    },
  },
  'workspaces.checkout': {
    ...read,
    params: (value) =>
      id(value.workspaceId) ? studioParams({ workspaceId: value.workspaceId }) : refuse(WORKSPACE_ID),
  },
  'workspaces.extensions': {
    ...read,
    params: (value) => {
      if (!id(value.workspaceId)) return refuse(WORKSPACE_ID)
      if (value.cli !== undefined && !id(value.cli)) return refuse(CLI_ID)
      return studioParams({
        workspaceId: value.workspaceId,
        ...(value.cli === undefined ? {} : { cli: (value.cli as string).trim() }),
      })
    },
  },
}
