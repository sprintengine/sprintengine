import type { GitWorktreeEntry, GitWorktreeOperationResult } from './git-types.js'

// The shapes of the worktree pool, the agents' worktrees and settled-chat
// deletion (`worktrees.ts`): what a Studio's core answers about the worktrees
// its agents run in. Defined here once; the desktop's `src/shared` re-exports
// them under the same names.

// ── The pool ────────────────────────────────────────────────────────────────

/**
 * Where a slot is in its life:
 *
 * - `creating`: `worktree add` is running for it.
 * - `idle`: detached, clean, unlocked, ready to lease. It sits at whatever base
 *   it was last leased at; the lease brings it up to date.
 * - `leasing`: being fetched up, reset and handed to an agent (a moment).
 * - `leased`: an agent owns it, on `<prefix>/<slug>` (`agent` unless changed), locked.
 * - `returning`: its owner is gone and it is being checked for work.
 * - `held`: it holds work (or could not be checked) and waits for a person.
 * - `evicting`: being removed from disk.
 */
export type WorktreePoolSlotState = 'creating' | 'idle' | 'leasing' | 'leased' | 'returning' | 'held' | 'evicting'

/**
 * Why a slot is held:
 * - `dirty`: uncommitted or untracked changes.
 * - `operation`: a merge, rebase, cherry-pick, revert or bisect is in progress.
 * - `unexpected-head`: an idle slot is on a branch, or moved off its base.
 * - `recovery`: the app stopped in the middle of an operation that cannot be
 *   safely re-run, or found a slot it had no record of.
 * - `error`: a git step failed; the detail says which.
 */
export type WorktreePoolHeldReason = 'dirty' | 'operation' | 'unexpected-head' | 'recovery' | 'error'

export type WorktreePoolSettings = {
  /** Agent worktrees come from the pool. Off: every one is created fresh and removed by the cleanup. */
  enabled: boolean
  /** Idle worktrees each repository keeps for reuse; a return beyond this removes the oldest. */
  keepIdle: number
  /**
   * Worktrees one repository's pool may hold in all, leased ones included.
   * Past it a new chat still gets a worktree, but a fresh one the cleanup
   * removes when the chat is done.
   */
  maxSlots: number
  /**
   * Disk every pool together may use, in gigabytes, or null for no limit.
   * Past it the least recently used idle worktrees are removed; one in use or
   * holding work never is. Sizes are measured only while a limit is set, or
   * when Settings ▸ Worktrees asks.
   */
  diskLimitGb: number | null
  /**
   * How long, in minutes, a leased worktree whose chat (or agent) still exists
   * sits clean, pushed and untouched, with nothing running in it, before the
   * cleanup gives it back to the pool. Its branch stays, and the chat checks
   * it out again, at the same path, when it is next opened or sent to. A
   * worktree that holds anything only it has is never given back this way.
   */
  idleReturnMinutes: number
  /**
   * Per project, keyed by its main checkout's path as the pool names it: run
   * the dependency install in a leased worktree when its lockfile changed
   * since that worktree last installed (owner ruling 2026-10-06). A project
   * with no entry is off: the install runs the repository's own scripts.
   */
  dependencyInstall: Record<string, WorktreeDependencyInstallSetting>
}

export type WorktreeDependencyInstallSetting = {
  enabled: boolean
  /** Run instead of the command the lockfile implies (`npm ci`, …); null to infer it. */
  command: string | null
}

/**
 * How much disk a worktree takes, as allocated on disk (`du`), with the
 * biggest entries at its top level (`node_modules`, `out`, …) so a person can
 * see what the space is. Measured on request, never on a timer.
 */
export type WorktreeDiskUsage = {
  bytes: number
  measuredAt: number
  /** The largest top-level entries, largest first; the rest are summed as `…`. */
  parts: Array<{ name: string; bytes: number }>
}

