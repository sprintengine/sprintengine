// The sidebar's right-click menus for a workspace row, a paired machine's chat
// row, and a folder header.

import { isSubagentRecord } from '../../../../../shared/agent-state'
import type { ReactNode } from 'react'
import { type Workspace, type HighlightColor } from '../../../../../shared/workspace'
import { resolveEnabledWorkspaceType } from '../../AppIcons'
import type { WorkspaceTypeRowAction } from '../../../modules/renderer-host'
import {
  type SnoozePresetId,
  isSnoozedWorkspace,
  canSnoozeWorkspace,
  resolveSnoozePresets,
} from '../../../utils/workspaceSnooze'
import { newChatProjectTarget, type FolderGroup } from './folderGroups'
import { isSettledWorkspace, normalizeAutoSettleAfterDays } from '../../../utils/workspaceSettle'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  ContextMenu,
  MenuItem,
  DescribedMenuItem,
  MenuDivider,
  StarGlyph,
  MenuFlyoutItem,
  MenuSwatchRow,
  ProjectColorSwatchRow,
  SwitchGlyph,
} from '../../ui'
import { type ProjectColorSetting, type ProjectColor } from '../../../utils/projectColor'
import { isProjectlessChatsRoot } from '../../../../../shared/projectless-chats'
import { clientSupports } from '../../../clientCapabilities'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import { chatMenuTooltips as tips, type ChatMenuPlace } from './chatMenuTooltips'
import type { MeshConversationManage } from '../../../../../shared/tailnet-mesh'
import { copy as appCopy } from '../../../../../shared/copy'

export function sidebarWorkspaceOf(workspace: Workspace): {
  id: string
  name: string
  mode: Workspace['mode']
  moduleState: Workspace['moduleState']
} {
  return {
    id: workspace.id,
    name: workspace.name,
    mode: workspace.mode,
    moduleState: workspace.moduleState,
  }
}

export function workspaceTypeRowActions(
  workspace: Workspace,
  moduleOverrides: Parameters<typeof resolveEnabledWorkspaceType>[1],
): WorkspaceTypeRowAction[] {
  const type = resolveEnabledWorkspaceType(workspace.mode, moduleOverrides)
  const row = sidebarWorkspaceOf(workspace)
  return (type?.rowActions ?? []).filter((action) => action.isVisible?.(row) !== false)
}

/**
 * A chat row's Auto compact switch: on by its own choice, or by the app-wide
 * default where it left that unset; and whether its chat is Claude's, the one
 * it works on yet. Null for a row with no chat in it, or a paired machine's,
 * whose switch is that machine's (`RemoteConversation.autoCompact`).
 */
export function autoCompactSwitchOf(
  workspace: Workspace,
  enabledByDefault: boolean,
): { on: boolean; claude: boolean } | null {
  if (workspace.remoteOrigin) return null
  const chats = Object.values(workspace.agents ?? {}).filter(
    (agent) => agent.runtimeKind === 'conversation' && agent.conversation && !isSubagentRecord(agent),
  )
  if (chats.length === 0) return null
  return {
    on: workspace.autoCompactEnabled ?? enabledByDefault,
    claude: chats.some((agent) => cliForConversationProvider(agent.conversation!.providerId) === 'claude-code'),
  }
}

/**
 * Whether a row's name can be written again by a model: a chat here, with a
 * conversation in it to title from. A paired machine's chat is named there.
 */
export function canRegenerateTitleOf(workspace: Workspace): boolean {
  if (workspace.remoteOrigin) return false
  return Object.values(workspace.agents ?? {}).some(
    (agent) => agent.runtimeKind === 'conversation' && agent.conversation && !isSubagentRecord(agent),
  )
}

