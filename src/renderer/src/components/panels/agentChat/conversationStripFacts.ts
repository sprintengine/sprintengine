import { useCallback, useMemo } from 'react'

import { distroOfHostId } from '../../../../../shared/execution-host'
import { displayBranchName } from '../../../utils/branchLabel'
import type { MachineRef } from '../../../../../shared/machine-identity'
import { isPathOrChild } from '../../../../../shared/paths'
import { useGitBranch } from '../../../hooks/useGitBranch'
import { otherMachineRef, useMachineIdentity, useWorkspaceMachineRef } from '../../../hooks/useMachineIdentity'
import { selectModuleEnabled } from '../../../modules'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { Workspace } from '../../../types/workspace'
import type { ChatBinding, ChatWorkspace } from './chatBinding'
import { dispatchFileReveal } from '../../../utils/fileReveal'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import { useCheckoutChanges } from '../../workspace/checkoutChanges'
import { changedFileMarks, changedFilesPhrase } from '../../workspace/terminalLines'
import type { ConversationTransport } from './conversationTransport'
import { useShellReach } from './shellReach'
import type { ChatPanelBranch, ChatPanelChanges, ChatPanelMachine } from './chatPanelStore'

// Where a conversation's agent works, read off the chat's binding and
// transport: the machine (when it is not this computer), the branch of the
// checkout it works in, and how many files that checkout has changed. Each
// answers null where the chat cannot know it — a chat on a paired machine has
// no checkout here to ask, and its branch and counts are the ones its machine
// lists — so the panel draws what is true and leaves out what is not known,
// never a guess.

/** No pull requests to scope by: a chat runs no terminal that would carry one. */
const NO_PULL_REQUESTS: never[] = []

/** The name a machine's tooltip says, from what the workspace records about it. */
export function stripMachineName(
  ref: MachineRef,
  workspace: Pick<Workspace, 'environment' | 'remoteOrigin' | 'hostId'> | null,
): string {
  if (ref.kind === 'paired') return ref.name
  if (ref.kind === 'ssh') return workspace?.environment?.kind === 'ssh' ? workspace.environment.label : ref.host
  if (ref.kind === 'wsl') return distroOfHostId(ref.hostId) ?? 'WSL'
  return 'This computer'
}

