import { canvasRefOf } from '../../shared/canvas/commit-checks'
import { canvasFail, type CanvasBoardRef, type CanvasResult } from '../../shared/canvas/types'
import type { McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import type { ControlRpc } from '../bootstrap/control-rpc'
import { SERVER_EVENTS, SHELL_METHODS } from '../desktop/server-methods'
import type { StudioCanvasHost } from './canvas-domain'

// The machine's boards for another device (`canvas.*`), when the Studio
// server and the canvas service are in different processes: the service is
// the shell's (its windows draw through it, and its hidden worker window
// renders the pictures), and the protocol is the server's. Both halves are
// here, so the request and the handler cannot drift.
//
// A board another device holds open is a subscriber of the shell's service.
// The server numbers its subscribers itself; the shell makes a subscriber of
// its own for each number the first time one is named, pushes what the
// service sends it back on `SERVER_EVENTS.canvasPush`, and forgets them all
// when the server goes, since nobody is left to hear them.

/** How long a board's read or write may take across the channel: a big board's scene is megabytes. */
const BOARD_CALL_MS = 60_000

/** The tools the domain reads (`canvas.list`, `canvas.screenshot`), run by the shell over its own service. */
const SHELL_CANVAS_TOOLS = ['canvas.list', 'canvas.screenshot'] as const

function unavailable<T>(error: unknown): CanvasResult<T> {
  return canvasFail(
    'worker_unavailable',
    `The canvas is the desktop app's, which did not answer: ${error instanceof Error ? error.message : String(error)}`,
  )
}

function answered<T>(value: unknown): CanvasResult<T> {
  if (value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean')
    return value as CanvasResult<T>
  return canvasFail('worker_unavailable', 'The canvas answered with something that is not a result.')
}

/** The server's half: the shell's canvas service, asked over the control channel. */
export function shellCanvasOverControl(rpc: Pick<ControlRpc, 'call' | 'emit' | 'on'>): StudioCanvasHost {
  const deliveries = new Map<number, (channel: string, payload: unknown) => void>()
  const openListeners = new Set<(ref: CanvasBoardRef) => void>()
  let next = 1
  rpc.on(SERVER_EVENTS.canvasPush, (raw) => {
    const { subscriberId, channel, payload } = (raw ?? {}) as Record<string, unknown>
    if (typeof subscriberId !== 'number' || typeof channel !== 'string') return
    deliveries.get(subscriberId)?.(channel, payload)
  })
  rpc.on(SERVER_EVENTS.canvasOpenRequest, (raw) => {
    const ref = canvasRefOf(raw)
    if (!ref.ok) return
    for (const listener of [...openListeners]) listener(ref.value)
  })
  const ask = <T>(method: string, params: unknown): Promise<CanvasResult<T>> =>
    rpc.call(method, params, { timeoutMs: BOARD_CALL_MS }).then(answered<T>, unavailable<T>)
  const tool = (name: string): McpToolRegistration => ({
    name,
    description: `${name}, run by the desktop app over its canvas.`,
    inputSchema: { type: 'object' },
    handler: async (args) => {
      try {
        return await rpc.call<McpToolResult>(SHELL_METHODS.canvasTool, { name, args }, { timeoutMs: BOARD_CALL_MS })
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `The canvas is the desktop app's, which did not answer: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    },
  })
  const tools = SHELL_CANVAS_TOOLS.map(tool)
  return {
    subscribe(deliver) {
      const id = next++
      deliveries.set(id, deliver)
      return id
    },
    unsubscribe(subscriberId) {
      deliveries.delete(subscriberId)
      rpc.emit(SERVER_EVENTS.canvasUnsubscribe, { subscriberId })
    },
    onOpenRequest(listener) {
      openListeners.add(listener)
      return () => openListeners.delete(listener)
    },
    confine: (ref) => ask(SHELL_METHODS.canvasConfine, { ref }),
    openBoard: (ref, opts) =>
      ask(SHELL_METHODS.canvasOpen, { ref, create: opts.create, subscriberId: opts.subscriberId }),
    readBoard: (ref) => ask(SHELL_METHODS.canvasRead, { ref }),
    commitScene: (input, subscriberId) => ask(SHELL_METHODS.canvasCommit, { input, subscriberId }),
    noteHumanInput: (ref, subscriberId) => rpc.emit(SERVER_EVENTS.canvasHumanInput, { ref, subscriberId }),
    tools: () => tools,
  }
}

function subscriberIdOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * The shell's half: answer the server from the shell's own view of the canvas
 * service for other devices (canvas-remote-subscribers.ts), which holds every
 * board to where its file really is. `reset` forgets the server's
 * subscribers: called when that server is gone.
 */
export function serveCanvasShell(
  rpc: Pick<ControlRpc, 'handle' | 'emit' | 'on'>,
  host: StudioCanvasHost,
): { reset(): void } {
  // The server's number for a subscriber → the service's own.
  const subscribers = new Map<number, number>()
  const subscriberFor = (serverId: number): number => {
    const known = subscribers.get(serverId)
    if (known !== undefined) return known
    const own = host.subscribe((channel, payload) =>
      rpc.emit(SERVER_EVENTS.canvasPush, { subscriberId: serverId, channel, payload }),
    )
    subscribers.set(serverId, own)
    return own
  }
  const drop = (serverId: number): void => {
    const own = subscribers.get(serverId)
    if (own === undefined) return
    subscribers.delete(serverId)
    host.unsubscribe(own)
  }
  const refOf = (params: unknown): CanvasResult<CanvasBoardRef> =>
    canvasRefOf((params as { ref?: unknown } | null)?.ref)

  host.onOpenRequest((ref) => rpc.emit(SERVER_EVENTS.canvasOpenRequest, ref))
  rpc.on(SERVER_EVENTS.canvasUnsubscribe, (raw) => {
    const id = subscriberIdOf((raw as { subscriberId?: unknown } | null)?.subscriberId)
    if (id !== null) drop(id)
  })
  rpc.on(SERVER_EVENTS.canvasHumanInput, (raw) => {
    const ref = refOf(raw)
    const id = subscriberIdOf((raw as { subscriberId?: unknown } | null)?.subscriberId)
    if (ref.ok) host.noteHumanInput(ref.value, id === null ? undefined : subscriberFor(id))
  })
  rpc.handle(SHELL_METHODS.canvasConfine, (params) => {
    const ref = refOf(params)
    return ref.ok ? host.confine(ref.value) : ref
  })
  rpc.handle(SHELL_METHODS.canvasRead, (params) => {
    const ref = refOf(params)
    return ref.ok ? host.readBoard(ref.value) : ref
  })
  rpc.handle(SHELL_METHODS.canvasOpen, (params) => {
    const ref = refOf(params)
    if (!ref.ok) return ref
    const { create, subscriberId } = (params ?? {}) as { create?: unknown; subscriberId?: unknown }
    const id = subscriberIdOf(subscriberId)
    if (id === null) return canvasFail('invalid_scene', 'A board is opened for a subscriber.')
    return host.openBoard(ref.value, { create: create === true, subscriberId: subscriberFor(id) })
  })
  rpc.handle(SHELL_METHODS.canvasCommit, (params) => {
    const { input, subscriberId } = (params ?? {}) as { input?: unknown; subscriberId?: unknown }
    const ref = canvasRefOf(input)
    const id = subscriberIdOf(subscriberId)
    if (!ref.ok) return ref
    if (id === null) return canvasFail('invalid_scene', 'A change is committed by a subscriber.')
    // The domain checked the change's shape before it asked (canvasCommitOf).
    return host.commitScene(input as Parameters<StudioCanvasHost['commitScene']>[0], subscriberFor(id))
  })
  rpc.handle(SHELL_METHODS.canvasTool, (params) => {
    const { name, args } = (params ?? {}) as { name?: unknown; args?: unknown }
    if (typeof name !== 'string' || !(SHELL_CANVAS_TOOLS as readonly string[]).includes(name))
      throw new Error('Only the canvas list and picture tools are run for another device.')
    const registration = host.tools().find((entry) => entry.name === name)
    if (!registration) throw new Error(`The canvas has no ${name} tool.`)
    return registration.handler(args && typeof args === 'object' ? (args as Record<string, unknown>) : {})
  })
  return {
    reset() {
      for (const id of [...subscribers.keys()]) drop(id)
    },
  }
}
