import type { ConversationRuntimeOptions } from '../../main/conversation-runtime'
import { chatIdsOnRecord } from '../../main/agent-worktree-keep-checks'
import { setAgentWorktreeLockProfile } from '../../main/agent-worktree-lock'
import { diagnosticLogger } from '../../main/diagnostics-service'
import { restoreGitWorktree, seedWorktreeIncludedFiles } from '../../main/git'
import { createMainCheckoutCatchUp } from '../../main/main-checkout-catch-up'
import type { SettledChatDeletionDeps } from '../../main/settled-chat-deletion'
import { createAppSettledChatDeletion } from '../../main/settled-chat-deletion-app'
import type { WorkspaceRegistryService } from '../../main/workspace-registry-service'
import type { WorkspaceSyncService } from '../../main/workspace-sync-service'
import { installWorktreePool } from '../../main/worktree-pool/active-pool'
import { createChatFolderGuard } from '../../main/worktree-pool/chat-folder-guard'
import { createDependencyInstaller, installDependencyInstaller } from '../../main/worktree-pool/dependency-install'
import { cachedDependencyInstallEnvironment } from '../../main/worktree-pool/install-environment'
import { markChatsReclaimed, poolChatsOf } from '../../main/worktree-pool/pool-chats'
import { createPoolStore } from '../../main/worktree-pool/pool-store'
import { createWorktreePoolService } from '../../main/worktree-pool/worktree-pool-service'
import { createWorktreePoolTools } from '../../main/worktree-pool/worktree-pool-tools'
import {
  dependencyInstallSettingFor,
  WORKTREE_INSTALL_CHANGED_CHANNEL,
  WORKTREE_POOL_CHANGED_CHANNEL,
} from '../../shared/ipc/worktree-pool'
import type { StudioPlatform } from '../platform/platform'

// The worktree pool, its dependency installs and the `worktree.*` tools, as
// the Studio core owns them: beside
// the agents that work in the slots, so the turn that checks a chat's folder,
// the pool that hands it out or takes it back, and the holds between them
// (worktree-leases.ts) are one process's. Built by `createStudioCore` in every
// mode: the desktop's main in process, the desktop's server out of process, a
// standalone, WSL or SSH machine's server. One pool per data directory and
// machine; nothing else in the app keeps one.
//
// It does nothing on its own: reading its records is all that happens here,
// and a pool recovers from an interrupted run the first time it is used.

/** What one of this core's terminals says about where it works. */
export type WorktreeTerminalPaths = {
  /**
   * False once its process has exited, or while it is suspended. A tab still
   * showing a shell that exited keeps no slot; a suspended one, which resumes
   * in place on a keystroke, keeps its slot, as the shell's own live list does.
   */
  processAlive?: boolean
  suspended?: boolean
  cwd?: string | null
  observedCheckout?: { cwd?: string | null; gitRoot?: string | null } | null
}

export type StudioWorktreePoolDeps = {
  platform: Pick<StudioPlatform, 'paths' | 'clients'>
  workspaceRegistry: Pick<WorkspaceRegistryService, 'getRecord'>
  workspaceSyncService: WorkspaceSyncService
  /** Where a chat's session works now (a running turn, a live child). Read lazily: the backend is built after. */
  liveConversationPaths: () => Promise<string[]>
  /** The chats' backend, for deleting a settled chat's history. Read lazily, as above. */
  conversations: () => SettledChatDeletionDeps['conversations']
  /**
   * The terminals this core runs (studio-agent-terminals.ts), read directly.
   * One still starting is not listed yet: it holds its folder shared
   * (worktree-leases.ts) until it is, which every step here meets.
   */
  listTerminalSessions?: () => ReadonlyArray<WorktreeTerminalPaths>
}

/**
 * How long the pool and its installs may wait for steps in flight when a
 * server stops: well inside every stop budget (eight seconds, less when the
 * desktop leaves for an update), so the legs after them still run. A step cut
 * short is recovered at the next start, as after a crash.
 */
export const WORKTREE_QUIT_WAIT_MS = 2_000

export type StudioWorktreePool = ReturnType<typeof createStudioWorktreePool>