/** What the rest-and-marks half of a chat's menu dispatches, on a row here or a paired machine's. */
export type ChatMarkAction =
  | 'toggle-star'
  | 'toggle-settle'
  | 'toggle-auto-settle'
  // Snooze presets dispatch as `snooze:<presetId>` so the union stays closed
  // while the list of wake times remains data: a new wake time is a row in the
  // preset table, not a new member of this union.
  | `snooze:${SnoozePresetId}`
  | 'wake'
  | 'clear-color'

/** A change to a chat's marks or sleep, as opposed to its rest: what a paired machine's `chat-lifecycle` takes. */
export type ChatMarkChange = Exclude<ChatMarkAction, 'toggle-settle'>

/**
 * A chat menu's row: `DescribedMenuItem`, whose `tooltip` is required, so no
 * item of a chat's menu can be added without saying what it does
 * (`chatMenuTooltips`).
 */
const ChatMenuItem = DescribedMenuItem

/**
 * A chat's rest and its marks, the half of its menu below the divider: Star,
 * then whatever the row adds (`between`), Settle, Snooze, Auto-settle and the
 * highlight swatches. One component for a row here and a paired machine's,
 * so the two menus cannot drift apart.
 */
function ChatRestAndMarkItems({
  where,
  starred,
  color,
  settle,
  working,
  snooze,
  autoSettle,
  autoCompact = null,
  between = null,
  onSelect,
  onPickColor,
}: {
  /** Whose the chat is, which its items' tooltips say (`ChatMenuPlace`). */
  where: ChatMenuPlace
  starred: boolean
  color: HighlightColor | null
  /** Settle, Un-settle, or neither where the chat's rest cannot be asked for. */
  settle: 'settle' | 'unsettle' | null
  /** An agent in the chat is still working, so Settle and Snooze wait. */
  working: boolean
  /**
   * Wake now on a sleeping chat; the Snooze presets where it may sleep,
   * disabled while it may not yet; null for neither.
   */
  snooze: 'wake' | { disabled: boolean } | null
  /** The Auto-settle switch's state; null leaves it off the menu. */
  autoSettle: boolean | null
  /**
   * The Auto compact switch: whether it is on for this chat (its own choice,
   * or the app-wide default), and whether the chat is Claude's, the only one
   * it works on yet. Null leaves it off the menu: a row with no chat in it,
   * or a paired machine's chat where that machine does not take the switch
   * from here.
   */
  autoCompact?: { on: boolean; claude: boolean } | null
  between?: ReactNode
  onSelect: (action: ChatMarkAction | 'toggle-auto-compact') => void
  onPickColor: (color: HighlightColor) => void
}) {
  // The quiet days a chat here settles after (Settings ▸ Settled chats).
  const autoSettleDays = useWorkspaceStore((s) => s.appSettings.autoSettleAfterDays)
  return (
    <>
      <ChatMenuItem
        checked={starred}
        tooltip={tips.star(starred, where)}
        onClick={() => onSelect('toggle-star')}
        icon={
          <StarGlyph
            filled={starred}
            stroked
            className={`icon-sm shrink-0 ${starred ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-disabled)]'}`}
          />
        }
      >
        {starred ? 'Unstar' : 'Star'}
      </ChatMenuItem>
      {between}
      {/* Rest by hand (settled-chats, 2026-09-07). Un-settle also holds the
          row out of the sweep until it sees new activity. Settling ends the
          chat's agents, and their work with them: it waits until they finish. */}
      {settle === 'unsettle' ? (
        <ChatMenuItem tooltip={tips.unsettle()} onClick={() => onSelect('toggle-settle')}>
          {appCopy.workspace.sidebar.contextMenus.unSettle}
        </ChatMenuItem>
      ) : settle === 'settle' ? (
        <ChatMenuItem
          disabled={working}
          hint={working ? appCopy.workspace.sidebar.contextMenus.working : undefined}
          tooltip={tips.settle(working, where)}
          onClick={() => onSelect('toggle-settle')}
        >
          {appCopy.workspace.sidebar.contextMenus.settle}
        </ChatMenuItem>
      ) : null}
      {/* Sleep by hand (snooze, 2026-09-10), beneath Settle because it is the
          softer of the two: Settle says the work is done, Snooze says only
          "not now". Resolved against the clock at OPEN time so the wake times
          on the rows are the ones the click will actually land on.

          Hidden entirely — rather than disabled — where the chat has nowhere
          to sleep (a settled row): a permanently dead entry is worse than no
          entry. Disabled, not hidden, when the agent is working: that one is
          temporary and the reason is worth showing. */}
      {snooze === 'wake' ? (
        <ChatMenuItem tooltip={tips.wake(where)} onClick={() => onSelect('wake')}>
          {appCopy.workspace.sidebar.contextMenus.wakeNow}
        </ChatMenuItem>
      ) : snooze ? (
        <MenuFlyoutItem
          label={appCopy.workspace.sidebar.contextMenus.snooze}
          ariaLabel={appCopy.workspace.sidebar.contextMenus.snoozeChat}
          disabled={snooze.disabled || working}
          hint={working ? appCopy.workspace.sidebar.contextMenus.working : undefined}
          tooltip={tips.snooze(working, where)}
        >
          {resolveSnoozePresets(Date.now()).map((preset) => (
            <ChatMenuItem
              key={preset.id}
              hint={preset.whenLabel}
              tooltip={tips.snoozeUntil(preset.label, preset.whenLabel)}
              onClick={() => onSelect(`snooze:${preset.id}`)}
            >
              {preset.label}
            </ChatMenuItem>
          ))}
        </MenuFlyoutItem>
      ) : null}
      {/* Whether this chat settles by itself: after its quiet days, or when
          its pull requests land. Off unless switched on here. A standing
          setting, so a switch row that stays open to show it flip, like Star. */}
      {autoSettle !== null ? (
        <ChatMenuItem
          checked={autoSettle}
          trailing={<SwitchGlyph checked={autoSettle} />}
          tooltip={tips.autoSettle(
            where,
            where.kind === 'local' ? normalizeAutoSettleAfterDays(autoSettleDays) : undefined,
          )}
          onClick={() => onSelect('toggle-auto-settle')}
        >
          {appCopy.workspace.sidebar.contextMenus.autoSettle}
        </ChatMenuItem>
      ) : null}
      {/* Whether Studio compacts the chat by itself before its prompt cache
          expires. Beside Auto-settle, as the other standing rule about what
          happens to an idle chat, and a switch the same way. Off, and said
          why, for a chat that is not Claude's. */}
      {autoCompact ? (
        <ChatMenuItem
          checked={autoCompact.claude && autoCompact.on}
          disabled={!autoCompact.claude}
          hint={autoCompact.claude ? undefined : appCopy.workspace.sidebar.contextMenus.claudeOnly}
          trailing={<SwitchGlyph checked={autoCompact.claude && autoCompact.on} />}
          tooltip={tips.autoCompact(autoCompact.claude, where)}
          onClick={() => onSelect('toggle-auto-compact')}
        >
          {appCopy.workspace.sidebar.contextMenus.autoCompact}
        </ChatMenuItem>
      ) : null}
      <MenuSwatchRow
        label={appCopy.workspace.sidebar.contextMenus.highlightColor}
        value={color}
        onPick={onPickColor}
        onClear={() => onSelect('clear-color')}
        swatchTooltip={(swatch) => tips.highlight(swatch, where)}
      />
    </>
  )
}

