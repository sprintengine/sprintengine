import React from 'react'
import {
  Badge,
  IconButton,
  MenuItem,
  OutlineButton,
  Popover,
  type PopoverPlacement,
  TONE_COLOR_VAR,
  TONE_SOFT_VAR,
  Tooltip,
  TruncatedText,
} from '../ui'
import type { SprintEngineAuthState } from '../../../../shared/electron-api'
import { AccountAvatar, AccountUserGlyph } from './AccountAvatar'
import { AddExtensionsGlyph, RemoteMachineGlyph } from '../AppIcons'
import { InstalledStack } from './globalSurface/extensions/catalogue/InstalledStack'
import type { RailBadge } from './AppRail'
import type { Tone } from '../ui/tokens'
import { SessionsIcon } from './topbar/SessionsPopover'

// The account + Settings cluster lives at the sidebar bottom, relocated from
// WorkspaceTopBar. The account menu, its trigger, and
// the Settings gear keep their original handlers — only the mount point moved.
//
// Five controls, and no more: the app update, Usage, the bell, the account and
// Settings. The bell came down from the top row (owner ruling 2026-11-07), and
// Remote and Sessions came with it, behind the account: the account menu opens
// for everyone, signed in or not, because neither of those is about an account. For four days it also hosted a trigger glyph per registered modal
// surface (doors→modals, 2026-09-01): Plugins, Automations and Design left the top-nav door band and
// opened as modals from beside the gear. The Extensions drawer ruling
// (2026-09-05) sent all three back to being doors — a destination the shell's
// own chrome offers routes the card region — so nothing renders a module's
// modal trigger here. Settings stays because it belongs to the WINDOW rather
// than to whichever section the sidebar is showing, and the usage dashboard
// joined it above the account (owner ruling 2026-10-10) for the same reason:
// what every agent on this machine has spent is nobody's section. The app
// update's glyph joined them on top (owner ruling 2026-10-30): a newer build of
// the app is the window's news, not any section's.

// Three bars of different heights, the column chart with no axes (lucide
// "chart-no-axes-column" geometry): a chart, read at icon size, with nothing
// in it that could be mistaken for a value.
export function UsageGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18 20V10M12 20V4M6 20v-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

// The account disc's ring and fill. One colour for every account: signing in
// unlocks nothing (the app is open source, owner ruling 2026-09-27), so the
// disc says who is signed in and nothing about what they may do.
const ACCOUNT_DISC_STYLE = {
  borderColor: TONE_COLOR_VAR.good,
  backgroundColor: TONE_SOFT_VAR.good,
  color: TONE_COLOR_VAR.good,
}

// Symmetric 8-lobe cog (lucide "settings" geometry), centered in the viewBox so
// it reads balanced at small sizes. Replaces an earlier hand-rolled gear whose
// teeth were unevenly spaced.
function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

// The footer cluster is `IconButton`, not a local lookalike. The helper that
// used to live here painted a `control-md` (34px) box with `rounded-md` — the
// OVERLAY radius, on a control — and carried its open state as a border plus
// `bg-hover`, where the kit's pressed state is the neutral `bg-selected` fill.
// Three divergences from the primitive it was imitating, on the most-used
// glyphs in the app. Retired 2026-09-02; the cluster now sits on the kit's
// icon ramp (30px) and speaks the kit's one pressed language.
//
// Deliberately ghost. The cluster is a row of controls inside the rail's
// surface, tier 3 of the control tiers (owner ruling 2026-10-04): the only
// highlight a control carries belongs to the view's one primary action, and a
// row of lifted glyphs would read as a row of tiles.

// The modal-surface trigger glyphs that used to sit here beside the gear
// (doors→modals, 2026-09-01) are rows of the sidebar's Extensions section now
// (ExtensionsRail, app shell 2026-09-05): one home for every surface a
// person can open, whether it mounts as a door or as a modal.

