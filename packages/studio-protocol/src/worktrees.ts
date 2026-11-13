import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_AGENT_WORKTREES_OWNER } from './git.js'
import type { GitCommandResult, GitWorktreeOperationResult } from './git-types.js'
import { STUDIO_WORKTREES_CAPABILITY } from './handshake.js'
import { isStudioPath } from './key.js'
import type { StudioScope } from './scopes.js'
import type {
  AgentWorktreeCleanupInput,
  AgentWorktreeCleanupReport,
  GitWorktreeCreated,
  GitWorktreeCreateInput,
  GitWorktreeRemoveInput,
  GitWorktreeRestoreInput,
  GitWorktreeRestoreResult,
  SettledChatDeletionOutcome,
  SettledChatDeletionPlan,
  WorktreeDependencyInstallSetting,
  WorktreeDependencyInstallView,
  WorktreeInventory,
  WorktreeInventoryInput,
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolHeldAction,
  WorktreePoolSettings,
  WorktreePoolSnapshot,
} from './worktree-types.js'

// The worktrees Studio's agents run in, on a Studio's machine: the worktree
// pool that hands them out and takes them back, the dependency installs a
// lease runs, every project's worktrees as Settings ▸ Worktrees lists them,
// and the agents' worktree steps a window takes (make one, bring a chat's
// back, remove one, clean up the agents' old ones). Offered as `worktrees` by
// every Studio's core, beside the pool it keeps, so the window, the agents'
// `worktree.lease` and `worktree.release` tools, schedules and a paired
// device's turns all reach the one pool.
//
// Grants.
// - The pool and the agents' worktrees are an owner's: they are this
//   machine's checkouts, which the pool hands out, resets, commits, stashes
//   and removes on its own judgement. Removing one gives the reason `git.ts`
//   gives for `git.pruneWorktrees`.
// - Deleting a settled chat (`settledChats.*`) reaches what a paired device's
//   Delete on a chat here reaches: the plan is a chat read, the delete drives
//   the chat.
//
// A folder on an SSH machine (`ssh://…`) is refused in words: its worktrees
// are its own server's.

type Commanded<P> = P & { commandId: string }
type Read<P, R> = { params: P; result: R }
type Write<P, R> = { params: Commanded<P>; result: R }

export type StudioWorktreesMethodMap = {
  /** A repository's pool, or null when it has none. */
  'worktrees.poolSnapshot': Read<{ repoRoot: string }, { snapshot: WorktreePoolSnapshot | null }>
  'worktrees.poolSettings': Read<Record<string, never>, WorktreePoolSettings>
  /** Change some of the pool's settings; answers with all of them as stored. */
  'worktrees.setPoolSettings': Write<{ patch: Partial<WorktreePoolSettings> }, WorktreePoolSettings>
  /** Every worktree of these projects and of every pool, for Settings ▸ Worktrees. */
  'worktrees.inventory': Read<WorktreeInventoryInput, WorktreeInventory>
  /** A person's decision on a held slot, an idle slot removed or cleared, a lease given back or brought up to date. */
  'worktrees.poolAction': Write<{ action: WorktreePoolActionInput }, WorktreePoolActionResult>
  /** Remove a worktree the pool does not own, checked as a pool eviction is. */
  'worktrees.removeOther': Write<{ repoRoot: string; path: string }, WorktreePoolActionResult>
  /** The dependency installs leased worktrees are running now. */
  'worktrees.installs': Read<Record<string, never>, { installs: WorktreeDependencyInstallView[] }>
  'worktrees.cancelInstall': Write<{ id: string }, { cancelled: boolean }>
  /** An agent's worktree, from the pool with `fromPool`; the dependency install it needs runs before the answer. */
  'worktrees.create': Write<{ input: GitWorktreeCreateInput }, GitWorktreeOperationResult<GitWorktreeCreated>>
  /** Check a chat's worktree out again at the path it had, on the branch it kept. */
  'worktrees.restore': Write<{ input: GitWorktreeRestoreInput }, GitWorktreeRestoreResult>
  'worktrees.remove': Write<{ input: GitWorktreeRemoveInput }, GitWorktreeOperationResult<GitCommandResult>>
  /** Remove agent worktrees that are clean and merged, give pool slots back; report (and keep) the rest. */
  'worktrees.cleanupAgents': Write<{ input: AgentWorktreeCleanupInput }, AgentWorktreeCleanupReport>

  /** What deleting each of these settled chats would do: its worktrees' fate, or why it cannot be deleted now. */
  'settledChats.planDelete': Read<{ workspaceIds: string[] }, { plans: SettledChatDeletionPlan[] }>
  /** Delete these settled chats for good: history, record, and the worktrees each owns (back to the pool, or removed). */
  'settledChats.delete': Write<{ workspaceIds: string[] }, { outcomes: SettledChatDeletionOutcome[] }>
}

