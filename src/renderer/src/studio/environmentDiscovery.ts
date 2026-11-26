import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import {
  STUDIO_AGENT_SETTINGS_CAPABILITY,
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_FILES_CAPABILITY,
  STUDIO_NEW_CHAT_FOLDER_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  type StudioScope,
} from '../../../../packages/studio-protocol/src/public'
import type { AgentCliAvailabilityMap } from '../../../shared/workspace'
import type { ConversationImageAttachment } from '../../../shared/conversation-runtime'
import type { WorkspaceSkill } from '../../../shared/ipc/skills'
import { asRecord } from '../../../shared/records'
import { TAILNET_SCOPE_STUDIO_SCOPES, TAILNET_SCOPES, type TailnetScope } from '../../../shared/tailnet'
import type {
  MeshCreateConversationResult,
  MeshGap,
  MeshNewChatWorktree,
  MeshWorkspace,
  MeshWorkspaceCheckoutResult,
  MeshWorkspaceExtensionsResult,
} from '../../../shared/tailnet-mesh'
import type { WorkspaceExtensions } from '../../../shared/workspace-extensions'
import { createStudioConversationParts } from '../components/panels/agentChat/studioChat'
import {
  askEnvironment,
  environmentCommandId,
  environmentRefusal,
  environmentStudioOutdated,
  withEnvironmentStudio,
  type EnvironmentTarget,
} from './environmentStudio'
import { copy } from '../../../shared/copy'

// What this window reads of another environment before it starts a chat
// there, and the start itself, asked of that environment's Studio on the
// window's own connection to it, whatever its route (design-environments PR
// 2): its projects (`workspaces.list`), a project's checkout and what a chat
// there can use (`workspaces.checkout`, `workspaces.extensions`), whether a
// folder there is a repository, which agent CLIs it has, and
// `conversation.create`. A Studio from before the protocol is told to update.

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

/** One environment's contents, as the window reads them of its Studio (`browseEnvironment`). */
export type EnvironmentBrowse = {
  /** The route it was asked by (`formatEnvironmentRoute`). */
  route: string
  /** False when it did not answer at all; everything below is then empty. */
  reachable: boolean
  /** Why it did not answer, in a sentence. Null when it did. */
  unreachableReason: string | null
  /** True when it refused this desktop: a pairing revoked there, a sign-in needed. */
  unauthorized: boolean
  workspaces: MeshWorkspace[]
  gaps: MeshGap[]
  /**
   * What of its chats' records its Studio keeps for this one, as its welcome
   * says: `lifecycle` (`chat-lifecycle`), `unwatchPullRequest`
   * (`pull-request-watch`). Absent from a browse that did not reach it.
   */
  chatRecord?: { lifecycle: boolean; unwatchPullRequest: boolean }
  /** It starts a chat in a folder no workspace there names yet (`new-chat-folder`). */
  takesFolder: boolean
  /** What this desktop may do there, as its grant says now; empty from one not reached. */
  grantScopes: StudioScope[]
}

/**
 * What another environment holds, and what this desktop may do there: its
 * projects, whether it starts a chat in a folder named here, and what of its
 * chats' records its Studio keeps for this one (its welcome). One that does
 * not answer keeps nothing here; one that refuses this desktop says so.
 */
