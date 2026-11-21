import type { ExtensionCommandContext } from '../../../../packages/extension-sdk/src/index'
import type { CapabilityManifest, ExtensionContributionsResult } from '../../../shared/modules/manifest'
import { sanitizeEntryMessage } from '../../../shared/modules/entry-messages'
import { extensionSurfaceId } from '../../../shared/modules/extension-ids'
import {
  EXTENSION_SURFACE_POINTS,
  type ExtensionCommandContribution,
  type ExtensionManifest,
} from '../../../shared/modules/third-party-manifest'
import { runAppCommand } from '../commands/appCommandRunner'
import { ExtensionSurfaceMount } from '../components/extensions/ExtensionSurfaceMount'
import { IconButton, Tooltip } from '../components/ui'
import { extensionGlyph } from './extension-glyphs'
import { registerExtensionSurface, retireExtensionSurfaces, type LoadedExtensionSurface } from './extension-surfaces'
import type { InternalRendererHost, RendererKernel } from './renderer-host'

// Puts what each approved extension's extension.json declares where the
// shell draws it, from the Studio's `extension.contributions`. No extension
// code runs in the window:
//
// - panels, doors and settings sections are drawn in a sandboxed frame each,
//   from a document the Studio builds (ExtensionSurfaceMount, ExtensionFrame);
//   they are offered only where the Studio draws frames (`extension-frames`);
// - commands join the palette; one with an `action` runs that Studio
//   command, one without calls the worker method of its id;
// - menus add items to the backlog-item, file and notification menus, each
//   running one of the extension's commands with what it was picked on;
// - top bar items run a command or open a door.
//
// The shell registers on the extension's behalf, under its install key,
// through the same scoped host the app's own modules use, so enablement gates
// every contribution the same way. Approval was decided on the server. A
// broken extension records an error shown in Settings → Extensions and never
// takes down the window or its neighbours.

export type ExtensionContributionsState = { status: 'loaded' } | { status: 'error'; message: string }

const LOAD_FAILURE_FALLBACK = 'The extension’s contributions could not be added.'

// Each key is registered at most once per window session. An extension added
// after install and approval joins live; an update needs the window reloaded.
const loadStates = new Map<string, ExtensionContributionsState>()

export function getExtensionContributionsState(moduleId: string): ExtensionContributionsState | undefined {
  return loadStates.get(moduleId)
}

// What each registered extension was served as, so one served again unchanged
// after it was retired can come back without registering it twice.
const loadedSignatures = new Map<string, string>()

type Retired = { manifest: CapabilityManifest; surfaces: LoadedExtensionSurface[]; signature: string }
const retired = new Map<string, Retired>()

function servedSignature(entry: ExtensionContributionsResult['extensions'][number]): string {
  return JSON.stringify(entry.extension)
}

/**
 * The registered extensions as the Studio serves them now. One it no longer
 * serves (uninstalled, or no longer approved) leaves the enablement universe and
 * takes its surfaces with it, so nothing of it is offered or drawn and an
 * open frame closes; its registrations stay with the shell, gated off by that
 * absence, whatever the person's switch said. One served again exactly as it
 * was comes back; a changed one waits for the window to reload.
 */
export function reconcileExtensionContributions(
  loaded: readonly CapabilityManifest[],
  served: ExtensionContributionsResult,
): CapabilityManifest[] {
  const servedById = new Map(served.extensions.map((entry) => [entry.id, entry]))
  const kept: CapabilityManifest[] = []
  for (const manifest of loaded) {
    if (servedById.has(manifest.id)) {
      kept.push(manifest)
      continue
    }
    retired.set(manifest.id, {
      manifest,
      surfaces: retireExtensionSurfaces(manifest.id),
      signature: loadedSignatures.get(manifest.id) ?? '',
    })
  }
  for (const [id, entry] of servedById) {
    const previous = retired.get(id)
    if (!previous || previous.signature !== servedSignature(entry)) continue
    retired.delete(id)
    for (const surface of previous.surfaces) registerExtensionSurface(surface)
    kept.push(previous.manifest)
  }
  return kept
}

