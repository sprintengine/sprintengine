import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { CanvasElement, CanvasRemoteLink } from '../../../shared/canvas/types'
import type { TailnetScope } from '../../../shared/tailnet'
import { FAR_CHAT, MACHINE, element, farMachine, waitFor, type FarMachine } from './tailnet-canvas.test-helper'
import { deviceWindowApi, pairedWindow } from '../../../../tests/paired-window'
import {
  PAIRED_CANVAS_LINK,
  PAIRED_CANVAS_OPEN_REQUEST,
  WINDOW_CANVAS_VIEWER,
  createPairedCanvas,
  listPairedBoards,
  onPairedCanvasPush,
  pairedBoardPicture,
  windowPairedCanvas,
  type PairedCanvas,
} from '../../../renderer/src/studio/pairedCanvas'
import { closeEnvironmentStudios, environmentStudios } from '../../../renderer/src/studio/environmentStudio'

// A paired desktop's Canvas pane on the boards of the machine a chat runs on,
// with both ends real and over loopback: on one side the tailnet listener, the
// Studio server and the canvas service over a real folder; on the other this
// desktop's window's half (src/renderer/src/studio/pairedCanvas.ts) on its own
// Studio connection to that machine, its tickets bought with a paired device's
// token for a window's origin. What a tab here would be is a viewer that
// records what it is pushed; what a window over there would be is
// a subscriber of the far service that records the same.

let cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

type Push = { viewer: number; channel: string; payload: Record<string, unknown> }

async function machine(options: { canvas?: boolean } = {}): Promise<FarMachine> {
  const far = await farMachine(options)
  cleanups.push(() => far.dispose())
  return far
}

/** This desktop: its half of the pane, holding a paired device's token for the far machine. */
function pairedDesktop(far: FarMachine, scopes: TailnetScope[] = ['workspace:read', 'workspace:operate']) {
  const device = far.rig.pair(scopes, 'dev-macbook-air')
  const api = deviceWindowApi({ endpoint: far.endpoint, deviceToken: device.token, machineName: MACHINE })
  cleanups.push(() => closeEnvironmentStudios(api))
  const lane: PairedCanvas = createPairedCanvas({
    target: (id) => (id === 'conn-1' ? { id, machineName: MACHINE } : null),
    studios: environmentStudios(api),
    lingerMs: 20,
    requestTimeoutMs: 5_000,
  })
  cleanups.push(() => lane.shutdown())
  const pushes: Push[] = []
  const viewer = (id: number) => ({
    id,
    send: (channel: string, payload: unknown): void => {
      pushes.push({ viewer: id, channel, payload: payload as Record<string, unknown> })
    },
  })
  const board = (path: string, extra: Record<string, unknown> = {}) => ({
    connectionId: 'conn-1',
    remoteWorkspaceId: FAR_CHAT,
    workspaceId: 'local-chat',
    path,
    ...extra,
  })
  return { lane, pushes, viewer, board, deviceId: device.id }
}

const scenesFor = (pushes: Push[], viewer: number) =>
  pushes.filter((push) => push.viewer === viewer && push.channel === 'canvas:scene').map((push) => push.payload)
const linksOf = (pushes: Push[]) =>
  pushes
    .filter((push) => push.channel === PAIRED_CANVAS_LINK)
    .map((push) => push.payload as unknown as CanvasRemoteLink)

test('a paired desktop makes a board over there, draws on it, and that machine keeps it', async () => {
  const far = await machine()
  const here = pairedDesktop(far)
  assert.deepEqual(await here.lane.access('conn-1'), { ok: true, live: true, canEdit: true })

  const opened = await here.lane.open(here.viewer(1), { ...here.board('plan'), create: true })
  assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
  assert.equal(opened.value.canEdit, true)
  assert.equal(opened.value.path, 'plan.excalidraw')
  const committed = await here.lane.commit(here.viewer(1), {
    ...here.board('plan'),
    baseRevision: opened.value.revision,
    elements: [element('drawn-here')],
    appState: { viewBackgroundColor: '#fff' },
    files: {},
  })
  assert.ok(committed.ok, committed.ok ? '' : committed.error.message)
  assert.ok(committed.value.revision > opened.value.revision)
  assert.deepEqual(
    far.sceneOnDisk('plan').map((item) => item.id),
    ['drawn-here'],
  )
  const snapshot = here.lane.snapshot(here.board('plan'))
  assert.ok(snapshot.ok)
  assert.deepEqual(
    snapshot.value.elements.map((item) => item.id),
    ['drawn-here'],
  )
})