export async function browseEnvironment(target: EnvironmentTarget): Promise<EnvironmentBrowse> {
  const unanswered = { workspaces: [], takesFolder: false, grantScopes: [] }
  try {
    return await withEnvironmentStudio(target, async (client) => {
      const gaps: MeshGap[] = []
      let workspaces: MeshWorkspace[] = []
      // Asked for only when the grant allows it. A refusal is a real answer and is
      // reported as one: an empty list would say "that machine has no workspaces".
      if (!client.supports(STUDIO_WORKSPACES_CAPABILITY))
        gaps.push({ part: 'workspaces', code: 'outdated', message: environmentStudioOutdated(target.name) })
      else if (!client.grant.scopes.includes('workspaces:read'))
        gaps.push({
          part: 'workspaces',
          code: 'scope_required',
          message: copy.studio.environmentDiscovery.thisPairingMayNotRead,
        })
      else
        try {
          const listed = await client.rpc['workspaces.list']({})
          workspaces = (Array.isArray(listed.workspaces) ? listed.workspaces : []).flatMap(meshWorkspaceOf)
        } catch (error) {
          const refused = environmentRefusal(target, error)
          gaps.push({ part: 'workspaces', code: refused.code, message: refused.message })
        }
      return {
        route: target.route,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        workspaces,
        gaps,
        chatRecord: chatRecordOf(client),
        takesFolder: client.supports(STUDIO_NEW_CHAT_FOLDER_CAPABILITY),
        grantScopes: [...client.grant.scopes],
      }
    })
  } catch (error) {
    const refused = environmentRefusal(target, error)
    // Reached, but the two do not share a protocol: said as a gap, with which side to update.
    if (refused.kind === 'outdated' || refused.kind === 'incompatible')
      return {
        ...unanswered,
        route: target.route,
        reachable: true,
        unreachableReason: null,
        unauthorized: false,
        gaps: [{ part: 'workspaces', code: refused.code, message: refused.message }],
      }
    return {
      ...unanswered,
      route: target.route,
      reachable: false,
      unreachableReason: refused.message,
      unauthorized: refused.kind === 'unauthorized' && refused.code !== 'scope_required',
      gaps: [],
    }
  }
}

