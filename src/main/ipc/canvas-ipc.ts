import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'

import type {
  CanvasContinueInput,
  CanvasContinueResult,
  CanvasElement,
  CanvasExportImages,
  CanvasExportResult,
  CanvasResult,
} from '../../shared/canvas/types'
import { canvasFail, canvasOk } from '../../shared/canvas/types'
import { canvasCommitOf, canvasRefOf } from '../../shared/canvas/commit-checks'
import { canvasBoardId, canvasBoardName, parseCanvasBoardId } from '../../shared/canvas/paths'
import { isRecord } from '../../shared/records'
import { emptyScene, serializeSceneFile } from '../../shared/canvas/scene-file'
import type { CanvasFs, CanvasServiceInternal } from '../canvas/canvas-service'
import type { CanvasSubscriberRegistry } from '../canvas/canvas-subscribers'
import { checkCanvasExport, writeCanvasExport } from '../canvas/canvas-export'
import { assertAppSender } from './ipc-sender'

// The Canvas pane's IPC. Seven channels, and every one of them treats its
// payload as input rather than as the shape the preload promises — the preload
// is ours, but the renderer it runs in hosts a lazy-loaded editor and
// third-party module code, and the service behind this writes files into the
// person's project. A caller that spells a path badly gets `invalid_path`; one
// that sends half a megabyte of nothing gets `too_large`; neither reaches disk.

// The checks themselves are in shared/canvas/commit-checks.ts, where a web
// tab's Canvas pane reaches them too.

/**
 * The images an export carries, checked for type only: their size and shape are
 * the service's to judge, and an absent or malformed field is simply not an
 * image the person asked for.
 */
function exportImagesOf(input: unknown): CanvasExportImages {
  if (!isRecord(input)) return {}
  return {
    ...(typeof input.png === 'string' && input.png.length > 0 ? { png: input.png } : {}),
    ...(typeof input.svg === 'string' && input.svg.length > 0 ? { svg: input.svg } : {}),
  }
}

export type CanvasIpcOptions = {
  /**
   * Show the folder picker for an export and answer the folder, or null when
   * the person dismissed it. Injected so the boundary can be tested without a
   * native dialog; absent, an export is refused rather than written anywhere.
   */
  pickExportDirectory?: (sender: WebContents, defaultPath?: string) => Promise<string | null>
  /** Show a board file in the system file manager; absent, reveal answers `forbidden`. */
  revealFile?: (absolutePath: string) => void
  /** Start a chat on a board; absent, "Continue in a new chat" answers `forbidden`. */
  continueInNewChat?: (input: CanvasContinueInput) => Promise<CanvasResult<CanvasContinueResult>>
  /** This machine's disk, where a scene a window holds (a paired chat's board) is exported. */
  exportFs?: CanvasFs
}

/** A request for a chat on a board, checked: strings where strings go, and the id whole. */
function continueInputOf(input: unknown): CanvasResult<CanvasContinueInput> {
  if (!isRecord(input)) return canvasFail('invalid_path', 'This call carried no board.')
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : ''
  if (!workspaceId) return canvasFail('no_workspace', 'This call named no workspace.')
  const id = typeof input.id === 'string' ? parseCanvasBoardId(input.id) : null
  if (!id) return canvasFail('invalid_path', 'This call named no board.')
  if (!id.ok) return id
  return canvasOk({
    workspaceId,
    id: canvasBoardId(id.value.store, id.value.path),
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : canvasBoardName(id.value.path),
    ...(typeof input.boardWorkspaceId === 'string' ? { boardWorkspaceId: input.boardWorkspaceId } : {}),
  })
}

