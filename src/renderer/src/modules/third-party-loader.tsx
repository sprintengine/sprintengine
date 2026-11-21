import type { ExtensionCommandContext, ExtensionMount } from '../../../../packages/extension-sdk/src/index'
import type { CapabilityManifest, ThirdPartyRendererEntriesResult } from '../../../shared/modules/manifest'
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

// Loads the window half of each trusted extension the Studio serves
// (src/main/modules/third-party-renderer-entries.ts) and puts what its
// extension.json declares where the shell draws it:
//
// - panels, doors and settings sections are drawn by the `mount` their
//   `entry` exports, inside a root the shell owns (ExtensionSurfaceMount);
// - commands join the palette; one with an `action` runs that Studio
//   command, one without calls the worker method of its id;
// - menus add items to the backlog-item, file and notification menus, each
//   running one of the extension's commands with what it was picked on;
// - top bar items run a command or open a door.
//
// The extension registers nothing itself: the shell registers on its behalf,
// under its install key, through the same scoped host the app's own modules
// use, so enablement gates every contribution the same way. Trust was decided
// on the server; this loader evaluates and isolates. A broken extension
// records an error shown in Settings → Extensions and never takes down the
// window or its neighbours.

export type ThirdPartyRendererLoadState = { status: 'loaded' } | { status: 'error'; message: string }

const LOAD_FAILURE_FALLBACK = 'The extension’s window code failed to load.'

// Each key is evaluated at most once per window session. An extension added
// after install and trust can load live; an update, or a failed evaluation,
// needs the window reloaded.
const loadStates = new Map<string, ThirdPartyRendererLoadState>()

export function getThirdPartyRendererLoadState(moduleId: string): ThirdPartyRendererLoadState | undefined {
  return loadStates.get(moduleId)
}

// What each loaded extension was served as, so one served again unchanged
// after it was retired can come back without evaluating its code twice.
const loadedSignatures = new Map<string, string>()

type Retired = { manifest: CapabilityManifest; surfaces: LoadedExtensionSurface[]; signature: string }
const retired = new Map<string, Retired>()

function servedSignature(entry: ThirdPartyRendererEntriesResult['entries'][number]): string {
  return JSON.stringify([entry.extension, entry.entries])
}

/**
 * The loaded extensions as the Studio serves them now. One it no longer
 * serves (uninstalled, or no longer trusted) leaves the enablement universe and
 * takes its surfaces with it, so nothing of it is offered or drawn and an
 * open surface unmounts; its registrations stay with the shell, gated off by
 * that absence, whatever the person's switch said. One served again exactly
 * as it was comes back; a changed one waits for the window to reload.
 */
export function reconcileThirdPartyRendererEntries(
  loaded: readonly CapabilityManifest[],
  served: ThirdPartyRendererEntriesResult,
): CapabilityManifest[] {
  const servedById = new Map(served.entries.map((entry) => [entry.id, entry]))
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

export type ThirdPartyEntryImporter = (code: string) => Promise<unknown>

// The code arrives over the Studio protocol and is evaluated by a dynamic
// import of a blob URL: no file:// or custom-protocol exposure of the
// extension's folder. Each bundle is self-contained; Studio shares neither
// React nor its UI kit with it.
const importEntryBundle: ThirdPartyEntryImporter = async (code) => {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function recordError(id: string, message: string): void {
  loadStates.set(id, { status: 'error', message: sanitizeEntryMessage(message, LOAD_FAILURE_FALLBACK) })
}

/**
 * The extensions a live refresh may add: ones this window has not evaluated,
 * and without a worker, whose methods the server loads only at its next start.
 */
export function rendererEntriesForRefresh(served: ThirdPartyRendererEntriesResult): ThirdPartyRendererEntriesResult {
  return {
    entries: served.entries.filter((entry) => entry.extension.tier !== 'worker' && !loadStates.has(entry.id)),
    failures: Object.fromEntries(Object.entries(served.failures).filter(([id]) => !loadStates.has(id))),
  }
}

/** Run one of an extension's commands, as the palette, a menu or the top bar does. */
async function runExtensionCommand(
  host: InternalRendererHost,
  command: ExtensionCommandContribution,
  context: ExtensionCommandContext,
): Promise<void> {
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
  mounts: ReadonlyMap<string, ExtensionMount>,
): void {
  const { contributes } = extension
  for (const point of EXTENSION_SURFACE_POINTS) {
    for (const contribution of contributes[point]) {
      registerExtensionSurface({ key, point, contribution, mount: mounts.get(contribution.entry)!, host })
    }
  }
  for (const door of contributes.doors) {
    host.registerGlobalSurface({
      id: extensionSurfaceId(key, door.id),
      label: door.title,
      Icon: extensionGlyph(door.icon),
      Component: function ExtensionDoor() {
        return <ExtensionSurfaceMount extensionKey={key} point="doors" id={door.id} />
      },
    })
  }
  contributes.settingsSections.forEach((section, index) => {
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
        runExtensionCommand(host, command, { where: 'palette', workspaceId: context?.activeWorkspaceId ?? null }),
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
          runExtensionCommand(host, command, {
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
          runExtensionCommand(host, command, {
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
            runExtensionCommand(host, command, {
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
        void runExtensionCommand(host, command, { where: 'topBar', workspaceId: host.getActiveWorkspaceId() })
      } else if (item.door) {
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

// Evaluates every served extension's entries and registers its contributions.
// Returns the manifests of the extensions that loaded cleanly: only those join
// the enablement universe, so one that failed halfway is gated off everywhere
// instead of surfacing half its contributions.
export async function loadThirdPartyRendererEntries(
  kernel: RendererKernel,
  served: ThirdPartyRendererEntriesResult,
  importEntry: ThirdPartyEntryImporter = importEntryBundle,
): Promise<CapabilityManifest[]> {
  for (const [id, message] of Object.entries(served.failures)) recordError(id, message)

  const loaded: CapabilityManifest[] = []
  for (const entry of served.entries) {
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
    const extension = entry.extension as ExtensionManifest
    try {
      const mounts = new Map<string, ExtensionMount>()
      for (const [path, code] of Object.entries(entry.entries)) {
        const exports = (await importEntry(code)) as { mount?: unknown } | null
        if (typeof exports?.mount !== 'function') throw new Error(`${path} must export mount(root, studio).`)
        mounts.set(path, exports.mount as ExtensionMount)
      }
      for (const point of EXTENSION_SURFACE_POINTS) {
        for (const surface of extension.contributes[point]) {
          if (!mounts.has(surface.entry)) throw new Error(`${surface.entry} was not served.`)
        }
      }
      if (entry.assetOrigin) kernel.setModuleAssetOrigin(entry.id, entry.assetOrigin)
      registerContributions(kernel.hostFor(entry.id, entry.manifest), entry.id, extension, mounts)
      loadStates.set(entry.id, { status: 'loaded' })
      loadedSignatures.set(entry.id, servedSignature(entry))
      loaded.push(entry.manifest)
    } catch (error) {
      recordError(entry.id, error instanceof Error ? error.message : String(error))
    }
  }
  return loaded
}