export function createStudioWorktreePool(deps: StudioWorktreePoolDeps) {
  const { platform, workspaceRegistry, workspaceSyncService } = deps
  const dataDir = platform.paths.dataDir()
  // The profile this process's agent worktree locks name, so its own locks
  // are told from another profile's (agent-worktree-lock.ts): every process
  // that cuts agent worktrees for this data directory names the same one.
  setAgentWorktreeLockProfile(dataDir)

  const liveConversationPaths = (): Promise<string[]> => deps.liveConversationPaths().catch(() => [])
  // Where live work sits, for the pool and the agent worktree cleanup alike:
  // every live terminal, the checkout it observes, and the folder of every
  // chat whose provider session is working now. One list, so neither
  // recycles a folder the other would have kept.
  const liveWorkPaths = async (): Promise<string[]> => {
    return [
      ...(deps.listTerminalSessions?.() ?? []).flatMap((session) =>
        (session.processAlive === false && session.suspended !== true
          ? []
          : [session.cwd, session.observedCheckout?.cwd, session.observedCheckout?.gitRoot]
        ).filter((path): path is string => typeof path === 'string' && path.length > 0),
      ),
      ...(await liveConversationPaths()),
    ]
  }
  // Settled chats included: a slot holding a chat's history is never removed.
  const knownWorkspaceIds = () => chatIdsOnRecord(workspaceSyncService.getSnapshot().state.workspaces)

  // The pool of reusable agent worktrees (main/worktree-pool/). Every agent
  // worktree made with `fromPool` (git.ts) is leased from it, and the agent
  // worktree cleanup hands back the slots nothing uses.
  const pool = createWorktreePoolService({
    store: createPoolStore(dataDir),
    livePaths: liveWorkPaths,
    liveSessionPaths: liveConversationPaths,
    // Recovery, holds and evictions are what a person asks about later.
    log: diagnosticLogger('worktree-pool'),
    onChange: (snapshot) => platform.clients.publish(WORKTREE_POOL_CHANGED_CHANNEL, snapshot),
    seedIncludedFiles: seedWorktreeIncludedFiles,
    knownWorkspaceIds,
    // What a slot given back while its chat lives is weighed against
    // (worktree-pool/pool-idle.ts): which chats work in it, whether one is on
    // screen, and when each was last active.
    chats: () => poolChatsOf(workspaceSyncService.getSnapshot().state),
    // The chat whose worktree it was is marked as the cleanup's report marks
    // it (`chatsReclaimedBy`), so opening it brings the worktree back: a slot
    // a lease gave back to make room is in no report. Given back on the
    // branch its agent moved to, the chat is moved to that branch too.
    onGivenBack: (slot) => markChatsReclaimed(workspaceSyncService, slot),
  })
  installWorktreePool(pool)
  void pool.load()

  // The dependency install an agent worktree runs when its project opted in
  // and its lockfile changed (worktree-pool/dependency-install.ts), with the
  // environment the person's own terminal has and none of the app's own
  // variables (worktree-pool/install-environment.ts): one login shell's,
  // kept for the leases of the next few minutes.
  const installEnvironment = cachedDependencyInstallEnvironment()
  const installer = createDependencyInstaller({
    env: () => installEnvironment.read(),
    forgetEnv: () => installEnvironment.forget(),
    log: diagnosticLogger('worktree-install'),
    onChange: (view) => platform.clients.publish(WORKTREE_INSTALL_CHANGED_CHANNEL, view, 'workspace-windows'),
  })
  installDependencyInstaller(installer)

  const findWorkspace = (workspaceId: string) =>
    workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null
  // `worktree.lease` and `worktree.release`, among the gateway's own tools.
  const tools = createWorktreePoolTools({
    pool,
    findWorkspace,
    // The install a chat's own leased worktree gets, when the project opted in.
    installDependencies: async (request) =>
      installer.prepare({
        ...request,
        setting: dependencyInstallSettingFor(await pool.getSettings(), request.repoRoot),
      }),
  })

  // The last word before an agent runs in a chat's folder, whoever sent the
  // turn (a window, a paired phone, a schedule, a pull request's wake): a
  // worktree chat whose slot was given back while it sat idle gets its branch
  // checked out again at the same path (chat-folder-guard.ts), and a new chat
  // in a project's own checkout starts on the default branch as origin has
  // it, when that touches no one's work (main-checkout-catch-up.ts).
  const chatFolderGuard = createChatFolderGuard({
    pool: () => pool,
    chat: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    restore: restoreGitWorktree,
  })
  const catchUpMainCheckout = createMainCheckoutCatchUp({
    chat: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    liveSessionPaths: liveConversationPaths,
  })
  const prepareChatFolder: NonNullable<ConversationRuntimeOptions['prepareChatFolder']> = async (input) => {
    const folder = await chatFolderGuard(input)
    // Never refused for the catch-up: it logs what stopped it.
    if (folder.ok && input.fresh) await catchUpMainCheckout(input)
    return folder
  }

  return {
    pool,
    installer,
    tools,
    prepareChatFolder,
    liveWorkPaths,
    knownWorkspaceIds,
    /** Deleting settled chats, their worktrees given back to this pool; the record removed as `actor`. */
    settledChatDeletion: (actor: 'ui' | 'mobile') =>
      createAppSettledChatDeletion(
        { workspaceSyncService, conversations: deps.conversations(), worktreePool: pool, liveWorkPaths },
        actor,
      ),
  }
}
