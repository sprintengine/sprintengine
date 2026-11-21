// What modules put in the window's band: a workspace type's view panels, and
// the controls registered with `registerTopBarItem` (the microphone and its
// siblings). Both are public SDK surfaces, so they keep a home when everything
// else leaves the top row. The shell's own controls live on the rail, behind the
// avatar, or on the panel.
//
// The at-rest control groups are capped via `{/* top-bar-group: <name> */}`
// markers asserted by scripts/lint-panel-composition.mjs; keep this file and
// CANONICAL_TOP_BAR_GROUPS (the TopBar inventory) in lockstep.

import React from 'react'
import { CheckIcon, resolveEnabledWorkspaceType } from '../AppIcons'
import {
  MENU_GROUP_LABEL_CLASS,
  MENU_LIST_CLASS,
  MenuItem,
  Popover,
  roveMenuFocus,
  Tooltip,
  TriggerButton,
} from '../ui'
import type { Workspace } from '../../../../shared/workspace'
import { hasComponentTab, toggleComponentTab } from '../../utils/modelRegistry'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import { ModuleContributionBoundary } from '../../modules/ModuleContributionBoundary'
import { copy } from '../../../../shared/copy'

export type BandActionsProps = {
  activeWorkspace: Workspace | null
  workspaceActionsEnabled: boolean | null

  viewMenuRef: React.RefObject<HTMLDivElement | null>
  viewMenuOpen: boolean
  setViewMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  viewMenuTick: number
  setViewMenuTick: React.Dispatch<React.SetStateAction<number>>
  /** The other popovers of the window close as this one opens. */
  onViewMenuOpened: () => void
}

