import {
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_CANVAS_BOARDS_CAPABILITY } from './handshake.js'

// A machine's Canvas boards, for a client on another device: the phone's list
// and pictures, and a paired desktop's Canvas pane drawing on them. Served by
// the Studio that is given the machine's one canvas service, so a board
// another device holds is merged, revisioned and told like a window there.
//
// Pushes are notices and data moves by request, as a web tab runs the canvas
// over a Studio's files: `canvas.board` says a board opened, moved to a
// revision, or who holds the pen; the client reads the scene with
// `canvas.read` and only the pictures it lacks with `canvas.files`. A scene
// names its pictures by id and never carries them, so a board full of
// screenshots costs each picture once. A change larger than one client frame
// is sent in `canvas.stage` parts first.
//
// Looking is `workspaces:read`; changing a board, staging for it and taking
// the pen are `workspaces:operate`. A paired device holds them with its
// `workspace:*` pairing. No file scope is involved: these name boards only (a
// store board, or an `.excalidraw` inside a project), which the Studio checks
// again as its own pane's calls are checked.

/** A board as every call names it: the workspace it is read under, its path, and its store when it is another project's. */
export type StudioCanvasRef = { workspaceId: string; path: string; store?: string }

/** One element of a scene. Opaque here: the Studio checks a scene as its own pane's. */
export type StudioCanvasElement = { id: string } & Record<string, unknown>

/** One board in a machine's list. */
export type StudioCanvasBoard = {
  /** Its id there (`canvas://ws_…/arch.excalidraw`), which `canvas.picture` takes. */
  id: string
  path: string
  name: string
  /** Its project; null for a project that machine has removed. */
  project: string | null
  /** A workspace in the board's folder, where it is read and a chat on it starts; null when none is left. */
  workspaceId: string | null
  /** In the project of the workspace that asked. */
  here: boolean
  elementCount: number
  /** Epoch milliseconds. */
  modifiedAt: number
}

/** A board's state now: the scene, and the ids of the pictures it holds (fetched apart, by `canvas.files`). */
export type StudioCanvasState = {
  id?: string
  /** Its path as the machine spells it. */
  path: string
  revision: number
  elements: StudioCanvasElement[]
  appState: Record<string, unknown>
  fileIds: string[]
}

/** Who has the pen on a board, as the machine's canvas service says. */
export type StudioCanvasPresence = {
  controller: 'agent' | 'human' | 'none'
  agentName?: string
  pointer?: { x: number; y: number }
  selectedElementIds?: string[]
}

/** What `canvas.board` pushes. */
export type StudioCanvasBoardNotice =
  /** The board is open (again, after a drop): read it. `canEdit` is the grant's, now. */
  | { type: 'opened'; revision: number; canEdit: boolean }
  /** An accepted write moved the board to this revision: read it if it is past what you hold. */
  | { type: 'scene'; revision: number; origin: 'agent' | 'human' | 'disk' }
  | ({ type: 'presence' } & StudioCanvasPresence)