function moveAccountFocus(event: React.KeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const surface = event.currentTarget.closest('[data-account-menu="true"]')
  if (!surface) return
  const items = Array.from(surface.querySelectorAll<HTMLButtonElement>('[data-account-item="true"]'))
  if (items.length === 0) return
  const idx = items.indexOf(event.currentTarget)
  const next =
    event.key === 'Home'
      ? items[0]
      : event.key === 'End'
        ? items[items.length - 1]
        : items[(idx + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
  next?.focus()
}

function AccountMenuItem({ onSelect, children }: { onSelect: () => void; children: React.ReactNode }) {
  return (
    // The kit's menu row. It passes `data-*` through now — this surface's own
    // roving-focus query selects on `data-account-item` — which is the one
    // thing that kept this a raw button element wearing `MENU_ITEM_CLASS`.
    <MenuItem data-account-item="true" onClick={onSelect} onKeyDown={moveAccountFocus}>
      {children}
    </MenuItem>
  )
}

/** A row the account menu opens something from: what it says at its end, and what it opens. */
export type AccountMenuRow = {
  meta: string | null
  onSelect: () => void
  tooltip?: string
  /** The glyph's ink, where the row's state is worn on it. */
  toneClass?: string
}

/** What the avatar wears for the rows behind it. */
export type AccountBadge = { count: number; tone: Tone; label: string }

function AccountRow({
  glyph,
  label,
  row,
  onChosen,
}: {
  glyph: React.ReactNode
  label: string
  row: AccountMenuRow
  onChosen: () => void
}) {
  return (
    <MenuItem
      data-account-item="true"
      icon={glyph}
      trailing={row.meta ? <span className="text-meta text-[color:var(--text-subtle)]">{row.meta}</span> : undefined}
      onClick={() => {
        onChosen()
        row.onSelect()
      }}
      onKeyDown={moveAccountFocus}
      title={row.tooltip}
    >
      {label}
    </MenuItem>
  )
}

function AccountPopover({
  authState,
  message,
  onRetry,
  onLogout,
  onSignIn,
  remote,
  sessions,
  onChosen,
}: {
  authState: SprintEngineAuthState
  message: string | null
  onRetry: () => void
  onLogout: () => void
  onSignIn: () => void
  remote: AccountMenuRow | null
  sessions: AccountMenuRow | null
  /** A row was pressed: the menu closes, and what it opened stands on its own. */
  onChosen: () => void
}) {
  const signedIn = authState.authenticated
  const metaLine = authState.selectedOrganization?.name ?? null
  const primaryLine = signedIn
    ? (authState.user?.displayName ?? authState.user?.email ?? 'Your account')
    : 'Your account'
  const email = signedIn && authState.user?.displayName ? authState.user?.email : null

  return (
    <div data-account-menu="true" className="w-64 overflow-hidden">
      {/* The header carries the same identity disc as the footer badge, one
          step larger, so the photo (or initials) sits beside the full name. */}
      <div className="flex items-center gap-2.5 px-2.5 pb-2.5 pt-3">
        <AccountAvatar
          user={authState.user}
          className="size-control-sm text-body"
          style={ACCOUNT_DISC_STYLE}
          glyphClassName="icon-md"
        />
        <div className="min-w-0 flex-1">
          <TruncatedText
            as="div"
            text={primaryLine}
            className="text-heading font-medium text-[color:var(--text-strong)]"
          />
          {email ? (
            <TruncatedText as="div" text={email} className="mt-0.5 text-body text-[color:var(--text-muted)]" />
          ) : null}
          {!signedIn ? <div className="mt-0.5 text-meta text-[color:var(--text-muted)]">Not signed in</div> : null}
          {signedIn && metaLine ? (
            <TruncatedText as="div" text={metaLine} className="mt-1 text-meta text-[color:var(--text-subtle)]" />
          ) : null}
        </div>
      </div>

      {message ? (
        <>
          <div className="border-t border-[color:var(--border-subtle)] px-2.5 py-2 text-body leading-5 text-[color:var(--tone-warn)]">
            {message}
          </div>
          <div className="border-t border-[color:var(--border-subtle)] py-1">
            <AccountMenuItem onSelect={onRetry}>Try again</AccountMenuItem>
          </div>
        </>
      ) : null}
      {remote || sessions ? (
        <div className="border-t border-[color:var(--border-subtle)] py-1">
          {remote ? (
            <AccountRow
              glyph={<RemoteMachineGlyph className={`icon-sm ${remote.toneClass ?? ''}`} />}
              label="Remote"
              row={remote}
              onChosen={onChosen}
            />
          ) : null}
          {sessions ? (
            <AccountRow
              glyph={<SessionsIcon className="icon-sm" />}
              label="Sessions"
              row={sessions}
              onChosen={onChosen}
            />
          ) : null}
        </div>
      ) : null}
      <div className="border-t border-[color:var(--border-subtle)] py-1">
        {signedIn ? (
          <AccountMenuItem onSelect={onLogout}>Sign out</AccountMenuItem>
        ) : (
          <AccountMenuItem onSelect={onSignIn}>Sign in</AccountMenuItem>
        )}
      </div>
    </div>
  )
}

export type AccountControlProps = {
  authState: SprintEngineAuthState
  authMessage: string | null
  accountOpen: boolean
  setAccountOpen: React.Dispatch<React.SetStateAction<boolean>>
  startLogin: () => void | Promise<void>
  refreshAuthState: () => void | Promise<void>
  logout: () => void | Promise<void>
  /** Null: the row is absent, as its glyph was while the feature is off. */
  remoteRow?: AccountMenuRow | null
  sessionsRow?: AccountMenuRow | null
  /** What the avatar wears for those rows, which would go quiet inside a menu. */
  accountBadge?: AccountBadge | null
}

export type SidebarAccountBarProps = AccountControlProps & {
  collapsed: boolean
  /** The bell, above the account. Null where the window's band has it. */
  bellSlot?: React.ReactNode
  /** The band has the account: the rail is hidden. */
  accountInBand?: boolean
  openSettings: (checkForUpdates?: boolean, targetTab?: string | null) => void
  settingsOpen: boolean
  /**
   * The updates waiting in Settings — an agent CLI or the app itself (owner
   * ruling 2026-09-25) — worn on the gear as the rail's own corner count.
   */
  settingsBadge?: RailBadge | null
  /**
   * The app update's glyph (AppUpdateRailButton), at the top of the cluster:
   * it lights up when a release is waiting, and pressing it downloads and
   * then restarts into it (owner ruling 2026-10-30).
   */
  updateButton?: React.ReactNode
  /** The usage dashboard's open state, and the toggle the chart glyph calls. */
  usageOpen?: boolean
  openUsage?: () => void
  /** The Extensions modal's open state, and the way the rail's pill opens it. */
  extensionsOpen?: boolean
  openExtensions?: () => void
}

/**
 * The account disc and its menu. Icon-only in BOTH sidebar states (owner,
 * 2026-09-01): the footer spends no width on the account name — the badge
 * (provider photo when the session carries one, initials otherwise) is the whole
 * control, the hover tooltip carries the name, and the click popover keeps the
 * full detail.
 *
 * It opens for everyone: the web client is always signed out, and Remote and
 * Sessions are not an account's. Signed out, the trigger keeps the plain outlined
 * square that says so, and Sign in is the menu's last row.
 */
export function AccountControl({
  authState,
  authMessage,
  accountOpen,
  setAccountOpen,
  startLogin,
  refreshAuthState,
  logout,
  remoteRow = null,
  sessionsRow = null,
  accountBadge = null,
  onRail,
  placement = 'top-start',
}: AccountControlProps & { onRail: boolean; placement?: PopoverPlacement }) {
  const signedIn = authState.authenticated
  const accountName = signedIn
    ? (authState.user?.displayName ?? authState.user?.email ?? 'Your account')
    : 'Your account'
  const shownBadge = accountBadge && accountBadge.count > 0 ? accountBadge : null
  const accessibleName = [`Account · ${accountName}`, shownBadge?.label].filter(Boolean).join(', ')
  const tooltipPlacement = onRail ? 'right' : placement.startsWith('top') ? 'top' : 'bottom'
  // The ring stays around the photo, and the photo replaces only the initials
  // inside it. On the rail the disc steps up with the square it sits in —
  // control-sm inside the rail's control-lg, the same glyph-to-square ratio the
  // section squares keep — so the foot is not a small cluster under big glyphs.
  const avatar = (
    <AccountAvatar
      user={authState.user}
      className={onRail ? 'size-control-sm text-body' : 'size-control-xs text-meta'}
      style={ACCOUNT_DISC_STYLE}
      glyphClassName="icon-sm"
    />
  )
  const corner = shownBadge ? (
    <Badge
      corner
      decorative
      tone={shownBadge.tone}
      count={shownBadge.count}
      max={99}
      // The rail's ground there, the band's here.
      className={onRail ? 'border-[color:var(--bg-side-canvas)]' : 'border-[color:var(--bg-canvas)]'}
    />
  ) : null
  return (
    <Popover
      open={accountOpen}
      onOpenChange={setAccountOpen}
      ariaLabel="Account"
      popupRole="menu"
      placement={placement}
      onOpenAutoFocus={(surface) => {
        surface.querySelector<HTMLButtonElement>('[data-account-item="true"]')?.focus()
      }}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content={accountName} placement={tooltipPlacement}>
          {signedIn ? (
            <IconButton
              ref={ref}
              size={onRail ? 'lg' : 'md'}
              pressed={accountOpen}
              onClick={togglePopover}
              aria-label={accessibleName}
              data-account-trigger=""
              className="relative"
              {...triggerProps}
            >
              {avatar}
              {corner}
            </IconButton>
          ) : (
            // Was a hand-rolled copy of OutlineButton — border, surface-raised
            // fill, both hover steps and the whole disabled:hover guard, restated
            // inline. It has to BE the primitive: the outline variant's look has
            // moved twice (a resting elevation on 2026-09-02, flat on a
            // `border.strong` hairline since 2026-10-04), and a lookalike is the
            // one button in the footer that would be left behind each time.
            <OutlineButton
              ref={ref}
              onClick={togglePopover}
              // On the rail it fills the same control-lg square as the glyphs
              // above it. `min-h` rather than a fourth labelled size: the outline
              // variant's own `h-control-sm` is the height a LABELLED button
              // takes, and the button spec keeps lg for icon-only chrome.
              className={`relative p-0 ${onRail ? 'size-control-lg min-h-control-lg' : 'size-control-md min-h-control-md'}`}
              aria-busy={authState.status === 'checking'}
              aria-label={accessibleName}
              data-account-trigger=""
              {...triggerProps}
            >
              <AccountUserGlyph className="icon-md" />
              {corner}
            </OutlineButton>
          )}
        </Tooltip>
      )}
    >
      <AccountPopover
        authState={authState}
        message={authMessage}
        onRetry={() => void refreshAuthState()}
        onLogout={() => void logout()}
        onSignIn={() => {
          setAccountOpen(false)
          void startLogin()
        }}
        remote={remoteRow}
        sessions={sessionsRow}
        onChosen={() => setAccountOpen(false)}
      />
    </Popover>
  )
}

