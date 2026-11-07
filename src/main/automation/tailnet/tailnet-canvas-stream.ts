import type { Duplex } from 'stream'

import { authorizeStudioAccess } from '../../../../packages/studio-protocol/src/permissions'
import { canvasCommitOf, canvasRefOf } from '../../../shared/canvas/commit-checks'
import type {
  CanvasBoardRef,
  CanvasBoardState,
  CanvasElement,
  CanvasPresence,
  CanvasResult,
  CanvasScenePush,
} from '../../../shared/canvas/types'
import { isRecord } from '../../../shared/records'
import { tailnetDevicePrincipal, type TailnetScope } from '../../../shared/tailnet'
import { CANVAS_LANE_ACCESS, type CanvasLaneMessageType } from './tailnet-scopes'
import {
  canvasLaneFileIds,
  canvasLaneMessages,
  canvasLaneTooLarge,
  createCanvasLaneAssembler,
  CANVAS_LANE_MAX_MESSAGE_BYTES,
} from './tailnet-canvas-wire'
import {
  createWebSocketFrameDecoder,
  encodeCloseFrame,
  encodePingFrame,
  encodePongFrame,
  encodeTextFrame,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WEBSOCKET_CLOSE_GOING_AWAY,
} from './websocket-frames'

// One paired device's canvas lane on the machine that holds the boards
// (`canvas-live-boards`). The device's Canvas pane runs the same editor it runs
// for a board of its own; this is the far half of the IPC that pane speaks at
// home, over the tailnet: open a board and be pushed every accepted write to
// it, send the person's scene, say the person has the pen.
//
// Every board the socket opens is a subscriber of this machine's one canvas
// service, the same service this machine's own windows and agents write
// through. That is the point: there is one merge, one revision and one file
// writer per board, so two people drawing at once (one here, one there, or both
// there) are merged element by element as two windows here are, and nothing
// is written twice over itself.
//
// What a device may do is its grant, read again on every message: the socket
// needs `workspace:read`, and a scene, a picture or the pen need
// `workspace:operate` (CANVAS_LANE_ACCESS). A board is a ref the service takes
// from its own pane, checked by the same `canvasRefOf`: a store board or a
// `.excalidraw` file inside a project, never a path out of either.

/** What the lane needs of this machine's canvas, from the canvas service and its subscriber list. */
export type TailnetCanvasHost = {
  /** A subscriber of the service for one board a socket holds; its pushes reach `deliver`. */
  subscribe(deliver: (channel: string, payload: unknown) => void): number
  /** That board is closed: the subscriber ends, and the service stops pushing to it. */
  unsubscribe(subscriberId: number): void
  /** Hear an agent's `canvas.open` here, for a device that follows that chat. */
  onOpenRequest(listener: (ref: CanvasBoardRef) => void): () => void
  openBoard(
    ref: CanvasBoardRef,
    opts: { create: boolean; subscriberId: number },
  ): Promise<CanvasResult<CanvasBoardState>>
  commitScene(
    input: CanvasBoardRef & {
      baseRevision: number
      elements: CanvasElement[]
      appState: Record<string, unknown>
      files: Record<string, unknown>
    },
    subscriberId: number,
  ): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>>
  noteHumanInput(ref: CanvasBoardRef, subscriberId: number): void
}

export type TailnetCanvasStream = {
  deviceId: string
  close(code: number, reason: string): void
  isClosed(): boolean
  /** Re-read the device's grant: close without read, say so without operate. */
  refreshScopes(): void
}

/** The close code for a device whose grant no longer reads boards. */
export const CANVAS_LANE_SCOPE_CLOSE_CODE = 4403

const PING_MS = 25_000
const PONG_TIMEOUT_MS = 60_000
/** Boards one socket may hold at once: a desktop's tabs, with room. */
const MAX_BOARDS = 64
/** Workspaces one socket may follow for `canvas.open`. */
const MAX_WATCHED = 64
/** Pictures sent ahead of one commit, waiting for it. A commit's own ceiling is 40 MB. */
const MAX_PENDING_FILE_BYTES = 48 * 1024 * 1024
/** Past this much unsent, a board's newest scene waits for the socket to drain. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024

type OpenBoard = {
  handle: number
  ref: CanvasBoardRef
  subscriberId: number
  /** Pictures the device holds: sent to it, sent by it, or named as held when it opened. */
  known: Set<string>
  /** Pictures the device sent for its next commit. */
  pendingFiles: Map<string, unknown>
  pendingBytes: number
}

