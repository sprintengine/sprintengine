import type { StudioWebSocketConstructor, StudioWebSocketLike } from '../packages/client-runtime/src/rpc/websocket'
import type { MemoryChannelEnd } from './memory-channel'

// A WebSocket in memory, for the suites that put a window's Studio connection
// on a socket: `open` is handed the URL and answers the far end's channel, or
// null to refuse, as a server refuses an upgrade. Frames posted before a close
// are still heard ahead of it, as on a real socket.

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

type Listener = (event: never) => void

export function memoryWebSocketClass(open: (url: string) => MemoryChannelEnd | null): StudioWebSocketConstructor {
  return class MemoryWebSocket implements StudioWebSocketLike {
    readyState = CONNECTING
    private end: MemoryChannelEnd | null = null
    private readonly listeners = new Map<string, Listener[]>()

    constructor(url: string) {
      queueMicrotask(() => {
        const end = open(url)
        if (!end) {
          this.readyState = CLOSED
          this.emit('error', {})
          this.emit('close', { code: 1006, reason: '' })
          return
        }
        this.end = end
        this.readyState = OPEN
        end.onFrame((frame) => this.emit('message', { data: frame }))
        end.onClose(() => {
          this.readyState = CLOSED
          this.emit('close', { code: 1000, reason: '' })
        })
        this.emit('open', {})
      })
    }

    send(data: string): void {
      if (this.readyState === OPEN) this.end?.post(data)
    }

    close(): void {
      this.end?.close()
    }

    addEventListener(type: string, listener: Listener): void {
      const list = this.listeners.get(type) ?? []
      list.push(listener)
      this.listeners.set(type, list)
    }

    private emit(type: string, event: object): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event as never)
    }
  } as unknown as StudioWebSocketConstructor
}
