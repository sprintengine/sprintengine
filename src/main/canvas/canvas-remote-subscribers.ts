import type { CanvasBoardRef } from '../../shared/canvas/types'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { StudioCanvasHost } from '../../server/canvas/canvas-domain'
import { CANVAS_OPEN_REQUEST_CHANNEL, type CanvasServiceInternal } from './canvas-service'

// The other devices' half of the canvas service's subscriber list. A window
// here is a subscriber by its WebContents id (canvas-subscribers.ts), always
// positive; a board another device holds open over the Studio protocol
// (`canvas.board`, src/server/canvas/canvas-domain.ts) is a subscriber too,
// numbered below zero so the two never meet. The service pushes to both the
// same way and cannot tell them apart, which is what puts a paired desktop's
// tab on the same footing as a window here: one merge, one revision, and
// every other subscriber told.

export type CanvasRemoteSubscribers = {
  /** Where the service's per-subscriber pushes go when the subscriber is another device's board. */
  sendTo(subscriberId: number, channel: string, payload: unknown): boolean
  /** Where the service's broadcasts go: an agent's `canvas.open` reaches the devices following that chat. */
  broadcast(channel: string, payload: unknown): void
  /** The Studio's view of the service, and of the canvas tools that list and draw its boards. */
  host(service: CanvasServiceInternal, tools: () => McpToolRegistration[]): StudioCanvasHost
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
    host(service, tools) {
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
        openBoard: (ref, opts) => service.openBoard(ref, opts),
        readBoard: (ref) => service.readBoard(ref),
        commitScene: (input, subscriberId) => service.commitScene(input, subscriberId),
        noteHumanInput: (ref, subscriberId) => service.noteHumanInput(ref, subscriberId),
        tools,
      }
    },
  }
}