test("an agent's edit over there appears here as it lands, with the agent's presence", async () => {
  const far = await machine()
  const here = pairedDesktop(far)
  const opened = await here.lane.open(here.viewer(1), { ...here.board('plan'), create: true })
  assert.ok(opened.ok)

  const edited = await far.service.edit(
    { workspaceId: FAR_CHAT, path: 'plan.excalidraw' },
    { create: [{ tempId: 'a', type: 'rectangle', x: 10, y: 10 }] },
    { kind: 'agent', workspaceId: FAR_CHAT, agentId: 'agent-1', agentName: 'Scout' },
  )
  assert.ok(edited.ok, edited.ok ? '' : edited.error.message)
  await waitFor(() => scenesFor(here.pushes, 1).length > 0, 'the agent’s scene is pushed here')
  const scene = scenesFor(here.pushes, 1).at(-1)!
  assert.equal(scene.workspaceId, 'local-chat', 'under this window’s own ref')
  assert.equal(scene.origin, 'agent')
  assert.ok((scene.revision as number) > opened.value.revision)
  assert.deepEqual(
    (scene.elements as CanvasElement[]).map((item) => item.id),
    edited.value.result.created,
  )
  await waitFor(
    () => here.pushes.some((push) => push.channel === 'canvas:presence' && push.payload.controller === 'agent'),
    'the agent’s presence is pushed here',
  )
  const presence = here.pushes.find((push) => push.channel === 'canvas:presence')!.payload
  assert.equal(presence.agentName, 'Scout')
  assert.equal(presence.workspaceId, 'local-chat')
})

test('two people drawing at once, one here and one over there, keep both drawings', async () => {
  const far = await machine()
  const here = pairedDesktop(far)
  const opened = await here.lane.open(here.viewer(1), { ...here.board('plan'), create: true })
  assert.ok(opened.ok)
  // A second window here, and a window over there, on the same board.
  const second = await here.lane.open(here.viewer(2), here.board('plan'))
  assert.ok(second.ok)
  const farRef = { workspaceId: FAR_CHAT, path: 'plan.excalidraw' }
  const farOpen = await far.service.openBoard(farRef, { subscriberId: 7 })
  assert.ok(farOpen.ok)

  const [mine, theirs] = await Promise.all([
    here.lane.commit(here.viewer(1), {
      ...here.board('plan'),
      baseRevision: opened.value.revision,
      elements: [element('drawn-here')],
      appState: {},
      files: {},
    }),
    far.service.commitScene(
      { ...farRef, baseRevision: farOpen.value.revision, elements: [element('drawn-there')], appState: {}, files: {} },
      7,
    ),
  ])
  assert.ok(mine.ok && theirs.ok)
  assert.deepEqual(
    far
      .sceneOnDisk('plan')
      .map((item) => item.id)
      .sort(),
    ['drawn-here', 'drawn-there'],
  )
  await waitFor(
    () => far.windowPushes.some((push) => push.payload.elements.some((item) => item.id === 'drawn-here')),
    'the window over there hears the drawing from here',
  )
  await waitFor(
    () =>
      scenesFor(here.pushes, 2).some((scene) =>
        (scene.elements as CanvasElement[]).some((item) => item.id === 'drawn-here'),
      ),
    'the second window here hears the first',
  )
  await waitFor(
    () =>
      scenesFor(here.pushes, 1).some((scene) =>
        (scene.elements as CanvasElement[]).some((item) => item.id === 'drawn-there'),
      ) ||
      (mine.ok && (mine.value.elements ?? []).some((item) => item.id === 'drawn-there')),
    'the window here hears the drawing from over there',
  )
})