export type StudioWorktreesMethod = keyof StudioWorktreesMethodMap

export type StudioWorktreesTopicMap = {
  /** A pool's snapshot moved; one stream for every pool, which a client filters on the repository. */
  'worktrees.poolChanged': { params: Record<string, never>; payload: WorktreePoolSnapshot; stream: 'push' }
  /** A leased worktree's dependency install started, moved on, or ended. */
  'worktrees.installChanged': { params: Record<string, never>; payload: WorktreeDependencyInstallView; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

/** More than any page asks for at once; a bigger list is a fault, not a request. */
const MAX_CHATS = 2_000
const MAX_PROJECTS = 200
const MAX_NAMES = 10_000
const HELD_ACTIONS: readonly WorktreePoolHeldAction[] = ['commit', 'stash', 'discard', 'keep']

type Fields = Record<string, unknown>

function record(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}
/** A branch or ref: never empty, never read by git as an option. */
function ref(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1000 &&
    !value.startsWith('-') &&
    !/[\0\n\r]/u.test(value)
  )
}
function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_NAMES && value.every((entry) => text(entry, 4096))
}
function count(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
}

type Check = (value: unknown) => boolean
type Shape = Record<string, readonly [Check, string] | readonly [Check, string, 'optional']>

/** Read an object member by member: each checked, an optional one dropped when absent, anything else dropped. */
function shaped<P>(value: unknown, shape: Shape, what: string): StudioParsed<P> {
  if (!record(value)) return refuse(`${what} is an object.`)
  const out: Fields = {}
  for (const [key, [check, words, optionalMember]] of Object.entries(shape)) {
    if (value[key] === undefined && optionalMember) continue
    if (!check(value[key])) return refuse(words)
    out[key] = Array.isArray(value[key]) ? [...(value[key] as unknown[])] : value[key]
  }
  return studioParams(out as P)
}

