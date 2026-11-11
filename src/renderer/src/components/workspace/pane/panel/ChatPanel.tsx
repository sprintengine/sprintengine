import React from 'react'

import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { selectModuleEnabled } from '../../../../modules'
import type { WorkspacePaneTab } from '../../../../types/workspace'
import { GitBranchGlyph } from '../../../AppIcons'
import CliIcon from '../../../CliIcon'
import { shortMachineName } from '../../../remote/machineRowModel'
import { useChatActivity, type ChatActivityRow } from '../../../panels/agentChat/chatActivityStore'
import { openPairedChanges, usePairedChanges } from '../../../panels/agentChat/pairedChanges'
import { useRemoteChat } from '../../../panels/agentChat/remoteChatRegistry'
import { useChatPanelFacts, type ChatPanelFacts } from '../../../panels/agentChat/chatPanelStore'
import { useShowSubagentFamily, useSubagentFamily } from '../../../panels/agentChat/subagentFamilyStore'
import { subagentViewOwner, useSubagentViews } from '../../../panels/agentChat/subagentViewStack'
import { DiffStatPill, FrontTruncatedText, MachineGlyph, Section, TruncatedText, WorktreeGlyph } from '../../../ui'
import { useScrollEdges } from '../../../ui/useScrollEdges'
import { remoteProjectName } from '../../sidebar/folderGroups'
import { dispatchFileReveal } from '../../../../utils/fileReveal'
import { DiffGlyph, FilesGlyph, LibraryGlyph, CanvasGlyph, TerminalGlyph } from '../paneKinds'
import { PermissionsRow, PullRequestRow, ServerRow, TokensRow } from './ChatPanelFactRows'
import { ChatPanelOpenNow, type OpenNowProps } from './ChatPanelOpenNow'
import { ChatPanelParentLink, ChatPanelSubagents } from './ChatPanelSubagents'
import { laneFacts } from './chatPanelLaneFacts'
import { useChatPanelTarget } from './chatPanelTarget'
import { PanelCard, PanelRow } from './PanelRow'
import { useCanvasBoardCount } from './useCanvasBoardCount'
import { useWorkspaceCheckoutFacts } from './useWorkspaceCheckoutFacts'

// The right-hand panel: the pane column's menu (owner ruling 2026-11-07). A
// head that says what the agent in view is and where it runs, a card up to its
// parent when it is a subagent, then what can be opened from here, by what it
// belongs to: its subagents, what is open now, this chat, its session and the
// project.
//
// It stands beside the chat rather than in it, and follows the agent in view
// (`useSubagentViews`): the tab's chat, or the subagent the person went into. It
// reads a chat through `chatPanelStore`, which `ConversationChatBody` fills for
// a chat here and a chat on a paired machine alike and for a sub-agent's chat as
// for any other, and who it is related to through `subagentFamilyStore`. A lane
// is no chat, and says only what `laneFacts` lets it. A row that has nothing to act on over there
// (`farMachine`) says so in words rather than going dead: what this computer
// cannot reach is a fact on the row, not a control that does nothing.
//
// Rows open tabs through `openPaneTab`, never `togglePaneKind`, whose second
// press on a tab showing closes it: a row is a door, and a door does not shut
// the room it leads to. Terminal and Browser select the tab that is there
// first, as `openPaneTab` mints a new terminal every time.

function PanelHead({
  name,
  cli,
  words,
  machine,
  project,
}: {
  name: string
  cli: ChatPanelFacts['cli']
  /** The harness and the model. */
  words: string | null
  machine: ChatPanelFacts['machine']
  /** The chat's project, where the sidebar's local groups cannot say it. */
  project: string | null
}) {
  return (
    <header className="flex flex-col items-center px-6 pb-1.5 pt-2 text-center">
      {cli ? (
        <span className="mb-2 grid size-control-lg place-items-center rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-hover)]">
          <CliIcon cli={cli} className="icon-lg" />
        </span>
      ) : null}
      <TruncatedText
        as="h2"
        text={name}
        className="max-w-full text-heading font-semibold text-[color:var(--text-strong)]"
      />
      {words || machine ? (
        <p className="mt-0.5 flex max-w-full flex-wrap items-center justify-center gap-x-1.5 text-meta text-[color:var(--text-muted)]">
          {words ? <span className="min-w-0 truncate">{words}</span> : null}
          {machine ? (
            <span
              className="inline-flex min-w-0 items-center gap-1 text-micro"
              data-panel-machine={machine.identity.id}
            >
              {words ? <span aria-hidden="true">·</span> : null}
              <MachineGlyph identity={machine.identity} />
              <span className="min-w-0 truncate">{shortMachineName(machine.name)}</span>
            </span>
          ) : null}
        </p>
      ) : null}
      {project ? <p className="max-w-full truncate text-micro text-[color:var(--text-subtle)]">{project}</p> : null}
    </header>
  )
}