// Sidebar-bottom account + Settings row. Expanded: the account avatar opens the
// account menu, and the Settings gear sits to its right.
// Collapsed: the avatar and gear stack as centred icons in the rail.
export default function SidebarAccountBar({
  collapsed,
  authState,
  authMessage,
  accountOpen,
  setAccountOpen,
  startLogin,
  refreshAuthState,
  logout,
  openSettings,
  settingsOpen,
  settingsBadge,
  updateButton,
  usageOpen = false,
  openUsage,
  extensionsOpen = false,
  openExtensions,
  remoteRow = null,
  sessionsRow = null,
  accountBadge = null,
  bellSlot = null,
  accountInBand = false,
}: SidebarAccountBarProps) {
  // The gear wears the updates waiting inside Settings the way the rail's
  // squares wear their news: the kit's corner count, ringed in the rail's own
  // canvas (AppRail's RailGlyph). Named — "2 updates available" — so the number
  // is never the whole message, and never drawn at zero.
  const shownSettingsBadge = settingsBadge && settingsBadge.count > 0 ? settingsBadge : null
  // On the rail the account button sits right above the gear, so a tooltip on
  // top would cover it; it opens beside the rail instead, as the rail's own
  // squares' tooltips do.
  const settingsButton = (
    <Tooltip content="Settings" placement={collapsed ? 'right' : 'top'}>
      <IconButton
        size={collapsed ? 'lg' : 'md'}
        pressed={settingsOpen}
        onClick={() => openSettings(false)}
        aria-label="Settings"
        className={shownSettingsBadge ? 'relative' : undefined}
      >
        <GearIcon className={collapsed ? 'size-icon-lg' : 'size-icon-md'} />
        {shownSettingsBadge ? (
          <Badge
            corner
            tone={shownSettingsBadge.tone}
            count={shownSettingsBadge.count}
            max={99}
            ariaLabel={shownSettingsBadge.label}
            className="border-[color:var(--bg-side-canvas)]"
          />
        ) : null}
      </IconButton>
    </Tooltip>
  )

  const usageButton = openUsage ? (
    <Tooltip content="Usage" placement={collapsed ? 'right' : 'top'}>
      <IconButton size={collapsed ? 'lg' : 'md'} pressed={usageOpen} onClick={openUsage} aria-label="Usage">
        <UsageGlyph className={collapsed ? 'size-icon-lg' : 'size-icon-md'} />
      </IconButton>
    </Tooltip>
  ) : null

  // The Extensions pill (owner ruling 2026-11-03): a square like the others
  // until it is pointed at or focused, when its name and the marks of what is
  // installed slide out of it over the column beside the rail. On the rail
  // only — it stands with the account because what is connected to the
  // product is the person's, like the account is.
  const extensionsButton =
    openExtensions && collapsed ? (
      <div className="relative size-control-lg shrink-0">
        <IconButton
          size="lg"
          pressed={extensionsOpen}
          onClick={openExtensions}
          aria-label="Extensions"
          className="rail-extensions-pill absolute left-0 top-0 z-[var(--z-float)]"
        >
          <AddExtensionsGlyph className="size-icon-lg shrink-0" />
          <span className="rail-extensions-pill-label inline-flex items-center gap-2 text-body font-medium">
            <span className="pl-2.5">Extensions</span>
            <InstalledStack size={18} />
            <span className="w-1" />
          </span>
        </IconButton>
      </div>
    ) : null

  return (
    // `app-no-drag` on the cluster, not on each button: the cluster mounts at the
    // foot of the app rail (app shell, 2026-09-05), and the rail is an
    // `app-drag` region the way the title strip is. A drag region swallows the
    // pointer before React sees it, so from the day the cluster moved there the
    // account badge and the gear painted but did not click. Every control in
    // this footer opts out here in one place, the popover trigger included.
    //
    // No rule above the cluster (owner, 2026-09-07): the rail is one column of
    // squares from its first glyph to its foot, and a hairline cutting the
    // account off from the sections above it boxed a strip that the space
    // already separates (principles, "Hairlines carry the structure").
    <div
      className={`app-no-drag shrink-0 ${
        collapsed ? 'flex flex-col items-center gap-1.5 px-2 py-2' : 'flex items-center gap-1.5 px-2 py-1.5'
      }`}
    >
      {/* On the rail, the update glyph and Usage stand above the account; in
          a row they sit with the gear at the right edge, the account holding
          the left. */}
      {collapsed ? updateButton : null}
      {extensionsButton}
      {collapsed ? usageButton : null}
      {bellSlot}
      {accountInBand ? null : (
        <AccountControl
          authState={authState}
          authMessage={authMessage}
          accountOpen={accountOpen}
          setAccountOpen={setAccountOpen}
          startLogin={startLogin}
          refreshAuthState={refreshAuthState}
          logout={logout}
          remoteRow={remoteRow}
          sessionsRow={sessionsRow}
          accountBadge={accountBadge}
          onRail={collapsed}
        />
      )}
      {collapsed ? (
        settingsButton
      ) : (
        // With the account control now icon-only, the settings gear pins to
        // the row's right edge; the account badge holds the left.
        <div className="ml-auto flex items-center gap-1.5">
          {updateButton}
          {usageButton}
          {settingsButton}
        </div>
      )}
    </div>
  )
}
