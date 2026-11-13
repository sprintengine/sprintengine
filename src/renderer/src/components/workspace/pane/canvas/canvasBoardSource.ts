import { isRecord } from '../../../../../../shared/records'
import { createPairedChat } from '../../../../studio/pairedDiscovery'
import { canvasContinuePrompt, parseCanvasBoardId } from '../../../../../../shared/canvas/paths'
import type {
  CanvasBoardRef,
  CanvasBoardState,
  CanvasBoardSummary,
  CanvasElement,
  CanvasExportImages,
  CanvasExportResult,
  CanvasRemoteAccess,
  CanvasRemoteLink,
  CanvasResult,
} from '../../../../../../shared/canvas/types'
import { canvasFail, canvasOk } from '../../../../../../shared/canvas/types'
import { SOLO_CHAT_TEMPLATE_ID } from '../../../../../../shared/layouts/templates'
import { meshConversationSessionId } from '../../../../../../shared/tailnet-mesh'
import { LAYOUT_TEMPLATES } from '../../../../layouts/templates'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { Workspace } from '../../../../types/workspace'
import { remoteOriginChatWorkspaceId } from '../../remoteBand/remoteSessionsModel'

// Where a Canvas tab's boards are, behind the one list the picker asks.
//
// A chat's boards are on the machine the chat runs on. Here they are read from
// this machine's canvas service; for a paired chat they are read from that
// machine's, through the mesh. The picker and the tab are told which by a
// source, and everything they draw from it is the same row (AGENTS.md: a chat
// looks and behaves the same whichever machine it runs on), so this is the one
// module that knows there are two machines involved.

export type CanvasBoardScope = 'project' | 'all'

/** Which machine a chat's boards are on. */
export type CanvasBoardSource =
  { kind: 'here' } | { kind: 'paired'; connectionId: string; machineName: string; remoteWorkspaceId: string }

/** One row of the picker, on whichever machine the board is. */
export type CanvasPickerBoard = Omit<CanvasBoardSummary, 'id'> & {
  id: string | null
  /** The store to open it by; null for a board of the chat's own project here. */
  store: string | null
  /** Its project; null for one nothing remembers. Only a list of every board says. */
  project: string | null
  /** The list this row came from names projects, so the row says its own. */
  showsProject: boolean
  /** The board's workspace on its machine, the one a new chat starts beside. */
  workspaceId: string | null
}

export type CanvasBoardList = { boards: CanvasPickerBoard[]; note: string | null }

/** Whose boards a workspace's Canvas tab shows. */
export function canvasBoardSourceOf(workspace: Pick<Workspace, 'remoteOrigin'> | null | undefined): CanvasBoardSource {
  const origin = workspace?.remoteOrigin
  if (!origin) return { kind: 'here' }
  return {
    kind: 'paired',
    connectionId: origin.connectionId,
    machineName: origin.machineName,
    remoteWorkspaceId: remoteOriginChatWorkspaceId(origin),
  }
}

async function listPaired(
  source: Extract<CanvasBoardSource, { kind: 'paired' }>,
  scope: CanvasBoardScope,
): Promise<CanvasResult<CanvasBoardList>> {
  const answer = await window.api.meshCanvasBoards({
    connectionId: source.connectionId,
    workspaceId: source.remoteWorkspaceId,
    scope: scope === 'all' ? 'machine' : 'workspace',
  })
  if (!answer.ok) return canvasFail('forbidden', answer.message)
  return canvasOk({
    note: answer.note,
    boards: answer.boards.map((board) => {
      const parsed = board.id ? parseCanvasBoardId(board.id) : null
      return {
        id: board.id,
        path: board.path,
        name: board.name,
        elementCount: board.elementCount,
        modifiedAt: board.modifiedAt,
        // Every far board is named by its store: this machine has no project
        // of its own there for a bare name to mean.
        store: parsed?.ok ? parsed.value.store : null,
        project: board.project,
        showsProject: answer.allBoards,
        workspaceId: board.workspaceId,
      }
    }),
  })
}

/** One list, wherever the boards are. */
export async function listCanvasBoards(
  source: CanvasBoardSource,
  workspaceId: string,
  scope: CanvasBoardScope,
): Promise<CanvasResult<CanvasBoardList>> {
  if (source.kind === 'paired') return listPaired(source, scope)
  if (scope === 'project') {
    const listed = await window.api.canvasListBoards(workspaceId)
    if (!listed.ok) return listed
    return canvasOk({
      note: null,
      boards: listed.value.map((board) => ({
        ...board,
        id: board.id ?? null,
        store: null,
        project: null,
        showsProject: false,
        workspaceId,
      })),
    })
  }
  const listed = await window.api.canvasListAllBoards(workspaceId)
  if (!listed.ok) return listed
  return canvasOk({
    note: listed.value.note,
    boards: listed.value.boards.map((board) => ({
      ...board,
      // A row of this chat's own project opens as its own board, so the tab it
      // opens is the tab this chat would have opened anyway.
      store: board.here ? null : board.store,
      showsProject: true,
    })),
  })
}

