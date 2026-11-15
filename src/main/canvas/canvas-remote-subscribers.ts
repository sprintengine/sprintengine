import { canvasFail, type CanvasBoardRef, type CanvasResult } from '../../shared/canvas/types'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { StudioCanvasHost } from '../../server/canvas/canvas-domain'
import { CANVAS_OPEN_REQUEST_CHANNEL, type CanvasServiceInternal } from './canvas-service'
import type { CanvasService } from './canvas-service-types'

// The other devices' half of the canvas service's subscriber list. A window
// here is a subscriber by its WebContents id (canvas-subscribers.ts), always
// positive; a board another device holds open over the Studio protocol
// (`canvas.board`, src/server/canvas/canvas-domain.ts) is a subscriber too,
// numbered below zero so the two never meet. The service pushes to both the
// same way and cannot tell them apart, which is what puts a paired desktop's
// tab on the same footing as a window here: one merge, one revision, and
// every other subscriber told.
//
// What differs is where a board may be. This machine's windows and agents
// name a board by its path in the project, as written; another device is held
// to where the file really is (`confineBoard`), every link followed, so a link
// inside a project that points at a board outside it is not a way out. Every
// call the Studio makes for another device goes through that check first: the
// pane's own calls, and the tools that list and draw boards for it, which are
// built over the same held view of the service.

export type CanvasRemoteSubscribers = {
  /** Where the service's per-subscriber pushes go when the subscriber is another device's board. */
  sendTo(subscriberId: number, channel: string, payload: unknown): boolean
  /** Where the service's broadcasts go: an agent's `canvas.open` reaches the devices following that chat. */
  broadcast(channel: string, payload: unknown): void
  /**
   * The Studio's view of the service, and of the canvas tools that list and
   * draw its boards. `tools` builds those over the service it is handed: the
   * view held to real paths, never the service itself.
   */
  host(service: CanvasServiceInternal, tools: (service: CanvasService) => McpToolRegistration[]): StudioCanvasHost
}

/** The service as another device reaches it: every call about a board held to where its file really is. */
function heldToRealPaths(service: CanvasServiceInternal): CanvasService {
  async function held<T>(ref: CanvasBoardRef, work: () => Promise<CanvasResult<T>>): Promise<CanvasResult<T>> {
    const confined = await service.confineBoard(ref)
    return confined.ok ? work() : canvasFail(confined.error.code, confined.error.message)
  }
  return {
    // A listing walks the folders without following a link (canvas-node-fs.ts).
    listBoards: (workspaceId) => service.listBoards(workspaceId),
    listAllBoards: (workspaceId) => service.listAllBoards(workspaceId),
    readBoard: (ref, opts) => held(ref, () => service.readBoard(ref, opts)),
    boardExists: (ref) => held(ref, () => service.boardExists(ref)),
    edit: (ref, edit, actor) => held(ref, () => service.edit(ref, edit, actor)),
    layout: (ref, request, actor) => held(ref, () => service.layout(ref, request, actor)),
    importContent: (ref, request, actor) => held(ref, () => service.importContent(ref, request, actor)),
    screenshot: (ref, opts) => held(ref, () => service.screenshot(ref, opts)),
    requestOpen: (ref) => held(ref, () => service.requestOpen(ref)),
    // In memory, of a board already loaded; every tool that asks has read it through `readBoard` first.
    changesSinceLastRead: (ref, readerKey) => service.changesSinceLastRead(ref, readerKey),
    actions: (ref) => service.actions(ref),
    // The service is the machine's, not this view's: it outlives every device.
    dispose: async () => undefined,
  }
}

export function isRemoteCanvasSubscriber(subscriberId: number): boolean {
  return subscriberId < 0
}

export function createCanvasRemoteSubscribers(): CanvasRemoteSubscribers {
  const deliveries = new Map<number, (channel: string, payload: unknown) => void>()
  const openListeners = new Set<(ref: CanvasBoardRef) => void>()
  let next = -1

  return {
    sendTo(subscriberId, channel, payload) {
      const deliver = deliveries.get(subscriberId)
      if (!deliver) return false
      deliver(channel, payload)
      return true
    },
    broadcast(channel, payload) {
      if (channel !== CANVAS_OPEN_REQUEST_CHANNEL) return
      for (const listener of [...openListeners]) listener(payload as CanvasBoardRef)
    },
    host(service, toolsOver) {
      const view = heldToRealPaths(service)
      let tools: McpToolRegistration[] | null = null
      return {
        subscribe(deliver) {
          const id = next
          next -= 1
          deliveries.set(id, deliver)
          return id
        },
        unsubscribe(subscriberId) {
          deliveries.delete(subscriberId)
          service.dropSubscriber(subscriberId)
        },
        onOpenRequest(listener) {
          openListeners.add(listener)
          return () => openListeners.delete(listener)
        },
        confine: (ref) => service.confineBoard(ref),
        openBoard: async (ref, opts) => {
          const confined = await service.confineBoard(ref)
          return confined.ok ? service.openBoard(ref, opts) : canvasFail(confined.error.code, confined.error.message)
        },
        readBoard: (ref) => view.readBoard(ref),
        commitScene: async (input, subscriberId) => {
          const confined = await service.confineBoard(input)
          return confined.ok
            ? service.commitScene(input, subscriberId)
            : canvasFail(confined.error.code, confined.error.message)
        },
        noteHumanInput: (ref, subscriberId) => {
          void service.confineBoard(ref).then((confined) => {
            if (confined.ok) service.noteHumanInput(ref, subscriberId)
          })
        },
        tools: () => (tools ??= toolsOver(view)),
      }
    },
  }
}
