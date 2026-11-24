import type { StudioAgentProcess, StudioBrowserTab } from '../../../../../../packages/studio-protocol/src/public'
import { copy } from '../../../../../shared/copy'

// What the Processes list draws, worked out apart from the drawing: rows
// grouped by the chat that started them, named from the workspaces this
// window knows, and how long things have run in words.

/** What the window knows of a chat: its name and its agents' names. */
export type KnownChat = { name: string; agents: Readonly<Record<string, { name: string }>> }

export type ProcessGroup = {
  key: string
  /** The chat's name and its agent's, or that the chat is no longer open here. */
  label: string
  known: boolean
  rows: StudioAgentProcess[]
  leftBehind: StudioAgentProcess[]
}

/** The words for a chat a row came from: `name · agent`, the name alone, or not open any more. */
export function chatLabel(
  workspaceId: string,
  agentId: string | undefined,
  chats: ReadonlyMap<string, KnownChat>,
): { label: string; known: boolean } {
  const chat = chats.get(workspaceId)
  if (!chat) return { label: copy.workspace.topbar.processesPopover.chatNoLongerOpen, known: false }
  const agent = agentId ? chat.agents[agentId]?.name : undefined
  return { label: agent && agent !== chat.name ? `${chat.name} · ${agent}` : chat.name, known: true }
}

/**
 * Rows by chat, the chats with something left behind first, then the
 * longest-running; chats no longer open last, together.
 */
export function groupProcesses(
  processes: readonly StudioAgentProcess[],
  chats: ReadonlyMap<string, KnownChat>,
): ProcessGroup[] {
  const groups = new Map<string, ProcessGroup>()
  for (const row of processes) {
    const { label, known } = chatLabel(row.workspaceId, row.agentId, chats)
    const key = known ? `${row.workspaceId}\0${row.agentId ?? ''}` : 'unknown'
    let group = groups.get(key)
    if (!group) {
      group = { key, label, known, rows: [], leftBehind: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
    if (row.state === 'left-behind') group.leftBehind.push(row)
  }
  const oldest = (group: ProcessGroup) => Math.min(...group.rows.map((row) => row.startedAt))
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.known) - Number(a.known) ||
      Number(b.leftBehind.length > 0) - Number(a.leftBehind.length > 0) ||
      oldest(a) - oldest(b),
  )
}

/** How long, in words: `4 minutes`, `3 hours`, `9 days`. Under a minute reads as a minute. */
export function durationWords(ms: number): string {
  const words = copy.workspace.topbar.processesPopover
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  if (minutes < 60) return words.minutes(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return words.hours(hours)
  return words.days(Math.floor(hours / 24))
}

/** Ports as a server is reached: `:5173 :5174`. */
export function portsWords(ports: readonly number[]): string {
  return ports.map((port) => `:${port}`).join(' ')
}

/** The state of a row in a word, and what that word means. */
export function processStateWords(state: StudioAgentProcess['state']): { word: string; hint: string } {
  const words = copy.workspace.topbar.processesPopover
  switch (state) {
    case 'left-behind':
      return { word: words.leftBehind, hint: words.leftBehindHint }
    case 'agent-idle':
      return { word: words.agentIdle, hint: words.agentIdleHint }
    case 'on-its-own':
      return { word: words.onItsOwn, hint: words.onItsOwnHint }
    case 'with-agent':
      return { word: words.withItsAgent, hint: words.withItsAgentHint }
  }
}

/** A tab's name: its title, else its address's host, else the address. */
export function tabName(tab: Pick<StudioBrowserTab, 'title' | 'url'>): string {
  if (tab.title.trim()) return tab.title.trim()
  try {
    return new URL(tab.url).host || tab.url
  } catch {
    return tab.url
  }
}
