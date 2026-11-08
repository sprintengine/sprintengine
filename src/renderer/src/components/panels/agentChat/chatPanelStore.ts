import { useEffect, useSyncExternalStore } from 'react'

import type { BranchPullRequest } from '../../../../../shared/git/pull-request'
import type { MachineIdentity } from '../../../../../shared/machine-identity'
import type { CliPermissionPreset } from '../../../../../shared/electron-api'
import type { StudioLocalServer } from '../../../../../../packages/studio-protocol/src/public'
import type { AgentCli } from '../../../types/workspace'
import type { PermissionModeOption } from '../../workspace/agentComposer/agentSpawnShared'
import type { CreatePullRequestSlot } from './createPullRequest'

// What each open chat says about itself, for the right-hand panel, which draws
// it outside the chat. `ConversationChatBody` publishes, and that one function
// is what a chat here and a chat on a paired machine share, so the panel reads
// both the same way and knows nothing about which it is drawing. Nothing here
// reads a transcript; `chatActivityStore` is the pattern, and holds what the
// chat touched.

export type ChatPanelMachine = { name: string; identity: MachineIdentity }
export type ChatPanelBranch = { name: string; worktree: boolean; onOpen: (() => void) | null }
export type ChatPanelChanges = {
  added: number
  removed: number
  /** The counts in words: "3 files added, 2 removed". */
  phrase: string
}

export type ChatPanelPermissions = {
  options: readonly PermissionModeOption[]
  preset: CliPermissionPreset
  mode?: string | null
  /** A change is in flight. */
  disabled: boolean
  /** Rows this agent cannot run, by row id, each with its reason. */
  disabledReasons?: Partial<Record<string, string>>
  onSelect: (next: PermissionModeOption) => void
}

export type ChatPanelFacts = {
  /** The chat's name, as its tab says it. */
  name: string
  /** The harness it runs on, for its logo; null for a provider that is no CLI. */
  cli: AgentCli | null
  /** The harness in words, and the model. */
  harnessLabel: string | null
  modelLabel: string | null
  /** Where the chat runs, when that is not this computer. */
  machine: ChatPanelMachine | null
  /** The chat runs on a paired machine, so its checkout and terminals are over there. */
  remote: boolean
  branch: ChatPanelBranch | null
  changes: ChatPanelChanges | null
  pullRequests: readonly BranchPullRequest[]
  /** Absent where this window cannot stop the watch. */
  onStopWatchingPullRequest?: (url: string) => void
  /** The checkout is ready to propose, or the control has something of its own to say. */
  createPullRequest: CreatePullRequestSlot | null
  /** The local servers this chat's agents linked; null when none did. */
  localServers: {
    workspaceId: string
    servers: readonly StudioLocalServer[]
    elsewhere?: { machineName: string }
  } | null
  /** Null where this chat's preset cannot be changed. */
  permissions: ChatPanelPermissions | null
  /** The preset in words, where this chat has one to say. */
  permissionLabel: string | null
  /** What it has spent, for an agent with no context reading of its own to say. */
  tokens?: number | null
}

const published = new Map<string, ChatPanelFacts>()
const listeners = new Set<() => void>()
const keyOf = (workspaceId: string, agentId: string) => `${workspaceId}\0${agentId}`

// A chat renders on every streamed token and hardly ever says anything new, so
// a publish that changes nothing wakes nobody.
function sameFacts(a: ChatPanelFacts, b: ChatPanelFacts): boolean {
  const keys = Object.keys(a) as (keyof ChatPanelFacts)[]
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]))
}

export function publishChatPanelFacts(workspaceId: string, agentId: string, facts: ChatPanelFacts | null): void {
  const key = keyOf(workspaceId, agentId)
  if (facts === null) {
    if (!published.delete(key)) return
  } else {
    const current = published.get(key)
    if (current && sameFacts(current, facts)) return
    published.set(key, facts)
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useChatPanelFacts(workspaceId: string | null, agentId: string | null): ChatPanelFacts | null {
  return useSyncExternalStore(subscribe, () =>
    workspaceId && agentId ? (published.get(keyOf(workspaceId, agentId)) ?? null) : null,
  )
}

/** Called once per chat view: says what the chat is now, and takes it back when the view goes. */
export function usePublishChatPanelFacts(workspaceId: string, agentId: string, facts: ChatPanelFacts): void {
  useEffect(() => {
    publishChatPanelFacts(workspaceId, agentId, facts)
  })
  useEffect(() => () => publishChatPanelFacts(workspaceId, agentId, null), [workspaceId, agentId])
}