export type WorktreePoolSlotView = {
  id: string
  path: string
  state: WorktreePoolSlotState
  baseRef: string | null
  baseSha: string | null
  /** The tail of a failed git step. */
  error: string | null
  lease: {
    leaseId: string
    branch: string
    owner: string
    /** The agent that leased it itself through MCP (`worktree.lease`); null for a chat's own worktree. */
    agentId: string | null
    /** The chat that agent is in; null for a chat's own worktree and a lease taken before chats were recorded. */
    workspaceId: string | null
    leasedAt: number
  } | null
  held: {
    reason: WorktreePoolHeldReason
    detail: string | null
    changedPaths: number | null
    branch: string | null
    since: number
  } | null
  lastUsedAt: number | null
  /** How many leases the slot has served. */
  uses: number
  /** The branch of its last lease, kept after the slot came back. */
  lastBranch: string | null
  /** As last measured; null until something asked. */
  size: WorktreeDiskUsage | null
  /**
   * Why the pool did not remove this idle slot when it last tried (over the
   * idle or disk limit, or asked to), as a phrase that follows "kept:":
   * `holds the history of a chat not settled`. Null when nothing
   * kept it.
   */
  kept: string | null
  /**
   * An idle slot given back while its chat (or the agent that leased it)
   * still exists, because it sat clean and unused: kept for that chat, on
   * whose return its branch is checked out here again. No other lease reuses
   * it as it stands; one that finds the pool full removes it and keeps its
   * path free for the chat. Null for every other slot.
   */
  parked: { branch: string; since: number } | null
}

export type WorktreePoolSnapshot = {
  poolId: string
  repoRoot: string
  /** Where the slots live: `<repo-parent>/.sprintengine-worktrees/<repo>`. */
  containerPath: string
  /** Another Studio holds this pool; this one creates worktrees fresh. */
  heldByOtherInstance: boolean
  defaultRef: string | null
  lastFetchAt: number | null
  slots: WorktreePoolSlotView[]
}

export type WorktreePoolHeldAction = 'commit' | 'stash' | 'discard' | 'keep'

export type WorktreePoolActionInput =
  | { kind: 'held'; repoRoot: string; slotId: string; action: WorktreePoolHeldAction; message?: string }
  | { kind: 'evict'; repoRoot: string; slotId: string }
  /** Delete an idle slot's ignored files (`git clean -dX`): the space, at the price of the next install. */
  | { kind: 'clear-ignored'; repoRoot: string; slotId: string }
  /**
   * Give a lease back at once: a New chat that was closed while its worktree
   * was being made has no one to use the slot (utils/newChatWorktree.ts).
   * The same return a sweep makes, so a slot with changes is held, not reset.
   */
  | { kind: 'release'; leaseId: string }
  /**
   * Bring a lease nobody has worked in yet to the default branch as origin has
   * it now: the worktree a New chat made while the person typed, before the
   * chat starts in it. One that has been worked in is left as it is.
   */
  | { kind: 'catch-up'; leaseId: string }

export type WorktreePoolActionResult = { ok: true; message: string | null } | { ok: false; message: string }

// ── Dependency installs ─────────────────────────────────────────────────────
//
// A leased worktree whose project opted in installs its dependencies before
// its agent starts (worktree-pool/dependency-install.ts). Clients following
// `worktrees.installChanged` hear one as it starts, now and then while it
// runs, and as it ends; nothing else about it is kept.

/**
 * Why it runs: the worktree never installed (`first`), its lockfile or the
 * command changed since it last did (`changed`), or its installed
 * dependencies are gone (`missing`, after "Clear ignored files").
 */
export type WorktreeDependencyInstallReason = 'first' | 'changed' | 'missing'

export type WorktreeDependencyInstallState = 'running' | 'succeeded' | 'failed' | 'timed-out' | 'cancelled'

export type WorktreeDependencyInstallView = {
  id: string
  /** The project's main checkout, as the pool names it. */
  repoRoot: string
  /** The leased worktree it runs in. */
  path: string
  branch: string
  command: string
  reason: WorktreeDependencyInstallReason
  state: WorktreeDependencyInstallState
  startedAt: number
  endedAt: number | null
  /** The last line it printed. */
  lastLine: string | null
  /** The end of what it printed, once it did not succeed. */
  output: string | null
  exitCode: number | null
  /** Its caller shows it (`GitWorktreeCreateInput.quietInstall`): no toast while it runs or once it succeeds. */
  quiet?: boolean
}

// ── Settings ▸ Worktrees ────────────────────────────────────────────────────

/** One git worktree of a project, as Settings ▸ Worktrees lists it. The main checkout is never one. */
export type WorktreeInventoryEntry = {
  path: string
  branch: string | null
  head: string | null
  /** The pool slot at this path; null for a worktree the pool does not own. */
  slotId: string | null
  /** Locked by hand or by another Studio profile (not the pool's or this profile's agent lock). */
  lockedByOther: boolean
  /** Registered with git but gone from disk: `git worktree prune` forgets it. */
  missing: boolean
  /** Commits on it the default branch lacks, or null when unknown (no default branch, git failed). */
  uniqueCommits: number | null
  /** Commits on the default branch it lacks. */
  behindCommits: number | null
  /** Every change on it is on the default branch already (by ancestry, or by content after a squash merge). */
  merged: boolean | null
  /** Uncommitted and untracked paths, ignored ones aside; null when status failed. */
  changedPaths: number | null
  /** The first few of those, as `git status --short` codes and paths. */
  changes: Array<{ code: string; path: string }>
  size: WorktreeDiskUsage | null
  /**
   * When it was last used, in ms since the epoch: its index or HEAD moved
   * (a stage, commit or checkout in it), or, for a pool slot, its last lease.
   * Null when unknown.
   */
  lastUsedAt: number | null
}

