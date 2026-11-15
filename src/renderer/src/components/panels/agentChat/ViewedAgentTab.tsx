import type { ReactNode } from 'react'

import type { AgentCli } from '../../../../../shared/workspace'
import CliIcon from '../../CliIcon'
import { useChatPanelFacts } from './chatPanelStore'
import { useSubagentFamily } from './subagentFamilyStore'
import { useSubagentViews } from './subagentViewStack'

// A chat's tab says who is on screen: the subagent the person went into, as the
// panel beside it does, and the chat itself otherwise. Small components, because
// a tab is drawn by a render callback that cannot read a store for one tab.

function useViewedAgent(workspaceId: string, rootAgentId: string): { name: string; cli: AgentCli | null } | null {
  const top = useSubagentViews(workspaceId, rootAgentId).at(-1)
  const family = useSubagentFamily(workspaceId, rootAgentId)
  const facts = useChatPanelFacts(workspaceId, top?.kind === 'chat' ? top.agentId : null)
  if (!top) return null
  if (top.kind === 'lane')
    return family.lane ? { name: family.lane.name, cli: family.lane.cli } : { name: top.label ?? 'Subagent', cli: null }
  return { name: facts?.name ?? top.label ?? 'Subagent', cli: facts?.cli ?? null }
}

export function ViewedAgentTabName({
  workspaceId,
  rootAgentId,
  children,
}: {
  workspaceId: string
  rootAgentId: string
  /** The tab's own name, while it shows its chat. */
  children: ReactNode
}) {
  const viewed = useViewedAgent(workspaceId, rootAgentId)
  return <>{viewed ? viewed.name : children}</>
}

export function ViewedAgentTabLogo({
  workspaceId,
  rootAgentId,
  className,
  children,
}: {
  workspaceId: string
  rootAgentId: string
  className?: string
  /** The tab's own mark, while it shows its chat. */
  children: ReactNode
}) {
  const viewed = useViewedAgent(workspaceId, rootAgentId)
  return <>{viewed?.cli ? <CliIcon cli={viewed.cli} className={className} /> : children}</>
}
