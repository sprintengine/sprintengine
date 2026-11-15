import { useEffect, useMemo, useState } from 'react'

import type { Workspace } from '../../../../../../shared/workspace'
import { canvasBoardSourceOf, listCanvasBoards } from '../canvas/canvasBoardSource'

/**
 * How many boards the Canvases row can say the chat's project has, on whichever
 * machine it runs: the same list the picker opens on. `version` is what moves it
 * (a board opened, or one an agent touched). Null until it is read, and for a
 * list that could not be: the row then says no number rather than a wrong one.
 */
export function useCanvasBoardCount(
  workspace: Pick<Workspace, 'id' | 'remoteOrigin'> | null,
  enabled: boolean,
  version: string,
): number | null {
  const [count, setCount] = useState<number | null>(null)
  const origin = workspace?.remoteOrigin
  const originKey = origin ? JSON.stringify(origin) : ''
  const source = useMemo(
    () => canvasBoardSourceOf(originKey ? { remoteOrigin: JSON.parse(originKey) as Workspace['remoteOrigin'] } : null),
    [originKey],
  )
  const workspaceId = workspace?.id ?? null
  useEffect(() => {
    if (!enabled || !workspaceId) {
      setCount(null)
      return undefined
    }
    let current = true
    void (async () => {
      try {
        const listed = await listCanvasBoards(source, workspaceId, 'project')
        if (current) setCount(listed.ok ? listed.value.boards.length : null)
      } catch {
        if (current) setCount(null)
      }
    })()
    return () => {
      current = false
    }
  }, [enabled, source, workspaceId, version])
  return count
}