/** A board as the tab holds it: the scene, and whether this pairing may change it. */
export type CanvasOpenedBoard = CanvasBoardState & { canEdit: boolean }

type CanvasCommit = CanvasBoardRef & {
  baseRevision: number
  elements: CanvasElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

/**
 * The calls a Canvas tab and its editor make about a board, wherever it is.
 * Here they are the canvas service's own IPC; for a paired chat they are the
 * same calls carried to the machine the chat runs on (`canvas-boards` on its Studio),
 * whose answers and pushes come back under the tab's own ref. So the tab and
 * the editor are one code path for both, and only this says which machine.
 */
export type CanvasBoardClient = {
  open(ref: CanvasBoardRef & { create: boolean }): Promise<CanvasResult<CanvasOpenedBoard>>
  close(ref: CanvasBoardRef): void
  commit(input: CanvasCommit): Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>>
  noteHumanInput(ref: CanvasBoardRef): void
  exportBoard(
    input: CanvasBoardRef & { defaultDirectory?: string; images: CanvasExportImages },
  ): Promise<CanvasResult<CanvasExportResult>>
  /** The board's link: a board here has none to lose, and never calls back. */
  onLink(ref: CanvasBoardRef, callback: (link: CanvasRemoteLink) => void): () => void
}

const HERE_CLIENT: CanvasBoardClient = {
  open: async (ref) => {
    const opened = await window.api.canvasOpenBoard(ref)
    return opened.ok ? canvasOk({ ...opened.value, canEdit: true }) : opened
  },
  close: (ref) => void window.api.canvasCloseBoard(ref),
  commit: (input) => window.api.canvasCommitScene(input),
  noteHumanInput: (ref) => window.api.canvasNoteHumanInput(ref),
  exportBoard: (input) => window.api.canvasExportBoard(input),
  onLink: () => () => undefined,
}

const sameBoard = (a: CanvasBoardRef, b: CanvasBoardRef): boolean =>
  a.workspaceId === b.workspaceId && (a.store ?? '') === (b.store ?? '') && a.path === b.path

/** The board calls for a source. Stable per source's strings, so an effect that names it runs once. */
export function canvasBoardClient(source: CanvasBoardSource): CanvasBoardClient {
  if (source.kind === 'here') return HERE_CLIENT
  const far = { connectionId: source.connectionId, remoteWorkspaceId: source.remoteWorkspaceId }
  return {
    open: (ref) => window.api.canvasRemoteOpen({ ...ref, ...far }),
    close: (ref) => void window.api.canvasRemoteClose({ ...ref, ...far }),
    commit: (input) => window.api.canvasRemoteCommit({ ...input, ...far }),
    noteHumanInput: (ref) => window.api.canvasRemoteNoteHumanInput({ ...ref, ...far }),
    // Its folder is picked on this machine, so nothing of it is suggested.
    exportBoard: ({ defaultDirectory: _unused, ...input }) => window.api.canvasRemoteExport({ ...input, ...far }),
    onLink: (ref, callback) =>
      window.api.onCanvasRemoteLink((link) => {
        if (sameBoard(link, ref)) callback(link)
      }),
  }
}

/** Whether a source's boards open in the editor: always here; on a paired machine, as it says. */
export async function readCanvasBoardAccess(source: CanvasBoardSource): Promise<CanvasRemoteAccess> {
  if (source.kind === 'here') return { ok: true, live: true, canEdit: true }
  try {
    return await window.api.canvasRemoteAccess(source.connectionId)
  } catch {
    return { ok: false, message: `${source.machineName} could not be reached.` }
  }
}

/**
 * Hear an agent's `canvas.open` in a paired chat, the way a chat here hears it
 * on `onCanvasOpenRequest`: only while this window shows that chat.
 */
export function watchPairedCanvasOpens(
  source: Extract<CanvasBoardSource, { kind: 'paired' }>,
  onOpen: (board: { path: string; store?: string }) => void,
): () => void {
  const target = { connectionId: source.connectionId, workspaceId: source.remoteWorkspaceId }
  const stop = window.api.onCanvasRemoteOpenRequest((request) => {
    if (request.connectionId !== target.connectionId || request.workspaceId !== target.workspaceId) return
    onOpen({ path: request.path, ...(request.store ? { store: request.store } : {}) })
  })
  void window.api.canvasRemoteWatch(target).catch(() => undefined)
  return () => {
    stop()
    void window.api.canvasRemoteUnwatch(target).catch(() => undefined)
  }
}

/** How long a chat started in main is waited for here, before its tab is left to the agent's own `canvas.open`. */
const NEW_CHAT_WAIT_MS = 5_000

function waitForWorkspace(workspaceId: string): Promise<boolean> {
  const has = () => useWorkspaceStore.getState().workspaces.some((workspace) => workspace.id === workspaceId)
  if (has()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let stop = () => {}
    const timer = setTimeout(() => {
      stop()
      resolve(false)
    }, NEW_CHAT_WAIT_MS)
    stop = useWorkspaceStore.subscribe(() => {
      if (!has()) return
      clearTimeout(timer)
      stop()
      resolve(true)
    })
  })
}