export type WorktreeInventoryProject = {
  /** The main checkout. */
  repoRoot: string
  defaultRef: string | null
  pool: WorktreePoolSnapshot | null
  worktrees: WorktreeInventoryEntry[]
  error: string | null
}

export type WorktreeInventoryInput = {
  /** Projects the window knows of; pools on record are added to them. */
  repoRoots: string[]
  /** Measure every worktree's size now (slow: seconds per worktree), instead of reporting the last one. */
  measure?: boolean
}

export type WorktreeInventory = {
  projects: WorktreeInventoryProject[]
  /** When sizes were last measured, or null if never. */
  measuredAt: number | null
}

// ── The agents' worktrees ───────────────────────────────────────────────────

export type GitWorktreeCreateInput = {
  repoRoot: string
  containerPath: string
  destinationPath: string
  branchName: string
  baseRef: string
  copyIncludedFiles?: boolean
  /**
   * Lock the new worktree as in use by an agent, naming this owner: the
   * agent's id, or the branch when the agent does not exist yet. The agent
   * worktree cleanup never removes a worktree another profile has locked, and
   * this profile releases its own lock once its records no longer use it.
   */
  agentLockOwner?: string
  /**
   * An agent's worktree, forked from the default branch: leased from the
   * worktree pool (its path is then a pool slot's, not `destinationPath`), or
   * created fresh from `origin/<default>` when there is no pool to lease from.
   * `baseRef` is used only when the repository has no default branch at all.
   */
  fromPool?: boolean
  /** The machine whose git makes it (a WSL machine's); absent resolves from the folder. */
  hostId?: string
  /**
   * The caller shows the dependency install itself: New chat's worktree,
   * whose install is folded into its chat's working line. The install is
   * marked `quiet`, and no window toasts it unless it fails.
   */
  quietInstall?: boolean
}

/** A created worktree, and what it was forked from. */
export type GitWorktreeCreated = GitWorktreeEntry & {
  /** The ref it was forked from, as the caller should record it (`origin/main`, `HEAD`). */
  baseRef: string
  /** Set when the worktree is a pool slot. */
  leaseId: string | null
  /** The dependency install the lease ran before handing the slot out, when it ran one. */
  dependencyInstall?: WorktreeDependencyInstallView | null
}

/**
 * Check a chat's worktree out again at the path it had, on the branch it kept,
 * after the agent worktree cleanup gave it back.
 */
export type GitWorktreeRestoreInput = {
  repoRoot: string
  path: string
  branchName: string
  copyIncludedFiles?: boolean
  /** Lock it again as in use, naming this owner, as creation does. */
  agentLockOwner?: string
  /** The machine whose git makes it (a WSL machine's); absent resolves from the folder. */
  hostId?: string
}

/**
 * A restore's answer. A refusal marked `definitive` is one no retry changes
 * (the branch was deleted, the path is not one of the app's worktrees); any
 * other may succeed next time (the volume is back, the branch was freed).
 */
export type GitWorktreeRestoreResult =
  GitWorktreeOperationResult<GitWorktreeEntry> | { ok: false; message: string; definitive: true }

export type GitWorktreeRemoveInput = {
  repoRoot: string
  path: string
  force?: boolean
}

/**
 * Why the cleanup kept an agent worktree, or that it removed it. `recent`: git
 * touched it within the last hour; `ignored-files`: ignored files that are not
 * rebuildable output or unchanged copies; `hidden-edits`: tracked files hidden
 * from `git status` by `--assume-unchanged` or `--skip-worktree`;
 * `not-owned`: an unattended sweep met a worktree this profile never locked.
 */
export type AgentWorktreeCleanupVerdict =
  | 'removed'
  /** A worktree pool slot nobody uses any more, detached and given back to the pool (its branch kept). */
  | 'returned'
  /** A worktree pool slot nobody uses that still holds work; held in the pool for a person to decide. */
  | 'held'
  | 'dirty'
  | 'unmerged'
  | 'in-use'
  | 'locked'
  | 'missing'
  | 'recent'
  | 'ignored-files'
  | 'hidden-edits'
  | 'not-owned'
  | 'no-default-branch'
  | 'error'