function recordError(id: string, message: string): void {
  loadStates.set(id, { status: 'error', message: sanitizeEntryMessage(message, LOAD_FAILURE_FALLBACK) })
}

/**
 * The extensions a live refresh may add: ones this window has not registered,
 * and without a worker, whose methods the server loads only at its next start.
 */
export function contributionsForRefresh(served: ExtensionContributionsResult): ExtensionContributionsResult {
  return {
    extensions: served.extensions.filter((entry) => entry.extension.tier !== 'worker' && !loadStates.has(entry.id)),
    failures: Object.fromEntries(Object.entries(served.failures).filter(([id]) => !loadStates.has(id))),
  }
}

/** Run one of an extension's commands, as the palette, a menu or the top bar does. */
async function runExtensionCommand(
  host: InternalRendererHost,
  live: () => boolean,
  command: ExtensionCommandContribution,
  context: ExtensionCommandContext,
): Promise<void> {
  // Checked at the moment it runs, not only when the button or row was drawn:
  // an extension switched off, uninstalled or no longer trusted runs nothing.
  if (!live()) return
  if (command.action) {
    if (!runAppCommand(command.action)) host.toast({ tone: 'warn', message: `${command.title} is not available here.` })
    return
  }
  const answer = await host.methods().operate(command.id, context)
  if (!answer.ok) host.toast({ tone: 'error', message: `${command.title} did not run.`, detail: answer.message })
}

function relativeTo(root: string, path: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, '')
  return path.startsWith(`${normalizedRoot}/`) || path.startsWith(`${normalizedRoot}\\`)
    ? path.slice(normalizedRoot.length + 1).replaceAll('\\', '/')
    : path
}