/** The glyph's ink, as the chat's activity says it: an agent in it now, or changed since it was last opened. */
function activityTone(row: ChatActivityRow | undefined): string {
  if (row?.live) return 'text-[color:var(--agent-trail-ink)]'
  if (row?.unseen) return 'text-[color:var(--text-strong)]'
  return ''
}

export type ChatPanelProps = OpenNowProps & {
  /**
   * The pane's strip floats over the list rather than standing above it
   * (WorkspacePane): the list starts at the pane's top, opens the strip's
   * height down, and scrolls up under it, fading its top edge once it has.
   */
  underStrip?: boolean
}

export function ChatPanel({ underStrip = false, ...openNow }: ChatPanelProps) {
  const { workspaceId, tabs } = openNow
  const listRef = React.useRef<HTMLDivElement>(null)
  useScrollEdges(listRef)
  const tabAgentId = useChatPanelTarget(workspaceId)
  const top = useSubagentViews(workspaceId, tabAgentId ?? '').at(-1)
  useShowSubagentFamily(workspaceId, tabAgentId)
  const family = useSubagentFamily(workspaceId, tabAgentId)
  const agentId = top ? subagentViewOwner(top) : tabAgentId
  const chatFacts = useChatPanelFacts(workspaceId, agentId)
  const onLane = top?.kind === 'lane'
  const facts = onLane && chatFacts ? laneFacts(chatFacts, family.lane, top.label) : chatFacts
  // What a chat touched is its own, and no part of it is known to be a lane's.
  const activity = useChatActivity(workspaceId, onLane ? null : agentId)
  const workspace = useWorkspaceStore((state) => state.workspaces.find((w) => w.id === workspaceId) ?? null)
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const openPaneTab = useWorkspaceStore((state) => state.openPaneTab)
  const setActivePaneTab = useWorkspaceStore((state) => state.setActivePaneTab)
  const checkout = useWorkspaceCheckoutFacts(workspace)

  const filesEnabled = selectModuleEnabled(moduleOverrides, 'dev-tools')
  const gitEnabled = selectModuleEnabled(moduleOverrides, 'git')
  const canvasEnabled = selectModuleEnabled(moduleOverrides, 'canvas')
  const boardCount = useCanvasBoardCount(
    workspace,
    canvasEnabled,
    `${tabs.filter((tab) => tab.kind === 'canvas').length}:${activity?.rows.find((row) => row.kind === 'canvas')?.meta ?? ''}`,
  )

  // A chat on a paired machine works over there: its terminals cannot be
  // opened from here. Its changes can, read from that machine, where it reads
  // them for this window (`conversation-changes`); an older one keeps the row
  // as its count.
  const farMachine = facts?.remote ? shortMachineName(facts.machine?.name ?? 'the other machine') : null
  const onFarMachine = farMachine ? `On ${farMachine}` : null
  const pairedChanges = usePairedChanges(workspaceId, facts?.remote ? agentId : null)
  const changesOpen = !farMachine || (pairedChanges !== null && gitEnabled)
  // Its files can be too, where the machine shows them (`conversation-checkout-files`).
  const pairedFiles = useRemoteChat(workspaceId, facts?.remote ? agentId : null)?.hostFiles === true

  const record = agentId ? workspace?.agents?.[agentId] : undefined
  const name = facts?.name ?? top?.label ?? record?.name ?? workspace?.name ?? ''
  const cli = facts?.cli ?? record?.cli ?? null
  const words = facts ? [facts.harnessLabel, facts.modelLabel].filter(Boolean).join(' · ') : null
  const origin = workspace?.remoteOrigin
  const project = origin ? remoteProjectName(origin.workspaceRoot, origin.machineName) : null

  const activityRow = (kind: ChatActivityRow['kind']) => activity?.rows.find((row) => row.kind === kind)
  const openChanges = () => {
    if (activityRow('changes')) activity?.open('changes')
    else if (!(gitEnabled && agentId && openPairedChanges(workspaceId, agentId)))
      openPaneTab(workspaceId, { kind: gitEnabled ? 'diff' : 'files' })
  }
  const openFiles = () => {
    if (activityRow('files')) activity?.open('files')
    else if (facts?.branch?.onOpen) facts.branch.onOpen()
    else {
      openPaneTab(workspaceId, { kind: 'files' })
      if (workspace?.folderPath) dispatchFileReveal({ workspaceId, path: workspace.folderPath })
    }
  }
  const terminalTabs = tabs.filter((tab: WorkspacePaneTab) => tab.kind === 'terminal')
  const openTerminal = () => {
    const first = terminalTabs[0]
    if (first) setActivePaneTab(workspaceId, first.id)
    else openPaneTab(workspaceId, { kind: 'terminal' })
  }

  const changes = facts ? facts.changes : checkout.changes
  const shownChanges = changes && (changes.added > 0 || changes.removed > 0) ? changes : null
  const branchName = facts ? (facts.branch?.name ?? null) : checkout.branch
  const worktree = facts?.branch?.worktree ?? false
  const changesRow = activityRow('changes')
  const filesRow = activityRow('files')

  return (
    <div
      ref={listRef}
      // Under the floating strip the strip's height is the list's own top
      // padding, so at rest the list sits where it did below a strip in the
      // flow, and scrolled it runs up to the pane's top edge instead of being
      // cut at the foot of a band that draws nothing. The shared scroll-edge
      // fade (`useScrollEdges`, `.scroll-edge-fade`) marks that edge only while
      // something is up there, and the foot the same way.
      className={`flex h-full min-h-0 flex-col gap-1 overflow-y-auto px-3 pb-4 ${underStrip ? 'scroll-edge-fade pt-[36px]' : ''}`}
      data-chat-panel=""
    >
      <PanelHead name={name} cli={cli} words={words} machine={facts?.machine ?? null} project={project} />
      {family.parent ? <ChatPanelParentLink parent={family.parent} /> : null}
      <ChatPanelSubagents family={family} />
      <ChatPanelOpenNow {...openNow} activity={activity} />
      <Section title="This chat" inset="flush">
        <PanelCard>
          {shownChanges || changesOpen ? (
            <PanelRow
              glyph={<DiffGlyph className={`icon-sm ${activityTone(changesRow)}`} />}
              label="Changes"
              meta={
                shownChanges ? (
                  <DiffStatPill
                    added={shownChanges.added}
                    removed={shownChanges.removed}
                    ariaLabel={shownChanges.phrase}
                  />
                ) : null
              }
              onClick={changesOpen ? openChanges : null}
              ariaLabel={shownChanges ? `Changes, ${shownChanges.phrase}` : 'Changes'}
            />
          ) : null}
          {filesEnabled || farMachine ? (
            <PanelRow
              glyph={<FilesGlyph className={`icon-sm ${activityTone(filesRow)}`} />}
              label="Files"
              meta={onFarMachine ?? filesRow?.meta ?? null}
              onClick={!farMachine ? openFiles : pairedFiles ? () => openPaneTab(workspaceId, { kind: 'files' }) : null}
            />
          ) : null}
          <PanelRow
            glyph={<TerminalGlyph className="icon-sm" />}
            label="Terminal"
            meta={onFarMachine ?? (terminalTabs.length > 0 ? `${terminalTabs.length} running` : null)}
            onClick={farMachine ? null : openTerminal}
          />
          {branchName ? (
            <PanelRow
              glyph={worktree ? <WorktreeGlyph className="icon-sm" /> : <GitBranchGlyph className="icon-sm" />}
              label="Branch"
              meta={<FrontTruncatedText text={branchName} className="min-w-0 font-mono" />}
              onClick={
                farMachine || !gitEnabled
                  ? (facts?.branch?.onOpen ?? null)
                  : () => openPaneTab(workspaceId, { kind: 'git' })
              }
              ariaLabel={worktree ? `Branch ${branchName}, in a worktree` : `Branch ${branchName}`}
              dataBranch={branchName}
            />
          ) : null}
          {facts ? <PullRequestRow facts={facts} /> : null}
          {facts?.localServers ? <ServerRow localServers={facts.localServers} /> : null}
        </PanelCard>
      </Section>
      {facts && (facts.permissions || facts.permissionLabel || facts.tokens) ? (
        <Section title="Session" inset="flush">
          <PanelCard>
            <PermissionsRow facts={facts} />
            <TokensRow facts={facts} />
          </PanelCard>
        </Section>
      ) : null}
      <Section title="Project" inset="flush">
        <PanelCard>
          <PanelRow
            glyph={<LibraryGlyph className="icon-sm" />}
            label="Library"
            meta={activityRow('library')?.meta ?? null}
            onClick={() => openPaneTab(workspaceId, { kind: 'library' })}
          />
          {canvasEnabled ? (
            <PanelRow
              glyph={<CanvasGlyph className="icon-sm" />}
              label="Canvases"
              meta={boardCount ? <span className="tabular-nums">{boardCount}</span> : null}
              onClick={() => openPaneTab(workspaceId, { kind: 'canvas' })}
            />
          ) : null}
        </PanelCard>
      </Section>
    </div>
  )
}
