import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import {
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  type StudioScope,
} from '../../../../packages/studio-protocol/src/public'
import type { ConversationImageAttachment } from '../../../shared/conversation-runtime'
import type { WorkspaceSkill } from '../../../shared/ipc/skills'
import { asRecord } from '../../../shared/records'
import { TAILNET_SCOPE_STUDIO_SCOPES, TAILNET_SCOPES, type TailnetScope } from '../../../shared/tailnet'
import type {
  MeshBrowse,
  MeshConnection,
  MeshCreateConversationResult,
  MeshNewChatWorktree,
  MeshWorkspace,
  MeshWorkspaceCheckoutResult,
  MeshWorkspaceExtensionsResult,
} from '../../../shared/tailnet-mesh'
import type { WorkspaceExtensions } from '../../../shared/workspace-extensions'
import { createStudioConversationParts } from '../components/panels/agentChat/studioChat'
import { settlePairedChat } from './pairedChats'
import {
  askEnvironment,
  environmentCommandId,
  environmentRefusal,
  environmentStudioOutdated,
  pairedTarget,
  withEnvironmentStudio,
  type PairedMachine,
} from './environmentStudio'

// What this window reads of a paired machine before it starts a chat there,
// and the start itself, asked of that machine's Studio on the window's own
// connection to it: its projects (`workspaces.list`), a project's checkout and
// what a chat there can use (`workspaces.checkout`, `workspaces.extensions`),
// and `conversation.create`. A machine whose Studio is from before the
// protocol is told to update.

const discoveryUnsupported = (machineName: string) => ({
  code: 'outdated',
  message: environmentStudioOutdated(machineName),
})

/**
 * The tailnet scopes a grant's Studio scopes carry: each scope the pairing
 * names whose Studio scopes the grant holds, all of them. What a pairing may
 * do there, as that machine reads it now.
 */
export function tailnetScopesOfGrant(scopes: readonly StudioScope[]): TailnetScope[] {
  const held = new Set<string>(scopes)
  return TAILNET_SCOPES.filter((scope) => {
    const carried = TAILNET_SCOPE_STUDIO_SCOPES[scope]
    return carried.length > 0 && carried.every((studio) => held.has(studio))
  })
}

/** One workspace as that machine's `workspaces.list` serves it, read member by member. */
function meshWorkspaceOf(entry: unknown): MeshWorkspace[] {
  const record = asRecord(entry)
  if (!record || typeof record.id !== 'string') return []
  const repository = asRecord(record.repository)
  return [
    {
      id: record.id,
      name: typeof record.name === 'string' ? record.name : record.id,
      mode: typeof record.mode === 'string' ? record.mode : null,
      folderPath: typeof record.folderPath === 'string' ? record.folderPath : null,
      repository:
        repository && typeof repository.canonicalKey === 'string' && repository.canonicalKey
          ? {
              canonicalKey: repository.canonicalKey,
              remoteUrl: typeof repository.remoteUrl === 'string' ? repository.remoteUrl : '',
              name: typeof repository.name === 'string' ? repository.name : repository.canonicalKey,
            }
          : null,
      settledAt: typeof record.settledAt === 'number' && Number.isFinite(record.settledAt) ? record.settledAt : null,
    },
  ]
}

/**
 * What a paired machine holds, and what this pairing may do there: its
 * projects, the scopes its grant carries now, and what of its chats' records
 * its Studio keeps for this one (its welcome). A machine that does not answer
 * keeps nothing here; one that refuses the pairing says so.
 */
