import type { ExtensionCommandContext } from '../../../../packages/extension-sdk/src/index'
import type { CapabilityManifest, ExtensionContributionsResult } from '../../../shared/modules/manifest'
import { sanitizeEntryMessage } from '../../../shared/modules/entry-messages'
import { extensionSurfaceId } from '../../../shared/modules/extension-ids'
import {
  EXTENSION_SURFACE_POINTS,
  type ExtensionCommandContribution,
  type ExtensionKeybindingContribution,
  type ExtensionManifest,
} from '../../../shared/modules/third-party-manifest'
import { runAppCommand } from '../commands/appCommandRunner'
import { COMMAND_REGISTRY, getCommandDefinition } from '../commands/commandRegistry'
import { normalizeKeybinding } from '../commands/keybindings'
import { keybindingProblem } from '../../../../packages/extension-sdk/src/extension-manifest'
import { ExtensionSettingsForm } from '../components/extensions/ExtensionSettingsForm'
import { ExtensionSurfaceMount } from '../components/extensions/ExtensionSurfaceMount'
import { GhostButton, IconButton, Tooltip } from '../components/ui'
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
// - custom editors are frames too, which open the files they name in the
//   editor (EditorPanel, ExtensionEditorView), only where the Studio also
//   offers `extension-editors`;
// - commands join the palette; one with an `action` runs that Studio
//   command, one without calls the worker method of its id;
// - menus add items to the backlog-item, file and notification menus, each
//   running one of the extension's commands with what it was picked on;
// - top bar items run a command or open a door;
// - keybindings bind a key to one of its commands, or to one of Studio's own
//   (a content extension binds Studio's without any code), joining Settings ▸
//   Shortcuts like Studio's, where they can be changed or removed;
// - status bar items show a short label, and run a command when pressed;
// - declared settings are drawn by Studio itself, as a section in Settings.
//
// Its syntaxes are registered apart from these (lib/highlight/
// contributedSyntaxes.ts), as data the window's languages read.
//
// The shell registers on the extension's behalf, under its install key,
// through the same scoped host the app's own modules use, so enablement gates
// every contribution the same way. Approval was decided on the server. A
// broken extension records an error shown in Settings → Extensions and never
// takes down the window or its neighbours.

export type ExtensionContributionsState = { status: 'loaded' } | { status: 'error'; message: string }

const LOAD_FAILURE_FALLBACK = 'The extension’s contributions could not be added.'

// Each key is registered once per version it is served at. An extension added
// after install and approval joins live, and one served changed (its
// extension.json, or its files: a development folder's save, an update) is
// taken out and registered again, so its open surfaces draw again.
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
  return JSON.stringify([entry.extension, entry.revision ?? null])
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
 * Take out each registered extension the Studio now serves changed, so the
 * refresh registers it again as it is: `forget` drops what it registered with
 * the window's kernel. Returns their ids.
 */
export function forgetChangedExtensions(
  served: ExtensionContributionsResult,
  forget: (moduleId: string) => void,
): string[] {
  const changed: string[] = []
  for (const entry of served.extensions) {
    if (!loadStates.has(entry.id)) continue
    const previous = retired.get(entry.id)?.signature ?? loadedSignatures.get(entry.id)
    if (previous === servedSignature(entry)) continue
    retired.delete(entry.id)
    retireExtensionSurfaces(entry.id)
    forget(entry.id)
    loadStates.delete(entry.id)
    loadedSignatures.delete(entry.id)
    changed.push(entry.id)
  }
  return changed
}