export function BandActions({
  activeWorkspace,
  workspaceActionsEnabled,
  viewMenuRef,
  viewMenuOpen,
  setViewMenuOpen,
  viewMenuTick,
  setViewMenuTick,
  onViewMenuOpened,
}: BandActionsProps) {
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  // A batch of extensions landing or leaving (installed, uninstalled, trust
  // granted or revoked) changes what is enabled without changing the switches.
  const [moduleRegistryGeneration, setModuleRegistryGeneration] = React.useState(0)
  React.useEffect(() => onThirdPartyRendererModulesLoaded(() => setModuleRegistryGeneration((n) => n + 1)), [])
  // Module-contributed top-bar controls, gated on live enablement so a module
  // toggle adds/removes its control without a reload (registry references are
  // stable; the memo recomputes when enablement or the extensions change).
  const moduleTopBarItems = React.useMemo(
    () => getRendererHost().getTopBarItems((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    // moduleRegistryGeneration is the signal, not an input the body reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [moduleOverrides, moduleRegistryGeneration],
  )
  // The active workspace type's top-bar view set, from the registry and gated by
  // module enablement (was VIEWS_FOR_MODE). getWorkspaceType returns a stable
  // reference, so this memo only recomputes when the mode or enablement changes;
  // null means no switcher (most types, or a disabled module).
  const activeWorkspaceViews = React.useMemo(
    () =>
      activeWorkspace
        ? (resolveEnabledWorkspaceType(activeWorkspace.mode, moduleOverrides)?.topBarViews ?? null)
        : null,
    [activeWorkspace, moduleOverrides],
  )
  // The view-panels menu surface, so its rows rove with the arrow keys the way
  // every other menu in the app does (menu/component.md → Accessibility).
  const viewMenuSurfaceRef = React.useRef<HTMLElement | null>(null)
  // Stable identity: `Popover`'s auto-focus effect is keyed on this callback, so
  // an inline arrow function would re-run it on every render and yank the
  // keyboard position back to row 1 while the menu is open (toggling a row bumps
  // `viewMenuTick`, which re-renders). See ui/FilterMenu.tsx for the same shape.
  const focusFirstViewMenuItem = React.useCallback((surface: HTMLElement) => {
    viewMenuSurfaceRef.current = surface
    surface.querySelector<HTMLElement>('[data-menu-item="true"]:not([disabled])')?.focus()
  }, [])
  return (
    <div className="app-no-drag flex shrink-0 items-center gap-1.5">
      {/* top-bar-group: views */}
      {workspaceActionsEnabled && activeWorkspace && activeWorkspaceViews ? (
        /*
         * The trigger condenses to an icon-only 30px square below ~1000px so
         * the band gives way before its tabs are squeezed out at narrow
         * widths; the label and chevron re-appear at
         * >= 1000px. The WIDTH lives here rather than on the control because
         * `TriggerButton` fills its track — one `w-*` on the element, not two
         * for a stylesheet to choose between.
         */
        <div ref={viewMenuRef} className="relative inline-flex w-control-sm min-[1000px]:w-auto">
          <Popover
            open={viewMenuOpen}
            onOpenChange={(next) => {
              setViewMenuOpen(next)
              if (next) {
                setViewMenuTick((tick) => tick + 1)
                onViewMenuOpened()
              }
            }}
            ariaLabel={copy.workspace.bandActions.panels(
              activeWorkspaceViews?.label ?? copy.workspace.bandActions.view,
            )}
            popupRole="menu"
            placement="bottom-end"
            surfaceClassName={`w-60 ${MENU_LIST_CLASS}`}
            onOpenAutoFocus={focusFirstViewMenuItem}
            renderTrigger={({ ref, triggerProps, togglePopover }) => (
              <Tooltip
                content={copy.workspace.bandActions.panels(
                  activeWorkspaceViews?.label ?? copy.workspace.bandActions.view,
                )}
                placement="bottom"
              >
                {/* The kit's popover trigger, ghost: it sits in the workspace
                      bar among ghost icon buttons, so it is a control inside a
                      surface and takes no edge or ground until the pointer
                      arrives (owner ruling 2026-10-04). Open, it holds the
                      neutral `--bg-selected` fill. The tooltip and `aria-label` carry the
                      meaning in the icon-only state. */}
                <TriggerButton
                  ref={ref}
                  variant="ghost"
                  open={viewMenuOpen}
                  onClick={togglePopover}
                  aria-label={copy.workspace.bandActions.toggleWorkspacePanels}
                  {...triggerProps}
                >
                  <svg className="size-icon-xs shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="2" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.4" />
                    <rect x="9" y="2" width="5" height="6" rx="1" stroke="currentColor" strokeWidth="1.4" />
                    <rect x="9" y="10" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                  <span className="hidden text-meta font-semibold min-[1000px]:inline">
                    {activeWorkspaceViews?.label ?? 'View'}
                  </span>
                  <svg
                    className={`hidden icon-xs transition-transform min-[1000px]:block ${viewMenuOpen ? 'rotate-180' : ''}`}
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M5 7.5L10 12.5L15 7.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </TriggerButton>
              </Tooltip>
            )}
          >
            {/* The shared menu rows: `MenuItem` carries the `menuitemcheckbox`
                  role, `aria-checked`, the inset ring and the hover fill, and
                  the surface roves the arrow keys. The tick is a neutral glyph
                  in a fixed leading slot — selection in a menu is the checked
                  state, never an accent-filled box per row. */}
            <div onKeyDown={(event) => roveMenuFocus(event, viewMenuSurfaceRef.current)}>
              <div className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-1`}>
                {activeWorkspaceViews?.label ?? 'View'} panels
              </div>
              {(activeWorkspaceViews?.views ?? []).map((view) => {
                void viewMenuTick
                const checked = hasComponentTab(activeWorkspace.id, view.component)
                return (
                  <MenuItem
                    key={view.component}
                    checked={checked}
                    onClick={() => {
                      toggleComponentTab(activeWorkspace.id, view.component, view.name)
                      setViewMenuTick((tick) => tick + 1)
                    }}
                    icon={<CheckIcon className={`icon-xs shrink-0 ${checked ? '' : 'invisible'}`} />}
                  >
                    {view.name}
                  </MenuItem>
                )
              })}
            </div>
          </Popover>
        </div>
      ) : null}

      {/* top-bar-group: module-items */}
      {/* Module-contributed top-bar controls (registerTopBarItem): the mic
       * button and its siblings. Enablement-filtered above, so a module toggle
       * adds/removes its control live. A control that crashes drops out of
       * the bar rather than taking the bar with it. */}
      {moduleTopBarItems.map((item) => (
        <ModuleContributionBoundary
          key={item.id}
          moduleId={item.moduleId}
          surface={`top-bar item "${item.id}"`}
          variant="inline"
        >
          <React.Suspense fallback={null}>
            <item.Component />
          </React.Suspense>
        </ModuleContributionBoundary>
      ))}
    </div>
  )
}