test('a large board with a large picture crosses in parts, and the picture once each way', async () => {
  const far = await machine()
  const here = pairedDesktop(far)
  const opened = await here.lane.open(here.viewer(1), { ...here.board('big'), create: true })
  assert.ok(opened.ok)
  // Past what one client frame carries: a drawing of 2.4 MB and a 3 MB picture.
  const elements = Array.from({ length: 2_000 }, (_, index) =>
    element(`box-${index}`, { text: `note ${index} ${'x'.repeat(1_200)}` }),
  )
  const picture = {
    id: 'photo',
    mimeType: 'image/png',
    dataURL: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`,
    created: 1,
  }
  elements.push(element('photo-element', { type: 'image', fileId: 'photo' }))
  const first = await here.lane.commit(here.viewer(1), {
    ...here.board('big'),
    baseRevision: opened.value.revision,
    elements,
    appState: {},
    files: { photo: picture },
  })
  assert.ok(first.ok, first.ok ? '' : first.error.message)
  assert.equal(far.sceneOnDisk('big').length, 2_001)
  assert.deepEqual(Object.keys(far.filesOnDisk('big')), ['photo'])
  assert.ok(far.calls.filter((call) => call.method === 'stage').length > 5, 'the change went in parts')

  // A second change to the same board sends its drawing, not its picture again.
  const before = far.calls.length
  const second = await here.lane.commit(here.viewer(1), {
    ...here.board('big'),
    baseRevision: first.value.revision,
    elements: [...elements, element('one-more')],
    appState: {},
    files: { photo: picture },
  })
  assert.ok(second.ok)
  const sent = far.calls.slice(before).reduce((sum, call) => sum + (call.method === 'files' ? 0 : call.bytes), 0)
  assert.ok(sent < 3 * 1024 * 1024, `the picture is not sent again (${sent} characters went)`)

  // Another desktop opening it gets all of it, picture and all, the picture apart from the scene.
  const other = pairedDesktop(far)
  const reopened = await other.lane.open(other.viewer(1), other.board('big'))
  assert.ok(reopened.ok, reopened.ok ? '' : reopened.error.message)
  assert.equal(reopened.value.elements.length, 2_002)
  assert.equal((reopened.value.files.photo as { dataURL: string }).dataURL.length, picture.dataURL.length)
  const reads = far.calls.filter((call) => call.method === 'read')
  assert.ok(reads.at(-1)!.bytes < 3 * 1024 * 1024, 'the scene it read carried no picture')
})

test('a pairing that may only look sees the board, and is told in words it cannot change it', async () => {
  const far = await machine()
  await far.service.readBoard({ workspaceId: FAR_CHAT, path: 'plan.excalidraw' }, { create: true })
  const here = pairedDesktop(far, ['workspace:read'])
  assert.deepEqual(await here.lane.access('conn-1'), { ok: true, live: true, canEdit: false })

  const opened = await here.lane.open(here.viewer(1), here.board('plan'))
  assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
  assert.equal(opened.value.canEdit, false)
  const refused = await here.lane.commit(here.viewer(1), {
    ...here.board('plan'),
    baseRevision: 0,
    elements: [element('should-not-land')],
    appState: {},
    files: {},
  })
  assert.ok(!refused.ok)
  assert.match(refused.error.message, /can look at boards on mac-mini but not change them/u)
  assert.deepEqual(far.sceneOnDisk('plan'), [])
  // A new board is not made for it either.
  const made = await here.lane.open(here.viewer(1), { ...here.board('fresh'), create: true })
  assert.ok(!made.ok)
  assert.equal(existsSync(join(far.storeDir, 'fresh.excalidraw')), false)
})

test('a machine whose Studio serves no boards: the pane says to update it there', async () => {
  const far = await machine({ canvas: false })
  const here = pairedDesktop(far)
  const access = await here.lane.access('conn-1')
  assert.ok(access.ok)
  assert.equal(access.live, false)
  assert.match(access.reason ?? '', /mac-mini runs a Studio that does not serve its boards here/u)
  const opened = await here.lane.open(here.viewer(1), here.board('plan'))
  assert.ok(!opened.ok)
  assert.match(opened.error.message, /Update SprintEngine Studio there/u)
})

test('the link drops and comes back: what was drawn meanwhile is saved, and the windows are told', async () => {
  const far = await machine()
  const here = pairedDesktop(far)
  const opened = await here.lane.open(here.viewer(1), { ...here.board('plan'), create: true })
  assert.ok(opened.ok)

  await far.stop()
  await waitFor(
    () => linksOf(here.pushes).some((link) => link.state === 'reconnecting'),
    'the window is told it is away',
  )
  assert.match(linksOf(here.pushes).at(-1)!.message ?? '', /mac-mini is out of reach\. What you draw is kept here/u)

  // Drawn while away: taken, and kept.
  const away = await here.lane.commit(here.viewer(1), {
    ...here.board('plan'),
    baseRevision: opened.value.revision,
    elements: [element('drawn-away')],
    appState: {},
    files: {},
  })
  assert.ok(away.ok)
  assert.deepEqual(far.sceneOnDisk('plan'), [])

  // An agent draws over there meanwhile, as the machine comes back.
  await far.service.edit(
    { workspaceId: FAR_CHAT, path: 'plan.excalidraw' },
    { create: [{ tempId: 'a', type: 'rectangle', x: 0, y: 0 }] },
    { kind: 'agent', workspaceId: FAR_CHAT, agentId: 'agent-1', agentName: 'Scout' },
  )
  await far.restart()
  await waitFor(() => linksOf(here.pushes).at(-1)?.state === 'live', 'the window is told it is back', 15_000)
  await waitFor(
    () => far.sceneOnDisk('plan').some((item) => item.id === 'drawn-away'),
    'what was drawn away is saved there',
    15_000,
  )
  assert.equal(far.sceneOnDisk('plan').length, 2, 'the agent’s box and the person’s are both there')
  await waitFor(
    () =>
      scenesFor(here.pushes, 1).some((scene) =>
        (scene.elements as CanvasElement[]).some((item) => item.id.startsWith('agent-box')),
      ),
    'the window hears the board as it stands',
  )
  const revisions = scenesFor(here.pushes, 1).map((scene) => scene.revision as number)
  assert.deepEqual(
    revisions,
    [...revisions].sort((a, b) => a - b),
    'what the window is told never goes backwards',
  )
})

test('a revoked pairing: the board is told it can no longer be saved there', async () => {
  const far = await machine()
  const here = pairedDesktop(far)
  const opened = await here.lane.open(here.viewer(1), { ...here.board('plan'), create: true })
  assert.ok(opened.ok)
  far.rig.devices.revokeDevice(here.deviceId)
  await waitFor(() => linksOf(here.pushes).some((link) => link.state === 'gone'), 'the window is told')
  const gone = linksOf(here.pushes).at(-1)!
  assert.match(String(gone.message), /mac-mini no longer accepts this pairing/u)
  assert.equal(gone.canEdit, false)
})

test("an agent's canvas.open over there opens the board here, for the window showing that chat", async () => {
  const far = await machine()
  const here = pairedDesktop(far)
  await far.service.readBoard({ workspaceId: FAR_CHAT, path: 'plan.excalidraw' }, { create: true })
  const viewer = here.viewer(1)
  const send = viewer.send
  let asked: Promise<unknown> | null = null
  // The window opens what it is asked to, which is what tells the agent it was shown.
  viewer.send = (channel, payload) => {
    send(channel, payload)
    if (channel === PAIRED_CANVAS_OPEN_REQUEST)
      asked = here.lane.open(viewer, here.board((payload as { path: string }).path))
  }
  here.lane.watch(viewer, { connectionId: 'conn-1', workspaceId: FAR_CHAT })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const revealed = await far.service.requestOpen({ workspaceId: FAR_CHAT, path: 'plan.excalidraw' })
  await waitFor(() => asked !== null, 'the window was asked')
  await asked
  assert.ok(revealed.ok)
  assert.equal(revealed.value.revealed, true, 'the agent is told the board was shown')
  const request = here.pushes.find((push) => push.channel === PAIRED_CANVAS_OPEN_REQUEST)!.payload
  assert.deepEqual(request, { connectionId: 'conn-1', workspaceId: FAR_CHAT, path: 'plan.excalidraw' })
})

test('a desktop window carries a paired machine’s boards, list, picture and pane, end to end', async () => {
  const far = await machine()
  const window = await pairedWindow({ port: () => far.port, devices: far.rig.devices }, [
    'workspace:read',
    'workspace:operate',
  ])
  cleanups.push(() => window.close())
  const machineHere = window.machine
  const connectionId = machineHere.id
  const canvas = windowPairedCanvas(machineHere)
  assert.deepEqual(await canvas.access(connectionId), { ok: true, live: true, canEdit: true })
  const pushes: Push[] = []
  for (const channel of ['canvas:scene', PAIRED_CANVAS_LINK])
    cleanups.push(
      onPairedCanvasPush(channel, (payload) =>
        pushes.push({ viewer: 1, channel, payload: payload as Record<string, unknown> }),
      ),
    )
  const ref = { connectionId, remoteWorkspaceId: FAR_CHAT, workspaceId: 'local-chat', path: 'plan' }
  const opened = await canvas.open(WINDOW_CANVAS_VIEWER, { ...ref, create: true })
  assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
  const committed = await canvas.commit(WINDOW_CANVAS_VIEWER, {
    ...ref,
    baseRevision: 0,
    elements: [element('via-window')],
    appState: {},
    files: {},
  })
  assert.ok(committed.ok)
  assert.deepEqual(
    far.sceneOnDisk('plan').map((item) => item.id),
    ['via-window'],
  )
  // The picker's list, every board on the machine, and the picture of one.
  const listed = await listPairedBoards(machineHere, FAR_CHAT, 'machine')
  assert.ok(listed.ok, listed.ok ? '' : listed.message)
  assert.equal(listed.allBoards, true)
  assert.deepEqual(
    listed.boards.map((row) => [row.name, row.project, row.here]),
    [['plan', basename(far.project), true]],
  )
  const picture = await pairedBoardPicture(machineHere, {
    workspaceId: FAR_CHAT,
    board: listed.boards[0]!.id!,
    dark: false,
  })
  assert.ok(picture.ok, picture.ok ? '' : picture.message)
  assert.equal(picture.mimeType, 'image/png')
  // Forgetting the machine here ends the pane, and the tab is told.
  window.mesh.forget(connectionId)
  window.environmentsChanged()
  await waitFor(
    () => pushes.some((push) => push.channel === PAIRED_CANVAS_LINK && push.payload.state === 'gone'),
    'the tab is told the board is gone',
  )
})
