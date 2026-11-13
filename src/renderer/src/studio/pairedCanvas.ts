import { StudioError, type StudioClient, type StudioClientState } from '../../../../packages/client-runtime/src/public'
import {
  STUDIO_CANVAS_BOARDS_CAPABILITY,
  STUDIO_CANVAS_LIMITS,
  studioGrantAllows,
  type StudioCanvasBoardNotice,
  type StudioCanvasRef,
} from '../../../../packages/studio-protocol/src/public'
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
import type { MeshCanvasBoard, MeshCanvasBoardsResult, MeshCanvasScreenshotResult } from '../../../shared/tailnet-mesh'
import { parseEnvironmentRoute } from '../../../../packages/studio-protocol/src/environment'
import {
  environmentRefusal,
  environmentStudios,
  onEnvironmentStudioForgotten,
  pairedTarget,
  withEnvironmentStudio,
  type EnvironmentHold,
  type EnvironmentStudios,
  type PairedMachine,
} from './environmentStudio'

// This desktop's half of a paired chat's Canvas pane: the boards of the
// machine the chat runs on, edited with the same editor and the same calls the
// pane makes for a board here (`canvas:open-board`, `canvas:commit-scene`, the
// `canvas:scene` and `canvas:presence` pushes), carried over that machine's
// Studio protocol (`canvas.*`, packages/studio-protocol/src/canvas.ts) on this
// window's own connection to it (environmentStudio.ts). The far machine's canvas
// service is the one owner of each board; this end keeps a copy of what it
// last read so a second tab, an export and a reconnect have something to read.
//
// A board several tabs hold is one `canvas.board` stream over there, and what
// one tab sends the others are told here, as the far service tells its own. The stream says only that the board moved; the scene is read with
// `canvas.read`, and only the pictures this end lacks with `canvas.files`, so
// each picture crosses once.
//
// The link drops. When it does the pane is told in words, what the person
// draws meanwhile is kept here and merged element by element into one pending
// change, and when the machine answers again its stream says `opened`, the
// board is read afresh and that change sent: nothing drawn while away is lost,
// as long as this app runs. A far restart begins its revisions again; what the
// windows are told never moves backwards.

/** What holds boards and hears their pushes: this window, in the app. */
export type PairedCanvasViewer = { id: number; send(channel: string, payload: unknown): void }

/** A far board as a window names it: its own ref, and where the board is over there. */
export type PairedCanvasBoardInput = {
  connectionId: unknown
  /** The chat's workspace on the far machine. */
  remoteWorkspaceId: unknown
  /** This window's workspace: pushes go out under its ref, as a board here's do. */
  workspaceId: unknown
  path: unknown
  store?: unknown
}

/** A paired board's link, told to what holds it: `CanvasRemoteLink`, under its own ref. */
export const PAIRED_CANVAS_LINK = 'paired-canvas:link'
/** A far agent's `canvas.open`, for a watched chat: `{ connectionId, workspaceId, path, store? }`. */
export const PAIRED_CANVAS_OPEN_REQUEST = 'paired-canvas:open-request'

export type PairedCanvas = {
  access(connectionId: unknown): Promise<CanvasRemoteAccess>
  open(
    viewer: PairedCanvasViewer,
    input: PairedCanvasBoardInput & { create?: unknown },
  ): Promise<CanvasResult<CanvasBoardState & { canEdit: boolean }>>
  close(viewer: PairedCanvasViewer, input: PairedCanvasBoardInput): void
  commit(
    viewer: PairedCanvasViewer,
    input: PairedCanvasBoardInput & { baseRevision?: unknown; elements?: unknown; appState?: unknown; files?: unknown },
  ): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>>
  noteHumanInput(viewer: PairedCanvasViewer, input: PairedCanvasBoardInput): void
  /** The board as this end last read it, with what it sent since: what an export writes. */
  snapshot(input: PairedCanvasBoardInput): CanvasResult<{
    name: string
    elements: CanvasElement[]
    appState: Record<string, unknown>
    files: Record<string, unknown>
  }>
  /** Follow a far chat's `canvas.open`, for the window showing it. */
  watch(viewer: PairedCanvasViewer, input: { connectionId: unknown; workspaceId: unknown }): void
  unwatch(viewer: PairedCanvasViewer, input: { connectionId: unknown; workspaceId: unknown }): void
  /** A window went away: everything it held is let go. */
  dropViewer(viewerId: number): void
  /** A pairing was removed: its boards go with it. */
  forget(connectionId: string): void
  shutdown(): void
}

