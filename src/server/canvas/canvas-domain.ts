import {
  STUDIO_CANVAS_LIMITS,
  parseStudioCanvasCommitBody,
  type StudioCanvasBoard,
  type StudioCanvasBoardNotice,
  type StudioCanvasCommitBody,
  type StudioCanvasElement,
  type StudioCanvasRef,
  type StudioCanvasRefusalCode,
  type StudioCanvasState,
} from '../../../packages/studio-protocol/src/public'
import { canvasCommitOf, canvasRefOf } from '../../shared/canvas/commit-checks'
import type {
  CanvasBoardRef,
  CanvasBoardState,
  CanvasElement,
  CanvasErrorCode,
  CanvasPresence,
  CanvasResult,
} from '../../shared/canvas/types'
import type { McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'

// A machine's Canvas boards for a client on another device (`canvas.*`,
// packages/studio-protocol/src/canvas.ts), served from the machine's one
// canvas service: the same service its windows draw through and its agents'
// canvas tools write through. A board a client holds open is a subscriber of
// that service, so two people drawing at once (one here, one on a paired
// desktop) are merged element by element, and each is told of the other's
// writes and of who holds the pen.
//
// What goes out on a board's stream is a notice: opened, a revision, a
// presence. The scene and its pictures are read by request, so a stream frame
// is never larger than a presence, a slow reader catches up with one read, and
// a picture is sent only to a client that asks for it by id.
//
// The list and the picture are the gateway's own `canvas.list` and
// `canvas.screenshot` tools, asked with no connection context, so a client on
// the protocol and an agent on MCP read one thing.

/**
 * What this needs of the machine's canvas: its service's pane-side calls, and
 * its tools. Every call about a board, the tools' included, is held to where
 * the board's file really is, links followed, as it is for any client on
 * another device; `confine` is that check alone.
 */
export type StudioCanvasHost = {
  /** Whether the board's file really is inside the folder its ref is held to. */
  confine(ref: CanvasBoardRef): Promise<CanvasResult<void>>
  /** A subscriber of the service; what it pushes for that subscriber reaches `deliver`. */
  subscribe(deliver: (channel: string, payload: unknown) => void): number
  /** The subscriber is gone: the service stops pushing to it. */
  unsubscribe(subscriberId: number): void
  /** An agent's `canvas.open`, for the clients that follow its workspace. */
  onOpenRequest(listener: (ref: CanvasBoardRef) => void): () => void
  openBoard(
    ref: CanvasBoardRef,
    opts: { create: boolean; subscriberId: number },
  ): Promise<CanvasResult<CanvasBoardState>>
  readBoard(ref: CanvasBoardRef): Promise<CanvasResult<CanvasBoardState>>
  commitScene(
    input: CanvasBoardRef & {
      baseRevision: number
      elements: CanvasElement[]
      appState: Record<string, unknown>
      files: Record<string, unknown>
    },
    subscriberId: number,
  ): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>>
  noteHumanInput(ref: CanvasBoardRef, subscriberId?: number): void
  /** The gateway's canvas tools: `canvas.list` and `canvas.screenshot` are read. */
  tools(): McpToolRegistration[]
}

export type StudioCanvasRefusal = {
  code: StudioCanvasRefusalCode | 'too_large' | 'unavailable' | 'invalid_params'
  message: string
}
export type StudioCanvasAnswer<T> = ({ ok: true } & { value: T }) | ({ ok: false } & StudioCanvasRefusal)

export type StudioCanvasOpened = { close(): void }

export type StudioCanvasDomain = {
  /** Open a board for one stream: notices go to `notify` until `close`. */
  open(
    connectionId: string,
    params: StudioCanvasRef & { create?: boolean },
    canEdit: boolean,
    notify: (notice: StudioCanvasBoardNotice) => void,
  ): Promise<StudioCanvasAnswer<StudioCanvasOpened>>
  onOpenRequest(listener: (ref: StudioCanvasRef) => void): () => void
  list(workspaceId?: string): Promise<StudioCanvasAnswer<{ boards: StudioCanvasBoard[]; note: string | null }>>
  picture(params: {
    board: string
    workspaceId?: string
    maxEdge?: number
    dark?: boolean
  }): Promise<StudioCanvasAnswer<{ mimeType: string; dataBase64: string; width: number; height: number }>>
  read(ref: StudioCanvasRef): Promise<StudioCanvasAnswer<StudioCanvasState>>
  files(
    ref: StudioCanvasRef,
    ids: string[],
  ): Promise<StudioCanvasAnswer<{ files: Record<string, unknown>; more: string[]; missing: string[] }>>
  stage(
    connectionId: string,
    params: StudioCanvasRef & { stageId: string; index: number; total: number; text: string },
  ): Promise<StudioCanvasAnswer<{ received: number }>>
  commit(
    connectionId: string,
    params: StudioCanvasRef & { baseRevision: number; body?: StudioCanvasCommitBody; stageId?: string },
  ): Promise<StudioCanvasAnswer<{ revision: number; elements: StudioCanvasElement[] | null }>>
  takePen(connectionId: string, ref: StudioCanvasRef): void
  /** A connection closed: what it staged goes. Its boards close with its streams. */
  connectionClosed(connectionId: string): void
  close(): void
}

/** How long a stage nobody commits is kept. */
const STAGE_TTL_MS = 5 * 60_000

type Stage = {
  key: string
  total: number
  parts: Map<number, string>
  bytes: number
  timer: ReturnType<typeof setTimeout>
}

const CODES: Readonly<Record<CanvasErrorCode, StudioCanvasRefusal['code']>> = {
  no_workspace: 'not_found',
  unknown_workspace: 'not_found',
  not_found: 'not_found',
  forbidden: 'invalid_params',
  invalid_path: 'invalid_params',
  invalid_scene: 'invalid_params',
  invalid_edit: 'invalid_params',
  unknown_element: 'invalid_params',
  too_large: 'too_large',
  fs_conflict: 'conflict',
  interrupted: 'unavailable',
  worker_unavailable: 'unavailable',
  timeout: 'unavailable',
}

function refused<T>(error: { code: CanvasErrorCode; message: string }): StudioCanvasAnswer<T> {
  return { ok: false, code: CODES[error.code] ?? 'unavailable', message: error.message }
}

const keyOf = (ref: CanvasBoardRef): string => `${ref.workspaceId}\u0000${ref.store ?? ''}\u0000${ref.path}`

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A tool's answer: its structured content, or its refusal in its own words. */
function toolAnswer(result: McpToolResult): StudioCanvasAnswer<Record<string, unknown>> {
  const structured = result.structuredContent
  const error = record(structured?.error) ? structured.error : null
  if (result.isError || error || !structured) {
    const code = typeof error?.code === 'string' ? error.code : 'unavailable'
    const message = typeof error?.message === 'string' ? error.message : 'The canvas could not answer.'
    return {
      ok: false,
      code: code in CODES ? CODES[code as CanvasErrorCode] : code === 'foreign_board' ? 'not_found' : 'unavailable',
      message,
    }
  }
  return { ok: true, value: structured }
}

function presenceOf(payload: Record<string, unknown>): CanvasPresence {
  const pointer = record(payload.pointer) ? payload.pointer : null
  return {
    controller: payload.controller === 'agent' || payload.controller === 'human' ? payload.controller : 'none',
    ...(typeof payload.agentName === 'string' ? { agentName: payload.agentName.slice(0, 200) } : {}),
    ...(pointer && typeof pointer.x === 'number' && typeof pointer.y === 'number'
      ? { pointer: { x: pointer.x, y: pointer.y } }
      : {}),
    ...(Array.isArray(payload.selectedElementIds)
      ? {
          selectedElementIds: payload.selectedElementIds
            .filter((id): id is string => typeof id === 'string')
            .slice(0, 2_000),
        }
      : {}),
  }
}

export function createStudioCanvasDomain(host: StudioCanvasHost): StudioCanvasDomain {
  /** The subscriber each connection holds a board under, for its commits and its pen. */
  const held = new Map<string, Map<string, number[]>>()
  const stages = new Map<string, Map<string, Stage>>()

  function hold(connectionId: string, key: string, subscriberId: number): () => void {
    let boards = held.get(connectionId)
    if (!boards) held.set(connectionId, (boards = new Map()))
    const ids = boards.get(key) ?? []
    ids.push(subscriberId)
    boards.set(key, ids)
    return () => {
      const now = held.get(connectionId)?.get(key)
      if (!now) return
      const left = now.filter((id) => id !== subscriberId)
      if (left.length > 0) now.splice(0, now.length, ...left)
      else {
        held.get(connectionId)!.delete(key)
        if (held.get(connectionId)!.size === 0) held.delete(connectionId)
      }
    }
  }

  const subscriberOf = (connectionId: string, key: string): number | undefined =>
    held.get(connectionId)?.get(key)?.at(-1)

  function tool(name: string): McpToolRegistration | undefined {
    return host.tools().find((entry) => entry.name === name)
  }

  function dropStage(connectionId: string, stageId: string): Stage | undefined {
    const own = stages.get(connectionId)
    const stage = own?.get(stageId)
    if (!own || !stage) return undefined
    clearTimeout(stage.timer)
    own.delete(stageId)
    if (own.size === 0) stages.delete(connectionId)
    return stage
  }

  function stagedBytes(connectionId: string): number {
    let bytes = 0
    for (const stage of stages.get(connectionId)?.values() ?? []) bytes += stage.bytes
    return bytes
  }

  return {
    async open(connectionId, params, canEdit, notify) {
      const ref = canvasRefOf(params)
      if (!ref.ok) return refused(ref.error)
      let opened = false
      let closed = false
      let sceneWaiting: { revision: number; origin: 'agent' | 'human' | 'disk' } | null = null
      const subscriberId = host.subscribe((channel, payload) => {
        if (closed || !record(payload)) return
        if (channel === 'canvas:scene') {
          if (typeof payload.revision !== 'number') return
          const origin = payload.origin === 'human' || payload.origin === 'disk' ? payload.origin : 'agent'
          // Before the board's own notice, the newest write waits for it.
          if (!opened) sceneWaiting = { revision: payload.revision, origin }
          else notify({ type: 'scene', revision: payload.revision, origin })
          return
        }
        if (channel === 'canvas:presence' && opened) notify({ type: 'presence', ...presenceOf(payload) })
      })
      let answer: CanvasResult<CanvasBoardState>
      try {
        answer = await host.openBoard(ref.value, { create: params.create === true && canEdit, subscriberId })
      } catch (error) {
        answer = {
          ok: false,
          error: { code: 'worker_unavailable', message: error instanceof Error ? error.message : String(error) },
        }
      }
      if (!answer.ok) {
        closed = true
        host.unsubscribe(subscriberId)
        return refused(answer.error)
      }
      const release = hold(connectionId, keyOf(ref.value), subscriberId)
      opened = true
      notify({ type: 'opened', revision: answer.value.revision, canEdit })
      const waiting = sceneWaiting as { revision: number; origin: 'agent' | 'human' | 'disk' } | null
      if (waiting && waiting.revision > answer.value.revision) notify({ type: 'scene', ...waiting })
      return {
        ok: true,
        value: {
          close() {
            if (closed) return
            closed = true
            release()
            host.unsubscribe(subscriberId)
          },
        },
      }
    },

    onOpenRequest(listener) {
      return host.onOpenRequest((ref) =>
        listener({ workspaceId: ref.workspaceId, path: ref.path, ...(ref.store ? { store: ref.store } : {}) }),
      )
    },

    async list(workspaceId) {
      const list = tool('canvas.list')
      if (!list) return { ok: false, code: 'unavailable', message: 'This Studio does not list its boards.' }
      const answer = toolAnswer(await list.handler({ scope: 'machine', ...(workspaceId ? { workspaceId } : {}) }))
      if (!answer.ok) return answer
      const rows = Array.isArray(answer.value.boards) ? answer.value.boards : []
      const boards = rows.flatMap((row): StudioCanvasBoard[] => {
        if (!record(row) || typeof row.id !== 'string' || typeof row.path !== 'string') return []
        const modifiedAt = typeof row.modifiedAt === 'string' ? Date.parse(row.modifiedAt) : Number.NaN
        return [
          {
            id: row.id,
            path: row.path,
            name: typeof row.name === 'string' ? row.name : row.path,
            project: typeof row.project === 'string' ? row.project : null,
            workspaceId: typeof row.workspaceId === 'string' ? row.workspaceId : null,
            here: row.here === true,
            elementCount: typeof row.elementCount === 'number' ? row.elementCount : 0,
            modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : 0,
          },
        ]
      })
      return { ok: true, value: { boards, note: typeof answer.value.note === 'string' ? answer.value.note : null } }
    },

    async picture(params) {
      const screenshot = tool('canvas.screenshot')
      if (!screenshot) return { ok: false, code: 'unavailable', message: 'This Studio does not draw its boards.' }
      const result = await screenshot.handler({
        board: params.board,
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        maxEdge: params.maxEdge ?? STUDIO_CANVAS_LIMITS.pictureMaxEdge,
        ...(params.dark === undefined ? {} : { dark: params.dark }),
      })
      const answer = toolAnswer(result)
      if (!answer.ok) return answer
      const image = result.content.find((block) => block.type === 'image')
      if (!image || image.type !== 'image' || !/^image\/(png|jpeg)$/u.test(image.mimeType))
        return { ok: false, code: 'unavailable', message: 'The board was drawn without a picture.' }
      const { width, height } = answer.value
      return {
        ok: true,
        value: {
          mimeType: image.mimeType,
          dataBase64: image.data,
          width: typeof width === 'number' ? width : 0,
          height: typeof height === 'number' ? height : 0,
        },
      }
    },

    async read(params) {
      const ref = canvasRefOf(params)
      if (!ref.ok) return refused(ref.error)
      const state = await host.readBoard(ref.value)
      if (!state.ok) return refused(state.error)
      return {
        ok: true,
        value: {
          ...(state.value.id ? { id: state.value.id } : {}),
          path: state.value.path,
          revision: state.value.revision,
          elements: state.value.elements as StudioCanvasElement[],
          appState: state.value.appState,
          fileIds: Object.keys(state.value.files),
        },
      }
    },

    async files(params, ids) {
      const ref = canvasRefOf(params)
      if (!ref.ok) return refused(ref.error)
      const state = await host.readBoard(ref.value)
      if (!state.ok) return refused(state.error)
      const files: Record<string, unknown> = {}
      const more: string[] = []
      const missing: string[] = []
      let bytes = 0
      for (const id of ids) {
        const value = state.value.files[id]
        if (value === undefined) {
          missing.push(id)
          continue
        }
        const size = JSON.stringify(value).length
        // At least one picture per answer, however large: one always fits.
        if (bytes > 0 && bytes + size > STUDIO_CANVAS_LIMITS.filesAnswerBytes) {
          more.push(id)
          continue
        }
        files[id] = value
        bytes += size
      }
      return { ok: true, value: { files, more, missing } }
    },

    async stage(connectionId, params) {
      const ref = canvasRefOf(params)
      if (!ref.ok) return refused(ref.error)
      // Nothing is held for a board this client could not commit to.
      const confined = await host.confine(ref.value)
      if (!confined.ok) return refused(confined.error)
      const key = keyOf(ref.value)
      let own = stages.get(connectionId)
      let stage = own?.get(params.stageId)
      if (stage && (stage.key !== key || stage.total !== params.total))
        return {
          ok: false,
          code: 'invalid_params',
          message: 'That stage was begun for another board or another length.',
        }
      const before = stage?.parts.get(params.index)?.length ?? 0
      if (stagedBytes(connectionId) - before + params.text.length > STUDIO_CANVAS_LIMITS.stagedBytesPerConnection) {
        dropStage(connectionId, params.stageId)
        return {
          ok: false,
          code: 'too_large',
          message: 'This change is larger than a board may hold. Split the board, or remove an embedded image.',
        }
      }
      // Counted as well as weighed: a stage of empty parts weighs nothing,
      // and each one held is a timer and a map until it is spent or expires.
      if (!stage && (own?.size ?? 0) >= STUDIO_CANVAS_LIMITS.stagesPerConnection)
        return {
          ok: false,
          code: 'too_large',
          message: 'Too many changes are being sent at once. Wait for one to finish, then send this again.',
        }
      if (!stage) {
        if (!own) stages.set(connectionId, (own = new Map()))
        const stageId = params.stageId
        stage = {
          key,
          total: params.total,
          parts: new Map(),
          bytes: 0,
          timer: setTimeout(() => dropStage(connectionId, stageId), STAGE_TTL_MS),
        }
        stage.timer.unref?.()
        own.set(stageId, stage)
      }
      stage.parts.set(params.index, params.text)
      stage.bytes += params.text.length - before
      return { ok: true, value: { received: stage.parts.size } }
    },

    async commit(connectionId, params) {
      const ref = canvasRefOf(params)
      if (!ref.ok) return refused(ref.error)
      const key = keyOf(ref.value)
      let body = params.body ?? null
      if (params.stageId !== undefined) {
        const stage = dropStage(connectionId, params.stageId)
        if (!stage || stage.key !== key || stage.parts.size !== stage.total)
          return { ok: false, code: 'invalid_params', message: 'Not every part of this change arrived. Send it again.' }
        let parsed: unknown
        try {
          parsed = JSON.parse(Array.from({ length: stage.total }, (_, index) => stage.parts.get(index)).join(''))
        } catch {
          return { ok: false, code: 'invalid_params', message: 'The staged change was not one this Studio reads.' }
        }
        body = parseStudioCanvasCommitBody(parsed)
        if (!body)
          return { ok: false, code: 'invalid_params', message: 'The staged change is { elements, appState, files }.' }
      }
      if (!body) return { ok: false, code: 'invalid_params', message: 'A commit carries its body.' }
      const checked = canvasCommitOf({ ...ref.value, baseRevision: params.baseRevision, ...body })
      if (!checked.ok) return refused(checked.error)
      // A commit from a connection that holds the board is that subscriber's,
      // so its own write is not pushed back to it; one that holds none writes
      // as a passing subscriber.
      const subscriberId = subscriberOf(connectionId, key)
      const passing = subscriberId === undefined ? host.subscribe(() => undefined) : null
      try {
        const result = await host.commitScene(checked.value, subscriberId ?? passing!)
        if (!result.ok) return refused(result.error)
        return {
          ok: true,
          value: { revision: result.value.revision, elements: result.value.elements as StudioCanvasElement[] | null },
        }
      } finally {
        if (passing !== null) host.unsubscribe(passing)
      }
    },

    takePen(connectionId, params) {
      const ref = canvasRefOf(params)
      if (!ref.ok) return
      host.noteHumanInput(ref.value, subscriberOf(connectionId, keyOf(ref.value)))
    },

    connectionClosed(connectionId) {
      for (const stageId of [...(stages.get(connectionId)?.keys() ?? [])]) dropStage(connectionId, stageId)
    },

    close() {
      for (const connectionId of [...stages.keys()])
        for (const stageId of [...(stages.get(connectionId)?.keys() ?? [])]) dropStage(connectionId, stageId)
    },
  }
}