export async function browsePairedMachine(
  machine: Pick<MeshConnection, 'id' | 'machineName' | 'scopes'>,
): Promise<MeshBrowse> {
  try {
    return await withEnvironmentStudio(pairedTarget(machine), async (client) => {
      const scopes = tailnetScopesOfGrant(client.grant.scopes)
      const gaps: MeshBrowse['gaps'] = []
      let workspaces: MeshWorkspace[] = []
      // Asked for only when the grant allows it. A refusal is a real answer and is
      // reported as one: an empty list would say "that machine has no workspaces".
      if (!client.supports(STUDIO_WORKSPACES_CAPABILITY))
        gaps.push({ part: 'workspaces', code: 'outdated', message: environmentStudioOutdated(machine.machineName) })
      else if (!scopes.some((scope) => scope.startsWith('workspace:')))
        gaps.push({
          part: 'workspaces',
          code: 'scope_required',
          message: "This pairing may not read that machine's workspaces.",
        })
      else
        try {
          const listed = await client.rpc['workspaces.list']({})
          workspaces = (Array.isArray(listed.workspaces) ? listed.workspaces : []).flatMap(meshWorkspaceOf)
        } catch (error) {
          const refused = environmentRefusal(pairedTarget(machine), error)
          gaps.push({ part: 'workspaces', code: refused.code, message: refused.message })
        }
      return {
        connectionId: machine.id,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        scopes,
        workspaces,
        gaps,
        chatRecord: chatRecordOf(client),
      }
    })
  } catch (error) {
    const refused = environmentRefusal(pairedTarget(machine), error)
    if (refused.kind === 'outdated')
      return {
        connectionId: machine.id,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        scopes: machine.scopes,
        workspaces: [],
        gaps: [{ part: 'workspaces', code: refused.code, message: refused.message }],
      }
    return {
      connectionId: machine.id,
      reachable: false,
      unreachableReason: refused.message,
      unauthorized: refused.kind === 'unauthorized' && refused.code !== 'scope_required',
      scopes: machine.scopes,
      workspaces: [],
      gaps: [],
    }
  }
}

/** What of its chats' records a machine's Studio keeps for this one, from its welcome. */
function chatRecordOf(client: StudioClient): NonNullable<MeshBrowse['chatRecord']> {
  return {
    lifecycle: client.supports(STUDIO_CHAT_LIFECYCLE_CAPABILITY),
    unwatchPullRequest: client.supports(STUDIO_PULL_REQUEST_WATCH_CAPABILITY),
  }
}

/**
 * One of that machine's projects' checkout facts: branch, trunk, branches,
 * worktrees. A pairing that may not read them gets the refusal as its
 * answer, never an empty list dressed as "no branches".
 */
export async function pairedWorkspaceCheckout(
  machine: PairedMachine,
  workspaceId: string,
): Promise<MeshWorkspaceCheckoutResult> {
  if (!workspaceId)
    return { ok: false, code: 'invalid_arguments', message: 'Name the workspace whose checkout to read.' }
  const answer = await askEnvironment(
    pairedTarget(machine),
    STUDIO_WORKSPACES_CAPABILITY,
    discoveryUnsupported,
    (client) => client.rpc['workspaces.checkout']({ workspaceId }),
  )
  if (!answer.ok) return answer
  const value = answer.value as Record<string, unknown>
  const branches: unknown[] = Array.isArray(value.branches) ? value.branches : []
  const worktrees: unknown[] = Array.isArray(value.worktrees) ? value.worktrees : []
  return {
    ok: true,
    checkout: {
      workspaceId,
      git: value.git === true,
      branch: typeof value.branch === 'string' ? value.branch : null,
      defaultBranch: typeof value.defaultBranch === 'string' ? value.defaultBranch : null,
      branches: branches.flatMap((entry) => {
        if (typeof entry === 'string') return entry ? [{ name: entry, current: entry === value.branch }] : []
        const record = asRecord(entry)
        if (!record || typeof record.name !== 'string') return []
        return [{ name: record.name, current: record.current === true }]
      }),
      worktrees: worktrees.flatMap((entry) => {
        const record = asRecord(entry)
        if (!record || typeof record.path !== 'string') return []
        return [
          {
            path: record.path,
            branch: typeof record.branch === 'string' ? record.branch : null,
            isMain: record.isMain === true,
          },
        ]
      }),
    },
  }
}

