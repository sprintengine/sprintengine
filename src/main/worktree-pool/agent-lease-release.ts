import type { WorkspaceSyncEvent } from '../../shared/workspace-sync'

/**
 * When an agent's own worktree leases are over (pool-return.ts
 * `releaseLeasesOf`), read off the registry's changes as the core hears them:
 *
 * - a chat settled, or removed: every agent of it is done;
 * - an agent removed from its chat: that agent is done;
 * - a sub-agent's task ended (`subagentEnd` written): that sub-agent is done.
 *
 * The release waits a few seconds, so the chat's processes, which a settle
 * ends, have ended by the time the pool looks; a slot something still runs
 * in is left for the cleanup's sweep. One release per owner at a time: a
 * burst of changes about one chat asks once.
 */

export const AGENT_LEASE_RELEASE_DELAY_MS = 5_000

export type AgentLeaseOwner = { workspaceId: string; agentId?: string }

/** The owners whose leases a registry change ends; empty for any other change. */
export function leaseOwnersEndedBy(event: WorkspaceSyncEvent): AgentLeaseOwner[] {
  switch (event.type) {
    case 'workspace.removed':
      return [{ workspaceId: event.payload.workspaceId }]
    case 'workspace.fields_updated':
      return typeof event.payload.patch.settledAt === 'number' ? [{ workspaceId: event.payload.workspaceId }] : []
    case 'workspace.agents_updated': {
      const { workspaceId, agentId, patch } = event.payload
      if (patch === null) return [{ workspaceId, agentId }]
      const ended = (patch as { subagentEnd?: unknown }).subagentEnd
      return ended !== null && typeof ended === 'object' ? [{ workspaceId, agentId }] : []
    }
    default:
      return []
  }
}

export function createAgentLeaseRelease(deps: {
  release(owner: AgentLeaseOwner): Promise<unknown>
  schedule?: (job: () => void, ms: number) => void
  log?: (message: string) => void
}): (event: WorkspaceSyncEvent) => void {
  const schedule =
    deps.schedule ??
    ((job: () => void, ms: number) => {
      const timer = setTimeout(job, ms)
      timer.unref?.()
    })
  const waiting = new Set<string>()
  return (event) => {
    for (const owner of leaseOwnersEndedBy(event)) {
      const key = `${owner.workspaceId}\0${owner.agentId ?? ''}`
      if (waiting.has(key)) continue
      waiting.add(key)
      schedule(() => {
        waiting.delete(key)
        void deps.release(owner).catch((error: unknown) => {
          deps.log?.(`Giving back an agent's worktree failed: ${String(error)}`)
        })
      }, AGENT_LEASE_RELEASE_DELAY_MS)
    }
  }
}