/** What a commit carries: the scene, and only the pictures the machine does not hold yet. */
export type StudioCanvasCommitBody = {
  elements: StudioCanvasElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

/**
 * The refusals a board call may answer with beyond every method's: a board or
 * workspace that is not there, and a write the disk kept changing under.
 * A ref or a scene the canvas will not take is `invalid_params`.
 */
export type StudioCanvasRefusalCode = 'not_found' | 'conflict'

export type StudioCanvasMethodMap = {
  /** Every board on the machine, newest first, at most 200; `note` says when the list was cut. */
  'canvas.list': {
    params: { workspaceId?: string }
    result: { boards: StudioCanvasBoard[]; note: string | null }
    errors: StudioCanvasRefusalCode
  }
  /** A picture of one board, by its id or its ref's path, drawn on that machine. */
  'canvas.picture': {
    params: { board: string; workspaceId?: string; maxEdge?: number; dark?: boolean }
    result: { mimeType: string; dataBase64: string; width: number; height: number }
    errors: StudioCanvasRefusalCode
  }
  /** The board as it stands. */
  'canvas.read': { params: StudioCanvasRef; result: StudioCanvasState; errors: StudioCanvasRefusalCode }
  /** Pictures by id: as many as fit one answer (at least one), the ids left over in `more`; an id it lacks in `missing`. */
  'canvas.files': {
    params: StudioCanvasRef & { ids: string[] }
    result: { files: Record<string, unknown>; more: string[]; missing: string[] }
    errors: StudioCanvasRefusalCode
  }
  /** One part of a commit's body (its JSON), under a stage id of this connection's. Parts may come in any order. */
  'canvas.stage': {
    params: StudioCanvasRef & { stageId: string; index: number; total: number; text: string }
    result: { received: number }
  }
  /**
   * Merge a scene into the board, element by element. `body` inline, or the
   * `stageId` its parts were staged under. `elements` comes back only when the
   * merge made something other than what was sent.
   */
  'canvas.commit': {
    params: StudioCanvasRef & {
      commandId: string
      baseRevision: number
      body?: StudioCanvasCommitBody
      stageId?: string
    }
    result: { revision: number; elements: StudioCanvasElement[] | null }
    errors: StudioCanvasRefusalCode
  }
  /** The person is drawing: an agent's edit in flight on this board gives way. */
  'canvas.takePen': { params: StudioCanvasRef; result: { taken: true } }
}

export type StudioCanvasMethod = keyof StudioCanvasMethodMap

export type StudioCanvasTopicMap = {
  /** One board, held open while subscribed. `create` makes it where the grant may change boards. */
  'canvas.board': {
    params: StudioCanvasRef & { create?: boolean }
    payload: StudioCanvasBoardNotice
    stream: 'push'
  }
  /** An agent's `canvas.open` in one of these workspaces: the board it wants shown. */
  'canvas.openRequests': { params: { workspaceIds: string[] }; payload: StudioCanvasRef; stream: 'push' }
}

// ── Limits ──────────────────────────────────────────────────────────────────

export const STUDIO_CANVAS_LIMITS = {
  /** A commit body up to this goes inline; past it, in parts. */
  inlineBodyBytes: 768 * 1024,
  /** Characters in one staged part. */
  stagePartChars: 512 * 1024,
  /** Parts in one stage: 64 MB at the part size. */
  stageParts: 128,
  /** Bytes one connection may hold staged at once. */
  stagedBytesPerConnection: 64 * 1024 * 1024,
  /** Changes one connection may be staging at once, however small: one per board a desktop's windows draw on. */
  stagesPerConnection: 32,
  /** Bytes of pictures one `canvas.files` answer carries before naming the rest in `more`. */
  filesAnswerBytes: 16 * 1024 * 1024,
  /** Ids one `canvas.files` may ask for. */
  filesPerAsk: 2_000,
  /** Workspaces one `canvas.openRequests` may follow. */
  watchedWorkspaces: 64,
  /** The longest edge a picture is drawn at. */
  pictureMaxEdge: 1600,
} as const

// ── Validation ──────────────────────────────────────────────────────────────

const refuse = (message: string): StudioParamsRefusal => studioParamsRefused(message)

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

const REF =
  "A board is { workspaceId, path, store? }: its workspace there, its path, and its store when another project's."

/** A board's ref, member by member. Its path is checked again where it is used, as the pane's are. */
export function parseStudioCanvasRef(value: Record<string, unknown>): StudioParsed<StudioCanvasRef> {
  if (!id(value.workspaceId) || !id(value.path, 1024)) return refuse(REF)
  if (value.store !== undefined && !id(value.store)) return refuse(REF)
  return studioParams({
    workspaceId: value.workspaceId,
    path: value.path,
    ...(value.store === undefined ? {} : { store: value.store as string }),
  })
}

function withRef<P>(
  read: (value: Record<string, unknown>, ref: StudioCanvasRef) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<P> {
  return (value) => {
    const ref = parseStudioCanvasRef(value)
    return ref.ok ? read(value, ref.params) : ref
  }
}

/** A commit's body, read only for shape: the Studio holds it to the canvas's own limits. */
export function parseStudioCanvasCommitBody(value: unknown): StudioCanvasCommitBody | null {
  if (!record(value) || !Array.isArray(value.elements)) return null
  if (!value.elements.every((element) => record(element) && typeof element.id === 'string')) return null
  if (!record(value.appState) || !record(value.files)) return null
  return {
    elements: value.elements as StudioCanvasElement[],
    appState: value.appState,
    files: value.files,
  }
}

const read = { scope: 'workspaces:read', mutation: false, capability: STUDIO_CANVAS_BOARDS_CAPABILITY } as const
const draw = { scope: 'workspaces:operate', mutation: false, capability: STUDIO_CANVAS_BOARDS_CAPABILITY } as const

export const STUDIO_CANVAS_METHODS: StudioMethodTable<StudioCanvasMethodMap> = {
  'canvas.list': {
    ...read,
    params: (value) => {
      if (value.workspaceId === undefined) return studioParams({})
      return id(value.workspaceId)
        ? studioParams({ workspaceId: value.workspaceId })
        : refuse('"workspaceId" names the workspace whose boards are "here".')
    },
  },
  'canvas.picture': {
    ...read,
    params: (value) => {
      if (!id(value.board, 1024)) return refuse('"board" is a board\'s id from canvas.list, or its path.')
      if (value.workspaceId !== undefined && !id(value.workspaceId))
        return refuse('"workspaceId" names the workspace a path is read under.')
      if (value.maxEdge !== undefined && !(integer(value.maxEdge) && value.maxEdge >= 64))
        return refuse('"maxEdge" is the longest edge in pixels, at least 64.')
      if (value.dark !== undefined && typeof value.dark !== 'boolean') return refuse('"dark" is true or false.')
      return studioParams({
        board: value.board,
        ...(value.workspaceId === undefined ? {} : { workspaceId: value.workspaceId as string }),
        maxEdge: Math.min(
          (value.maxEdge as number | undefined) ?? STUDIO_CANVAS_LIMITS.pictureMaxEdge,
          STUDIO_CANVAS_LIMITS.pictureMaxEdge,
        ),
        ...(value.dark === undefined ? {} : { dark: value.dark as boolean }),
      })
    },
  },
  'canvas.read': { ...read, params: parseStudioCanvasRef },
  'canvas.files': {
    ...read,
    params: withRef((value, ref) => {
      const ids = value.ids
      if (!(Array.isArray(ids) && ids.length > 0 && ids.length <= STUDIO_CANVAS_LIMITS.filesPerAsk))
        return refuse(`"ids" lists 1 to ${STUDIO_CANVAS_LIMITS.filesPerAsk} picture ids.`)
      if (!ids.every((fileId) => id(fileId, 256))) return refuse('A picture id is a string of 1 to 256 characters.')
      return studioParams({ ...ref, ids: [...new Set(ids as string[])] })
    }),
  },
  'canvas.stage': {
    ...draw,
    params: withRef((value, ref) => {
      if (!id(value.stageId)) return refuse('"stageId" names the stage: a string of 1 to 200 characters.')
      if (!(integer(value.total) && value.total >= 1 && value.total <= STUDIO_CANVAS_LIMITS.stageParts))
        return refuse(`"total" is how many parts, 1 to ${STUDIO_CANVAS_LIMITS.stageParts}.`)
      if (!(integer(value.index) && value.index >= 0 && value.index < value.total))
        return refuse('"index" is this part\'s place, from 0.')
      if (typeof value.text !== 'string' || value.text.length > STUDIO_CANVAS_LIMITS.stagePartChars)
        return refuse(`"text" is one part of at most ${STUDIO_CANVAS_LIMITS.stagePartChars} characters.`)
      return studioParams({ ...ref, stageId: value.stageId, index: value.index, total: value.total, text: value.text })
    }),
  },
  'canvas.commit': {
    ...draw,
    mutation: true,
    params: withRef<StudioCanvasMethodMap['canvas.commit']['params']>((value, ref) => {
      if (!id(value.commandId)) return refuse('"commandId" names this command: a string of 1 to 200 characters.')
      if (!(integer(value.baseRevision) && value.baseRevision >= 0))
        return refuse('"baseRevision" is the revision the scene was drawn over.')
      const hasBody = value.body !== undefined
      const hasStage = value.stageId !== undefined
      if (hasBody === hasStage) return refuse('A commit carries its "body", or the "stageId" it was staged under.')
      const common: StudioCanvasMethodMap['canvas.commit']['params'] = {
        ...ref,
        commandId: value.commandId,
        baseRevision: value.baseRevision,
      }
      if (hasStage) {
        if (!id(value.stageId)) return refuse('"stageId" names the stage its parts were sent under.')
        return studioParams({ ...common, stageId: value.stageId })
      }
      const body = parseStudioCanvasCommitBody(value.body)
      if (!body) return refuse('"body" is { elements, appState, files }.')
      return studioParams({ ...common, body })
    }),
  },
  'canvas.takePen': { ...draw, params: parseStudioCanvasRef },
}

export const STUDIO_CANVAS_TOPICS: StudioTopicTable<StudioCanvasTopicMap> = {
  'canvas.board': {
    scope: 'workspaces:read',
    capability: STUDIO_CANVAS_BOARDS_CAPABILITY,
    push: true,
    params: withRef((value, ref) => {
      if (value.create !== undefined && typeof value.create !== 'boolean') return refuse('"create" is true or false.')
      return studioParams({ ...ref, ...(value.create === true ? { create: true } : {}) })
    }),
  },
  'canvas.openRequests': {
    scope: 'workspaces:read',
    capability: STUDIO_CANVAS_BOARDS_CAPABILITY,
    push: true,
    params: (value) => {
      const ids = value.workspaceIds
      if (!(Array.isArray(ids) && ids.length <= STUDIO_CANVAS_LIMITS.watchedWorkspaces && ids.every((one) => id(one))))
        return refuse(`"workspaceIds" lists at most ${STUDIO_CANVAS_LIMITS.watchedWorkspaces} workspaces.`)
      return studioParams({ workspaceIds: [...new Set(ids as string[])] })
    },
  },
}