/** The skills, and with a CLI that CLI's MCP servers, a chat in one of that machine's projects can use. */
export async function pairedWorkspaceExtensions(
  machine: PairedMachine,
  workspaceId: string,
  cli?: string,
): Promise<MeshWorkspaceExtensionsResult> {
  if (!workspaceId) return { ok: false, code: 'invalid_arguments', message: 'Name the workspace whose skills to list.' }
  const answer = await askEnvironment(
    pairedTarget(machine),
    STUDIO_WORKSPACES_CAPABILITY,
    (machineName) => ({
      code: 'skills_unsupported',
      message: `${machineName} cannot take skills from here yet. Update SprintEngine Studio there, or remove the skills.`,
    }),
    (client) => client.rpc['workspaces.extensions']({ workspaceId, ...(cli ? { cli } : {}) }),
  )
  if (!answer.ok) return answer
  return { ok: true, extensions: readWorkspaceExtensions(answer.value as Record<string, unknown>) }
}

/** What New chat asks of a paired machine. */
export type PairedChatLaunch = {
  /** A project there; absent with `noProject`. */
  workspaceId?: string
  noProject?: boolean
  cli?: string
  prompt?: string
  cliModel?: string
  permissionPreset?: string
  effort?: string
  worktree?: MeshNewChatWorktree
  /** Pictures that go with the first message, staged there once the chat exists. */
  images?: ConversationImageAttachment[]
  /** That machine's skills, installed into the chat's folder there and run with its first message. */
  skills?: string[]
}

/** How long starting a chat there may take: it starts its CLI, a healthy slow start is not a failure. */
const CREATE_TIMEOUT_MS = 60_000

/**
 * Start a chat agent on a paired machine. It runs there, in that machine's
 * conversation runtime; a pane here follows it by the ids this answers. With
 * pictures, the chat is started without its prompt, and the prompt is then
 * sent with them under its session, as a message to a chat here is; a chat
 * whose first message did not go is put to rest there, and refused here.
 */
export async function createPairedChat(
  machine: PairedMachine,
  launch: PairedChatLaunch,
): Promise<MeshCreateConversationResult> {
  if (!launch.noProject && !launch.workspaceId)
    return { ok: false, code: 'invalid_arguments', message: 'Name the remote workspace to start the chat in.' }
  if (launch.worktree?.kind === 'existing' && !launch.worktree.path.trim())
    return { ok: false, code: 'invalid_arguments', message: 'Name the worktree to start the chat in.' }
  const images = launch.images ?? []
  const skills = launch.skills ?? []
  const worktreeName = launch.worktree?.kind === 'new' ? launch.worktree.name.trim() : ''
  const create = {
    commandId: environmentCommandId(),
    // The workspace names the project the picker chose, not a chat to join,
    // so the chat is asked for as a new one; under no project it is new by what it is.
    ...(launch.noProject ? { noProject: true as const } : { workspaceId: launch.workspaceId!, newChat: true }),
    ...(launch.cli ? { cli: launch.cli } : {}),
    // With pictures the prompt is the first message's words, sent once they are up.
    ...(launch.prompt && images.length === 0 ? { prompt: launch.prompt } : {}),
    ...(launch.cliModel ? { model: launch.cliModel } : {}),
    ...(launch.permissionPreset ? { permissionPreset: launch.permissionPreset } : {}),
    ...(launch.effort ? { effort: launch.effort } : {}),
    ...(launch.worktree?.kind === 'new' ? { worktree: true, ...(worktreeName ? { worktreeName } : {}) } : {}),
    ...(launch.worktree?.kind === 'existing' ? { inWorktree: launch.worktree.path.trim() } : {}),
    ...(skills.length > 0 && images.length === 0 ? { skills } : {}),
  }
  const answer = await askEnvironment(
    pairedTarget(machine),
    STUDIO_WORKSPACES_CAPABILITY,
    (machineName) => ({
      code: 'outdated',
      message: `${machineName} cannot start chat agents from here yet. Update SprintEngine Studio there to start one from here.`,
    }),
    async (client) => {
      const created = await client.rpc['conversation.create'](
        create as Parameters<StudioClient['rpc']['conversation.create']>[0],
      )
      if (images.length === 0) return { created, first: null }
      // The first message, with its pictures, the way a chat here sends one.
      const sessionId = created.conversation.sessionId
      const first = sessionId
        ? await createStudioConversationParts(async () => client)
            .send({
              sessionId,
              message: launch.prompt ?? '',
              attachments: images,
              ...(skills.length > 0 ? { skills: skills.map((id) => ({ id })) } : {}),
            })
            .then(
              (sent) => (sent.ok ? null : sent.message),
              (error: unknown) => (error instanceof Error ? error.message : String(error)),
            )
        : 'The chat did not start a session to take it.'
      return { created, first }
    },
    { timeoutMs: CREATE_TIMEOUT_MS },
  )
  if (!answer.ok) return answer
  const { created, first } = answer.value
  const conversation = created.conversation
  if (first !== null) {
    // An empty chat nobody asked for is put to rest there, so it does not sit in its list.
    void settlePairedChat(machine, conversation.workspaceId).catch(() => undefined)
    return { ok: false, code: 'first_message_failed', message: `Its first message did not go: ${first}` }
  }
  return {
    ok: true,
    workspaceId: conversation.workspaceId,
    agentId: conversation.agentId,
    title: conversation.name || 'Chat',
    providerId: conversation.providerId,
    modelId: conversation.modelId,
    worktree: conversation.worktree ?? null,
  }
}