export function useConversationStripFacts({
  workspaceId,
  agentId,
  workspace,
  workspaceRoot,
  transport,
  listed = null,
}: {
  workspaceId: string
  agentId: string
  workspace: ChatWorkspace | null
  workspaceRoot: string | null
  transport: Pick<ConversationTransport, 'environment'>
  /** Where a remote chat works, as the machine running it lists it. */
  listed?: Pick<NonNullable<ChatBinding['listed']>, 'branch' | 'worktree' | 'files'> | null
}): {
  machine: ChatPanelMachine | null
  branch: ChatPanelBranch | null
  changes: ChatPanelChanges | null
} {
  // ── The machine ───────────────────────────────────────────────────────────
  // A chat in an environment the person named (a paired machine) is named by
  // its environment; one on the window's own Studio by the machine its
  // workspace runs on (an SSH machine, a WSL distribution, or the paired
  // machine a workspace was born on). This computer is no machine to mark:
  // the panel says nothing about it.
  const environmentLabel = transport.environment.label
  // An SSH machine's chat is named by its environment and marked by the host
  // every device keys it by (`sshMachineRef`); a paired machine's by its name.
  const pairedName = environmentLabel && !workspace?.environment ? environmentLabel : null
  const workspaceRef = useWorkspaceMachineRef(pairedName ? null : workspace)
  const named = useMemo<MachineRef | null>(
    () => (pairedName ? { kind: 'paired', name: pairedName } : otherMachineRef(workspaceRef)),
    [pairedName, workspaceRef],
  )
  const identity = useMachineIdentity(named)
  const machineName = named ? stripMachineName(named, pairedName ? null : workspace) : null
  // Held from render to render, as the chat renders on every token and the
  // panel it publishes these to redraws when one is a new object.
  const machine = useMemo(
    () => (machineName !== null && identity ? { name: machineName, identity } : null),
    [machineName, identity],
  )

  // ── The checkout ──────────────────────────────────────────────────────────
  // Only a folder this computer can read: the working root is the agent's
  // worktree when it runs in one (`conversationWorkingRoot`), else the
  // workspace's own checkout.
  // Only a folder the window's Studio reads: the chat's own environment's.
  const checkout = useShellReach().openDocument ? workspaceRoot : null
  const gitBranch = useGitBranch(checkout)
  const workspaceWorktree = workspace ? resolveWorkspaceWorktree(workspace) : null
  // Its own field, not the agent record: an agent is rewritten on every turn.
  const agentExecution = useWorkspaceStore(
    (state) => state.workspaces.find((candidate) => candidate.id === workspaceId)?.agents[agentId]?.execution,
  )
  const execution = workspace ? agentExecution : undefined
  // A worktree only when the agent actually works in one: its own (a worktree
  // launch), or the workspace's, when the workspace is a worktree.
  const agentWorktree = execution?.mode === 'worktree' && Boolean(execution.cwd?.trim())
  const inWorktree = Boolean(checkout) && (agentWorktree || workspaceWorktree !== null)
  const knownBranch = workspaceWorktree && !agentWorktree ? (workspaceWorktree.branch ?? null) : null
  const branchName = gitBranch.branch ?? knownBranch ?? (gitBranch.isRepo ? 'detached' : null)

  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const openPaneTab = useWorkspaceStore((state) => state.openPaneTab)
  const filesEnabled = selectModuleEnabled(moduleOverrides, 'dev-tools')
  const folderPath = workspace?.folderPath ?? null
  // The file explorer is the workspace pane's Files tab, rooted at the
  // workspace folder. A worktree inside that folder is revealed there; one
  // outside it cannot be shown by that tree, which opens on the folder.
  const openFiles = useCallback(() => {
    openPaneTab(workspaceId, { kind: 'files' })
    if (checkout && folderPath && checkout !== folderPath && isPathOrChild(checkout, folderPath))
      dispatchFileReveal({ workspaceId, path: checkout })
  }, [checkout, folderPath, openPaneTab, workspaceId])

  // A chat whose checkout the window does not read (a paired machine's) has
  // its branch named by its server's list, and no explorer here to open it in.
  const shownBranch = checkout && branchName ? branchName : (listed?.branch ?? null)
  const shownWorktree = checkout && branchName ? inWorktree : (listed?.worktree ?? false)
  const onOpenBranch = checkout && branchName && filesEnabled && folderPath ? openFiles : null
  const branch = useMemo<ChatPanelBranch | null>(
    () =>
      shownBranch ? { name: displayBranchName(shownBranch), worktree: shownWorktree, onOpen: onOpenBranch } : null,
    [shownBranch, shownWorktree, onOpenBranch],
  )

  const counts = useCheckoutChanges(checkout, NO_PULL_REQUESTS, 'conversation-strip')
  // Counts its server lists (a paired machine's) where the window reads none itself.
  const remoteFiles = listed?.files ?? null
  const remoteMarks = remoteFiles ? changedFileMarks(remoteFiles) : null
  const localChanges = counts.hasCounts && counts.marks && counts.files ? counts : null
  const remoteChanged = remoteFiles && remoteMarks && (remoteMarks.plus > 0 || remoteMarks.minus > 0)
  const added = localChanges?.marks?.plus ?? (remoteChanged ? remoteMarks.plus : null)
  const removed = localChanges?.marks?.minus ?? (remoteChanged ? remoteMarks.minus : null)
  const phrase = localChanges?.files
    ? changedFilesPhrase(localChanges.files)
    : remoteChanged
      ? changedFilesPhrase(remoteFiles)
      : null
  const changes = useMemo<ChatPanelChanges | null>(
    () => (added !== null && removed !== null && phrase !== null ? { added, removed, phrase } : null),
    [added, removed, phrase],
  )

  return { machine, branch, changes }
}