/** The extensions a live refresh may add: ones this window has not registered (or has just taken out). */
export function contributionsForRefresh(served: ExtensionContributionsResult): ExtensionContributionsResult {
  return {
    extensions: served.extensions.filter((entry) => !loadStates.has(entry.id)),
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

// Chords Studio's own shortcuts use: an extension's binding on one would
// never fire, so it is not made.
let studioChords: Set<string> | null = null
function studioDefaultChords(): Set<string> {
  studioChords ??= new Set(
    COMMAND_REGISTRY.flatMap((command) => command.defaultKeybindings ?? []).flatMap((chord) => {
      const normalized = normalizeKeybinding(chord)
      return normalized ? [normalized] : []
    }),
  )
  return studioChords
}

type KeybindingPlan = {
  /** Keys that join one of the extension's own commands as they are. */
  ownKeys: Map<string, string[]>
  /** Commands that carry a binding of their own: a Studio action's, or one whose `when` differs. */
  wrappers: Array<{ id: string; command: string; workspace: boolean; keys: string[] }>
}

/**
 * Where each keybinding goes. A binding keeps its own `when`: on an own
 * command whose condition matches, its key joins that command; otherwise it
 * gets a command of its own per target and condition. A key the system or
 * the browser keeps, or one Studio's shortcuts use, is not bound (the SDK
 * refuses the first at install; a folder edited since is held to it here).
 */
export function planKeybindings(
  bindings: readonly ExtensionKeybindingContribution[],
  commands: ReadonlyMap<string, ExtensionCommandContribution>,
  extensionKey: string,
): KeybindingPlan {
  const ownKeys = new Map<string, string[]>()
  const wrappers = new Map<string, KeybindingPlan['wrappers'][number]>()
  for (const binding of bindings) {
    const problem = keybindingProblem(binding.key)
    const chord = normalizeKeybinding(binding.key)
    if (problem || !chord || studioDefaultChords().has(chord)) {
      console.warn(
        `[extensions] ${extensionKey}: ${binding.key} is not bound: ${problem ?? 'Studio’s own shortcuts use it.'}`,
      )
      continue
    }
    const own = commands.get(binding.command)
    const workspace = binding.when === 'workspace' || own?.when === 'workspace'
    if (own && workspace === (own.when === 'workspace')) {
      ownKeys.set(own.id, [...(ownKeys.get(own.id) ?? []), binding.key])
      continue
    }
    const id = `${own ? 'command' : 'studio-action'}:${binding.command}${workspace ? ':workspace' : ''}`
    const wrapper = wrappers.get(id) ?? { id, command: binding.command, workspace, keys: [] }
    wrapper.keys.push(binding.key)
    wrappers.set(id, wrapper)
  }
  return { ownKeys, wrappers: [...wrappers.values()] }
}

/** Run one of Studio's own commands for an extension that bound it, while the extension is live. */
function runStudioAction(host: InternalRendererHost, live: () => boolean, action: string, title: string): void {
  if (!live()) return
  if (!runAppCommand(action)) host.toast({ tone: 'warn', message: `${title} is not available here.` })
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
  drawsEditors: boolean,
): void {
  const { contributes } = extension
  const live = () => !retired.has(key) && isEnabled(key)
  // Surfaces only where the Studio draws them in frames, and custom editors
  // only where it also opens files in them; elsewhere a file opens in the
  // text editor.
  const surfaces = drawsFrames
    ? { ...contributes, customEditors: drawsEditors ? contributes.customEditors : [] }
    : { ...contributes, panels: [], doors: [], settingsSections: [], customEditors: [] }
  for (const point of EXTENSION_SURFACE_POINTS) {
    for (const contribution of surfaces[point]) {
      registerExtensionSurface({
        key,
        point,
        contribution,
        host,
        live,
        extension: { name: extension.name, permissions: extension.permissions },
      })
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
  const plan = planKeybindings(contributes.keybindings, commands, key)
  for (const command of contributes.commands) {
    const keys = plan.ownKeys.get(command.id)
    host.registerCommand({
      id: command.id,
      title: command.title,
      category: extension.name,
      scopes: ['global'],
      ...(keys ? { defaultKeybindings: keys } : {}),
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
  // A key whose condition is not its command's own, or bound to one of
  // Studio's commands: a command of the extension's that runs it, titled as
  // it, one per command and condition, so each binding keeps its own `when`.
  // It is listed under the extension in the palette and in Settings ▸
  // Shortcuts, where the person can change or remove its key without touching
  // Studio's own. Its id holds a colon, which no command of an extension's can.
  for (const wrapper of plan.wrappers) {
    const own = commands.get(wrapper.command)
    const title = own?.title ?? getCommandDefinition(wrapper.command)?.title ?? wrapper.command
    host.registerCommand({
      id: wrapper.id,
      title,
      category: extension.name,
      scopes: ['global'],
      defaultKeybindings: wrapper.keys,
      ...(wrapper.workspace ? { availability: ['activeWorkspace'] as const } : {}),
      run: (context) =>
        own
          ? runExtensionCommand(host, live, own, { where: 'palette', workspaceId: context?.activeWorkspaceId ?? null })
          : runStudioAction(host, live, wrapper.command, title),
    })
  }
  // A status bar item's command: one of the extension's own, or Studio's.
  const runFromStatusBar = (command: string) => {
    const own = commands.get(command)
    if (own) {
      void runExtensionCommand(host, live, own, { where: 'topBar', workspaceId: host.getActiveWorkspaceId() })
      return
    }
    runStudioAction(host, live, command, getCommandDefinition(command)?.title ?? command)
  }
  contributes.statusBarItems.forEach((item, index) => {
    const Glyph = item.icon ? extensionGlyph(item.icon) : null
    // Always the extension's name, whatever the author's words, so an item
    // never passes for one of Studio's own.
    const tooltip = item.tooltip ? `${item.tooltip}, from ${extension.name}` : extension.name
    const label = (
      <>
        {Glyph ? <Glyph className="icon-sm" /> : null}
        {item.text ? <span className="truncate">{item.text}</span> : null}
      </>
    )
    host.registerTopBarItem({
      id: extensionSurfaceId(key, `status.${item.id}`),
      // After the extension's buttons: a status reads after the controls.
      order: 100 + index,
      Component: function ExtensionStatusBarItem() {
        const command = item.command
        return (
          <Tooltip content={tooltip} placement="bottom">
            {command ? (
              <GhostButton
                size="sm"
                className="app-no-drag max-w-48 gap-1"
                aria-label={item.text ? `${item.text}, ${tooltip}` : tooltip}
                onClick={() => runFromStatusBar(command)}
              >
                {label}
              </GhostButton>
            ) : (
              <span
                role="status"
                aria-label={item.text ? `${item.text}, ${tooltip}` : tooltip}
                className="app-no-drag inline-flex h-control-sm max-w-48 items-center gap-1 px-2 text-body text-[color:var(--text-muted)]"
              >
                {label}
              </span>
            )}
          </Tooltip>
        )
      },
    })
  })
  if (contributes.settings.length > 0) {
    const declared = contributes.settings
    host.registerSettingsSection({
      id: extensionSurfaceId(key, 'settings'),
      label: extension.name,
      description: 'Settings it declares',
      icon: extensionGlyph('settings'),
      order: surfaces.settingsSections.length,
      Component: function ExtensionDeclaredSettings() {
        return <ExtensionSettingsForm extensionKey={key} settings={declared} />
      },
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
  drawsEditors = drawsFrames,
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
        drawsEditors,
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
