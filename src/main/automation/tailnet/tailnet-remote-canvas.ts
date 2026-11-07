import { canvasCommitOf, canvasRefOf } from '../../../shared/canvas/commit-checks'
import { mergeElements } from '../../../shared/canvas/merge'
import { canvasBoardName } from '../../../shared/canvas/paths'
import type {
  CanvasBoardRef,
  CanvasBoardState,
  CanvasElement,
  CanvasErrorCode,
  CanvasPresence,
  CanvasRemoteAccess,
  CanvasRemoteLink,
  CanvasResult,
} from '../../../shared/canvas/types'
import { canvasFail, canvasOk } from '../../../shared/canvas/types'
import { isRecord } from '../../../shared/records'
import type { TailnetScope } from '../../../shared/tailnet'
import { tailnetPeerSupports } from './tailnet-routes'
import {
  canvasLaneFileIds,
  canvasLaneMessages,
  createCanvasLaneAssembler,
  type CanvasLaneRef,
} from './tailnet-canvas-wire'
import {
  openRemoteCanvasSocket,
  type RemoteCallOutcome,
  type RemoteCanvasSocket,
  type RemoteJsonSocketHandlers,
  type TailnetEndpoint,
} from './tailnet-remote-client'

// This desktop's half of the canvas lane: a paired chat's Canvas pane editing
// the boards on the machine the chat runs on, with the same editor and the same
// calls it makes for a board here (`canvas:open-board`, `canvas:commit-scene`,
// the `canvas:scene` and `canvas:presence` pushes). The far machine's canvas
// service is the one owner of each board; this end keeps a copy of what it last
// heard so a second window, an export and a reconnect have something to read.
//
// One socket per paired machine, while anything here holds one of its boards
// or follows one of its chats for `canvas.open`. A window is a viewer; one far
// board several windows hold is one subscription over there, and what one
// window sends the others are told here, as the far service tells its own.
//
// The link drops. When it does the pane is told in words, what the person draws
// meanwhile is kept here and merged element by element into one pending change,
// and when the machine answers again each board is opened afresh and that
// change sent: nothing drawn while away is lost, as long as this app runs.

/** A window holding boards, by the id the canvas subscriber list gave it. */
export type RemoteCanvasViewer = { id: number; send(channel: string, payload: unknown): void }

/** A far board as a window names it: its own ref, and where the board is over there. */
export type RemoteCanvasBoardInput = {
  connectionId: unknown
  /** The chat's workspace on the far machine. */
  remoteWorkspaceId: unknown
  /** This window's workspace: pushes go out under its ref, as a board here's do. */
  workspaceId: unknown
  path: unknown
  store?: unknown
}

export type RemoteCanvasAccess = CanvasRemoteAccess
export type RemoteCanvasLink = CanvasRemoteLink

export const CANVAS_REMOTE_LINK_CHANNEL = 'canvas:remote-link'
export const CANVAS_REMOTE_OPEN_REQUEST_CHANNEL = 'canvas:remote-open-request'

export type TailnetRemoteCanvas = {
  access(connectionId: unknown): Promise<RemoteCanvasAccess>
  open(
    viewer: RemoteCanvasViewer,
    input: RemoteCanvasBoardInput & { create?: unknown },
  ): Promise<CanvasResult<CanvasBoardState & { canEdit: boolean }>>
  close(viewer: RemoteCanvasViewer, input: RemoteCanvasBoardInput): void
  commit(
    viewer: RemoteCanvasViewer,
    input: RemoteCanvasBoardInput & { baseRevision?: unknown; elements?: unknown; appState?: unknown; files?: unknown },
  ): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>>
  noteHumanInput(viewer: RemoteCanvasViewer, input: RemoteCanvasBoardInput): void
  /** The board as this end last heard it, with what it sent since: what an export writes. */
  snapshot(input: RemoteCanvasBoardInput): CanvasResult<{
    name: string
    elements: CanvasElement[]
    appState: Record<string, unknown>
    files: Record<string, unknown>
  }>
  /** Follow a far chat's `canvas.open`, for the window showing it. */
  watch(viewer: RemoteCanvasViewer, input: { connectionId: unknown; workspaceId: unknown }): void
  unwatch(viewer: RemoteCanvasViewer, input: { connectionId: unknown; workspaceId: unknown }): void
  /** A window went away: everything it held is let go. */
  dropViewer(viewerId: number): void
  /** A pairing was removed: its socket and boards go with it. */
  forget(connectionId: string): void
  shutdown(): void
}