/** What of its chats' records a machine's Studio keeps for this one, from its welcome. */
function chatRecordOf(client: StudioClient): NonNullable<EnvironmentBrowse['chatRecord']> {
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
export async function environmentWorkspaceCheckout(
  target: EnvironmentTarget,
  workspaceId: string,
): Promise<MeshWorkspaceCheckoutResult> {
  if (!workspaceId)
    return {
      ok: false,
      code: 'invalid_arguments',
      message: copy.studio.environmentDiscovery.nameTheWorkspaceWhoseCheckout,
    }
  const answer = await askEnvironment(target, STUDIO_WORKSPACES_CAPABILITY, discoveryUnsupported, (client) =>
    client.rpc['workspaces.checkout']({ workspaceId }),
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
export async function environmentWorkspaceExtensions(
  target: EnvironmentTarget,
  workspaceId: string,
  cli?: string,
): Promise<MeshWorkspaceExtensionsResult> {
  if (!workspaceId)
    return {
      ok: false,
      code: 'invalid_arguments',
      message: copy.studio.environmentDiscovery.nameTheWorkspaceWhoseSkills,
    }
  const answer = await askEnvironment(
    target,
    STUDIO_WORKSPACES_CAPABILITY,
    (machineName) => ({
      code: 'skills_unsupported',
      message: copy.studio.environmentDiscovery.canTTakeSkillsFrom(machineName),
    }),
    (client) => client.rpc['workspaces.extensions']({ workspaceId, ...(cli ? { cli } : {}) }),
  )
  if (!answer.ok) return answer
  return { ok: true, extensions: readWorkspaceExtensions(answer.value as Record<string, unknown>) }
}

/** What New chat asks of another environment. */
export type EnvironmentChatLaunch = {
  /** A project there; absent with `noProject` or `folder`. */
  workspaceId?: string
  noProject?: boolean
  /** A folder there no workspace names yet, as that machine spells it (`new-chat-folder`). */
  folder?: string
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

/** A chat started there: where it is (`environmentId`, null for a Studio that did not say) and what it is. */
export type EnvironmentChatCreated = MeshCreateConversationResult & { environmentId?: string | null }

/**
 * Start a chat agent on another environment, the one way New chat starts one
 * anywhere but this computer. It runs there, in that machine's conversation
 * runtime; a pane here follows it by the address this answers. With
 * pictures, the chat is started without its prompt, and the prompt is then
 * sent with them under its session, as a message to a chat here is; a chat
 * whose first message did not go is put to rest there, and refused here.
 */
export async function createEnvironmentChat(
  target: EnvironmentTarget,
  launch: EnvironmentChatLaunch,
): Promise<EnvironmentChatCreated> {
  const folder = launch.folder?.trim() ?? ''
  if (!launch.noProject && !launch.workspaceId && !folder)
    return { ok: false, code: 'invalid_arguments', message: copy.studio.environmentDiscovery.nameTheRemoteWorkspaceTo }
  if (launch.worktree?.kind === 'existing' && !launch.worktree.path.trim())
    return { ok: false, code: 'invalid_arguments', message: copy.studio.environmentDiscovery.nameTheWorktreeToStart }
  const images = launch.images ?? []
  const skills = launch.skills ?? []
  const worktreeName = launch.worktree?.kind === 'new' ? launch.worktree.name.trim() : ''
  const create = {
    commandId: environmentCommandId(),
    // The workspace names the project the picker chose, not a chat to join,
    // so the chat is asked for as a new one; under no project it is new by what it is.
    ...(launch.noProject
      ? { noProject: true as const }
      : folder
        ? { folder }
        : { workspaceId: launch.workspaceId!, newChat: true }),
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
    target,
    STUDIO_WORKSPACES_CAPABILITY,
    (machineName) => ({
      code: 'outdated',
      message: copy.studio.environmentDiscovery.canTStartChatAgents(machineName),
    }),
    async (client) => {
      // A Studio from before a folder could be named: said in words, never a chat somewhere else.
      if (folder && !client.supports(STUDIO_NEW_CHAT_FOLDER_CAPABILITY))
        throw new Error(copy.studio.environmentDiscovery.updateToStartInAFolder(target.name))
      const environmentId = client.welcome.environment?.id ?? null
      const created = await client.rpc['conversation.create'](
        create as Parameters<StudioClient['rpc']['conversation.create']>[0],
      )
      if (images.length === 0) return { created, first: null, environmentId }
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
      return { created, first, environmentId }
    },
    { timeoutMs: CREATE_TIMEOUT_MS },
  )
  if (!answer.ok) return answer
  const { created, first, environmentId } = answer.value
  const conversation = created.conversation
  if (first !== null) {
    // An empty chat nobody asked for is put to rest there, so it does not sit in its list.
    void askEnvironment(target, STUDIO_CHAT_LIFECYCLE_CAPABILITY, discoveryUnsupported, (client) =>
      client.rpc['conversation.settle']({ workspaceId: conversation.workspaceId, commandId: environmentCommandId() }),
    ).catch(() => undefined)
    return {
      ok: false,
      code: 'first_message_failed',
      message: copy.studio.environmentDiscovery.itsFirstMessageDidNot(first),
    }
  }
  return {
    ok: true,
    environmentId,
    workspaceId: conversation.workspaceId,
    agentId: conversation.agentId,
    title: conversation.name || copy.studio.environmentDiscovery.chat,
    providerId: conversation.providerId,
    modelId: conversation.modelId,
    worktree: conversation.worktree ?? null,
  }
}

/**
 * Whether a folder on another environment, as that machine spells it, is in a
 * git repository there: New chat offers Worktree only inside one. False for
 * one it cannot read, or a Studio that does not say.
 */
export async function environmentFolderIsRepository(target: EnvironmentTarget, folder: string): Promise<boolean> {
  const answer = await askEnvironment(target, STUDIO_FILES_CAPABILITY, discoveryUnsupported, (client) =>
    client.rpc['files.repoRoot']({ folderPath: folder }),
  )
  return answer.ok && typeof answer.value.repoRoot === 'string' && answer.value.repoRoot.length > 0
}

/**
 * Which of these agent CLIs another environment has installed, asked of that
 * machine's own Studio (`cliRuntimes.detect`, one probe per CLI there): the
 * agent picker for a chat there lists that machine's CLIs, not this
 * computer's. Null when it cannot say (not reached, too old, not allowed).
 */
export async function environmentAgentAvailability(
  target: EnvironmentTarget,
  clis: readonly string[],
): Promise<AgentCliAvailabilityMap | null> {
  const answer = await askEnvironment(target, STUDIO_AGENT_SETTINGS_CAPABILITY, discoveryUnsupported, (client) =>
    Promise.all(
      clis.map(async (cli) => {
        const found = await client.rpc['cliRuntimes.detect']({ cli }).catch(() => null)
        return [cli, found] as const
      }),
    ),
  )
  if (!answer.ok) return null
  // A CLI it would not probe (not allowed, not served) is left out, which
  // lists it as before; a machine that probed none says nothing.
  const map: AgentCliAvailabilityMap = {}
  for (const [cli, found] of answer.value)
    if (found)
      map[cli] = {
        cli,
        installed: found.installed === true,
        version: found.version ?? null,
        resolvedPath: found.resolvedPath ?? null,
      }
  return Object.keys(map).length > 0 ? map : null
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
