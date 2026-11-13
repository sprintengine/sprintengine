import { afterEach, expect, test, vi } from 'vitest'

import { StudioError } from '../../../../../../../packages/client-runtime/src/public'
import { fakePairedStudios } from '../../../../studio/pairedStudio.double'
import type { Workspace } from '../../../../types/workspace'

const state = vi.hoisted(() => ({
  workspaces: [] as Array<Pick<Workspace, 'id' | 'remoteOrigin'>>,
  openPaneTab: vi.fn(),
  setActiveWorkspace: vi.fn(),
  addWorkspace: vi.fn(() => 'local-chat'),
}))

vi.mock('../../../../store/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => state, subscribe: () => () => {} },
}))

// This window's coordinator of its paired boards (pairedCanvas.ts, tested over
// a real listener in tailnet-paired-window-canvas.test.ts), stood in for: what
// the source asks of it, and what it pushes on each channel.
const stand = vi.hoisted(() => ({
  listeners: new Map<string, Array<(payload: unknown) => void>>(),
  canvas: {
    access: vi.fn(),
    open: vi.fn(async () => ({ ok: true, value: { path: 'fleet.excalidraw', canEdit: true } })),
    close: vi.fn(),
    commit: vi.fn(async () => ({ ok: true, value: { revision: 2, elements: null } })),
    noteHumanInput: vi.fn(),
    snapshot: vi.fn(() => ({ ok: true, value: { name: 'fleet', elements: [], appState: {}, files: {} } })),
    watch: vi.fn(),
    unwatch: vi.fn(),
  },
  listPairedBoards: vi.fn(),
}))
vi.mock('../../../../studio/pairedCanvas', () => ({
  PAIRED_CANVAS_LINK: 'paired-canvas:link',
  PAIRED_CANVAS_OPEN_REQUEST: 'paired-canvas:open-request',
  WINDOW_CANVAS_VIEWER: { id: 1, send: () => undefined },
  windowPairedCanvas: () => stand.canvas,
  listPairedBoards: stand.listPairedBoards,
  onPairedCanvasPush: (channel: string, listener: (payload: unknown) => void) => {
    stand.listeners.set(channel, [...(stand.listeners.get(channel) ?? []), listener])
    return () =>
      stand.listeners.set(
        channel,
        (stand.listeners.get(channel) ?? []).filter((one) => one !== listener),
      )
  },
}))
const push = (channel: string, payload: unknown) => {
  for (const listener of stand.listeners.get(channel) ?? []) listener(payload)
}

const {
  canvasBoardClient,
  canvasBoardSourceOf,
  continueBoardInNewChat,
  listCanvasBoards,
  readCanvasBoardAccess,
  watchPairedCanvasOpens,
} = await import('./canvasBoardSource')

const STORE = `ws_${'a'.repeat(24)}`
const ID = `canvas://${STORE}/fleet.excalidraw`
const origin = {
  connectionId: 'conn-1',
  machineName: 'mac-mini',
  workspaceId: 'far-chat',
  workspaceName: 'harbor',
  workspaceRoot: null,
}
const paired = {
  kind: 'paired',
  connectionId: 'conn-1',
  machineName: 'mac-mini',
  remoteWorkspaceId: 'far-chat',
} as const
const board = {
  id: ID,
  path: 'fleet.excalidraw',
  name: 'fleet',
  elementCount: 1,
  modifiedAt: 1,
  store: STORE,
  project: 'harbor',
  showsProject: true,
  workspaceId: 'far-project',
}

function api(members: Record<string, unknown>): void {
  vi.stubGlobal('window', { api: members })
}

/** A paired machine's Studio, as this window's own client of it reaches it, starting chats as `create` answers. */
function pairedStudio(create: () => unknown) {
  const members = {}
  api(members)
  return fakePairedStudios(members, { 'conversation.create': create })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  state.workspaces = []
})

test('a chat with a remote origin reads its boards from that machine', async () => {
  expect(canvasBoardSourceOf({ remoteOrigin: origin })).toEqual(paired)
  expect(canvasBoardSourceOf({ remoteOrigin: null })).toEqual({ kind: 'here' })
  stand.listPairedBoards.mockResolvedValue({
    ok: true,
    allBoards: true,
    note: null,
    boards: [{ ...board, here: false }],
  })
  const listed = await listCanvasBoards(paired, 'local-chat', 'all')
  expect(stand.listPairedBoards).toHaveBeenCalledWith({ id: 'conn-1', machineName: 'mac-mini' }, 'far-chat', 'machine')
  expect(listed.ok && listed.value.boards[0].store).toBe(STORE)
})

test("a row of the chat's own project opens without a store, and a foreign row with one", async () => {
  const row = { ...board, here: false }
  api({
    canvasListAllBoards: async () => ({
      ok: true,
      value: { note: null, boards: [row, { ...row, here: true, path: 'own.excalidraw' }] },
    }),
  })
  const listed = await listCanvasBoards({ kind: 'here' }, 'chat', 'all')
  expect(listed.ok && listed.value.boards.map((entry) => entry.store)).toEqual([STORE, null])
})

test('continuing on a paired machine starts the chat there, naming the board, with its tab open here', async () => {
  state.workspaces = [{ id: 'local-chat', remoteOrigin: origin }]
  const studio = pairedStudio(() => ({
    conversation: { workspaceId: 'new-far', agentId: 'agent-1', name: 'Chat', providerId: 'p', modelId: 'm' },
  }))
  const started = await continueBoardInNewChat(paired, 'local-chat', board)
  expect(started.ok).toBe(true)
  const asked = studio.calls[0]!.params as { workspaceId: string; prompt: string }
  expect(asked.workspaceId).toBe('far-project')
  expect(asked.prompt).toContain(ID)
  expect(state.openPaneTab).toHaveBeenCalledWith('local-chat', {
    kind: 'canvas',
    canvas: { path: 'fleet.excalidraw', store: STORE },
  })
})