const SKILL_ID = /^[\w.-]{1,200}(?::[\w.-]{1,200})?$/
const SKILL_SOURCES = new Set(['builtin', 'custom', 'plugin'])
const SKILL_STATES = new Set(['installed', 'available', 'update-available'])
const SERVER_STATUSES = new Set(['connected', 'pending', 'needs-auth', 'failed', 'disabled'])
const SERVER_SCOPES = new Set(['workspace', 'user', 'session'])
const shortText = (value: unknown, max = 500) =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined

/**
 * `workspace.extensions`' answer, read member by member: another machine's
 * words are not trusted to be the shape they claim.
 */
function readWorkspaceExtensions(value: Record<string, unknown>): WorkspaceExtensions {
  const skills = (Array.isArray(value.skills) ? value.skills : []).flatMap((entry): WorkspaceSkill[] => {
    const record = asRecord(entry)
    const id = typeof record?.id === 'string' && SKILL_ID.test(record.id) ? record.id : null
    if (!record || !id) return []
    const description = shortText(record.description)
    const sourceRepo = shortText(record.sourceRepo, 200)
    return [
      {
        id,
        name: shortText(record.name, 200) ?? id,
        ...(description ? { description } : {}),
        source: (SKILL_SOURCES.has(record.source as string) ? record.source : 'custom') as WorkspaceSkill['source'],
        harnesses: [],
        installState: (SKILL_STATES.has(record.installState as string)
          ? record.installState
          : 'installed') as WorkspaceSkill['installState'],
        ...(sourceRepo && /^[\w.-]+\/[\w.-]+$/.test(sourceRepo) ? { sourceRepo } : {}),
      },
    ]
  })
  const servers = (Array.isArray(value.servers) ? value.servers : []).flatMap(
    (entry): WorkspaceExtensions['servers'] => {
      const record = asRecord(entry)
      const id = shortText(record?.id, 200)
      if (!record || !id) return []
      const error = shortText(record.error)
      return [
        {
          id,
          transport: shortText(record.transport, 40) ?? '',
          scope: (SERVER_SCOPES.has(record.scope as string) ? record.scope : 'session') as
            'workspace' | 'user' | 'session',
          ...(SERVER_STATUSES.has(record.status as string)
            ? { status: record.status as NonNullable<WorkspaceExtensions['servers'][number]['status']> }
            : {}),
          ...(error ? { error } : {}),
          ...(typeof record.toolCount === 'number' && Number.isSafeInteger(record.toolCount) && record.toolCount >= 0
            ? { toolCount: record.toolCount }
            : {}),
        },
      ]
    },
  )
  return { skills, servers }
}