export type PairedCanvasDeps = {
  /** Where a paired machine is and the token this desktop holds for it; null for one not paired here. */
  target(connectionId: string): PairedMachine | null
  studios: EnvironmentStudios
  /** How long a board nobody here shows is kept open, for the last change of a tab that just closed. */
  lingerMs?: number
  requestTimeoutMs?: number
  log?: (message: string) => void
}

type ViewerHold = { viewer: PairedCanvasViewer; local: CanvasBoardRef }
type Held = { elements: CanvasElement[]; appState: Record<string, unknown>; files: Record<string, unknown> }
type Origin = 'agent' | 'human' | 'disk'

type Board = {
  key: string
  ref: StudioCanvasRef
  holds: Map<string, ViewerHold>
  /** The stream over there; null until subscribed, and after it ended. */
  unsubscribe: (() => void) | null
  /** Settles the first open's wait. */
  firstOpen: ((answer: CanvasResult<void>) => void) | null
  opening: Promise<CanvasResult<void>> | null
  opened: boolean
  /** Opened once already: a later `opened` is a reconnect, and the windows are handed the board again. */
  everOpened: boolean
  /** Whether the first open may make the board; a reopen after a drop never does. */
  create: boolean
  reading: boolean
  /** A notice that came while a read was on its way: read once more after it, with this origin. */
  readAgain: Origin | null
  flushing: boolean
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
  held: Held | null
  linger: ReturnType<typeof setTimeout> | null
  gone: string | null
}

type Session = {
  connectionId: string
  hold: EnvironmentHold
  client: StudioClient | null
  state: StudioClientState | 'connecting'
  stopState: () => void
  /** Why it will not be reached again; null while it may be. */
  gone: string | null
  boards: Map<string, Board>
  watches: Map<number, { viewer: PairedCanvasViewer; workspaceIds: Set<string> }>
  stopWatch: (() => void) | null
}

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

/** A far refusal in the pane's own codes. */
function codeOf(code: string): CanvasErrorCode {
  if (code === 'invalid_params') return 'invalid_scene'
  if (code === 'conflict') return 'fs_conflict'
  return CANVAS_ERROR_CODES.has(code) ? (code as CanvasErrorCode) : 'forbidden'
}

/** A failure that is the link's, not the board's: the change is kept and sent when the machine is back. */
const isLinkFailure = (error: unknown): boolean =>
  !(error instanceof StudioError) || error.code === 'unavailable' || error.code === 'closed' || error.code === 'busy'