export function createTailnetCanvasStream(options: {
  socket: Duplex
  deviceId: string
  /** The device's grant now; null once it is gone. Read live, never captured. */
  scopes: () => readonly TailnetScope[] | null
  host: TailnetCanvasHost
  onClosed: () => void
  /** A write accepted or refused, for the gateway's audit. Never the drawing. */
  audit?: (entry: { tool: string; ref: CanvasBoardRef; ok: boolean; code?: string; durationMs: number }) => void
  log?: (message: string) => void
  now?: () => number
}): TailnetCanvasStream {
  const { socket, host } = options
  const now = options.now ?? (() => Date.now())
  const boards = new Map<number, OpenBoard>()
  const watched = new Set<string>()
  const pendingScenes = new Map<number, CanvasScenePush>()
  let flushScheduled = false
  let waitingForDrain = false
  let closed = false
  let lastPong = now()
  let nextStream = 1
  let lastCanEdit: boolean | null = null
  let queue = Promise.resolve()

  const allows = (type: CanvasLaneMessageType): boolean => {
    const scopes = options.scopes()
    return scopes !== null && authorizeStudioAccess(tailnetDevicePrincipal(scopes), CANVAS_LANE_ACCESS[type]).ok
  }
  const canRead = () => allows('open')
  const canEdit = () => allows('commit')

  const write = (text: string): void => {
    if (closed || socket.destroyed) return
    try {
      socket.write(encodeTextFrame(text))
    } catch {
      /* The peer left; the close handlers below run. */
    }
  }
  const send = (message: Record<string, unknown>): void => {
    for (const text of canvasLaneMessages(message, () => nextStream++)) write(text)
  }

  const stopOpenRequests = host.onOpenRequest((ref) => {
    if (closed || !watched.has(ref.workspaceId) || !canRead()) return
    send({
      type: 'open-request',
      workspaceId: ref.workspaceId,
      path: ref.path,
      ...(ref.store ? { store: ref.store } : {}),
    })
  })

  const close = (code: number, reason: string): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    stopOpenRequests()
    for (const board of boards.values()) host.unsubscribe(board.subscriberId)
    boards.clear()
    pendingScenes.clear()
    if (!socket.destroyed) {
      try {
        socket.write(encodeCloseFrame(code, reason))
      } catch {
        /* Peer already left. */
      }
      socket.end()
    }
    options.onClosed()
  }

  const applyScopes = (): boolean => {
    if (!canRead()) {
      close(CANVAS_LANE_SCOPE_CLOSE_CODE, 'workspace_scope_required')
      return false
    }
    const edit = canEdit()
    if (edit !== lastCanEdit) {
      lastCanEdit = edit
      send({ type: 'access', canEdit: edit })
    }
    return true
  }

  /** Pictures the device does not hold yet, each as its own message, ahead of the scene that names them. */
  const sendFiles = (board: OpenBoard, files: Record<string, unknown>): void => {
    for (const [id, value] of Object.entries(files)) {
      if (board.known.has(id)) continue
      const message = { type: 'file', board: board.handle, id, value }
      // A picture larger than the lane carries is left off: the board opens
      // with it drawn as a missing image rather than not at all.
      if (canvasLaneTooLarge(message)) {
        options.log?.(`canvas lane: a picture on ${board.ref.path} is too large to send`)
        continue
      }
      board.known.add(id)
      send(message)
    }
  }

  const flushScenes = (): void => {
    flushScheduled = false
    if (closed) return
    if (socket.writableLength > HIGH_WATER_BYTES) {
      // A slow reader gets the newest scene of each board once it has caught
      // up, not every scene in between: each one is the whole board.
      if (!waitingForDrain) {
        waitingForDrain = true
        socket.once('drain', () => {
          waitingForDrain = false
          flushScenes()
        })
      }
      return
    }
    for (const [handle, push] of [...pendingScenes]) {
      pendingScenes.delete(handle)
      const board = boards.get(handle)
      if (!board) continue
      sendFiles(board, push.files ?? {})
      const scene = {
        type: 'scene',
        board: handle,
        revision: push.revision,
        elements: push.elements,
        fileIds: Object.keys(push.files ?? {}),
        origin: push.origin,
      }
      if (canvasLaneTooLarge(scene)) {
        dropBoard(board)
        send({
          type: 'closed',
          board: handle,
          code: 'too_large',
          message: 'This board has grown past what can be sent between machines. Split it into two boards.',
        })
        continue
      }
      send(scene)
    }
  }

  const deliverTo =
    (handle: number) =>
    (channel: string, payload: unknown): void => {
      if (closed || !isRecord(payload)) return
      if (channel === 'canvas:scene') {
        pendingScenes.set(handle, payload as CanvasScenePush)
        if (!flushScheduled) {
          flushScheduled = true
          setImmediate(flushScenes)
        }
        return
      }
      if (channel === 'canvas:presence') {
        const presence = payload as unknown as CanvasPresence
        // Presence is a moment: one that cannot go now is not worth queueing.
        if (socket.writableLength > HIGH_WATER_BYTES) return
        send({
          type: 'presence',
          board: handle,
          controller: presence.controller,
          ...(presence.agentName ? { agentName: presence.agentName } : {}),
          ...(presence.pointer ? { pointer: presence.pointer } : {}),
          ...(presence.selectedElementIds ? { selectedElementIds: presence.selectedElementIds.slice(0, 2_000) } : {}),
        })
      }
    }

  const dropBoard = (board: OpenBoard): void => {
    boards.delete(board.handle)
    pendingScenes.delete(board.handle)
    host.unsubscribe(board.subscriberId)
  }

  const refuse = (id: unknown, type: 'opened' | 'committed', code: string, message: string): void => {
    send({ type, id, ok: false, code, message })
  }

  async function open(message: Record<string, unknown>): Promise<void> {
    const handle = message.board
    if (!Number.isInteger(handle) || (handle as number) <= 0)
      return refuse(message.id, 'opened', 'invalid_arguments', 'An open names its board by a positive number.')
    const ref = canvasRefOf(message.ref)
    if (!ref.ok) return refuse(message.id, 'opened', ref.error.code, ref.error.message)
    const existing = boards.get(handle as number)
    if (existing) dropBoard(existing)
    if (boards.size >= MAX_BOARDS)
      return refuse(message.id, 'opened', 'too_many_boards', `One device may hold ${MAX_BOARDS} boards open at once.`)
    const wantsCreate = message.create === true
    const create = wantsCreate && canEdit()
    const subscriberId = host.subscribe(deliverTo(handle as number))
    const board: OpenBoard = {
      handle: handle as number,
      ref: ref.value,
      subscriberId,
      known: new Set(canvasLaneFileIds(message.have)),
      pendingFiles: new Map(),
      pendingBytes: 0,
    }
    boards.set(board.handle, board)
    let opened: CanvasResult<CanvasBoardState>
    try {
      opened = await host.openBoard(ref.value, { create, subscriberId })
    } catch (error) {
      opened = {
        ok: false,
        error: { code: 'forbidden', message: error instanceof Error ? error.message : String(error) },
      }
    }
    if (closed || boards.get(board.handle) !== board) {
      if (boards.get(board.handle) !== board) host.unsubscribe(subscriberId)
      return
    }
    if (!opened.ok) {
      dropBoard(board)
      // A board this device could have made, had its grant let it: said so,
      // rather than as a board that is not there.
      if (opened.error.code === 'not_found' && wantsCreate && !create)
        return refuse(message.id, 'opened', 'read_only', opened.error.message)
      return refuse(message.id, 'opened', opened.error.code, opened.error.message)
    }
    const state = opened.value
    sendFiles(board, state.files)
    const answer = {
      type: 'opened',
      id: message.id,
      board: board.handle,
      ok: true,
      state: {
        ...(state.id ? { id: state.id } : {}),
        path: state.path,
        revision: state.revision,
        elements: state.elements,
        appState: state.appState,
      },
      fileIds: Object.keys(state.files),
      canEdit: canEdit(),
    }
    if (canvasLaneTooLarge(answer)) {
      dropBoard(board)
      return refuse(
        message.id,
        'opened',
        'too_large',
        'This board is larger than can be sent between machines. Open it on the machine it is on, or split it.',
      )
    }
    send(answer)
  }

  function takeFile(message: Record<string, unknown>): void {
    const board = boards.get(message.board as number)
    if (!board || typeof message.id !== 'string' || !message.id || message.id.length > 256) return
    let size = 0
    try {
      size = JSON.stringify(message.value ?? null).length
    } catch {
      return
    }
    if (board.pendingBytes + size > MAX_PENDING_FILE_BYTES) {
      // The commit that follows carries the rest and is refused on its size.
      board.pendingFiles.clear()
      board.pendingBytes = Number.POSITIVE_INFINITY
      return
    }
    board.pendingFiles.set(message.id, message.value)
    board.pendingBytes += size
  }

  async function commit(message: Record<string, unknown>): Promise<void> {
    const board = boards.get(message.board as number)
    if (!board) return refuse(message.id, 'committed', 'not_open', 'That board is not open on this connection.')
    const tooMany = board.pendingBytes === Number.POSITIVE_INFINITY
    const files = Object.fromEntries(board.pendingFiles)
    board.pendingFiles = new Map()
    board.pendingBytes = 0
    if (tooMany)
      return refuse(
        message.id,
        'committed',
        'too_large',
        'The pictures sent with this change come to more than a board may hold.',
      )
    const checked = canvasCommitOf({
      ...board.ref,
      baseRevision: message.baseRevision,
      elements: message.elements,
      appState: message.appState,
      files,
    })
    if (!checked.ok) return refuse(message.id, 'committed', checked.error.code, checked.error.message)
    const started = now()
    let result: CanvasResult<{ revision: number; elements: CanvasElement[] | null }>
    try {
      result = await host.commitScene(checked.value, board.subscriberId)
    } catch (error) {
      result = {
        ok: false,
        error: { code: 'forbidden', message: error instanceof Error ? error.message : String(error) },
      }
    }
    options.audit?.({
      tool: 'canvas.commit',
      ref: board.ref,
      ok: result.ok,
      ...(result.ok ? {} : { code: result.error.code }),
      durationMs: now() - started,
    })
    if (!result.ok) return refuse(message.id, 'committed', result.error.code, result.error.message)
    for (const id of Object.keys(files)) board.known.add(id)
    send({
      type: 'committed',
      id: message.id,
      ok: true,
      revision: result.value.revision,
      elements: result.value.elements,
    })
  }

  async function handle(message: Record<string, unknown>): Promise<void> {
    const type = message.type as CanvasLaneMessageType
    if (!(type in CANVAS_LANE_ACCESS)) return
    if (!applyScopes()) return
    if (!allows(type)) {
      // Said in words where there is an answer to say it in; a gesture has none.
      if (type === 'commit')
        refuse(
          message.id,
          'committed',
          'read_only',
          'This device may look at boards on this machine but not change them.',
        )
      return
    }
    switch (type) {
      case 'open':
        return open(message)
      case 'close': {
        const board = boards.get(message.board as number)
        if (board) dropBoard(board)
        return
      }
      case 'watch': {
        watched.clear()
        for (const id of Array.isArray(message.workspaceIds) ? message.workspaceIds.slice(0, MAX_WATCHED) : [])
          if (typeof id === 'string' && id) watched.add(id)
        return
      }
      case 'file':
        return takeFile(message)
      case 'commit':
        return commit(message)
      case 'human': {
        const board = boards.get(message.board as number)
        if (board) host.noteHumanInput(board.ref, board.subscriberId)
        return
      }
    }
  }

  const heartbeat = setInterval(() => {
    if (closed) return
    if (now() - lastPong > PONG_TIMEOUT_MS) {
      close(WEBSOCKET_CLOSE_GOING_AWAY, 'pong_timeout')
      return
    }
    if (!socket.destroyed) socket.write(encodePingFrame())
  }, PING_MS)
  heartbeat.unref()

  const stream: TailnetCanvasStream = {
    deviceId: options.deviceId,
    close,
    isClosed: () => closed,
    refreshScopes: () => void applyScopes(),
  }
  if (!applyScopes()) return stream

  // Parts are only ever needed to send a change: a device that may only look
  // has no message larger than a plain one to send.
  const assembler = createCanvasLaneAssembler(() => (canEdit() ? CANVAS_LANE_MAX_MESSAGE_BYTES : 0))
  const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES)
  socket.on('data', (chunk: Buffer) => {
    if (closed) return
    const decoded = decoder.push(chunk)
    if (decoded.kind === 'error') {
      close(decoded.code, decoded.reason)
      return
    }
    for (const frame of decoded.frames) {
      if (closed) return
      if (frame.kind === 'close') {
        close(WEBSOCKET_CLOSE_GOING_AWAY, '')
        return
      }
      if (frame.kind === 'pong') {
        lastPong = now()
        continue
      }
      if (frame.kind === 'ping') {
        if (!socket.destroyed) socket.write(encodePongFrame(frame.payload))
        continue
      }
      if (frame.kind !== 'text') continue
      lastPong = now()
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.text)
      } catch {
        close(1007, 'A canvas message was not JSON.')
        return
      }
      if (!isRecord(parsed)) continue
      const assembled = assembler.push(parsed)
      if (assembled.kind === 'error') {
        close(1009, assembled.reason)
        return
      }
      if (assembled.kind === 'pending') continue
      const message = assembled.message
      // In order, one at a time: a picture is taken before the commit that
      // names it, and a board is open before anything is said about it.
      queue = queue
        .then(() => (closed ? undefined : handle(message)))
        .catch((error: unknown) => options.log?.(`canvas lane message failed: ${String(error)}`))
    }
  })
  socket.on('end', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  socket.on('close', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  socket.on('error', () => close(WEBSOCKET_CLOSE_GOING_AWAY, ''))
  return stream
}
