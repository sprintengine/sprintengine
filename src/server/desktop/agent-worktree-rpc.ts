import type { AutomationBackends } from '../../main/automation/automation-tools'
import type { DependencyInstaller, StartedDependencyInstall } from '../../main/worktree-pool/dependency-install'
import type { WorktreeDependencyInstallView } from '../../shared/ipc/worktree-pool'
import type { ControlRpc } from '../bootstrap/control-rpc'
import { createAgentWorktreeHere } from './gateway-backends'
import { SERVER_METHODS } from './server-methods'

// An agent-at-launch worktree (`agent.launch` with isolation), cut by the
// Studio server out of process for the shell, whose `agent` toolset launches
// the terminal: the worktree pool and its installs are the server's
// (core/studio-worktree-pool.ts), so the shell asks it for the worktree over
// the control channel rather than keep a pool of its own. The install the
// worktree started is followed from the shell by its id: how it ends is one
// long call, answered when it does.

type AgentWorktreeResult = Awaited<ReturnType<AutomationBackends['createAgentWorktree']>>
type AgentWorktreeInput = Parameters<AutomationBackends['createAgentWorktree']>[0]

/** What crosses the channel: the worktree, and the install's view as it started. */
type AgentWorktreeWire =
  { worktreePath: string; branch: string; dependencyInstall?: WorktreeDependencyInstallView } | { error: string }

/** As long as an install may run (20 minutes), and a minute more for it to say how it ended. */
const INSTALL_SETTLED_TIMEOUT_MS = 21 * 60_000

/** The server's half: cut the worktree here, from this process's pool. */
export function serveAgentWorktrees(rpc: Pick<ControlRpc, 'handle'>, installer: DependencyInstaller): void {
  rpc.handle(SERVER_METHODS.createAgentWorktree, async (params): Promise<AgentWorktreeWire> => {
    const input = params as Partial<AgentWorktreeInput> | null
    if (!input || typeof input.workspaceRoot !== 'string' || typeof input.name !== 'string') {
      return { error: 'A folder and a name are required.' }
    }
    const created = await createAgentWorktreeHere({
      workspaceRoot: input.workspaceRoot,
      name: input.name,
      ...(typeof input.baseRef === 'string' ? { baseRef: input.baseRef } : {}),
    })
    if ('error' in created) return created
    return {
      worktreePath: created.worktreePath,
      branch: created.branch,
      ...(created.dependencyInstall ? { dependencyInstall: created.dependencyInstall.view } : {}),
    }
  })
  rpc.handle(SERVER_METHODS.dependencyInstallSettled, (params) => {
    const id = (params as { id?: unknown } | null)?.id
    return typeof id === 'string' ? installer.settled(id) : null
  })
}

/** The shell's half: `createAgentWorktree` for the backends behind its `agent` toolset. */
export function agentWorktreesOverRpc(rpc: Pick<ControlRpc, 'call'>): AutomationBackends['createAgentWorktree'] {
  return async (input): Promise<AgentWorktreeResult> => {
    const answer = await rpc
      .call<AgentWorktreeWire>(SERVER_METHODS.createAgentWorktree, input, { timeoutMs: 5 * 60_000 })
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
    if ('error' in answer) return answer
    const started = answer.dependencyInstall
    return {
      worktreePath: answer.worktreePath,
      branch: answer.branch,
      ...(started && started.state === 'running' ? { dependencyInstall: followedInstall(rpc, started) } : {}),
    }
  }
}

/**
 * An install the server runs, as the shell follows it: as it started until it
 * ends, then as it ended. A server that went away under it ends it as a quit
 * does (null): no agent is started on an install nobody can see end.
 */
function followedInstall(rpc: Pick<ControlRpc, 'call'>, view: WorktreeDependencyInstallView): StartedDependencyInstall {
  let latest = view
  const settled = rpc
    .call<WorktreeDependencyInstallView | null>(
      SERVER_METHODS.dependencyInstallSettled,
      { id: view.id },
      { timeoutMs: INSTALL_SETTLED_TIMEOUT_MS },
    )
    .then(
      (ended) => {
        if (ended) latest = ended
        return ended
      },
      () => null,
    )
  return { view, current: () => latest, settled }
}