export type TailnetRemoteCanvasDeps = {
  connection(connectionId: string): { endpoint: TailnetEndpoint; token: string; machineName: string } | null
  /** What the machine says it is and may do now; a fresh answer also refreshes what the mesh knows of it. */
  identity(connectionId: string): Promise<RemoteCallOutcome<{ scopes: TailnetScope[]; capabilities: string[] | null }>>
  /** What the machine last said it can do, without asking again. */
  knownCapabilities(connectionId: string): string[] | null | undefined
  openSocket?: typeof openRemoteCanvasSocket
  retry?: { baseMs: number; maxMs: number }
  /** How long a board nobody here shows is kept open, for the last change of a tab that just closed. */
  lingerMs?: number
  requestTimeoutMs?: number
  log?: (message: string) => void
}

type ViewerHold = { viewer: RemoteCanvasViewer; local: CanvasBoardRef }

type Board = {
  handle: number
  key: string
  ref: CanvasLaneRef
  holds: Map<string, ViewerHold>
  opened: boolean
  /** Opened once already: a later open is a reconnect, and the windows are handed the board again. */
  everOpened: boolean
  opening: Promise<CanvasResult<void>> | null
  /** The kept change is on its way. */
  flushing: boolean
  /** Whether the first open may make the board; a reopen after a drop never does. */
  create: boolean
  id: string | undefined
  /** The path as the far machine spells it. */
  path: string
  elements: CanvasElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
  /** Pictures the far machine holds for this board. */
  peerFiles: Set<string>
  remoteRevision: number
  /** What this end has told its windows: never moves backwards, across a reconnect or a restart over there. */
  shown: number
  offset: number
  canEdit: boolean
  /** What the person drew while the machine was away, merged into one change. */
  held: { elements: CanvasElement[]; appState: Record<string, unknown>; files: Record<string, unknown> } | null
  linger: ReturnType<typeof setTimeout> | null
  gone: string | null
}

