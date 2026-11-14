import type { JSX } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { EmptyState } from '../ui/EmptyState'

// What a pane says in a workspace on an SSH machine when it cannot run there
// yet (phase 8): a terminal, for one. Never this computer's files or shell in
// its place.

/** The SSH machine a workspace is on, by its label, or null for this computer's. */
export function useWorkspaceMachine(workspaceId: string): string | null {
  return useWorkspaceStore((state) => {
    const environment = state.workspaces.find((workspace) => workspace.id === workspaceId)?.environment
    return environment?.kind === 'ssh' ? environment.label : null
  })
}

/** The machine another environment's workspace is on (an SSH machine, a WSL distribution), by its label; null for this computer's. */
export function useWorkspaceEnvironmentLabel(workspaceId: string): string | null {
  return useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.environment?.label ?? null,
  )
}

/**
 * What Files says in a chat on another machine: its folder is that machine's,
 * which this version does not open from here. No folder of this computer's is
 * offered in its place: picking one would move the chat off its machine.
 */
export function FilesOnMachineLater({ machine }: { machine: string }): JSX.Element {
  return (
    <EmptyState
      title={`Files on ${machine} open in a later version`}
      body={`This chat works in a folder on ${machine}. Browsing that machine's files from here comes in a later version of Studio.`}
    />
  )
}

export function NotOnMachineYet({ what, machine }: { what: string; machine: string }): JSX.Element {
  return (
    <EmptyState
      title={`${what} are not available for SSH machines yet`}
      body={`This workspace is on ${machine}. Its chats, files and git run there; ${what.toLowerCase()} do not yet.`}
    />
  )
}