export type EnvironmentChatMenuAction =
  | 'open'
  | 'mark-unread'
  | 'copy-link'
  | 'move-to-new-window'
  | 'move-to-main-window'
  | ChatMarkAction
  | 'rename'
  | 'toggle-auto-compact'
  | 'stop-watching'
  | 'new-chat'
  // ── This computer's chat, as the window holds it ──
  | 'regenerate-title'
  | 'reveal'
  | 'toggle-schedule-pause'
  | 'delete-settled'
  | `type-action:${string}`

/**
 * What a chat of this computer's menu adds, from the window's record of it:
 * its folder on this disk (Reveal, New chat in its project), its title
 * regenerated from what was said, the schedule that started it, its
 * workspace type's own actions, and Delete once it is settled.
 */
export type LocalChatMenuExtras = {
  /** The window's record of the chat, as its row draws it (`localChatRows`). */
  workspace: Workspace
  moduleOverrides: Parameters<typeof resolveEnabledWorkspaceType>[1]
  /** The schedule here that started the chat, and whether it is paused; null for every other chat. */
  schedule: { paused: boolean } | null
  /** The window can delete settled chats (a confirm dialog and the delete are there). */
  canDelete: boolean
}

// A chat's menu, by its address, on any machine: this computer's (`local`), a
// paired desktop's, an SSH machine's, a WSL distribution's. Each item asks
// the Studio that keeps the chat. Generic menu chrome (surface, clamped
// positioning, items, dividers, swatch row, dismissal, focus handling) lives
// in the ui/ContextMenu primitive; only the chat's actions are here.
//
// This computer's chat adds what the window holds of it (`LocalChatMenuExtras`).
// Another machine's: its rest
// (`conversation-lifecycle`), its marks and sleep (`chat-lifecycle`) and its read
// state (`chat-lifecycle`) are offered where the machine takes them; an
// older machine's chat offers what it can, as a local menu hides what does
// not apply. Reveal folder is shown off, saying why: the folder is on the
// other machine's disk. Rename is offered where the machine keeps the name
// (`chat-lifecycle`), and New chat in project where this pairing may start a
// chat there, opening New chat on that machine and project. Left out because
// they are about a workspace here, which this row does not have until it is
// opened: the workspace type's own actions, and Close workspace.
export function EnvironmentChatContextMenu({
  x,
  y,
  title,
  machineName,
  canSettle,
  marks,
  manage,
  autoCompact = null,
  watchedPullRequestNumber = null,
  canNewChat = false,
  canMarkUnread,
  isDetachedWindow,
  chatLink,
  starred,
  color,
  snoozedUntil,
  autoSettle,
  now,
  working,
  local = null,
  onClose,
  onSelect,
  onPickColor,
}: {
  x: number
  y: number
  title: string
  machineName: string
  /** A chat of this computer's: what the window holds of it. */
  local?: LocalChatMenuExtras | null
  /** The machine keeps its chats' rest, so it can be asked to settle this one. */
  canSettle: boolean
  /** The machine takes the row menu's Star, Highlight color, Snooze and Auto-settle (`chat-lifecycle`). */
  marks: boolean
  /** What of the chat's management the machine takes from here; none when absent. */
  manage?: MeshConversationManage
  /** The chat's Auto compact switch as its machine reads it; offered where the machine takes it from here. */
  autoCompact?: { on: boolean; claude: boolean } | null
  /** The pull request its machine watches for it, by number, where the machine takes Stop watching from here. */
  watchedPullRequestNumber?: number | null
  /** This pairing may start a chat on the machine: New chat in project opens there, in this chat's project. */
  canNewChat?: boolean
  /** Its agent finished something nobody has been marked as missing, and the machine takes Mark unread. */
  canMarkUnread: boolean
  isDetachedWindow: boolean
  /** The chat's link, by its address on its environment; null while that environment's id is not known. */
  chatLink: string | null
  starred: boolean
  color: HighlightColor | null
  /** When it wakes, while it sleeps over there. */
  snoozedUntil: number | null
  autoSettle: boolean
  now: number
  /** Its agent is working, so Settle and Snooze wait, as they do on a local row. */
  working: boolean
  onClose: () => void
  onSelect: (action: EnvironmentChatMenuAction) => void
  onPickColor: (color: HighlightColor) => void
}) {
  const canCopyLink = clientSupports('deep-links') && chatLink !== null
  const snoozed = isSnoozedWorkspace({ snoozedUntil }, now)
  const where: ChatMenuPlace = local
    ? { kind: 'local' }
    : { kind: 'environment', machineName, marks, ...(manage ? { manage } : {}) }
  const workspace = local?.workspace ?? null
  const settled = workspace ? isSettledWorkspace(workspace) : false
  // New chat is about the project the row files under, which a pruned worktree
  // does not touch; Reveal is about THIS row's folder, so a missing one takes
  // it away (and says why).
  const newChatTarget = workspace ? newChatProjectTarget(workspace) : null
  const folderPathExists = Boolean(workspace?.folderPath) && !workspace?.folderMissing
  const revealUnavailable = Boolean(workspace?.folderPath) && workspace?.folderMissing === true
  const typeActions = local ? workspaceTypeRowActions(local.workspace, local.moduleOverrides) : []
  const snooze = snoozed
    ? ('wake' as const)
    : settled
      ? null
      : { disabled: workspace ? !canSnoozeWorkspace(workspace) : false }
  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={
        local
          ? appCopy.workspace.sidebar.contextMenus.workspaceActions(title)
          : appCopy.workspace.sidebar.contextMenus.chatActionsOn(title, machineName)
      }
      onClose={onClose}
      surfaceClassName="min-w-[240px]"
    >
      <ChatMenuItem tooltip={tips.open(where)} onClick={() => onSelect('open')}>
        {appCopy.workspace.sidebar.contextMenus.open}
      </ChatMenuItem>
      {canMarkUnread ? (
        <ChatMenuItem tooltip={tips.markUnread(where)} onClick={() => onSelect('mark-unread')}>
          {appCopy.workspace.sidebar.contextMenus.markUnread}
        </ChatMenuItem>
      ) : null}
      {local || manage?.rename ? (
        <ChatMenuItem
          tooltip={tips.rename(where)}
          onClick={() => onSelect('rename')}
          shortcut={local ? 'F2' : undefined}
        >
          {appCopy.workspace.sidebar.contextMenus.rename}
        </ChatMenuItem>
      ) : null}
      {workspace && canRegenerateTitleOf(workspace) ? (
        <ChatMenuItem tooltip={tips.regenerateTitle()} onClick={() => onSelect('regenerate-title')}>
          {appCopy.workspace.sidebar.contextMenus.regenerateTitle}
        </ChatMenuItem>
      ) : null}
      {local ? (
        newChatTarget !== null ? (
          <ChatMenuItem
            tooltip={tips.newChat(isProjectlessChatsRoot(newChatTarget))}
            onClick={() => onSelect('new-chat')}
          >
            {isProjectlessChatsRoot(newChatTarget) ? 'New chat without a project' : 'New chat in project'}
          </ChatMenuItem>
        ) : null
      ) : canNewChat ? (
        <ChatMenuItem tooltip={tips.newChat(false, where)} onClick={() => onSelect('new-chat')}>
          {appCopy.workspace.sidebar.contextMenus.newChatInProject}
        </ChatMenuItem>
      ) : null}
      {local ? (
        folderPathExists ? (
          <ChatMenuItem tooltip={tips.reveal()} onClick={() => onSelect('reveal')}>
            {appCopy.workspace.sidebar.contextMenus.revealFolder}
          </ChatMenuItem>
        ) : revealUnavailable ? (
          <ChatMenuItem
            disabled
            hint={appCopy.workspace.sidebar.contextMenus.missing}
            tooltip={tips.revealUnavailable(where)}
            onClick={() => undefined}
          >
            {appCopy.workspace.sidebar.contextMenus.revealFolder}
          </ChatMenuItem>
        ) : null
      ) : (
        // Off, and saying why: the folder is on the other machine's disk.
        <ChatMenuItem
          disabled
          hint={appCopy.workspace.sidebar.contextMenus.on(machineName)}
          tooltip={tips.revealUnavailable(where)}
          onClick={() => undefined}
        >
          {appCopy.workspace.sidebar.contextMenus.revealFolder}
        </ChatMenuItem>
      )}
      {canCopyLink ? (
        <ChatMenuItem tooltip={tips.copyLink(where)} onClick={() => onSelect('copy-link')}>
          {appCopy.workspace.sidebar.contextMenus.copyLinkToChat}
        </ChatMenuItem>
      ) : null}
      {/* Opened in that window, as a local row is moved to it. */}
      {isDetachedWindow ? (
        <ChatMenuItem tooltip={tips.moveToMainWindow(where)} onClick={() => onSelect('move-to-main-window')}>
          {appCopy.workspace.sidebar.contextMenus.moveToMainWindow}
        </ChatMenuItem>
      ) : (
        <ChatMenuItem tooltip={tips.moveToNewWindow(where)} onClick={() => onSelect('move-to-new-window')}>
          {appCopy.workspace.sidebar.contextMenus.moveToNewWindow}
        </ChatMenuItem>
      )}
      {marks || canSettle ? (
        <>
          <MenuDivider />
          {marks ? (
            <ChatRestAndMarkItems
              where={where}
              starred={starred}
              color={color}
              settle={settled ? 'unsettle' : canSettle ? 'settle' : null}
              working={working}
              snooze={snooze}
              autoSettle={autoSettle}
              // Auto compact is the rule of the machine that runs the chat,
              // switched there where that machine takes it from here.
              autoCompact={local || manage?.autoCompact ? autoCompact : null}
              between={
                <>
                  {/* A chat whose agent has its pull request watched reads as
                      working until it is woken; this ends the watch, there, and
                      leaves the chat as it is. Settle ends the watch too. */}
                  {watchedPullRequestNumber !== null ? (
                    <ChatMenuItem
                      tooltip={tips.stopWatching(watchedPullRequestNumber, where)}
                      onClick={() => onSelect('stop-watching')}
                    >
                      {appCopy.workspace.sidebar.contextMenus.stopWatching}
                      {watchedPullRequestNumber}
                    </ChatMenuItem>
                  ) : null}
                  {/* A run's chat is where a person notices a schedule doing
                      too much: this stops its next runs from here, and leaves
                      this chat (and any run still going) as it is. */}
                  {local?.schedule ? (
                    <ChatMenuItem
                      tooltip={tips.schedule(local.schedule.paused)}
                      onClick={() => onSelect('toggle-schedule-pause')}
                    >
                      {local.schedule.paused ? 'Resume this schedule' : 'Pause this schedule'}
                    </ChatMenuItem>
                  ) : null}
                </>
              }
              onSelect={onSelect}
              onPickColor={onPickColor}
            />
          ) : (
            <ChatMenuItem
              disabled={working}
              hint={working ? appCopy.workspace.sidebar.contextMenus.working : undefined}
              tooltip={tips.settle(working, where)}
              onClick={() => onSelect('toggle-settle')}
            >
              {appCopy.workspace.sidebar.contextMenus.settle}
            </ChatMenuItem>
          )}
        </>
      ) : null}
      {typeActions.length > 0 ? (
        <>
          <MenuDivider />
          {typeActions.map((action) => (
            <ChatMenuItem
              key={action.id}
              variant={action.variant}
              tooltip={tips.typeAction(action.label)}
              onClick={() => onSelect(`type-action:${action.id}`)}
            >
              {action.label}
            </ChatMenuItem>
          ))}
        </>
      ) : null}
      {local?.canDelete && settled ? (
        <>
          <MenuDivider />
          <ChatMenuItem variant="danger" tooltip={tips.deleteSettled(where)} onClick={() => onSelect('delete-settled')}>
            {appCopy.workspace.sidebar.contextMenus.deleteChat}
          </ChatMenuItem>
        </>
      ) : null}
    </ContextMenu>
  )
}