/** Register everything the manifest declares through the extension's scoped host. */
function registerContributions(
  host: InternalRendererHost,
  key: string,
  extension: ExtensionManifest,
  isEnabled: (moduleId: string) => boolean,
  drawsFrames: boolean,
): void {
  const { contributes } = extension
  const live = () => !retired.has(key) && isEnabled(key)
  // Surfaces only where the Studio draws them in frames.
  const surfaces = drawsFrames ? contributes : { ...contributes, panels: [], doors: [], settingsSections: [] }
  for (const point of EXTENSION_SURFACE_POINTS) {
    for (const contribution of surfaces[point]) {
      registerExtensionSurface({ key, point, contribution, host })
    }
  }
  for (const door of surfaces.doors) {
    host.registerGlobalSurface({
      id: extensionSurfaceId(key, door.id),
      label: door.title,
      Icon: extensionGlyph(door.icon),
      Component: function ExtensionDoor() {
        return <ExtensionSurfaceMount extensionKey={key} point="doors" id={door.id} />
      },
    })
  }
  surfaces.settingsSections.forEach((section, index) => {
    host.registerSettingsSection({
      id: extensionSurfaceId(key, section.id),
      label: section.title,
      description: extension.name,
      icon: extensionGlyph(section.icon),
      order: index,
      Component: function ExtensionSettingsSection() {
        return <ExtensionSurfaceMount extensionKey={key} point="settingsSections" id={section.id} />
      },
    })
  })
  const commands = new Map(contributes.commands.map((command) => [command.id, command]))
  for (const command of contributes.commands) {
    host.registerCommand({
      id: command.id,
      title: command.title,
      category: extension.name,
      scopes: ['global'],
      ...(command.when === 'workspace' ? { availability: ['activeWorkspace'] as const } : {}),
      run: (context) =>
        runExtensionCommand(host, live, command, { where: 'palette', workspaceId: context?.activeWorkspaceId ?? null }),
    })
  }
  for (const menu of contributes.menus) {
    const command = commands.get(menu.command)!
    if (menu.where === 'backlog.item') {
      host.registerBacklogItemAction({
        id: extensionSurfaceId(key, command.id),
        label: command.title,
        category: 'execute',
        run: (context) =>
          runExtensionCommand(host, live, command, {
            where: 'backlog.item',
            workspaceId: context.workspaceId,
            backlogItemIds: context.selection ? context.selection.items.map((item) => item.id) : [context.item.id],
          }),
      })
    } else if (menu.where === 'file') {
      host.registerFileAction({
        id: extensionSurfaceId(key, command.id),
        label: command.title,
        run: (context) =>
          runExtensionCommand(host, live, command, {
            where: 'file',
            workspaceId: context.workspaceId,
            filePaths: context.entries.map((entry) => relativeTo(context.workspaceRoot, entry.path)),
          }),
      })
    }
  }
  const notificationCommands = contributes.menus
    .filter((menu) => menu.where === 'notification')
    .map((menu) => commands.get(menu.command)!)
  if (notificationCommands.length > 0) {
    host.registerNotificationActionProvider({
      source: key,
      resolveActions: ({ notification }) =>
        notificationCommands.map((command) => ({
          id: command.id,
          label: command.title,
          run: () =>
            runExtensionCommand(host, live, command, {
              where: 'notification',
              workspaceId: notification.workspaceId ?? null,
              notification: {
                title: notification.title ?? '',
                ...(notification.message ? { body: notification.message } : {}),
                emittedAt: Date.parse(notification.timestamp) || 0,
              },
            }),
        })),
    })
  }
  contributes.topBarItems.forEach((item, index) => {
    const Glyph = extensionGlyph(item.icon)
    const command = item.command ? commands.get(item.command) : undefined
    const press = () => {
      if (command) {
        void runExtensionCommand(host, live, command, { where: 'topBar', workspaceId: host.getActiveWorkspaceId() })
      } else if (item.door && drawsFrames && live()) {
        host.openGlobalSurface(extensionSurfaceId(key, item.door))
      }
    }
    host.registerTopBarItem({
      id: extensionSurfaceId(key, item.id),
      order: index,
      Component: function ExtensionTopBarItem() {
        return (
          <Tooltip content={item.title} placement="bottom">
            <IconButton aria-label={item.title} onClick={press} className="app-no-drag">
              <Glyph className="icon-sm" />
            </IconButton>
          </Tooltip>
        )
      },
    })
  })
}

// Registers what every served extension declares. Returns the manifests of the
// extensions registered cleanly: only those join the enablement universe, so
// one that failed halfway is gated off everywhere instead of surfacing half
// its contributions.
export function loadExtensionContributions(
  kernel: RendererKernel,
  served: ExtensionContributionsResult,
  drawsFrames: boolean,
): CapabilityManifest[] {
  for (const [id, message] of Object.entries(served.failures)) recordError(id, message)

  const loaded: CapabilityManifest[] = []
  for (const entry of served.extensions) {
    if (entry.manifest.id !== entry.id) {
      recordError(entry.id, 'The served extension does not match its install key.')
      continue
    }
    // The server keys extensions by folder, so a duplicate should never
    // arrive; keep the first without clobbering its recorded state.
    if (loadStates.has(entry.id)) {
      console.warn(`[extensions] duplicate extension "${entry.id}"; ignoring the later one.`)
      continue
    }
    try {
      registerContributions(
        kernel.hostFor(entry.id, entry.manifest),
        entry.id,
        entry.extension as ExtensionManifest,
        (id) => kernel.isModuleEnabled(id),
        drawsFrames,
      )
      loadStates.set(entry.id, { status: 'loaded' })
      loadedSignatures.set(entry.id, servedSignature(entry))
      loaded.push(entry.manifest)
    } catch (error) {
      recordError(entry.id, error instanceof Error ? error.message : String(error))
    }
  }
  return loaded
}