export function registerCanvasIpc(
  ipcMain: IpcMain,
  service: CanvasServiceInternal,
  subscribers: CanvasSubscriberRegistry,
  options: CanvasIpcOptions = {},
): void {
  // A window that closed, reloaded or crashed stops being a subscriber of every
  // board it held, without each board having to notice separately.
  subscribers.onGone((subscriberId) => {
    service.dropSubscriber(subscriberId)
  })

  ipcMain.handle('canvas:list-boards', (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      return canvasFail('no_workspace', 'This call named no workspace.')
    }
    return service.listBoards(workspaceId.trim())
  })

  ipcMain.handle('canvas:list-all-boards', (_event, workspaceId: unknown) =>
    service.listAllBoards(typeof workspaceId === 'string' ? workspaceId : undefined),
  )

  ipcMain.handle(
    'canvas:continue-in-new-chat',
    async (_event: IpcMainInvokeEvent, input: unknown): Promise<CanvasResult<CanvasContinueResult>> => {
      const checked = continueInputOf(input)
      if (!checked.ok) return checked
      if (!options.continueInNewChat) return canvasFail('forbidden', 'A chat cannot be started from this window.')
      return options.continueInNewChat(checked.value)
    },
  )

  ipcMain.handle('canvas:open-board', (event: IpcMainInvokeEvent, input: unknown) => {
    const ref = canvasRefOf(input)
    if (!ref.ok) return ref
    const create = isRecord(input) && input.create === true
    // Opening is what subscribes: the window that asked for the board is the
    // one that gets pushed every accepted write to it until it closes it.
    const subscriberId = subscribers.add(event.sender)
    return service.openBoard(ref.value, { create, subscriberId })
  })

  ipcMain.handle('canvas:close-board', (event: IpcMainInvokeEvent, input: unknown) => {
    const ref = canvasRefOf(input)
    if (!ref.ok) return
    service.closeBoard(ref.value, event.sender.id)
  })

  ipcMain.handle('canvas:commit-scene', (event: IpcMainInvokeEvent, input: unknown) => {
    const commit = canvasCommitOf(input)
    if (!commit.ok) return commit
    // The sender is registered here too: a commit from a window that has not
    // opened the board still has to be excluded from its own echo.
    const subscriberId = subscribers.add(event.sender)
    return service.commitScene(commit.value, subscriberId)
  })

  // The folder comes from the picker main shows, never from the payload: the
  // renderer may suggest where the picker opens, and that is all it may say
  // about where the files land.
  ipcMain.handle(
    'canvas:export-board',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<CanvasResult<CanvasExportResult>> => {
      const ref = canvasRefOf(input)
      if (!ref.ok) return ref
      if (!options.pickExportDirectory) {
        return canvasFail('forbidden', 'Exporting a board is not available in this window.')
      }
      const record = input as Record<string, unknown>
      const defaultPath = typeof record.defaultDirectory === 'string' ? record.defaultDirectory : undefined
      let directory: string | null
      try {
        directory = await options.pickExportDirectory(event.sender, defaultPath)
      } catch (error) {
        return canvasFail(
          'forbidden',
          `The folder picker could not be shown: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!directory) return canvasOk({ cancelled: true })
      const exported = await service.exportBoard(ref.value, directory, exportImagesOf(record.images))
      if (!exported.ok) return exported
      return canvasOk({ cancelled: false, directory: exported.value.directory, files: exported.value.files })
    },
  )

  // Main finds the file and shows it: a store board is in the app's data
  // folder, which the renderer cannot name, and only needs to name its board.
  ipcMain.handle('canvas:reveal-board', (_event: IpcMainInvokeEvent, input: unknown): CanvasResult<void> => {
    const ref = canvasRefOf(input)
    if (!ref.ok) return ref
    if (!options.revealFile) return canvasFail('forbidden', 'Revealing a board is not available in this window.')
    const location = service.boardLocation(ref.value)
    if (!location.ok) return location
    options.revealFile(location.value)
    return canvasOk(undefined)
  })

  // Fire-and-forget by contract: the person has started a gesture, and an
  // answer would only be read after the gesture was over.
  ipcMain.on('canvas:note-human-input', (event: IpcMainEvent, input: unknown) => {
    const ref = canvasRefOf(input)
    if (!ref.ok) return
    service.noteHumanInput(ref.value, event.sender.id)
  })

  registerCanvasExportSceneIpc(ipcMain, options)
}

/**
 * A scene a window holds, written into a folder the person picks here: a
 * paired chat's board, which the window reads of that machine's Studio itself
 * (`pairedCanvas.ts`). The copy is theirs, on this computer's disk.
 */
function registerCanvasExportSceneIpc(ipcMain: IpcMain, options: CanvasIpcOptions): void {
  ipcMain.handle(
    'canvas:export-scene',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<CanvasResult<CanvasExportResult>> => {
      assertAppSender(event)
      const scene = sceneOf(input)
      if (!scene.ok) return scene
      if (!options.pickExportDirectory || !options.exportFs) {
        return canvasFail('forbidden', 'Exporting a board is not available in this window.')
      }
      const images = exportImagesOf(isRecord(input) ? input.images : undefined)
      let directory: string | null
      try {
        directory = await options.pickExportDirectory(event.sender)
      } catch (error) {
        return canvasFail(
          'forbidden',
          `The folder picker could not be shown: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!directory) return canvasOk({ cancelled: true })
      const checked = checkCanvasExport(directory, images)
      if (!checked.ok) return checked
      const exported = await writeCanvasExport(options.exportFs, {
        directory,
        name: scene.value.name,
        text: serializeSceneFile({
          ...emptyScene(),
          elements: scene.value.elements,
          appState: scene.value.appState,
          files: scene.value.files,
        }),
        images,
      })
      if (!exported.ok) return exported
      return canvasOk({ cancelled: false, directory: exported.value.directory, files: exported.value.files })
    },
  )
}

/**
 * A scene a window asks to export, checked as a commit of a board by that
 * name is: a plain board name (no folder, nothing above it) and a scene within
 * a board's limits.
 */
function sceneOf(input: unknown): CanvasResult<{
  name: string
  elements: CanvasElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}> {
  if (!isRecord(input) || typeof input.name !== 'string' || !input.name.trim())
    return canvasFail('invalid_scene', 'This call carried no scene to export.')
  const name = input.name.trim()
  if (/[\\/]/u.test(name) || name === '.' || name === '..')
    return canvasFail('invalid_path', 'A board is exported by its own name, not a path.')
  const checked = canvasCommitOf({ ...input, workspaceId: 'export', path: `${name}.excalidraw` })
  if (!checked.ok) return checked
  return canvasOk({
    name: canvasBoardName(checked.value.path),
    elements: checked.value.elements,
    appState: checked.value.appState,
    files: checked.value.files,
  })
}
