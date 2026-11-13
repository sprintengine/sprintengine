import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'

import type {
  CanvasContinueInput,
  CanvasContinueResult,
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
import type { PeerCanvas, PeerCanvasViewer } from '../automation/tailnet/tailnet-peer-canvas'

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
  /**
   * A paired chat's boards, on the machine the chat runs on
   * (tailnet-peer-canvas.ts). Absent, or answering null, where this process
   * runs no mesh: the pane is told so in words.
   */
  remote?: () => PeerCanvas | null
  /** This machine's disk, where an export of a paired chat's board is written. */
  exportFs?: CanvasFs
}

const NO_REMOTE =
  "This Studio runs its server in a separate process, which does not carry a paired machine's boards yet, so they are shown as pictures."

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
  // Its paired machines' boards too (registerRemoteCanvasIpc).
  subscribers.onGone((subscriberId) => {
    service.dropSubscriber(subscriberId)
    options.remote?.()?.dropViewer(subscriberId)
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

  registerRemoteCanvasIpc(ipcMain, subscribers, options)
}

/**
 * The same pane, for a board on the machine a paired chat runs on. Each channel
 * is its `canvas:*` twin with the machine named beside the board; the pushes
 * are the same `canvas:scene` and `canvas:presence` a board here sends, under
 * the window's own ref, so the tab and the editor read them as they read their
 * own. What only a paired board has is its link: `canvas:remote-link` says it
 * is out of reach, back, or read-only, in words.
 */
function registerRemoteCanvasIpc(
  ipcMain: IpcMain,
  subscribers: CanvasSubscriberRegistry,
  options: CanvasIpcOptions,
): void {
  const remote = () => options.remote?.() ?? null
  const viewerOf = (sender: WebContents): PeerCanvasViewer => {
    const id = subscribers.add(sender)
    return { id, send: (channel, payload) => subscribers.sendTo(id, channel, payload) }
  }

  ipcMain.handle('canvas:remote-access', async (_event, connectionId: unknown) => {
    const lane = remote()
    return lane ? lane.access(connectionId) : { ok: true, live: false, canEdit: false, reason: NO_REMOTE }
  })
  ipcMain.handle('canvas:remote-open', (event: IpcMainInvokeEvent, input: unknown) => {
    const lane = remote()
    if (!lane) return canvasFail('forbidden', NO_REMOTE)
    const record = isRecord(input) ? input : {}
    return lane.open(viewerOf(event.sender), { ...(record as object), create: record.create } as never)
  })
  ipcMain.handle('canvas:remote-close', (event: IpcMainInvokeEvent, input: unknown) => {
    remote()?.close(viewerOf(event.sender), (isRecord(input) ? input : {}) as never)
  })
  ipcMain.handle('canvas:remote-commit', (event: IpcMainInvokeEvent, input: unknown) => {
    const lane = remote()
    if (!lane) return canvasFail('forbidden', NO_REMOTE)
    return lane.commit(viewerOf(event.sender), (isRecord(input) ? input : {}) as never)
  })
  ipcMain.on('canvas:remote-note-human-input', (event: IpcMainEvent, input: unknown) => {
    remote()?.noteHumanInput(viewerOf(event.sender), (isRecord(input) ? input : {}) as never)
  })
  ipcMain.handle('canvas:remote-watch', (event: IpcMainInvokeEvent, input: unknown) => {
    remote()?.watch(viewerOf(event.sender), (isRecord(input) ? input : {}) as never)
  })
  ipcMain.handle('canvas:remote-unwatch', (event: IpcMainInvokeEvent, input: unknown) => {
    remote()?.unwatch(viewerOf(event.sender), (isRecord(input) ? input : {}) as never)
  })

  // The board as this desktop holds it, after the tab's last change, written
  // into a folder the person picks here: the copy is theirs, on their disk.
  ipcMain.handle(
    'canvas:remote-export',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<CanvasResult<CanvasExportResult>> => {
      const lane = remote()
      if (!lane) return canvasFail('forbidden', NO_REMOTE)
      const record = isRecord(input) ? input : {}
      const snapshot = lane.snapshot(record as never)
      if (!snapshot.ok) return snapshot
      if (!options.pickExportDirectory || !options.exportFs) {
        return canvasFail('forbidden', 'Exporting a board is not available in this window.')
      }
      const images = exportImagesOf(record.images)
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
        name: snapshot.value.name,
        text: serializeSceneFile({
          ...emptyScene(),
          elements: snapshot.value.elements,
          appState: snapshot.value.appState,
          files: snapshot.value.files,
        }),
        images,
      })
      if (!exported.ok) return exported
      return canvasOk({ cancelled: false, directory: exported.value.directory, files: exported.value.files })
    },
  )
}