export type FolderMenuAction = 'new-chat' | 'reveal' | 'icon' | 'forget'

export function FolderContextMenu({
  x,
  y,
  group,
  remoteNewChat = false,
  projectColorKey: colorKey,
  projectColorSettled,
  projectColor,
  automaticProjectColor,
  onClose,
  onSelect,
  onPickProjectColor,
}: {
  x: number
  y: number
  group: FolderGroup | null
  /**
   * A header of a paired machine's project, on a machine this pairing may
   * start a chat on: New chat in project opens New chat there.
   */
  remoteNewChat?: boolean
  /** The project this header names, or null when it is not a project. */
  projectColorKey: string | null
  /** Whether that key is the project's FINAL one — see `canPickColor` below. */
  projectColorSettled: boolean
  /** The person's override for that project: a hue, `'none'`, or null for none. */
  projectColor: ProjectColorSetting | null
  /** The hue hashed from that project's key — what "Automatic" returns to. */
  automaticProjectColor: ProjectColor
  onClose: () => void
  onSelect: (action: FolderMenuAction) => void
  /** A hue, `'none'`, or null for "Automatic" (deletes the override). */
  onPickProjectColor: (color: ProjectColorSetting | null) => void
}) {
  if (!group) return null
  const canReveal = Boolean(group.fullPath) && !group.missing
  const canForget = Boolean(group.fullPath)
  const canCreateWorkspace = (Boolean(group.fullPath) && !group.missing) || (Boolean(group.remote) && remoteNewChat)
  // "Changed by you" (decision 5) — but only where there is a project to
  // change, and only once we know which project it IS. The "No folder" bucket
  // is not a project, and a remote group's root lives on another machine with
  // no identity to key by.
  //
  // The `settled` half is not cosmetic. Before the repository read lands the key
  // is the folder's PATH; a person who right-clicks a header in that first
  // second and picks a hue would have it written to `folder:/path`, and a beat
  // later the project is keyed `repo:…` and their choice has silently vanished
  // — leaving a stray override on a key nothing reads. Better to not offer the
  // control for that beat than to take a choice and lose it.
  const canPickColor = Boolean(colorKey) && projectColorSettled

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={appCopy.workspace.sidebar.contextMenus.folderActions(group.displayName)}
      onClose={onClose}
      surfaceClassName="min-w-[220px]"
    >
      {canCreateWorkspace ? (
        <MenuItem onClick={() => onSelect('new-chat')}>
          {/* The "No project" header starts another chat of its kind, in a
              folder of its own, never one inside the root itself. */}
          {isProjectlessChatsRoot(group.fullPath) ? 'New chat without a project' : 'New chat in project'}
        </MenuItem>
      ) : null}
      {canReveal ? (
        <MenuItem onClick={() => onSelect('reveal')}>{appCopy.workspace.sidebar.contextMenus.revealFolder}</MenuItem>
      ) : null}
      {/* The icon is a folder's, on this disk: a chosen file is a path here,
          so only a project with a folder that is present offers it. */}
      {canReveal && !isProjectlessChatsRoot(group.fullPath) ? (
        <MenuItem onClick={() => onSelect('icon')}>{appCopy.workspace.sidebar.contextMenus.projectIcon}</MenuItem>
      ) : null}
      {/* The same swatch control the row menu spends on "Highlight color", one
          menu up: a highlight is a tint a person puts ON a chat, a project
          colour is what the project IS, and the header is the one line that
          names the project. "Automatic" (the hashed hue), eight named hues,
          and "No colour" — the last for a project whose own logo already
          identifies it. */}
      {canPickColor ? (
        <ProjectColorSwatchRow
          label={appCopy.workspace.sidebar.contextMenus.projectColor}
          value={projectColor}
          automaticColor={automaticProjectColor}
          onPick={onPickProjectColor}
        />
      ) : null}
      {canCreateWorkspace && canForget ? <MenuDivider /> : null}
      {canForget ? (
        <MenuItem variant="danger" onClick={() => onSelect('forget')}>
          {appCopy.workspace.sidebar.contextMenus.forgetFolder}
        </MenuItem>
      ) : null}
    </ContextMenu>
  )
}