export function createPairedCanvas(deps: PairedCanvasDeps): PairedCanvas {
  const sessions = new Map<string, Session>()
  const lingerMs = deps.lingerMs ?? DEFAULT_LINGER_MS
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  /** What each machine last said it serves, for a pane asked about while it is away. */
  const lastAccess = new Map<string, { live: boolean; canEdit: boolean }>()
  let shutDown = false

  const machineOf = (connectionId: string): string => deps.target(connectionId)?.machineName ?? 'That machine'
  const readOnlyWords = (connectionId: string): string =>
    `This pairing can look at boards on ${machineOf(connectionId)} but not change them. Pair again with workspace operate access to draw here.`
  const goneWords = (connectionId: string): string =>
    `${machineOf(connectionId)} no longer accepts this pairing, so this board cannot be saved there. Pair again to keep drawing.`
  const outdatedWords = (connectionId: string): string =>
    `${machineOf(connectionId)} runs a Studio that does not serve its boards here. Update SprintEngine Studio there to edit them here.`

  function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StudioError('unavailable', what)), requestTimeoutMs)
      }),
    ]).finally(() => clearTimeout(timer))
  }

  function sessionFor(connectionId: string, target: PairedMachine): Session {
    let session = sessions.get(connectionId)
    if (session) return session
    const hold = deps.studios.hold(pairedTarget(target))
    const created: Session = {
      connectionId,
      hold,
      client: null,
      state: 'connecting',
      stopState: () => undefined,
      gone: null,
      boards: new Map(),
      watches: new Map(),
      stopWatch: null,
    }
    session = created
    created.stopState = hold.onState((state) => {
      created.state = state
      // Refused its credential (revoked, unpaired there) or closed for good:
      // nothing drawn here can be saved there until it is paired again.
      if (state === 'closed' || state === 'parked') {
        created.gone = goneWords(connectionId)
        for (const board of created.boards.values()) board.opened = false
      }
      for (const board of created.boards.values()) tellLink(created, board)
    })
    hold.client.then(
      (client) => {
        created.client = client
        if (created.state === 'connecting') created.state = client.state
      },
      (error: unknown) => {
        created.gone = environmentRefusal(pairedTarget(target), error).message
      },
    )
    sessions.set(connectionId, created)
    return created
  }

  async function clientOf(session: Session): Promise<StudioClient> {
    return (
      session.client ?? (await withTimeout(session.hold.client, `${machineOf(session.connectionId)} did not answer.`))
    )
  }

  const remoteKey = (ref: StudioCanvasRef): string => `${ref.workspaceId}\u0000${ref.store ?? ''}\u0000${ref.path}`
  const localKey = (viewerId: number, ref: CanvasBoardRef): string =>
    `${viewerId}\u0000${ref.workspaceId}\u0000${ref.store ?? ''}\u0000${ref.path}`

  /** A window's ask, checked as the pane's own IPC checks it, and its far half beside it. */
  function readInput(
    input: PairedCanvasBoardInput,
  ): CanvasResult<{ connectionId: string; local: CanvasBoardRef; remote: StudioCanvasRef }> {
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

  function pushScene(board: Board, origin: Origin, except?: string): void {
    tell(
      board,
      'canvas:scene',
      () => ({ revision: board.shown, elements: board.elements, files: board.files, origin }),
      except,
    )
  }

  function tellLink(session: Session, board: Board): void {
    const reconnecting = session.state !== 'open' && session.state !== 'connecting'
    const state: CanvasRemoteLink['state'] =
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
    tell(board, PAIRED_CANVAS_LINK, () => ({ state, canEdit: board.canEdit && state !== 'gone', message }))
  }

  /** Move what the windows are told on to a far revision, never backwards. */
  function show(board: Board, remoteRevision: number, fresh: boolean): void {
    if (fresh) board.offset = board.shown + 1 - remoteRevision
    board.remoteRevision = remoteRevision
    board.shown = Math.max(board.shown, remoteRevision + board.offset)
  }

  // ------------------------------------------------------------ reading the board

  /** The board as it stands over there, with the pictures this end lacks; null when the read failed. */
  async function readBoard(session: Session, board: Board): Promise<{ revision: number } | null> {
    try {
      const client = await clientOf(session)
      const state = await withTimeout(
        client.request('canvas.read', board.ref),
        `${machineOf(session.connectionId)} did not answer in time.`,
      )
      let wanted = state.fileIds.filter((id) => board.files[id] === undefined)
      const fetched: Record<string, unknown> = {}
      while (wanted.length > 0) {
        const answer = await withTimeout(
          client.request('canvas.files', { ...board.ref, ids: wanted.slice(0, STUDIO_CANVAS_LIMITS.filesPerAsk) }),
          `${machineOf(session.connectionId)} did not answer in time.`,
        )
        Object.assign(fetched, answer.files)
        const asked = new Set(wanted.slice(0, STUDIO_CANVAS_LIMITS.filesPerAsk))
        wanted = [...answer.more, ...wanted.filter((id) => !asked.has(id))]
        if (Object.keys(answer.files).length === 0 && answer.more.length > 0) break
      }
      board.id = state.id ?? board.id
      board.path = state.path
      board.elements = state.elements as CanvasElement[]
      board.appState = state.appState
      const held = new Set(state.fileIds)
      const files: Record<string, unknown> = {}
      for (const [id, value] of Object.entries({ ...board.files, ...fetched }))
        if (held.has(id) || board.held?.files[id] !== undefined) files[id] = value
      board.files = files
      board.peerFiles = held
      return { revision: state.revision }
    } catch (error) {
      deps.log?.(`canvas: reading ${board.ref.path} on ${machineOf(session.connectionId)} failed: ${String(error)}`)
      return null
    }
  }

  /** A write over there: read it once, however many notices arrive while the read is on its way. */
  async function follow(session: Session, board: Board, origin: Origin): Promise<void> {
    if (board.reading) {
      board.readAgain = origin
      return
    }
    board.reading = true
    try {
      const read = await readBoard(session, board)
      if (read && read.revision > board.remoteRevision) {
        show(board, read.revision, false)
        pushScene(board, origin)
      }
    } finally {
      board.reading = false
    }
    const again = board.readAgain
    board.readAgain = null
    if (again && sessions.get(session.connectionId) === session && session.boards.get(board.key) === board)
      await follow(session, board, again)
  }

  async function onOpened(session: Session, board: Board, notice: { revision: number; canEdit: boolean }) {
    const fresh = board.everOpened
    board.canEdit = notice.canEdit
    board.reading = true
    let read: { revision: number } | null
    try {
      read = await readBoard(session, board)
    } finally {
      board.reading = false
    }
    if (!read) {
      board.firstOpen?.(canvasFail('forbidden', `${machineOf(session.connectionId)} did not hand over the board.`))
      board.firstOpen = null
      return
    }
    board.opened = true
    board.everOpened = true
    board.create = false
    board.gone = null
    show(board, read.revision, fresh)
    if (fresh) {
      // Back after a drop: every window is handed the board as it stands,
      // which its editor reconciles with what the person drew meanwhile.
      pushScene(board, 'disk')
      tellLink(session, board)
    }
    board.firstOpen?.(canvasOk(undefined))
    board.firstOpen = null
    if (board.held) await flushHeld(session, board)
    const again = board.readAgain
    board.readAgain = null
    if (again) await follow(session, board, again)
  }

  function onNotice(session: Session, board: Board, notice: StudioCanvasBoardNotice): void {
    if (notice.type === 'opened') {
      void onOpened(session, board, notice)
      return
    }
    if (notice.type === 'scene') {
      if (!board.opened) {
        board.readAgain = notice.origin
        return
      }
      if (notice.revision > board.remoteRevision) void follow(session, board, notice.origin)
      return
    }
    const presence: CanvasPresence = {
      controller: notice.controller,
      ...(notice.agentName ? { agentName: notice.agentName } : {}),
      ...(notice.pointer ? { pointer: notice.pointer } : {}),
      ...(notice.selectedElementIds ? { selectedElementIds: notice.selectedElementIds } : {}),
    }
    tell(board, 'canvas:presence', () => presence)
  }

  /** Subscribe the board's stream over there, once; settles at its first `opened`, or why not. */
  function openOnPeer(session: Session, board: Board): Promise<CanvasResult<void>> {
    if (board.opened) return Promise.resolve(canvasOk(undefined))
    if (board.opening) return board.opening
    board.opening = (async (): Promise<CanvasResult<void>> => {
      let client: StudioClient
      try {
        client = await clientOf(session)
      } catch (error) {
        return canvasFail('forbidden', environmentRefusal({ name: machineOf(session.connectionId) }, error).message)
      }
      if (!client.supports(STUDIO_CANVAS_BOARDS_CAPABILITY))
        return canvasFail('forbidden', outdatedWords(session.connectionId))
      const opened = new Promise<CanvasResult<void>>((resolve) => {
        board.firstOpen = resolve
        setTimeout(() => {
          if (board.firstOpen !== resolve) return
          board.firstOpen = null
          resolve(canvasFail('timeout', `${machineOf(session.connectionId)} did not answer in time.`))
        }, requestTimeoutMs)
      })
      board.unsubscribe = client.subscribe(
        'canvas.board',
        { ...board.ref, ...(board.create ? { create: true } : {}) },
        {
          onPayload: (notice) => onNotice(session, board, notice),
          onEnd: (error) => {
            board.unsubscribe = null
            const code = error?.code
            const message =
              code === 'scope_required'
                ? `This pairing may no longer look at boards on ${machineOf(session.connectionId)}.`
                : code === 'revoked' || code === 'unauthorized' || code === 'peer_mismatch'
                  ? goneWords(session.connectionId)
                  : (error?.message ?? 'That machine closed this board.')
            if (board.firstOpen) {
              board.firstOpen(
                error?.code === 'not_found' ? canvasFail('not_found', message) : canvasFail('forbidden', message),
              )
              board.firstOpen = null
              return
            }
            board.gone = message
            board.opened = false
            tellLink(session, board)
          },
        },
      )
      const answer = await opened
      if (!answer.ok) {
        board.unsubscribe?.()
        board.unsubscribe = null
      }
      return answer
    })().finally(() => {
      board.opening = null
    })
    return board.opening
  }

  // ------------------------------------------------------------ writing

  /** The pictures the far machine lacks, then the change that names them: inline, or staged in parts. */
  async function sendCommit(
    session: Session,
    board: Board,
    change: Held & { baseRevision: number },
  ): Promise<{ revision: number; elements: CanvasElement[] | null }> {
    const client = await clientOf(session)
    const files = Object.fromEntries(Object.entries(change.files).filter(([id]) => !board.peerFiles.has(id)))
    const body = { elements: change.elements, appState: change.appState, files }
    const base = {
      ...board.ref,
      commandId: `canvas-${crypto.randomUUID()}`,
      baseRevision: Math.max(0, change.baseRevision - board.offset),
    }
    const text = JSON.stringify(body)
    let answer: { revision: number; elements: unknown[] | null }
    if (Buffer.byteLength(text, 'utf8') <= STUDIO_CANVAS_LIMITS.inlineBodyBytes) {
      answer = await withTimeout(
        client.request('canvas.commit', { ...base, body: body as never }),
        `${machineOf(session.connectionId)} did not answer in time.`,
      )
    } else {
      const stageId = `stage-${crypto.randomUUID()}`
      const size = STUDIO_CANVAS_LIMITS.stagePartChars
      const total = Math.ceil(text.length / size)
      for (let index = 0; index < total; index += 1)
        await withTimeout(
          client.request('canvas.stage', {
            ...board.ref,
            stageId,
            index,
            total,
            text: text.slice(index * size, (index + 1) * size),
          }),
          `${machineOf(session.connectionId)} did not answer in time.`,
        )
      answer = await withTimeout(
        client.request('canvas.commit', { ...base, stageId }),
        `${machineOf(session.connectionId)} did not answer in time.`,
      )
    }
    for (const id of Object.keys(files)) board.peerFiles.add(id)
    return { revision: answer.revision, elements: answer.elements as CanvasElement[] | null }
  }

  const mergeHeld = (older: Held, newer: Held): Held => ({
    elements: mergeElements(older.elements, newer.elements),
    appState: newer.appState,
    files: { ...older.files, ...newer.files },
  })

  /** The change kept while the machine was away, sent now; the windows hear what it merged into. */
  async function flushHeld(session: Session, board: Board): Promise<void> {
    const held = board.held
    if (!held || board.flushing) return
    board.held = null
    board.flushing = true
    let answer: { revision: number; elements: CanvasElement[] | null }
    try {
      answer = await sendCommit(session, board, { baseRevision: board.shown, ...held })
    } catch (error) {
      if (isLinkFailure(error)) {
        board.held = board.held ? mergeHeld(held, board.held) : held
        return
      }
      board.gone = error instanceof Error ? error.message : 'What you drew could not be saved there.'
      tellLink(session, board)
      return
    } finally {
      board.flushing = false
    }
    // What was drawn while this was on its way goes next.
    if (board.held) void flushHeld(session, board)
    show(board, answer.revision, false)
    if (answer.elements) board.elements = answer.elements
    pushScene(board, 'human')
    if (board.holds.size === 0) scheduleLinger(session, board)
  }

  function removeBoard(session: Session, board: Board): void {
    if (board.linger) clearTimeout(board.linger)
    board.linger = null
    board.firstOpen?.(canvasFail('interrupted', 'The board was closed.'))
    board.firstOpen = null
    board.unsubscribe?.()
    board.unsubscribe = null
    if (session.boards.get(board.key) === board) session.boards.delete(board.key)
    settleSession(session)
  }

  /** Anything here still needs the connection: a board, a pending change, or a chat followed for `canvas.open`. */
  const wanted = (session: Session): boolean => session.boards.size > 0 || session.watches.size > 0

  /** A session nothing needs any more lets go of its connection. */
  function settleSession(session: Session): void {
    if (wanted(session)) return
    session.stopWatch?.()
    session.stopWatch = null
    session.stopState()
    session.hold.release()
    if (sessions.get(session.connectionId) === session) sessions.delete(session.connectionId)
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
  }

  function boardOf(input: PairedCanvasBoardInput): { session: Session; board: Board; local: CanvasBoardRef } | null {
    const read = readInput(input)
    if (!read.ok) return null
    const session = sessions.get(read.value.connectionId)
    const board = session?.boards.get(remoteKey(read.value.remote))
    return session && board ? { session, board, local: read.value.local } : null
  }

  // ------------------------------------------------------------ following a chat's canvas.open

  function sendWatches(session: Session): void {
    const workspaceIds = new Set<string>()
    for (const watch of session.watches.values()) for (const id of watch.workspaceIds) workspaceIds.add(id)
    session.stopWatch?.()
    session.stopWatch = null
    if (workspaceIds.size === 0) return
    const ids = [...workspaceIds].slice(0, STUDIO_CANVAS_LIMITS.watchedWorkspaces)
    void clientOf(session).then(
      (client) => {
        // A machine without boards has no `canvas.open` to tell of: its agent's
        // board is still named in the chat, which opens it here.
        if (!client.supports(STUDIO_CANVAS_BOARDS_CAPABILITY) || sessions.get(session.connectionId) !== session) return
        session.stopWatch?.()
        session.stopWatch = client.subscribe(
          'canvas.openRequests',
          { workspaceIds: ids },
          {
            onPayload: (ref) => {
              for (const watch of session.watches.values()) {
                if (!watch.workspaceIds.has(ref.workspaceId)) continue
                watch.viewer.send(PAIRED_CANVAS_OPEN_REQUEST, { connectionId: session.connectionId, ...ref })
              }
            },
          },
        )
      },
      () => undefined,
    )
  }

  function watchInput(input: {
    connectionId: unknown
    workspaceId: unknown
  }): { connectionId: string; workspaceId: string; target: PairedMachine } | null {
    if (!isRecord(input) || typeof input.connectionId !== 'string' || typeof input.workspaceId !== 'string') return null
    const target = deps.target(input.connectionId)
    if (!input.workspaceId.trim() || !target) return null
    return { connectionId: input.connectionId, workspaceId: input.workspaceId.trim(), target }
  }

  // ------------------------------------------------------------ the calls

  async function access(connectionId: unknown): Promise<CanvasRemoteAccess> {
    const target = typeof connectionId === 'string' ? deps.target(connectionId) : null
    if (typeof connectionId !== 'string' || !target) return { ok: false, message: 'That machine is not paired here.' }
    try {
      const known = await deps.studios.ask(pairedTarget(target), async (client) => ({
        live: client.supports(STUDIO_CANVAS_BOARDS_CAPABILITY),
        canEdit: studioGrantAllows(client.grant, 'canvas.commit'),
      }))
      lastAccess.set(connectionId, known)
      return { ok: true, ...known, ...(known.live ? {} : { reason: outdatedWords(connectionId) }) }
    } catch (error) {
      const refusal = environmentRefusal(pairedTarget(target), error)
      if (refusal.kind === 'outdated')
        return { ok: true, live: false, canEdit: false, reason: outdatedWords(connectionId) }
      // Out of reach: what it last said decides which pane to draw, and the
      // pane says the machine is away once it tries.
      const known = lastAccess.get(connectionId)
      if (known && refusal.kind === 'unavailable') return { ok: true, ...known }
      return { ok: false, message: refusal.message }
    }
  }

  async function open(
    viewer: PairedCanvasViewer,
    input: PairedCanvasBoardInput & { create?: unknown },
  ): Promise<CanvasResult<CanvasBoardState & { canEdit: boolean }>> {
    if (shutDown) return canvasFail('worker_unavailable', 'The app is shutting down.')
    const read = readInput(input)
    if (!read.ok) return read
    const { connectionId, local, remote } = read.value
    const target = deps.target(connectionId)
    if (!target) return canvasFail('unknown_workspace', 'That machine is not paired here.')
    const session = sessionFor(connectionId, target)
    if (session.gone && session.boards.size === 0) {
      // A machine refused before: ask afresh.
      sessions.delete(connectionId)
      session.stopState()
      session.hold.release()
      return open(viewer, input)
    }
    const key = remoteKey(remote)
    let board = session.boards.get(key)
    if (!board) {
      board = {
        key,
        ref: remote,
        holds: new Map(),
        unsubscribe: null,
        firstOpen: null,
        opening: null,
        opened: false,
        everOpened: false,
        // A board named by its store is never made: the far service refuses
        // that itself, and asking would only blur its answer.
        create: input.create === true && !remote.store,
        reading: false,
        readAgain: null,
        flushing: false,
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
      session.boards.set(key, board)
    }
    if (board.linger) clearTimeout(board.linger)
    board.linger = null
    const holdKey = localKey(viewer.id, local)
    board.holds.set(holdKey, { viewer, local })
    const opened = await openOnPeer(session, board)
    if (!opened.ok) {
      // A board this window already showed stays: the pane says it is away.
      if (board.shown > 0) return canvasOk(stateOf(board))
      board.holds.delete(holdKey)
      if (board.holds.size === 0 && !board.held) removeBoard(session, board)
      return opened
    }
    return canvasOk(stateOf(board))
  }

  function close(viewer: PairedCanvasViewer, input: PairedCanvasBoardInput): void {
    const found = boardOf(input)
    if (!found) return
    found.board.holds.delete(localKey(viewer.id, found.local))
    // Not at once: a tab's last change is sent as it unmounts, and it may
    // arrive after the tab has said it is closing.
    if (found.board.holds.size === 0) scheduleLinger(found.session, found.board)
  }

  async function commit(
    viewer: PairedCanvasViewer,
    input: PairedCanvasBoardInput & { baseRevision?: unknown; elements?: unknown; appState?: unknown; files?: unknown },
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
      if (session.state === 'open' && board.opened) void flushHeld(session, board)
      return canvasOk({ revision: board.shown, elements: null })
    }
    if (session.state !== 'open' || !board.opened || board.held || board.flushing) return hold()
    let answer: { revision: number; elements: CanvasElement[] | null }
    try {
      answer = await sendCommit(session, board, change)
    } catch (error) {
      if (isLinkFailure(error)) return hold()
      const studio = error as StudioError
      if (studio.code === 'scope_required') {
        board.canEdit = false
        tellLink(session, board)
        return canvasFail('forbidden', readOnlyWords(session.connectionId))
      }
      return canvasFail(codeOf(studio.code), studio.message || 'The change was not saved.')
    }
    show(board, answer.revision, false)
    if (answer.elements) board.elements = answer.elements
    pushScene(board, 'human', sender)
    return canvasOk({ revision: board.shown, elements: answer.elements })
  }

  function noteHumanInput(_viewer: PairedCanvasViewer, input: PairedCanvasBoardInput): void {
    const found = boardOf(input)
    if (!found || !found.board.canEdit || !found.board.opened || found.session.state !== 'open') return
    const client = found.session.client
    void client?.request('canvas.takePen', found.board.ref).catch(() => undefined)
  }

  function snapshot(input: PairedCanvasBoardInput) {
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

  function watch(viewer: PairedCanvasViewer, input: { connectionId: unknown; workspaceId: unknown }): void {
    const read = watchInput(input)
    if (!read || shutDown) return
    const session = sessionFor(read.connectionId, read.target)
    const watching = session.watches.get(viewer.id) ?? { viewer, workspaceIds: new Set<string>() }
    if (watching.workspaceIds.has(read.workspaceId)) return
    watching.workspaceIds.add(read.workspaceId)
    session.watches.set(viewer.id, watching)
    sendWatches(session)
  }

  function unwatch(viewer: PairedCanvasViewer, input: { connectionId: unknown; workspaceId: unknown }): void {
    const read = watchInput(input)
    if (!read) return
    const session = sessions.get(read.connectionId)
    const watching = session?.watches.get(viewer.id)
    if (!session || !watching) return
    watching.workspaceIds.delete(read.workspaceId)
    if (watching.workspaceIds.size === 0) session.watches.delete(viewer.id)
    sendWatches(session)
    settleSession(session)
  }

  function dropViewer(viewerId: number): void {
    for (const session of [...sessions.values()]) {
      const watched = session.watches.delete(viewerId)
      for (const board of [...session.boards.values()]) {
        for (const [key, hold] of [...board.holds]) if (hold.viewer.id === viewerId) board.holds.delete(key)
        if (board.holds.size === 0 && !board.linger) scheduleLinger(session, board)
      }
      if (watched) sendWatches(session)
      settleSession(session)
    }
  }

  function forget(connectionId: string): void {
    const session = sessions.get(connectionId)
    lastAccess.delete(connectionId)
    if (!session) return
    session.gone = 'That machine is not paired here any more.'
    for (const board of [...session.boards.values()]) {
      tellLink(session, board)
      board.held = null
      removeBoard(session, board)
    }
    session.watches.clear()
    settleSession(session)
  }

  function shutdown(): void {
    shutDown = true
    for (const session of [...sessions.values()]) {
      session.watches.clear()
      for (const board of [...session.boards.values()]) {
        board.held = null
        removeBoard(session, board)
      }
      settleSession(session)
    }
    sessions.clear()
  }

  return { access, open, close, commit, noteHumanInput, snapshot, watch, unwatch, dropViewer, forget, shutdown }
}

// ── This window's paired boards ─────────────────────────────────────────────
//
// One coordinator per window, over the window's own clients of its paired
// machines; what it pushes (`canvas:scene`, `canvas:presence`, the link and an
// agent's open request) is heard here, in the window, by the tab and the
// editor, as a board here's pushes are heard from main.

type PushListener = (payload: unknown) => void
const pushListeners = new Map<string, Set<PushListener>>()

/** Hear what this window's paired boards push on one channel. Returns the unsubscriber. */
export function onPairedCanvasPush(channel: string, listener: PushListener): () => void {
  let set = pushListeners.get(channel)
  if (!set) pushListeners.set(channel, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}

/** This window, as the coordinator's one viewer. */
export const WINDOW_CANVAS_VIEWER: PairedCanvasViewer = {
  id: 1,
  send(channel, payload) {
    for (const listener of [...(pushListeners.get(channel) ?? [])]) listener(payload)
  },
}

const machineNames = new Map<string, string>()
let windowCanvas: PairedCanvas | null = null

/**
 * This window's coordinator of its paired boards, made on first use. A
 * machine named here is the name its words use; a pairing forgotten here
 * takes its boards with it.
 */
export function windowPairedCanvas(machine?: PairedMachine): PairedCanvas {
  if (machine) machineNames.set(machine.id, machine.machineName)
  if (windowCanvas) return windowCanvas
  const made = createPairedCanvas({
    target: (connectionId) => ({ id: connectionId, machineName: machineNames.get(connectionId) ?? 'That machine' }),
    studios: environmentStudios(),
  })
  onEnvironmentStudioForgotten((route) => {
    const forgotten = parseEnvironmentRoute(route)
    if (forgotten?.kind === 'tailnet') made.forget(forgotten.connection)
  })
  windowCanvas = made
  return made
}

/** A far refusal of a board list or picture, in words about boards. */
function boardsRefused(machine: PairedMachine, error: unknown): { ok: false; code: string; message: string } {
  const refused = environmentRefusal(pairedTarget(machine), error)
  return {
    ok: false,
    code: refused.code,
    message:
      refused.kind === 'outdated'
        ? `${machine.machineName} runs a Studio that does not serve its boards here. Update SprintEngine Studio there.`
        : refused.code === 'unavailable' && /does not serve canvas/u.test(refused.message)
          ? `${machine.machineName} is not offering its boards right now. Open SprintEngine Studio there and try again.`
          : refused.message,
  }
}

/** A paired machine's boards: the chat's project's there, or (`machine`) every board on it. */
export async function listPairedBoards(
  machine: PairedMachine,
  workspaceId: string,
  scope: 'workspace' | 'machine',
): Promise<MeshCanvasBoardsResult> {
  if (!workspaceId) return { ok: false, code: 'invalid_arguments', message: 'Name the workspace whose boards to list.' }
  const allBoards = scope === 'machine'
  try {
    const listed = await withEnvironmentStudio(pairedTarget(machine), (client) =>
      client.request('canvas.list', { workspaceId }),
    )
    const boards: MeshCanvasBoard[] = listed.boards
      .filter((board) => allBoards || board.here)
      .map((board) => ({
        id: board.id,
        path: board.path,
        name: board.name,
        project: board.project,
        workspaceId: allBoards ? board.workspaceId : workspaceId,
        modifiedAt: board.modifiedAt,
        elementCount: board.elementCount,
        here: board.here,
      }))
    return { ok: true, boards, allBoards, note: listed.note }
  } catch (error) {
    return boardsRefused(machine, error)
  }
}

/** A picture of one of a paired machine's boards, named by its id. */
export async function pairedBoardPicture(
  machine: PairedMachine,
  input: { workspaceId: string; board: string; dark: boolean },
): Promise<MeshCanvasScreenshotResult> {
  if (!input.workspaceId || !input.board)
    return { ok: false, code: 'invalid_arguments', message: 'Name the board to show.' }
  try {
    const picture = await withEnvironmentStudio(
      pairedTarget(machine),
      (client) => client.request('canvas.picture', input),
      // Drawn in a hidden window over there; the picture's own wait, not a read's.
      { timeoutMs: 45_000 },
    )
    return {
      ok: true,
      mimeType: picture.mimeType,
      data: picture.dataBase64,
      width: picture.width,
      height: picture.height,
    }
  } catch (error) {
    return boardsRefused(machine, error)
  }
}
