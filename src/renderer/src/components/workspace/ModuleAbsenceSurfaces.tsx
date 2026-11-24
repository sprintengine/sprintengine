import { ACTIVE_RENDERER_MODULE_MANIFESTS, COMING_SOON_MODULE_MANIFESTS } from '../../modules'
import { EmptyState, PrimaryButton } from '../ui'
import { copy as appCopy } from '../../../../shared/copy'

// Explicit absence surfaces for module-owned UI. A workspace whose
// mode's module is not installed — fresh machine, uninstalled — must render a
// labeled state with a way to the extensions, never a blank pane or a grid of
// dead tabs. Data-safe by construction: nothing here
// mutates the workspace; installing the module renders it again.

// Last-known display label for a mode with no registered workspace type: the
// bundled-but-inactive (dev-only) manifests still know their names; anything
// else (an extension) falls back to the capitalized mode id.
export function moduleLabelForMode(mode: string): string {
  const comingSoon = COMING_SOON_MODULE_MANIFESTS.find((manifest) => manifest.id === mode)
  if (comingSoon) return comingSoon.displayName
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

/**
 * The display name of a module that IS on the machine, by id.
 *
 * Used by the turned-off surface, which reaches it through the registered
 * workspace type (`RegisteredWorkspaceTypeDefinition.moduleId`) rather than the
 * mode string: a module's id and the workspace-type id it registers need not
 * match, so capitalizing the mode would name the wrong thing. Falls back to the id when no manifest knows it, which is the
 * third-party case before its manifest is read.
 */
export function moduleLabelForModuleId(moduleId: string): string {
  const active = ACTIVE_RENDERER_MODULE_MANIFESTS.find((manifest) => manifest.id === moduleId)
  if (active) return active.displayName
  const comingSoon = COMING_SOON_MODULE_MANIFESTS.find((manifest) => manifest.id === moduleId)
  if (comingSoon) return comingSoon.displayName
  return moduleId
}

/**
 * Whether a workspace's mode can be rendered at all, and if not, why.
 *
 * Absence is a surface, never a blank (epic rule). Two ways a module-owned
 * workspace stops being renderable, and the copy differs because the remedy
 * does:
 *
 *  - `not-installed` — nothing registered this mode. A fresh machine, an
 *    uninstalled module, or a marketplace module whose install has not landed.
 *    The mode string is all there is to name it by.
 *  - `disabled` — the type IS registered and its owning module is switched off
 *    in Settings → Extensions. This is where a persisted workspace of a
 *    module-registered type lands: without this answer the layout mounts and every module-owned tab paints
 *    its own dead placeholder, which is the grid of blanks the rule exists to
 *    prevent. The module is on the machine, so the remedy is a toggle.
 *
 * `standard` is the shell's own mode, so it can never be absent.
 *
 * Pure and dependency-injected so the rule is asserted without a renderer host.
 */
export type WorkspaceModuleAbsence =
  { kind: 'not-installed'; label: string } | { kind: 'disabled'; label: string; moduleId: string } | null

export function workspaceModuleAbsence(
  mode: string,
  deps: {
    /** The module that registered this workspace type, or undefined when none did. */
    workspaceTypeModuleId: (mode: string) => string | undefined
    isModuleEnabled: (moduleId: string) => boolean
  },
): WorkspaceModuleAbsence {
  if (mode === 'standard') return null
  const moduleId = deps.workspaceTypeModuleId(mode)
  if (!moduleId) return { kind: 'not-installed', label: moduleLabelForMode(mode) }
  if (deps.isModuleEnabled(moduleId)) return null
  return { kind: 'disabled', label: moduleLabelForModuleId(moduleId), moduleId }
}

export function ModuleNotInstalledSurface({
  label,
  installed = false,
  actionLabel = 'Find it in Plugins',
  onOpenMarketplace,
}: {
  label: string
  /** True when the module is on the machine but disabled — the copy stays honest. */
  installed?: boolean
  /**
   * What the one action says. Defaults to the marketplace signpost; a caller
   * that routes somewhere else (a turned-off module goes to its settings, not
   * to a storefront that would offer to reinstall what is already there) names
   * that destination instead.
   */
  actionLabel?: string
  onOpenMarketplace: () => void
}) {
  // The kit's empty state: this and the door surface below
  // were their own dialect — `text-meta` title, `text-micro` body, and one of
  // them painting `bg-app` while the other painted nothing. The wrapper keeps
  // the `role="note"` labelling, which is this surface's own contract.
  return (
    <div
      role="note"
      aria-label={appCopy.workspace.moduleAbsenceSurfaces.moduleNotInstalled}
      className="h-full bg-[color:var(--bg-app)]"
    >
      <EmptyState
        title={
          installed
            ? appCopy.workspace.moduleAbsenceSurfaces.isTurnedOff(label)
            : appCopy.workspace.moduleAbsenceSurfaces.isnTInstalled(label)
        }
        body={
          installed
            ? appCopy.workspace.moduleAbsenceSurfaces.thisWorkspaceNeedsTheModule(label)
            : appCopy.workspace.moduleAbsenceSurfaces.thisWorkspaceNeedsTheModule2(label)
        }
        action={
          <PrimaryButton size="sm" onClick={onOpenMarketplace}>
            {actionLabel}
          </PrimaryButton>
        }
      />
    </div>
  )
}

// A top-level door whose owning module is absent: the persisted
// `activeGlobalSurface` id names a surface that never registered (module not
// installed) or whose module is disabled. Same rule as the workspace surface
// above — a labeled state with a way to the extensions, never a blank pane — and the
// persisted id is never cleared: reinstalling lands the user back on this door.
export function DoorModuleNotInstalledSurface({
  label,
  installed = false,
  onOpenExtensions,
}: {
  label: string
  /** True when the module is on the machine but disabled — the copy stays honest. */
  installed?: boolean
  onOpenExtensions: () => void
}) {
  return (
    <div role="note" aria-label={appCopy.workspace.moduleAbsenceSurfaces.doorModuleNotInstalled} className="h-full">
      <EmptyState
        title={label}
        body={
          installed
            ? appCopy.workspace.moduleAbsenceSurfaces.theModuleIsTurnedOff(label)
            : appCopy.workspace.moduleAbsenceSurfaces.theModuleIsnTInstalled(label)
        }
        action={
          <PrimaryButton size="sm" onClick={onOpenExtensions}>
            {appCopy.workspace.moduleAbsenceSurfaces.findItInPlugins}
          </PrimaryButton>
        }
      />
    </div>
  )
}