export type AgentWorktreeCleanupEntry = {
  path: string
  branch: string | null
  verdict: AgentWorktreeCleanupVerdict
  /** For `unmerged`: commits on the branch that the default branch does not have. */
  uniqueCommits?: number
  /** For `dirty`, `ignored-files` and `hidden-edits`: how many paths kept it. */
  changedPaths?: number
  detail?: string
}

export type AgentWorktreeCleanupInput = {
  repoRoot: string
  /** Paths the app still uses (a workspace's folder, a live agent's worktree). Never removed. */
  protectedPaths: string[]
  /** Report what would happen without removing anything. */
  dryRun?: boolean
  /**
   * Take only worktrees this profile locked and has since released. The
   * unattended sweep sets it; a person's cleanup from the Worktree manager,
   * whose report they read, does not.
   */
  ownedOnly?: boolean
  /**
   * Every agent the app's records hold. A pool slot an agent leased for itself
   * (MCP `worktree.lease`) is in use while its agent exists, wherever the
   * agent's terminal sits. Left out: unknown, and every such slot is kept.
   */
  agentIds?: string[]
  /**
   * The same agents, each with its chat (`agentLeaseKey`): what a lease that
   * records its agent's chat is matched against, since an agent id is unique
   * only within its chat. Left out: unknown, and every such slot is kept.
   */
  agentKeys?: string[]
  /**
   * Branches the app's records still name (a chat's `worktree.branch`, a
   * worktree entry's): never deleted, merged or not, because a chat whose
   * worktree was given back is restored from its branch. Left out: unknown,
   * and no branch is deleted.
   */
  keepBranches?: string[]
}

export type AgentWorktreeCleanupReport = {
  repoRoot: string
  /** The ref "merged" was measured against, e.g. `origin/main`. Null when none could be found. */
  defaultRef: string | null
  entries: AgentWorktreeCleanupEntry[]
  /**
   * Studio's branches (under the person's branch prefix or `agent/`) no
   * worktree has checked out whose work is on the default branch: deleted
   * (or, on a dry run, the ones that would be).
   */
  deletedBranches?: string[]
  dryRun: boolean
}

// ── Deleting settled chats ──────────────────────────────────────────────────
//
// A client asks first what a delete would do (`settledChats.planDelete`),
// shows that in its confirmation, and then asks for the delete itself
// (`settledChats.delete`), which checks everything again: a worktree written
// to between the two is kept, not taken.

/** Why a chat's worktree stays when the chat is deleted. */
export type SettledChatWorktreeKeptBecause =
  /** Uncommitted or untracked changes: removing the folder would lose them. */
  | 'changes'
  /** Another chat works in it, or in a folder inside it. */
  | 'shared'
  /** Neither a pool slot nor in Studio's worktree folder: someone else made it. */
  | 'not-made-here'
  /** It is on another machine (an SSH machine or a WSL distribution). */
  | 'other-machine'
  /** Its status could not be read, so nothing is known to be safe. */
  | 'unreadable'

export type SettledChatWorktreePlan = {
  path: string
  /** The folder's own name, which is how Settings ▸ Worktrees lists it. */
  name: string
  branch: string | null
  /** A worktree pool slot: it goes back to the pool rather than off the disk. */
  pooled: boolean
  /** Changed, staged and untracked paths; null when not read. */
  changedPaths: number | null
  /** Commits HEAD has that no remote branch (and no other local branch) has; null when not read. */
  unpushedCommits: number | null
  /** What the delete would do with it, as things stand now. */
  fate: 'remove' | 'keep'
  keptBecause?: SettledChatWorktreeKeptBecause
}

export type SettledChatDeletionPlan = {
  workspaceId: string
  /**
   * The paired machine the chat lives on, for one opened here from there.
   * Deleting it takes this computer's record only; the chat, its history and
   * its worktree stay on that machine.
   */
  remoteMachine: string | null
  worktrees: SettledChatWorktreePlan[]
  /** Why it cannot be deleted now (not settled, working, gone). Absent when it can. */
  refused?: string
}

export type SettledChatWorktreeOutcome = {
  path: string
  name: string
  branch: string | null
  /** `removed`: off the disk; `returned`: back in the pool, detached; `kept`: still there. */
  result: 'removed' | 'returned' | 'kept'
  /** Why it was kept, in a sentence. */
  detail?: string
}

export type SettledChatDeletionOutcome =
  | { workspaceId: string; ok: true; worktrees: SettledChatWorktreeOutcome[] }
  | { workspaceId: string; ok: false; message: string }
