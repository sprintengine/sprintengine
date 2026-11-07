import { afterEach, expect, test, vi } from 'vitest'

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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  state.workspaces = []
})

test('a chat with a remote origin reads its boards from that machine', async () => {
  expect(canvasBoardSourceOf({ remoteOrigin: origin })).toEqual(paired)
  expect(canvasBoardSourceOf({ remoteOrigin: null })).toEqual({ kind: 'here' })
  const meshCanvasBoards = vi.fn(async () => ({
    ok: true,
    allBoards: true,
    note: null,
    boards: [{ ...board, here: false }],
  }))
  api({ meshCanvasBoards })
  const listed = await listCanvasBoards(paired, 'local-chat', 'all')
  expect(meshCanvasBoards).toHaveBeenCalledWith({ connectionId: 'conn-1', workspaceId: 'far-chat', scope: 'machine' })
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
  const meshCreateConversation = vi.fn(async () => ({
    ok: true,
    workspaceId: 'new-far',
    agentId: 'agent-1',
    title: 'Chat',
  }))
  api({ meshCreateConversation })
  const started = await continueBoardInNewChat(paired, 'local-chat', board)
  expect(started.ok).toBe(true)
  const asked = meshCreateConversation.mock.calls[0] as unknown as [{ workspaceId: string; prompt: string }]
  expect(asked[0].workspaceId).toBe('far-project')
  expect(asked[0].prompt).toContain(ID)
  expect(state.openPaneTab).toHaveBeenCalledWith('local-chat', {
    kind: 'canvas',
    canvas: { path: 'fleet.excalidraw', store: STORE },
  })
})

test("an older machine, with no id to give, is asked by the board's path", async () => {
  state.workspaces = [{ id: 'local-chat', remoteOrigin: origin }]
  const meshCreateConversation = vi.fn(async () => ({ ok: false, code: 'x', message: 'Refused there.' }))
  api({ meshCreateConversation })
  const started = await continueBoardInNewChat(paired, 'local-chat', { ...board, id: null, store: null })
  expect(started.ok).toBe(false)
  expect(!started.ok && started.error.message).toBe('Refused there.')
  const asked = meshCreateConversation.mock.calls[0] as unknown as [{ prompt: string }]
  expect(asked[0].prompt).toContain('fleet.excalidraw')
  expect(asked[0].prompt).not.toContain('canvas://')
})

test("a paired chat's board calls carry the machine and the chat there, under the tab's own ref", async () => {
  const canvasRemoteOpen = vi.fn(async () => ({ ok: true, value: { path: 'fleet.excalidraw', canEdit: true } }))
  const canvasRemoteCommit = vi.fn(async () => ({ ok: true, value: { revision: 2, elements: null } }))
  const canvasRemoteExport = vi.fn(async () => ({ ok: true, value: { cancelled: true } }))
  const canvasRemoteNoteHumanInput = vi.fn()
  const canvasRemoteClose = vi.fn(async () => undefined)
  const canvasOpenBoard = vi.fn()
  api({
    canvasRemoteOpen,
    canvasRemoteCommit,
    canvasRemoteExport,
    canvasRemoteNoteHumanInput,
    canvasRemoteClose,
    canvasOpenBoard,
  })
  const client = canvasBoardClient(paired)
  const ref = { workspaceId: 'local-chat', path: 'fleet.excalidraw', store: STORE }
  await client.open({ ...ref, create: false })
  expect(canvasRemoteOpen).toHaveBeenCalledWith({
    ...ref,
    create: false,
    connectionId: 'conn-1',
    remoteWorkspaceId: 'far-chat',
  })
  expect(canvasOpenBoard).not.toHaveBeenCalled()
  await client.commit({ ...ref, baseRevision: 1, elements: [], appState: {}, files: {} })
  expect(canvasRemoteCommit).toHaveBeenCalledWith(
    expect.objectContaining({ connectionId: 'conn-1', remoteWorkspaceId: 'far-chat', baseRevision: 1 }),
  )
  client.noteHumanInput(ref)
  expect(canvasRemoteNoteHumanInput).toHaveBeenCalledWith({
    ...ref,
    connectionId: 'conn-1',
    remoteWorkspaceId: 'far-chat',
  })
  // Its folder is picked on this machine: nothing from the chat's is suggested.
  await client.exportBoard({ ...ref, defaultDirectory: '/Users/dev/harbor', images: {} })
  expect(canvasRemoteExport).toHaveBeenCalledWith({
    ...ref,
    images: {},
    connectionId: 'conn-1',
    remoteWorkspaceId: 'far-chat',
  })
  client.close(ref)
  expect(canvasRemoteClose).toHaveBeenCalled()
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
  let listener: ((link: unknown) => void) | null = null
  api({ onCanvasRemoteLink: (cb: (link: unknown) => void) => ((listener = cb), () => undefined) })
  const heard: unknown[] = []
  canvasBoardClient(paired).onLink({ workspaceId: 'local-chat', path: 'fleet.excalidraw' }, (link) => heard.push(link))
  listener!({ workspaceId: 'local-chat', path: 'other.excalidraw', state: 'reconnecting', canEdit: true, message: 'x' })
  listener!({
    workspaceId: 'local-chat',
    path: 'fleet.excalidraw',
    state: 'reconnecting',
    canEdit: true,
    message: 'away',
  })
  expect(heard).toHaveLength(1)
})

test("a paired chat's agent opening a board is heard while the window shows that chat", () => {
  let listener: ((request: unknown) => void) | null = null
  const canvasRemoteWatch = vi.fn(async () => undefined)
  const canvasRemoteUnwatch = vi.fn(async () => undefined)
  api({
    canvasRemoteWatch,
    canvasRemoteUnwatch,
    onCanvasRemoteOpenRequest: (cb: (request: unknown) => void) => ((listener = cb), () => undefined),
  })
  const opened: unknown[] = []
  const stop = watchPairedCanvasOpens(paired, (board) => opened.push(board))
  expect(canvasRemoteWatch).toHaveBeenCalledWith({ connectionId: 'conn-1', workspaceId: 'far-chat' })
  listener!({ connectionId: 'conn-1', workspaceId: 'another-chat', path: 'x.excalidraw' })
  listener!({ connectionId: 'conn-1', workspaceId: 'far-chat', path: 'fleet.excalidraw', store: STORE })
  expect(opened).toEqual([{ path: 'fleet.excalidraw', store: STORE }])
  stop()
  expect(canvasRemoteUnwatch).toHaveBeenCalledWith({ connectionId: 'conn-1', workspaceId: 'far-chat' })
})

test("a paired machine's answer about its boards is passed on, and one that cannot be reached says so", async () => {
  api({ canvasRemoteAccess: vi.fn(async () => ({ ok: true, live: false, canEdit: true, reason: 'older' })) })
  expect(await readCanvasBoardAccess(paired)).toEqual({ ok: true, live: false, canEdit: true, reason: 'older' })
  api({ canvasRemoteAccess: vi.fn(async () => Promise.reject(new Error('gone'))) })
  expect(await readCanvasBoardAccess(paired)).toEqual({ ok: false, message: 'mac-mini could not be reached.' })
})
