import React, { useCallback, useEffect, useMemo } from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { selectModuleEnabled } from '../../../modules'
import { dispatchFileReveal } from '../../../utils/fileReveal'
import { openSubagentList } from './subagentViewStack'
import { openPairedChanges } from './pairedChanges'
import type { TranscriptEntry } from './conversationProjection'
import { deriveChatActivity, sharedEditFolder, type ChatActivity, type ChatActivityKind } from './chatActivity'
import {
  markRowSeen,
  publishChatActivity,
  rowSeen,
  type ChatActivityRow,
  type PublishedChatActivity,
} from './chatActivityStore'

// What the agent touched in a chat — the files it changed and where they sit,
// the page it drove, the board it drew on, the agents it sent off and the
// pictures in the chat — each opening the workspace pane on that tab, so none
// of it is a hunt after a run. The right-hand panel draws it (`ChatPanel`). It is
// never docked over the transcript at any width (owner ruling 2026-11-02): a
// card there took its width out of the chat's text column and pushed the
// conversation left.

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(/^[a-z]+:\/\//iu.test(url) ? url : `http://${url}`).host || url
  } catch {
    return url
  }
}

/** What each row says, from the activity and the checkout's own counts. */
export function chatActivityRows(
  activity: ChatActivity,
  facts: {
    diff: { added: number; removed: number } | null
    workspaceRoot: string | null
    seen: (kind: ChatActivityKind, version: string) => boolean
  },
): Array<ChatActivityRow & { version: string }> {
  return activity.order.map((kind) => {
    const row = (
      label: string,
      meta: string | null,
      live: boolean,
      version: string,
      diff?: ChatActivityRow['diff'],
    ): ChatActivityRow & { version: string } => ({
      kind,
      label,
      meta,
      live,
      version,
      unseen: !facts.seen(kind, version),
      ...(diff ? { diff } : {}),
    })
    switch (kind) {
      case 'changes': {
        const files = activity.edits.paths.length
        return row(
          files ? `Changes · ${plural(files, 'file')}` : 'Changes',
          null,
          activity.edits.live,
          `${files}:${facts.diff?.added ?? ''}:${facts.diff?.removed ?? ''}`,
          facts.diff ?? undefined,
        )
      }
      case 'files': {
        const folder = sharedEditFolder(activity.edits.paths, facts.workspaceRoot)
        return row('Files', folder, activity.edits.live, activity.edits.paths.join('\n'))
      }
      case 'browser': {
        const live = activity.browser?.live ?? false
        return row(
          'Browser',
          live ? 'Agent here' : hostOf(activity.browser?.url ?? null),
          live,
          activity.browser?.url ?? '',
        )
      }
      case 'canvas': {
        const live = activity.canvas?.live ?? false
        return row('Canvas', live ? 'Drawing' : (activity.canvas?.board ?? null), live, activity.canvas?.board ?? '')
      }
      case 'agents': {
        const agents = activity.agents ?? { total: 0, working: 0 }
        return row(
          `Subagents · ${agents.total}`,
          agents.working ? `${agents.working} working` : 'All done',
          agents.working > 0,
          `${agents.total}:${agents.working}`,
        )
      }
      case 'library':
        return row('Library', plural(activity.images.length, 'image'), false, String(activity.images.length))
    }
  })
}

/**
 * Derives the chat's rows and publishes them for the right-hand panel.
 * Called once per chat view.
 */
export function useChatActivityCard({
  workspaceId,
  agentId,
  entries,
  diff,
  workspaceRoot,
}: {
  workspaceId: string
  agentId: string
  entries: readonly TranscriptEntry[]
  /** The checkout's changed lines, as the composer strip counts them; null where it cannot. */
  diff: { added: number; removed: number } | null
  workspaceRoot: string | null
}): void {
  const activity = useMemo(() => deriveChatActivity(entries), [entries])
  const openPaneTab = useWorkspaceStore((state) => state.openPaneTab)
  const setActivePaneTab = useWorkspaceStore((state) => state.setActivePaneTab)
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const gitEnabled = selectModuleEnabled(moduleOverrides, 'git')
  // A seen mark is kept outside React, so opening a row redraws through this.
  const [seenRevision, bumpSeen] = React.useReducer((value: number) => value + 1, 0)
  const rows = useMemo(
    () =>
      chatActivityRows(activity, {
        diff,
        workspaceRoot,
        seen: (kind, version) => rowSeen(workspaceId, agentId, kind, version),
      }),
    // seenRevision: a row opened since is redrawn as seen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activity, diff, workspaceRoot, workspaceId, agentId, seenRevision],
  )

  const open = useCallback(
    (kind: ChatActivityKind) => {
      const row = rows.find((candidate) => candidate.kind === kind)
      if (row) markRowSeen(workspaceId, agentId, kind, row.version)
      bumpSeen()
      const pane = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.paneState
      switch (kind) {
        case 'changes':
          // The Diff tab reads the workspace's checkout, or, for a chat on a
          // paired machine, that machine's; with Git off there is no tab to
          // open, and Files shows the same files.
          if (gitEnabled && openPairedChanges(workspaceId, agentId)) return
          if (gitEnabled) openPaneTab(workspaceId, { kind: 'diff' })
          else openPaneTab(workspaceId, { kind: 'files' })
          return
        case 'files': {
          openPaneTab(workspaceId, { kind: 'files' })
          const folder = sharedEditFolder(activity.edits.paths, null)
          if (folder && folder.startsWith('/')) dispatchFileReveal({ workspaceId, path: folder })
          return
        }
        case 'browser': {
          // The tab the agent drove, when it is still open; otherwise one on
          // the page it was last on.
          const host = hostOf(activity.browser?.url ?? null)
          const tab = pane?.tabs.find(
            (candidate) => candidate.kind === 'browser' && host && hostOf(candidate.url ?? null) === host,
          )
          if (tab) {
            setActivePaneTab(workspaceId, tab.id)
            useWorkspaceStore.getState().setPaneOpen(workspaceId, true)
          } else
            openPaneTab(workspaceId, {
              kind: 'browser',
              ...(activity.browser?.url
                ? {
                    url: /^[a-z]+:\/\//iu.test(activity.browser.url)
                      ? activity.browser.url
                      : `http://${activity.browser.url}`,
                  }
                : {}),
            })
          return
        }
        case 'canvas': {
          // The board's tab, by its name; the canvas picker when it is not open.
          const board = activity.canvas?.board?.replace(/\.excalidraw$/u, '') ?? null
          const tab = pane?.tabs.find(
            (candidate) =>
              candidate.kind === 'canvas' &&
              board !== null &&
              (candidate.canvas?.path.split(/[\\/]/u).at(-1) ?? '').replace(/\.excalidraw$/u, '') === board,
          )
          if (tab) {
            setActivePaneTab(workspaceId, tab.id)
            useWorkspaceStore.getState().setPaneOpen(workspaceId, true)
          } else openPaneTab(workspaceId, { kind: 'canvas' })
          return
        }
        case 'agents':
          openSubagentList(workspaceId)
          return
        case 'library':
          openPaneTab(workspaceId, { kind: 'library' })
          return
      }
    },
    [activity, agentId, gitEnabled, openPaneTab, rows, setActivePaneTab, workspaceId],
  )

  const published = useMemo<PublishedChatActivity>(() => ({ rows, open }), [rows, open])
  useEffect(() => {
    publishChatActivity(workspaceId, agentId, published.rows.length ? published : null)
  }, [workspaceId, agentId, published])
  useEffect(() => () => publishChatActivity(workspaceId, agentId, null), [workspaceId, agentId])
}
