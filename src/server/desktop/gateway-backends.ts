import type { AutomationBackends } from '../../main/automation/automation-tools'
import {
  addOrUpdateBacklogLink,
  listBacklogItems,
  readBacklogItem,
  repairBacklogIntegrity,
  updateBacklogDependenciesPlanned,
  updateBacklogEpic,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from '../../main/backlog-service'
import { ensureSkillInstalled } from '../../main/builtin-skills'
import { createGitWorktree } from '../../main/git'
import { startedDependencyInstall } from '../../main/worktree-pool/dependency-install'
import { worktreeBranchPrefix } from '../../main/worktree-branch-prefix'
import { hostRegistry } from '../../main/hosts/host-registry'
import { getPluginRegistry } from '../../main/plugin-registry-instance'
import { readRepositoryIdentity } from '../../main/repository-identity'
import { effectiveAgentLaunchSettings, type AgentLaunchSettings } from '../../shared/launch-settings'
import { agentWorktreePaths } from '../../shared/worktree-paths'

// The gateway's automation backends that are the server's own: backlog reads
// and writes, the mobile companion's snapshot and command lane, agent
// worktrees, a folder's repository identity, the CLI plugins and the built-in
// skill installer. Built here, free of Electron, so
// the desktop composes them in process and the Studio server composes the same
// ones out of process; only what reaches a screen, a terminal or the shell's
// caches is handed in.

export type GatewayBackendDeps = Pick<
  AutomationBackends,
  | 'getWorkspaceSyncSnapshot'
  | 'listTerminalSessions'
  | 'readTerminalOutputTail'
  | 'launchAgent'
  | 'linkLaunchedAgent'
  | 'resolveAgentPermissionPreset'
  | 'agentStarterOf'
  | 'getScheduledAgents'
  | 'machineSchedules'
  | 'defaultChatCli'
  | 'getModuleRegistrySnapshot'
  | 'listInstalledThirdPartyModules'
  | 'listModuleContributedTools'
  | 'readMarketplaceRegistry'
> & {
  /** Where an agent-at-launch worktree is cut; this process's own pool when left out. */
  createAgentWorktree?: AutomationBackends['createAgentWorktree']
}

/**
 * An agent-at-launch worktree (agent.launch isolation + every connector
 * launch), cut in this process: derive the `<prefix>/<slug>` branch (the
 * person's branch prefix) and container the Worktree manager uses, then create
 * through the shared git helper, from the worktree pool this process's core
 * keeps. Mirrors WorkspaceManager's own worktree-agent spawn
 * (copyIncludedFiles carries the repo's worktree-include set into the
 * isolated tree).
 */
export const createAgentWorktreeHere: AutomationBackends['createAgentWorktree'] = async ({
  workspaceRoot,
  name,
  baseRef,
}) => {
  const paths = agentWorktreePaths(workspaceRoot, name, worktreeBranchPrefix())
  if (!paths) return { error: `"${name}" does not reduce to a usable worktree name.` }
  const named = baseRef?.trim()
  const created = await createGitWorktree({
    repoRoot: workspaceRoot,
    containerPath: paths.containerPath,
    destinationPath: paths.destinationPath,
    branchName: paths.branchName,
    // A remote launch names the branch to fork from (its picker lists
    // this checkout's branches); a launch that names none forks the
    // default branch, from the worktree pool.
    baseRef: named || 'HEAD',
    fromPool: !named,
    copyIncludedFiles: true,
    // The agent's id is minted after this, by the launch; the branch
    // names the owner until then.
    agentLockOwner: paths.branchName,
    // A gateway call answers while the project's dependency install
    // runs, and the launch waits on it instead (`agent.launch`): the
    // call's client would give up long before an install ends.
    dependencyInstall: 'start',
  })
  if (!created.ok) return { error: created.message ?? 'Git worktree creation failed.' }
  const installing = startedDependencyInstall(created.data.dependencyInstall)
  return {
    worktreePath: created.data.path,
    branch: created.data.branch ?? paths.branchName,
    ...(installing ? { dependencyInstall: installing } : {}),
  }
}

/**
 * What the gateway reads from the launch settings this process holds: the
 * CLI a new chat starts with, read as the settings are when asked.
 */
export function launchSettingsGatewayDeps(settings: {
  get(): AgentLaunchSettings
}): Pick<GatewayBackendDeps, 'defaultChatCli'> {
  return {
    defaultChatCli: () => effectiveAgentLaunchSettings(settings.get()).lastSelectedCli ?? null,
  }
}

export function createServerGatewayBackends(deps: GatewayBackendDeps): AutomationBackends {
  const { createAgentWorktree, ...backends } = deps
  return {
    ...backends,
    listBacklogItems: (workspaceRoot) => listBacklogItems(workspaceRoot),
    readBacklogItem: (workspaceRoot, relativePath) => readBacklogItem(workspaceRoot, relativePath),
    backlogWrite: {
      updateStatus: updateBacklogStatus,
      updateType: updateBacklogType,
      updateTriage: updateBacklogTriage,
      updateEpic: updateBacklogEpic,
      updateDependenciesPlanned: updateBacklogDependenciesPlanned,
      addOrUpdateLink: addOrUpdateBacklogLink,
      repairIntegrity: repairBacklogIntegrity,
    },
    // Agent-at-launch worktrees (agent.launch isolation + every connector
    // launch), cut where the worktree pool is: here, unless the caller is the
    // shell out of process, which asks the server (agent-worktree-rpc.ts).
    createAgentWorktree: createAgentWorktree ?? createAgentWorktreeHere,
    readRepositoryIdentity: (folderPath) => readRepositoryIdentity(folderPath),
    // backlog.work composes the target CLI's native skill invocation from the
    // loaded plugin manifests.
    listPlugins: () => getPluginRegistry().loaded(),
    // backlog.work ensures the Backlog skill exists in the CLI's native dir
    // before launch (the same getStatus → install seam as a spawn). Reports
    // whether the skill is now present; a false result is non-fatal. Asked
    // of the machine the agent will run on: a WSL machine is prepared
    // first (the launch that follows waits for the same), so its answer
    // is the one that launch will act on.
    ensureBuiltinSkillInstalled: async (workspaceRoot, skillId, cli, hostId) => {
      const host = hostRegistry().resolve({ requested: hostId ?? null, folder: workspaceRoot })
      if (host.kind === 'wsl') await host.prepare().catch(() => undefined)
      const result = await ensureSkillInstalled(workspaceRoot, skillId, {
        cli,
        hostId: host.id,
        integration: host.agentIntegration(),
      })
      if (!result.ok && result.status === 'unknown-skill') {
        console.warn(`[skills] backlog.work asked for unknown skill "${skillId}".`)
      }
      return result.ok
    },
  }
}
