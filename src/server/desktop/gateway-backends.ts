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
import { createGitWorktree, getGitRepoRoot } from '../../main/git'
import { startedDependencyInstall } from '../../main/worktree-pool/dependency-install'
import { worktreeBranchPrefix } from '../../main/worktree-branch-prefix'
import { readBranchName, resolveTrunk } from '../../main/git-branch-span'
import { getGitBranches } from '../../main/git-read-models'
import { listGitWorktrees } from '../../main/git-worktree-list'
import { hostRegistry } from '../../main/hosts/host-registry'
import { getPluginRegistry } from '../../main/plugin-registry-instance'
import { readRepositoryIdentity } from '../../main/repository-identity'
import { readDiscoveredCliModelCatalogs } from '../../main/model-discovery/service'
import { effectiveAgentLaunchSettings, type AgentLaunchSettings } from '../../shared/launch-settings'
import { agentWorktreePaths } from '../../shared/worktree-paths'

// The gateway's automation backends that are the server's own: backlog reads
// and writes, the mobile companion's snapshot and command lane, agent
// worktrees, a checkout's branches, a folder's repository identity, the CLI
// plugins and the built-in skill installer. Built here, free of Electron, so
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
  | 'createWorkspace'
  | 'getScheduledAgents'
  | 'machineSchedules'
  | 'defaultChatCli'
  | 'projectUsage'
  | 'getModuleRegistrySnapshot'
  | 'listInstalledThirdPartyModules'
  | 'listModuleContributedTools'
  | 'readMarketplaceRegistry'
  | 'readWorkspaceExtensions'
  | 'studioDataDirs'
> & {
  /**
   * The ids the person added for a CLI in Settings, from the launch settings
   * this process holds. Given, `cli.runtime.list` answers each CLI with the
   * model picker's own rows (`readCliModelSources`); a gateway that does not
   * serve that tool leaves it out.
   */
  userCliModels?: (cli: string) => readonly string[] | undefined
  /** The ids the person took off a CLI's list in Settings. */
  removedCliModels?: (cli: string) => readonly string[] | undefined
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
 * CLI a new chat starts with, the projects' usage, and the ids the person
 * added for each CLI. One helper, so the gateways built in process, out of
 * process and for the shell read them alike.
 */
export function launchSettingsGatewayDeps(settings: {
  get(): AgentLaunchSettings
}): Pick<GatewayBackendDeps, 'defaultChatCli' | 'projectUsage' | 'userCliModels' | 'removedCliModels'> {
  return {
    defaultChatCli: () => effectiveAgentLaunchSettings(settings.get()).lastSelectedCli ?? null,
    projectUsage: () => settings.get().projectUsage,
    userCliModels: (cli) => settings.get().cliRuntimes[cli]?.models,
    removedCliModels: (cli) => settings.get().cliRuntimes[cli]?.removedModels,
  }
}

export function createServerGatewayBackends(deps: GatewayBackendDeps): AutomationBackends {
  const { userCliModels, removedCliModels, createAgentWorktree, ...backends } = deps
  return {
    ...backends,
    // The model picker's sources, read where the picker's are: the discovery
    // cache under this profile's user data, and the person's own ids.
    ...(userCliModels
      ? {
          readCliModelSources: async () => ({
            discovered: await readDiscoveredCliModelCatalogs().catch(() => ({})),
            userModels: userCliModels,
            ...(removedCliModels ? { removedModels: removedCliModels } : {}),
          }),
        }
      : {}),
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
    // The facts behind `workspace.checkout` (checkout-and-branch-on-remote-
    // create): the same readers the sidebar rows and the Worktree manager
    // use, so a remote picker lists exactly what this machine's Git view
    // would. Not a repo is an answer, not an error.
    readWorkspaceCheckout: async (workspaceRoot) => {
      const empty = { git: false as const, branch: null, defaultBranch: null, branches: [], worktrees: [] }
      const repoRoot = await getGitRepoRoot(workspaceRoot).catch(() => null)
      if (!repoRoot) return empty
      const [branch, snapshot, worktrees] = await Promise.all([
        readBranchName(repoRoot),
        getGitBranches(repoRoot).catch(() => null),
        listGitWorktrees(repoRoot).catch(() => null),
      ])
      const trunk = await resolveTrunk(repoRoot, branch).catch(() => null)
      return {
        git: true,
        branch,
        defaultBranch: trunk?.name ?? null,
        // `git branch` prints a detached HEAD as a pseudo-entry,
        // "(HEAD detached at abc)", marked current; it is not a ref
        // anyone can fork from and is dropped.
        branches: (snapshot?.branches ?? [])
          .filter((entry) => !entry.name.startsWith('('))
          .map((entry) => ({ name: entry.name, current: entry.current })),
        worktrees: worktrees?.ok
          ? worktrees.data.worktrees
              .filter((entry) => !entry.bare)
              // `git worktree list` names the main worktree first, always.
              .map((entry, index) => ({ path: entry.path, branch: entry.branch, isMain: index === 0 }))
          : [],
      }
    },
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