function commanded<P>(read: (value: Fields) => StudioParsed<P>) {
  return (value: Fields): StudioParsed<Commanded<P>> => {
    if (!id(value.commandId)) return refuse('"commandId" must be a string of 1 to 200 characters.')
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

/** The `input` member, an object read by `shape`. */
function input<P>(shape: Shape) {
  return (value: Fields): StudioParsed<{ input: P }> => {
    const inner = shaped<P>(value.input, shape, '"input"')
    return inner.ok ? studioParams({ input: inner.params }) : inner
  }
}

const REPO = [isStudioPath, '"repoRoot" is the project’s main checkout.'] as const
const PATH = [isStudioPath, '"path" is the worktree’s folder.'] as const
const BOOL = (name: string) =>
  [(value: unknown) => typeof value === 'boolean', `"${name}" is true or false.`, 'optional'] as const
const HOST = [id, '"hostId" names the machine.', 'optional'] as const
const LOCK_OWNER = [(value: unknown) => text(value, 500), '"agentLockOwner" is text.', 'optional'] as const

function dependencyInstall(value: unknown): value is Record<string, WorktreeDependencyInstallSetting> {
  if (!record(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_PROJECTS * 10 &&
    entries.every(
      ([root, setting]) =>
        isStudioPath(root) &&
        record(setting) &&
        typeof setting.enabled === 'boolean' &&
        (setting.command === null || text(setting.command, 1_000)),
    )
  )
}

const SETTINGS_PATCH: Shape = {
  enabled: BOOL('enabled'),
  keepIdle: [(value) => count(value, 1_000), '"keepIdle" is a count.', 'optional'],
  maxSlots: [(value) => count(value, 1_000), '"maxSlots" is a count.', 'optional'],
  diskLimitGb: [
    (value) => value === null || count(value, 1_000_000),
    '"diskLimitGb" is a size in gigabytes, or null.',
    'optional',
  ],
  idleReturnMinutes: [(value) => count(value, 1_000_000), '"idleReturnMinutes" is minutes.', 'optional'],
  dependencyInstall: [
    dependencyInstall,
    '"dependencyInstall" maps each project’s folder to { enabled, command }.',
    'optional',
  ],
}

function poolAction(value: unknown): StudioParsed<WorktreePoolActionInput> {
  if (!record(value)) return refuse('"action" is an object.')
  switch (value.kind) {
    case 'release':
    case 'catch-up':
      return id(value.leaseId)
        ? studioParams({ kind: value.kind, leaseId: value.leaseId })
        : refuse('"leaseId" names the lease.')
    case 'evict':
    case 'clear-ignored':
      if (!isStudioPath(value.repoRoot) || !id(value.slotId)) return refuse('"repoRoot" and "slotId" name the slot.')
      return studioParams({ kind: value.kind, repoRoot: value.repoRoot, slotId: value.slotId })
    case 'held': {
      if (!isStudioPath(value.repoRoot) || !id(value.slotId)) return refuse('"repoRoot" and "slotId" name the slot.')
      if (!(HELD_ACTIONS as readonly unknown[]).includes(value.action))
        return refuse('"action" is commit, stash, discard or keep.')
      if (value.message !== undefined && typeof value.message !== 'string') return refuse('"message" is text.')
      return studioParams({
        kind: 'held',
        repoRoot: value.repoRoot,
        slotId: value.slotId,
        action: value.action as WorktreePoolHeldAction,
        ...(typeof value.message === 'string' ? { message: value.message.slice(0, 2_000) } : {}),
      })
    }
    default:
      return refuse('"action.kind" is held, evict, clear-ignored, release or catch-up.')
  }
}

function chatIds(value: Fields): StudioParsed<{ workspaceIds: string[] }> {
  const ids = value.workspaceIds
  if (!Array.isArray(ids) || ids.length > MAX_CHATS || !ids.every(id))
    return refuse(`"workspaceIds" lists up to ${MAX_CHATS} chats.`)
  return studioParams({ workspaceIds: [...new Set(ids as string[])] })
}

// ── Grants ──────────────────────────────────────────────────────────────────

const POOL =
  'It is the pool of worktrees Studio’s agents run in on this machine: it hands them out, takes them back, installs in them and decides what they hold.'

const owners = (reason: string, scope: StudioScope, mutation: boolean) =>
  ({ scope, mutation, capability: STUDIO_WORKTREES_CAPABILITY, owner: reason }) as const
const poolRead = owners(POOL, 'files:read', false)
const poolWrite = owners(POOL, 'files:write', true)
const removing = owners(STUDIO_AGENT_WORKTREES_OWNER, 'files:write', true)

export const STUDIO_WORKTREES_METHODS: StudioMethodTable<StudioWorktreesMethodMap> = {
  'worktrees.poolSnapshot': { ...poolRead, params: (value) => shaped(value, { repoRoot: REPO }, 'params') },
  'worktrees.poolSettings': { ...poolRead, params: studioNoParams },
  'worktrees.setPoolSettings': {
    ...owners(POOL, 'settings:write', true),
    params: commanded((value) => {
      const patch = shaped<Partial<WorktreePoolSettings>>(value.patch, SETTINGS_PATCH, '"patch"')
      return patch.ok ? studioParams({ patch: patch.params }) : patch
    }),
  },
  'worktrees.inventory': {
    ...poolRead,
    params: (value) => {
      const roots = value.repoRoots
      if (!Array.isArray(roots) || !roots.every(isStudioPath)) return refuse('"repoRoots" lists projects’ folders.')
      if (value.measure !== undefined && typeof value.measure !== 'boolean')
        return refuse('"measure" is true or false.')
      return studioParams({ repoRoots: (roots as string[]).slice(0, MAX_PROJECTS), measure: value.measure === true })
    },
  },
  'worktrees.poolAction': {
    ...poolWrite,
    params: commanded((value) => {
      const action = poolAction(value.action)
      return action.ok ? studioParams({ action: action.params }) : action
    }),
  },
  'worktrees.removeOther': {
    ...removing,
    params: commanded((value) => shaped(value, { repoRoot: REPO, path: PATH }, 'params')),
  },
  'worktrees.installs': { ...poolRead, params: studioNoParams },
  'worktrees.cancelInstall': {
    ...poolWrite,
    params: commanded((value) => shaped(value, { id: [id, '"id" names the install.'] }, 'params')),
  },
  'worktrees.create': {
    ...poolWrite,
    params: commanded(
      input<GitWorktreeCreateInput>({
        repoRoot: REPO,
        containerPath: [(value) => text(value, 4096), '"containerPath" is the worktrees’ folder.'],
        destinationPath: [isStudioPath, '"destinationPath" is the new worktree’s folder.'],
        branchName: [ref, '"branchName" is a branch name, never starting with "-".'],
        baseRef: [ref, '"baseRef" is a ref, never starting with "-".'],
        copyIncludedFiles: BOOL('copyIncludedFiles'),
        agentLockOwner: LOCK_OWNER,
        fromPool: BOOL('fromPool'),
        hostId: HOST,
        quietInstall: BOOL('quietInstall'),
      }),
    ),
  },
  'worktrees.restore': {
    ...poolWrite,
    params: commanded(
      input<GitWorktreeRestoreInput>({
        repoRoot: REPO,
        path: PATH,
        branchName: [ref, '"branchName" is a branch name, never starting with "-".'],
        copyIncludedFiles: BOOL('copyIncludedFiles'),
        agentLockOwner: LOCK_OWNER,
        hostId: HOST,
      }),
    ),
  },
  'worktrees.remove': {
    ...removing,
    params: commanded(input<GitWorktreeRemoveInput>({ repoRoot: REPO, path: PATH, force: BOOL('force') })),
  },
  'worktrees.cleanupAgents': {
    ...removing,
    params: commanded(
      input<AgentWorktreeCleanupInput>({
        repoRoot: REPO,
        protectedPaths: [names, '"protectedPaths" lists folders.'],
        dryRun: BOOL('dryRun'),
        ownedOnly: BOOL('ownedOnly'),
        agentIds: [names, '"agentIds" lists agents.', 'optional'],
        agentKeys: [names, '"agentKeys" lists agents by chat.', 'optional'],
        keepBranches: [names, '"keepBranches" lists branches.', 'optional'],
      }),
    ),
  },

  'settledChats.planDelete': {
    scope: 'conversation:read',
    mutation: false,
    capability: STUDIO_WORKTREES_CAPABILITY,
    params: chatIds,
  },
  'settledChats.delete': {
    scope: 'conversation:operate',
    mutation: true,
    capability: STUDIO_WORKTREES_CAPABILITY,
    params: commanded(chatIds),
  },
}

export const STUDIO_WORKTREES_TOPICS: StudioTopicTable<StudioWorktreesTopicMap> = {
  'worktrees.poolChanged': {
    scope: 'files:read',
    capability: STUDIO_WORKTREES_CAPABILITY,
    owner: POOL,
    push: true,
    params: studioNoParams,
  },
  'worktrees.installChanged': {
    scope: 'files:read',
    capability: STUDIO_WORKTREES_CAPABILITY,
    owner: POOL,
    push: true,
    params: studioNoParams,
  },
}