type Pending = {
  resolve(message: Record<string, unknown>): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type Session = {
  connectionId: string
  socket: RemoteCanvasSocket | null
  dialing: Promise<boolean> | null
  retryTimer: ReturnType<typeof setTimeout> | null
  attempt: number
  /** Why it will not be dialled again; null while it may be. */
  gone: string | null
  lastFailure: string | null
  boards: Map<number, Board>
  byKey: Map<string, Board>
  watches: Map<number, { viewer: RemoteCanvasViewer; workspaceIds: Set<string> }>
  pending: Map<number, Pending>
  assembler: ReturnType<typeof createCanvasLaneAssembler>
}

const DEFAULT_RETRY = { baseMs: 1_000, maxMs: 30_000 }
const DEFAULT_LINGER_MS = 3_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

const CANVAS_ERROR_CODES: ReadonlySet<string> = new Set<CanvasErrorCode>([
  'no_workspace',
  'unknown_workspace',
  'forbidden',
  'invalid_path',
  'not_found',
  'invalid_scene',
  'invalid_edit',
  'unknown_element',
  'interrupted',
  'worker_unavailable',
  'timeout',
  'too_large',
  'fs_conflict',
])

const codeOf = (code: unknown): CanvasErrorCode =>
  typeof code === 'string' && CANVAS_ERROR_CODES.has(code) ? (code as CanvasErrorCode) : 'forbidden'

class LaneClosed extends Error {}

export function createTailnetRemoteCanvas(deps: TailnetRemoteCanvasDeps): TailnetRemoteCanvas {
  const sessions = new Map<string, Session>()
  const openSocket = deps.openSocket ?? openRemoteCanvasSocket
  const retry = deps.retry ?? DEFAULT_RETRY
  const lingerMs = deps.lingerMs ?? DEFAULT_LINGER_MS
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  let nextHandle = 1
  let nextRequest = 1
  let nextStream = 1
  let shutDown = false

  const machineOf = (connectionId: string): string => deps.connection(connectionId)?.machineName ?? 'That machine'
  const readOnlyWords = (connectionId: string): string =>
    `This pairing can look at boards on ${machineOf(connectionId)} but not change them. Pair again with workspace operate access to draw here.`

  function sessionFor(connectionId: string): Session {
    let session = sessions.get(connectionId)
    if (!session) {
      session = {
        connectionId,
        socket: null,
        dialing: null,
        retryTimer: null,
        attempt: 0,
        gone: null,
        lastFailure: null,
        boards: new Map(),
        byKey: new Map(),
        watches: new Map(),
        pending: new Map(),
        assembler: createCanvasLaneAssembler(),
      }
      sessions.set(connectionId, session)
    }
    return session
  }

  const remoteKey = (ref: CanvasLaneRef): string => `${ref.workspaceId}\u0000${ref.store ?? ''}\u0000${ref.path}`
  const localKey = (viewerId: number, ref: CanvasBoardRef): string =>
    `${viewerId}\u0000${ref.workspaceId}\u0000${ref.store ?? ''}\u0000${ref.path}`

  /** A window's ask, checked as the pane's own IPC checks it, and its far half beside it. */
  function readInput(
    input: RemoteCanvasBoardInput,
  ): CanvasResult<{ connectionId: string; local: CanvasBoardRef; remote: CanvasLaneRef }> {
    if (!isRecord(input)) return canvasFail('invalid_path', 'This call carried no board.')
    if (typeof input.connectionId !== 'string' || !input.connectionId)
      return canvasFail('unknown_workspace', 'This call named no paired machine.')
    if (typeof input.remoteWorkspaceId !== 'string' || !input.remoteWorkspaceId.trim())
      return canvasFail('no_workspace', 'This call named no chat on the paired machine.')
    const local = canvasRefOf({ workspaceId: input.workspaceId, path: input.path, store: input.store })
    if (!local.ok) return local
    return canvasOk({
      connectionId: input.connectionId,
      local: local.value,
      remote: {
        workspaceId: input.remoteWorkspaceId.trim(),
        path: local.value.path,
        ...(local.value.store ? { store: local.value.store } : {}),
      },
    })
  }

  function stateOf(board: Board): CanvasBoardState & { canEdit: boolean } {
    return {
      ...(board.id ? { id: board.id } : {}),
      path: board.path,
      revision: board.shown,
      elements: board.elements,
      appState: board.appState,
      files: board.files,
      canEdit: board.canEdit,
    }
  }

  // ------------------------------------------------------------ sending

  function send(session: Session, message: Record<string, unknown>): boolean {
    const socket = session.socket
    if (!socket?.isOpen()) return false
    for (const text of canvasLaneMessages(message, () => nextStream++)) socket.sendText(text)
    return true
  }

  function request(session: Session, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = nextRequest++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(new LaneClosed(`${machineOf(session.connectionId)} did not answer in time.`))
      }, requestTimeoutMs)
      timer.unref?.()
      session.pending.set(id, { resolve, reject, timer })
      if (!send(session, { ...message, id })) {
        clearTimeout(timer)
        session.pending.delete(id)
        reject(new LaneClosed(`${machineOf(session.connectionId)} is not connected.`))
      }
    })
  }

  // ------------------------------------------------------------ telling windows

  function tell(
    board: Board,
    channel: string,
    payload: (local: CanvasBoardRef) => Record<string, unknown>,
    except?: string,
  ) {
    for (const [key, hold] of board.holds) {
      if (key === except) continue
      hold.viewer.send(channel, { ...hold.local, ...payload(hold.local) })
    }
  }

  function pushScene(board: Board, origin: 'agent' | 'human' | 'disk', except?: string): void {
    tell(
      board,
      'canvas:scene',
      () => ({ revision: board.shown, elements: board.elements, files: board.files, origin }),
      except,
    )
  }

  function tellLink(session: Session, board: Board): void {
    const reconnecting = !session.socket?.isOpen()
    const state: RemoteCanvasLink['state'] =
      board.gone || session.gone ? 'gone' : reconnecting ? 'reconnecting' : 'live'
    const machine = machineOf(session.connectionId)
    const message =
      state === 'gone'
        ? (board.gone ?? session.gone)
        : state === 'reconnecting'
          ? `${machine} is out of reach. What you draw is kept here and saved there when it answers again.`
          : board.canEdit
            ? null
            : readOnlyWords(session.connectionId)
    tell(board, CANVAS_REMOTE_LINK_CHANNEL, () => ({ state, canEdit: board.canEdit && state !== 'gone', message }))
  }

  /** Move what the windows are told on to a far revision, never backwards. */
  function show(board: Board, remoteRevision: number, fresh: boolean): void {
    if (fresh) board.offset = board.shown + 1 - remoteRevision
    board.remoteRevision = remoteRevision
    board.shown = Math.max(board.shown, remoteRevision + board.offset)
  }

  /** The pictures the far machine holds now, and any this end sent it that it has yet to write. */
  function keepFiles(board: Board, fileIds: string[]): void {
    const held = new Set(fileIds)
    const kept: Record<string, unknown> = {}
    for (const [id, value] of Object.entries(board.files))
      if (held.has(id) || board.held?.files[id] !== undefined) kept[id] = value
    board.files = kept
    board.peerFiles = held
  }

  // ------------------------------------------------------------ the socket

  function onFrame(session: Session, frame: Record<string, unknown>): void {
    const assembled = session.assembler.push(frame)
    if (assembled.kind === 'error') {
      deps.log?.(`canvas lane: ${assembled.reason}`)
      session.socket?.close(assembled.reason)
      return
    }
    if (assembled.kind === 'pending') return
    const message = assembled.message
    if (message.type === 'opened' || message.type === 'committed') {
      const pending = typeof message.id === 'number' ? session.pending.get(message.id) : undefined
      if (!pending) return
      session.pending.delete(message.id as number)
      clearTimeout(pending.timer)
      pending.resolve(message)
      return
    }
    if (message.type === 'open-request') {
      if (typeof message.workspaceId !== 'string' || typeof message.path !== 'string') return
      for (const watch of session.watches.values()) {
        if (!watch.workspaceIds.has(message.workspaceId)) continue
        watch.viewer.send(CANVAS_REMOTE_OPEN_REQUEST_CHANNEL, {
          connectionId: session.connectionId,
          workspaceId: message.workspaceId,
          path: message.path,
          ...(typeof message.store === 'string' ? { store: message.store } : {}),
        })
      }
      return
    }
    if (message.type === 'access') {
      const canEdit = message.canEdit === true
      for (const board of session.boards.values()) {
        if (board.canEdit === canEdit) continue
        board.canEdit = canEdit
        tellLink(session, board)
      }
      return
    }
    const board = typeof message.board === 'number' ? session.boards.get(message.board) : undefined
    if (!board) return
    if (message.type === 'file') {
      if (typeof message.id !== 'string' || !message.id) return
      board.files[message.id] = message.value
      board.peerFiles.add(message.id)
      return
    }
    if (message.type === 'scene') {
      if (typeof message.revision !== 'number' || !Array.isArray(message.elements)) return
      // A scene the socket wrote before an answer this end has already taken:
      // the answer was newer, and it is what the windows hold.
      if (message.revision <= board.remoteRevision) return
      board.elements = message.elements as CanvasElement[]
      keepFiles(board, canvasLaneFileIds(message.fileIds))
      show(board, message.revision, false)
      pushScene(board, message.origin === 'human' ? 'human' : message.origin === 'disk' ? 'disk' : 'agent')
      return
    }
    if (message.type === 'presence') {
      const presence: CanvasPresence = {
        controller: message.controller === 'agent' || message.controller === 'human' ? message.controller : 'none',
        ...(typeof message.agentName === 'string' ? { agentName: message.agentName } : {}),
        ...(isRecord(message.pointer) && typeof message.pointer.x === 'number' && typeof message.pointer.y === 'number'
          ? { pointer: { x: message.pointer.x, y: message.pointer.y } }
          : {}),
        ...(Array.isArray(message.selectedElementIds)
          ? { selectedElementIds: canvasLaneFileIds(message.selectedElementIds) }
          : {}),
      }
      tell(board, 'canvas:presence', () => presence)
      return
    }
    if (message.type === 'closed') {
      board.gone = typeof message.message === 'string' ? message.message : 'That machine closed this board.'
      tellLink(session, board)
      removeBoard(session, board)
    }
  }

  function onClosed(session: Session, outcome: { code: number | null; reason: string }): void {
    session.socket = null
    session.assembler = createCanvasLaneAssembler()
    for (const [id, pending] of session.pending) {
      clearTimeout(pending.timer)
      pending.reject(new LaneClosed(outcome.reason))
      session.pending.delete(id)
    }
    for (const board of session.boards.values()) board.opened = false
    const machine = machineOf(session.connectionId)
    if (outcome.code === 4401)
      session.gone = `${machine} no longer accepts this pairing, so this board cannot be saved there. Pair again to keep drawing.`
    else if (outcome.code === 4403) session.gone = `This pairing may no longer look at boards on ${machine}.`
    for (const board of session.boards.values()) tellLink(session, board)
    if (!shutDown && !session.gone && wanted(session)) scheduleRetry(session)
  }

  /** Anything here still needs the socket: a board, a pending change, or a chat followed for `canvas.open`. */
  const wanted = (session: Session): boolean => session.boards.size > 0 || session.watches.size > 0

  function scheduleRetry(session: Session): void {
    if (session.retryTimer || shutDown) return
    const delay = Math.min(retry.maxMs, retry.baseMs * 2 ** session.attempt)
    session.attempt += 1
    session.retryTimer = setTimeout(() => {
      session.retryTimer = null
      void connect(session)
    }, delay)
    session.retryTimer.unref?.()
  }

  function connect(session: Session): Promise<boolean> {
    if (session.socket?.isOpen()) return Promise.resolve(true)
    if (session.gone) return Promise.resolve(false)
    if (session.dialing) return session.dialing
    session.dialing = (async () => {
      const connection = deps.connection(session.connectionId)
      if (!connection) {
        session.gone = 'That machine is not paired here any more.'
        return false
      }
      const handlers: RemoteJsonSocketHandlers = {
        onFrame: (frame) => onFrame(session, frame),
        onClosed: (outcome) => onClosed(session, outcome),
      }
      const opened = await openSocket({ endpoint: connection.endpoint, token: connection.token, handlers })
      if (shutDown) {
        if (opened.ok) opened.value.close('Shutting down.')
        return false
      }
      if (!opened.ok) {
        session.lastFailure = opened.message
        if (opened.code === 'unauthorized' || opened.code === 'workspace_scope_required') {
          session.gone = opened.message
          for (const board of session.boards.values()) tellLink(session, board)
        } else if (wanted(session)) scheduleRetry(session)
        return false
      }
      session.socket = opened.value
      session.attempt = 0
      session.lastFailure = null
      sendWatches(session)
      // Every board a window holds, or a change waits for, is opened again:
      // the far machine may have restarted, and the windows still show it.
      for (const board of [...session.boards.values()]) {
        if (board.holds.size === 0 && !board.held) continue
        void openOnPeer(session, board).then((answer) => {
          if (!answer.ok) {
            board.gone = answer.error.message
            tellLink(session, board)
          }
        })
      }
      return true
    })().finally(() => {
      session.dialing = null
    })
    return session.dialing
  }

  function sendWatches(session: Session): void {
    const workspaceIds = new Set<string>()
    for (const watch of session.watches.values()) for (const id of watch.workspaceIds) workspaceIds.add(id)
    send(session, { type: 'watch', workspaceIds: [...workspaceIds] })
  }

  function openOnPeer(session: Session, board: Board): Promise<CanvasResult<void>> {
    if (board.opened) return Promise.resolve(canvasOk(undefined))
    if (board.opening) return board.opening
    const fresh = board.everOpened
    board.opening = (async (): Promise<CanvasResult<void>> => {
      let answer: Record<string, unknown>
      try {
        answer = await request(session, {
          type: 'open',
          board: board.handle,
          ref: board.ref,
          ...(board.create ? { create: true } : {}),
          have: [...board.peerFiles].filter((id) => board.files[id] !== undefined),
        })
      } catch (error) {
        return canvasFail('forbidden', error instanceof Error ? error.message : String(error))
      }
      if (answer.ok !== true) {
        if (answer.code === 'read_only') return canvasFail('forbidden', readOnlyWords(session.connectionId))
        return canvasFail(
          codeOf(answer.code),
          typeof answer.message === 'string' ? answer.message : 'The board could not be opened.',
        )
      }
      const state = isRecord(answer.state) ? answer.state : {}
      board.opened = true
      board.everOpened = true
      board.create = false
      board.gone = null
      board.canEdit = answer.canEdit === true
      board.id = typeof state.id === 'string' ? state.id : board.id
      board.path = typeof state.path === 'string' ? state.path : board.path
      board.elements = Array.isArray(state.elements) ? (state.elements as CanvasElement[]) : []
      board.appState = isRecord(state.appState) ? state.appState : {}
      keepFiles(board, canvasLaneFileIds(answer.fileIds))
      show(board, typeof state.revision === 'number' ? state.revision : 0, fresh)
      if (fresh) {
        // Back after a drop: every window is handed the board as it stands,
        // which its editor reconciles with what the person drew meanwhile.
        pushScene(board, 'disk')
        tellLink(session, board)
      }
      if (board.held) await flushHeld(session, board)
      return canvasOk(undefined)
    })().finally(() => {
      board.opening = null
    })
    return board.opening
  }

  /** Send the pictures the far machine lacks, then the change that names them. */
  async function sendCommit(
    session: Session,
    board: Board,
    change: {
      baseRevision: number
      elements: CanvasElement[]
      appState: Record<string, unknown>
      files: Record<string, unknown>
    },
  ): Promise<Record<string, unknown>> {
    const sent: string[] = []
    for (const [id, value] of Object.entries(change.files)) {
      if (board.peerFiles.has(id)) continue
      if (!send(session, { type: 'file', board: board.handle, id, value })) throw new LaneClosed('not connected')
      sent.push(id)
    }
    const answer = await request(session, {
      type: 'commit',
      board: board.handle,
      baseRevision: change.baseRevision - board.offset,
      elements: change.elements,
      appState: change.appState,
    })
    if (answer.ok === true) for (const id of sent) board.peerFiles.add(id)
    return answer
  }

  /** The change kept while the machine was away, sent now; the windows hear what it merged into. */
  async function flushHeld(session: Session, board: Board): Promise<void> {
    const held = board.held
    if (!held || board.flushing) return
    board.held = null
    board.flushing = true
    let answer: Record<string, unknown>
    try {
      answer = await sendCommit(session, board, { baseRevision: board.shown, ...held })
    } catch {
      board.held = board.held ? mergeHeld(held, board.held) : held
      return
    } finally {
      board.flushing = false
    }
    // What was drawn while this was on its way goes next.
    if (board.held) void flushHeld(session, board)
    if (answer.ok !== true) {
      board.gone = typeof answer.message === 'string' ? answer.message : 'What you drew could not be saved there.'
      tellLink(session, board)
      return
    }
    if (typeof answer.revision === 'number') show(board, answer.revision, false)
    if (Array.isArray(answer.elements)) board.elements = answer.elements as CanvasElement[]
    pushScene(board, 'human')
    if (board.holds.size === 0) scheduleLinger(session, board)
  }

  const mergeHeld = (
    older: NonNullable<Board['held']>,
    newer: NonNullable<Board['held']>,
  ): NonNullable<Board['held']> => ({
    elements: mergeElements(older.elements, newer.elements),
    appState: newer.appState,
    files: { ...older.files, ...newer.files },
  })

  function removeBoard(session: Session, board: Board): void {
    if (board.linger) clearTimeout(board.linger)
    board.linger = null
    session.boards.delete(board.handle)
    if (session.byKey.get(board.key) === board) session.byKey.delete(board.key)
    send(session, { type: 'close', board: board.handle })
    settleSession(session)
  }

  /** A session nothing needs any more is closed, socket, timer and all. */
  function settleSession(session: Session): void {
    if (wanted(session)) return
    if (session.retryTimer) clearTimeout(session.retryTimer)
    session.retryTimer = null
    session.socket?.close('Nothing here holds its boards any more.')
    session.socket = null
    sessions.delete(session.connectionId)
  }

  function scheduleLinger(session: Session, board: Board): void {
    if (board.linger) clearTimeout(board.linger)
    board.linger = setTimeout(() => {
      board.linger = null
      if (board.holds.size > 0) return
      // A change still waiting for the machine keeps the board until it is sent.
      if (board.held) return
      removeBoard(session, board)
    }, lingerMs)
    board.linger.unref?.()
  }

  function boardOf(input: RemoteCanvasBoardInput): { session: Session; board: Board; local: CanvasBoardRef } | null {
    const read = readInput(input)
    if (!read.ok) return null
    const session = sessions.get(read.value.connectionId)
    const board = session?.byKey.get(remoteKey(read.value.remote))
    return session && board ? { session, board, local: read.value.local } : null
  }

  // ------------------------------------------------------------ the calls

  async function access(connectionId: unknown): Promise<RemoteCanvasAccess> {
    if (typeof connectionId !== 'string' || !deps.connection(connectionId))
      return { ok: false, message: 'That machine is not paired here.' }
    const pictures = `${machineOf(connectionId)} runs a Studio that shows its boards here as pictures only. Update SprintEngine Studio there to edit them here.`
    const answer = (capabilities: string[] | null, canEdit: boolean): RemoteCanvasAccess => {
      const live = tailnetPeerSupports(capabilities, 'canvas-live-boards')
      return { ok: true, live, canEdit, ...(live ? {} : { reason: pictures }) }
    }
    const identity = await deps.identity(connectionId)
    if (identity.ok) return answer(identity.value.capabilities, identity.value.scopes.includes('workspace:operate'))
    // Out of reach: what it last said decides which pane to draw, and the
    // pane says the machine is away once it tries.
    const known = deps.knownCapabilities(connectionId)
    if (known) return answer(known, true)
    return { ok: false, message: identity.message }
  }

  async function open(
    viewer: RemoteCanvasViewer,
    input: RemoteCanvasBoardInput & { create?: unknown },
  ): Promise<CanvasResult<CanvasBoardState & { canEdit: boolean }>> {
    if (shutDown) return canvasFail('worker_unavailable', 'The app is shutting down.')
    const read = readInput(input)
    if (!read.ok) return read
    const { connectionId, local, remote } = read.value
    if (!deps.connection(connectionId)) return canvasFail('unknown_workspace', 'That machine is not paired here.')
    let capabilities = deps.knownCapabilities(connectionId)
    if (capabilities === undefined) {
      const identity = await deps.identity(connectionId)
      if (identity.ok) capabilities = identity.value.capabilities
      else return canvasFail('forbidden', identity.message)
    }
    if (!tailnetPeerSupports(capabilities, 'canvas-live-boards'))
      return canvasFail(
        'forbidden',
        `${machineOf(connectionId)} runs a Studio that shows its boards as pictures only. Update it there to edit them here.`,
      )
    const session = sessionFor(connectionId)
    if (session.gone && session.boards.size === 0) session.gone = null
    const key = remoteKey(remote)
    let board = session.byKey.get(key)
    if (!board) {
      board = {
        handle: nextHandle++,
        key,
        ref: remote,
        holds: new Map(),
        opened: false,
        everOpened: false,
        opening: null,
        flushing: false,
        // A board named by its store is never made: the far service refuses
        // that itself, and asking would only blur its answer.
        create: input.create === true && !remote.store,
        id: undefined,
        path: remote.path,
        elements: [],
        appState: {},
        files: {},
        peerFiles: new Set(),
        remoteRevision: 0,
        shown: 0,
        offset: 0,
        canEdit: false,
        held: null,
        linger: null,
        gone: null,
      }
      session.boards.set(board.handle, board)
      session.byKey.set(key, board)
    }
    if (board.linger) clearTimeout(board.linger)
    board.linger = null
    const holdKey = localKey(viewer.id, local)
    board.holds.set(holdKey, { viewer, local })
    const release = (): void => {
      board!.holds.delete(holdKey)
      if (board!.holds.size === 0 && !board!.held) removeBoard(session, board!)
    }
    if (!(await connect(session))) {
      const reason = session.gone ?? session.lastFailure ?? `${machineOf(connectionId)} did not answer.`
      // A board this window already showed stays: the pane says it is away.
      if (board.shown > 0) return canvasOk(stateOf(board))
      release()
      return canvasFail('forbidden', reason)
    }
    const opened = await openOnPeer(session, board)
    if (!opened.ok) {
      release()
      return opened
    }
    return canvasOk(stateOf(board))
  }

  function close(viewer: RemoteCanvasViewer, input: RemoteCanvasBoardInput): void {
    const found = boardOf(input)
    if (!found) return
    found.board.holds.delete(localKey(viewer.id, found.local))
    // Not at once: a tab's last change is sent as it unmounts, and it may
    // arrive after the tab has said it is closing.
    if (found.board.holds.size === 0) scheduleLinger(found.session, found.board)
  }

  async function commit(
    viewer: RemoteCanvasViewer,
    input: RemoteCanvasBoardInput & { baseRevision?: unknown; elements?: unknown; appState?: unknown; files?: unknown },
  ): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>> {
    const found = boardOf(input)
    if (!found) return canvasFail('not_found', 'This board is not open from here.')
    const { session, board, local } = found
    if (session.gone || board.gone) return canvasFail('forbidden', board.gone ?? session.gone ?? '')
    if (!board.canEdit) return canvasFail('forbidden', readOnlyWords(session.connectionId))
    const checked = canvasCommitOf({
      ...local,
      baseRevision: input.baseRevision,
      elements: input.elements,
      appState: input.appState,
      files: input.files,
    })
    if (!checked.ok) return checked
    const change = checked.value
    const sender = localKey(viewer.id, local)
    board.elements = mergeElements(board.elements, change.elements)
    board.appState = change.appState
    board.files = { ...board.files, ...change.files }
    if (board.linger && board.holds.size === 0) scheduleLinger(session, board)
    const hold = (): CanvasResult<{ revision: number; elements: CanvasElement[] | null }> => {
      const next = { elements: change.elements, appState: change.appState, files: change.files }
      board.held = board.held ? mergeHeld(board.held, next) : next
      // The other windows show it at once; the machine hears it when it is back.
      pushScene(board, 'human', sender)
      if (session.socket?.isOpen()) {
        if (board.opened) void flushHeld(session, board)
      } else if (!session.retryTimer && !session.dialing) scheduleRetry(session)
      return canvasOk({ revision: board.shown, elements: null })
    }
    if (!session.socket?.isOpen() || !board.opened || board.held || board.flushing) return hold()
    let answer: Record<string, unknown>
    try {
      answer = await sendCommit(session, board, change)
    } catch (error) {
      if (error instanceof LaneClosed) return hold()
      throw error
    }
    if (answer.ok !== true) {
      if (answer.code === 'read_only') {
        board.canEdit = false
        tellLink(session, board)
        return canvasFail('forbidden', readOnlyWords(session.connectionId))
      }
      return canvasFail(
        codeOf(answer.code),
        typeof answer.message === 'string' ? answer.message : 'The change was not saved.',
      )
    }
    if (typeof answer.revision === 'number') show(board, answer.revision, false)
    const merged = Array.isArray(answer.elements) ? (answer.elements as CanvasElement[]) : null
    if (merged) board.elements = merged
    pushScene(board, 'human', sender)
    return canvasOk({ revision: board.shown, elements: merged })
  }

  function noteHumanInput(_viewer: RemoteCanvasViewer, input: RemoteCanvasBoardInput): void {
    const found = boardOf(input)
    if (!found || !found.board.canEdit || !found.board.opened) return
    send(found.session, { type: 'human', board: found.board.handle })
  }

  function snapshot(input: RemoteCanvasBoardInput) {
    const found = boardOf(input)
    if (!found) return canvasFail<never>('not_found', 'This board is not open from here.')
    const { board } = found
    const elements = mergeElements(board.elements, board.held?.elements ?? [])
    const referenced = new Set(
      elements.map((element) => element.fileId).filter((id): id is string => typeof id === 'string'),
    )
    const files = Object.fromEntries(
      Object.entries({ ...board.files, ...board.held?.files }).filter(([id]) => referenced.has(id)),
    )
    return canvasOk({
      name: canvasBoardName(board.path),
      elements,
      appState: board.held?.appState ?? board.appState,
      files,
    })
  }

  function watchInput(input: {
    connectionId: unknown
    workspaceId: unknown
  }): { connectionId: string; workspaceId: string } | null {
    if (!isRecord(input) || typeof input.connectionId !== 'string' || typeof input.workspaceId !== 'string') return null
    if (!input.workspaceId.trim() || !deps.connection(input.connectionId)) return null
    return { connectionId: input.connectionId, workspaceId: input.workspaceId.trim() }
  }

  function watch(viewer: RemoteCanvasViewer, input: { connectionId: unknown; workspaceId: unknown }): void {
    const read = watchInput(input)
    if (!read || shutDown) return
    // A machine without the lane has no `canvas.open` to tell of: its agent's
    // board is still named in the chat, which opens it here.
    if (!tailnetPeerSupports(deps.knownCapabilities(read.connectionId), 'canvas-live-boards')) return
    const session = sessionFor(read.connectionId)
    const watch = session.watches.get(viewer.id) ?? { viewer, workspaceIds: new Set<string>() }
    watch.workspaceIds.add(read.workspaceId)
    session.watches.set(viewer.id, watch)
    if (session.socket?.isOpen()) sendWatches(session)
    else void connect(session)
  }

  function unwatch(viewer: RemoteCanvasViewer, input: { connectionId: unknown; workspaceId: unknown }): void {
    const read = watchInput(input)
    if (!read) return
    const session = sessions.get(read.connectionId)
    const watch = session?.watches.get(viewer.id)
    if (!session || !watch) return
    watch.workspaceIds.delete(read.workspaceId)
    if (watch.workspaceIds.size === 0) session.watches.delete(viewer.id)
    sendWatches(session)
    settleSession(session)
  }

  function dropViewer(viewerId: number): void {
    for (const session of [...sessions.values()]) {
      session.watches.delete(viewerId)
      for (const board of [...session.boards.values()]) {
        for (const [key, hold] of [...board.holds]) if (hold.viewer.id === viewerId) board.holds.delete(key)
        if (board.holds.size === 0 && !board.linger) scheduleLinger(session, board)
      }
      if (session.socket?.isOpen()) sendWatches(session)
      settleSession(session)
    }
  }

  function forget(connectionId: string): void {
    const session = sessions.get(connectionId)
    if (!session) return
    session.gone = 'That machine is not paired here any more.'
    for (const board of session.boards.values()) {
      if (board.linger) clearTimeout(board.linger)
      tellLink(session, board)
    }
    session.boards.clear()
    session.byKey.clear()
    session.watches.clear()
    settleSession(session)
  }

  function shutdown(): void {
    shutDown = true
    for (const session of sessions.values()) {
      if (session.retryTimer) clearTimeout(session.retryTimer)
      for (const board of session.boards.values()) if (board.linger) clearTimeout(board.linger)
      session.socket?.close('Shutting down.')
    }
    sessions.clear()
  }

  return { access, open, close, commit, noteHumanInput, snapshot, watch, unwatch, dropViewer, forget, shutdown }
}