/** The new chat in front, with the board's tab open beside it. */
function showBoardInChat(workspaceId: string, board: Pick<CanvasPickerBoard, 'path' | 'store'>): void {
  const store = useWorkspaceStore.getState()
  store.openPaneTab(workspaceId, {
    kind: 'canvas',
    canvas: { path: board.path, ...(board.store ? { store: board.store } : {}) },
  })
  store.setActiveWorkspace(workspaceId)
}

async function continuePaired(
  source: Extract<CanvasBoardSource, { kind: 'paired' }>,
  workspaceId: string,
  board: CanvasPickerBoard,
): Promise<CanvasResult<void>> {
  const created = await createPairedChat(
    { id: source.connectionId, machineName: source.machineName },
    {
      workspaceId: board.workspaceId ?? source.remoteWorkspaceId,
      prompt: canvasContinuePrompt(board.name, board.id ?? board.path),
    },
  )
  if (!created.ok) return canvasFail('forbidden', created.message)
  const store = useWorkspaceStore.getState()
  const origin = store.workspaces.find((candidate) => candidate.id === workspaceId)?.remoteOrigin
  const template = LAYOUT_TEMPLATES.find((candidate) => candidate.id === SOLO_CHAT_TEMPLATE_ID)
  // Made all the same, and listed with that machine's chats.
  if (!origin || !template) {
    return canvasFail('forbidden', `The chat started on ${source.machineName}, but no pane could open for it here.`)
  }
  const chat = store.addWorkspace(template, {
    name: created.title,
    folderPath: null,
    remoteOrigin: {
      ...origin,
      // The chat that was created, as a New chat's pane is: settle, visit and
      // bring-back ask about this id.
      workspaceId: created.workspaceId,
      workspaceName: board.project ?? origin.workspaceName,
      // The project it starts in may not be this chat's, and only that machine
      // has its folder; the row reads its branch from what the machine lists.
      ...(board.workspaceId && board.workspaceId !== source.remoteWorkspaceId
        ? { workspaceRoot: null, repository: null, checkout: null }
        : {}),
      sessionId: meshConversationSessionId(created.workspaceId, created.agentId),
    },
    seedAgent: {
      tabName: created.title,
      meshConversation: {
        connectionId: source.connectionId,
        machineName: source.machineName,
        remoteWorkspaceId: created.workspaceId,
        remoteAgentId: created.agentId,
        title: created.title,
      },
    },
  })
  showBoardInChat(chat, board)
  return canvasOk(undefined)
}

/**
 * "Continue in a new chat": a chat on the board's own machine whose first
 * message names the board by id, with the board open beside it. The same file,
 * not a copy (owner ruling 2026-11-07).
 */
export async function continueBoardInNewChat(
  source: CanvasBoardSource,
  workspaceId: string,
  board: CanvasPickerBoard,
): Promise<CanvasResult<void>> {
  try {
    if (source.kind === 'paired') return await continuePaired(source, workspaceId, board)
    if (!board.id) return canvasFail('forbidden', 'This board has no id a chat could name it by.')
    const started = await window.api.canvasContinueInNewChat({
      workspaceId,
      id: board.id,
      name: board.name,
      boardWorkspaceId: board.workspaceId,
    })
    if (!started.ok) return started
    // The chat's workspace is made in main and reaches this store as an event.
    // Past the wait its own `canvas.open` still brings the board up.
    if (await waitForWorkspace(started.value.workspaceId)) {
      // By its store even in its own project: the id is what the chat was told.
      showBoardInChat(started.value.workspaceId, { path: board.path, store: storeOfId(board.id) })
    }
    return canvasOk(undefined)
  } catch (error) {
    return canvasFail('forbidden', error instanceof Error ? error.message : 'The chat could not be started.')
  }
}

function storeOfId(id: string): string | null {
  const parsed = parseCanvasBoardId(id)
  return parsed?.ok ? parsed.value.store : null
}

/** A picture's data URL, from a tool's answer: never built from anything but an image type. */
export function canvasPictureUrl(answer: unknown): string | null {
  if (!isRecord(answer) || typeof answer.data !== 'string' || typeof answer.mimeType !== 'string') return null
  return /^image\/(png|jpeg)$/u.test(answer.mimeType) ? `data:${answer.mimeType};base64,${answer.data}` : null
}