test("an older machine, with no id to give, is asked by the board's path", async () => {
  state.workspaces = [{ id: 'local-chat', remoteOrigin: origin }]
  const studio = pairedStudio(() => {
    throw new StudioError('x', 'Refused there.')
  })
  const started = await continueBoardInNewChat(paired, 'local-chat', { ...board, id: null, store: null })
  expect(started.ok).toBe(false)
  expect(!started.ok && started.error.message).toBe('Refused there.')
  const asked = studio.calls[0]!.params as { prompt: string }
  expect(asked.prompt).toContain('fleet.excalidraw')
  expect(asked.prompt).not.toContain('canvas://')
})

test("a paired chat's board calls carry the machine and the chat there, under the tab's own ref", async () => {
  const canvasOpenBoard = vi.fn()
  const canvasExportScene = vi.fn(async () => ({ ok: true, value: { cancelled: true } }))
  api({ canvasOpenBoard, canvasExportScene })
  const client = canvasBoardClient(paired)
  const ref = { workspaceId: 'local-chat', path: 'fleet.excalidraw', store: STORE }
  const far = { connectionId: 'conn-1', remoteWorkspaceId: 'far-chat' }
  const viewer = expect.objectContaining({ id: 1 })
  await client.open({ ...ref, create: false })
  expect(stand.canvas.open).toHaveBeenCalledWith(viewer, { ...ref, create: false, ...far })
  expect(canvasOpenBoard).not.toHaveBeenCalled()
  await client.commit({ ...ref, baseRevision: 1, elements: [], appState: {}, files: {} })
  expect(stand.canvas.commit).toHaveBeenCalledWith(viewer, expect.objectContaining({ ...far, baseRevision: 1 }))
  client.noteHumanInput(ref)
  expect(stand.canvas.noteHumanInput).toHaveBeenCalledWith(viewer, { ...ref, ...far })
  // The board as this window holds it, into a folder picked on this machine:
  // nothing from the chat's is suggested.
  await client.exportBoard({ ...ref, defaultDirectory: '/Users/dev/harbor', images: {} })
  expect(stand.canvas.snapshot).toHaveBeenCalledWith({ ...ref, ...far })
  expect(canvasExportScene).toHaveBeenCalledWith({ name: 'fleet', elements: [], appState: {}, files: {}, images: {} })
  client.close(ref)
  expect(stand.canvas.close).toHaveBeenCalledWith(viewer, { ...ref, ...far })
})

test("a board here goes through this machine's canvas, and may always be changed", async () => {
  const canvasOpenBoard = vi.fn(async () => ({
    ok: true,
    value: { path: 'plan.excalidraw', revision: 0, elements: [], appState: {}, files: {} },
  }))
  api({ canvasOpenBoard })
  const opened = await canvasBoardClient({ kind: 'here' }).open({
    workspaceId: 'w',
    path: 'plan.excalidraw',
    create: true,
  })
  expect(canvasOpenBoard).toHaveBeenCalledWith({ workspaceId: 'w', path: 'plan.excalidraw', create: true })
  expect(opened.ok && opened.value.canEdit).toBe(true)
  expect(await readCanvasBoardAccess({ kind: 'here' })).toEqual({ ok: true, live: true, canEdit: true })
})

test("a paired board's link is heard for that board alone", () => {
  api({})
  const heard: unknown[] = []
  canvasBoardClient(paired).onLink({ workspaceId: 'local-chat', path: 'fleet.excalidraw' }, (link) => heard.push(link))
  const link = { workspaceId: 'local-chat', state: 'reconnecting', canEdit: true }
  push('paired-canvas:link', { ...link, path: 'other.excalidraw', message: 'x' })
  push('paired-canvas:link', { ...link, path: 'fleet.excalidraw', message: 'away' })
  expect(heard).toHaveLength(1)
})

test("a paired chat's agent opening a board is heard while the window shows that chat", () => {
  api({})
  const opened: unknown[] = []
  const stop = watchPairedCanvasOpens(paired, (board) => opened.push(board))
  const target = { connectionId: 'conn-1', workspaceId: 'far-chat' }
  expect(stand.canvas.watch).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), target)
  push('paired-canvas:open-request', { connectionId: 'conn-1', workspaceId: 'another-chat', path: 'x.excalidraw' })
  push('paired-canvas:open-request', { ...target, path: 'fleet.excalidraw', store: STORE })
  expect(opened).toEqual([{ path: 'fleet.excalidraw', store: STORE }])
  stop()
  expect(stand.canvas.unwatch).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), target)
})

test("a paired machine's answer about its boards is passed on, and one that cannot be reached says so", async () => {
  // A desktop window reaches its paired machines itself.
  api({ environmentsTicket: vi.fn() })
  stand.canvas.access.mockResolvedValue({ ok: true, live: false, canEdit: true, reason: 'older' })
  expect(await readCanvasBoardAccess(paired)).toEqual({ ok: true, live: false, canEdit: true, reason: 'older' })
  stand.canvas.access.mockRejectedValue(new Error('gone'))
  expect(await readCanvasBoardAccess(paired)).toEqual({ ok: false, message: 'mac-mini could not be reached.' })
  // A browser tab does not, and shows them as pictures.
  api({})
  const tab = await readCanvasBoardAccess(paired)
  expect(tab.ok && tab.live).toBe(false)
})
