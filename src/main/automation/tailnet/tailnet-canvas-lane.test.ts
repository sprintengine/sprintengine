import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createSecretCipherStandIn } from '../../../../tests/stubs/secret-cipher'
import type { CanvasElement, CanvasRemoteLink, CanvasScenePush } from '../../../shared/canvas/types'
import type { TailnetScope } from '../../../shared/tailnet'
import { canvasBoardStoreDir } from '../../canvas/canvas-board-store'
import { createCanvasRemoteSubscribers, isRemoteCanvasSubscriber } from '../../canvas/canvas-remote-subscribers'
import { createCanvasService, type CanvasServiceInternal } from '../../canvas/canvas-service'
import { createCanvasStoreCatalogue } from '../../canvas/canvas-store-catalogue'
import { createNodeCanvasFs, watchCanvasDirectory } from '../../canvas/canvas-node-fs'
import type { CanvasWorkerHost } from '../../canvas/canvas-worker-host'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { createTailnetMeshService } from './tailnet-mesh-service'
import { createTailnetMeshStore } from './tailnet-mesh-store'
import { createTailnetPeerResolver } from './tailnet-peer-identity'
import {
  openRemoteCanvasSocket,
  pairWithMachine,
  readRemoteIdentity,
  type RemoteCanvasSocket,
} from './tailnet-remote-client'
import {
  CANVAS_REMOTE_LINK_CHANNEL,
  createTailnetRemoteCanvas,
  type TailnetRemoteCanvas,
} from './tailnet-remote-canvas'
import { pairingUrl } from './tailnet-service'
import { canvasLaneMessages, createCanvasLaneAssembler } from './tailnet-canvas-wire'

// A paired desktop's Canvas pane on the boards of the machine a chat runs on
// (`canvas-live-boards`), with both ends real and over loopback: on one side
// the gateway, its device store and the canvas service over a real folder; on
// the other this desktop's half of the lane, dialling it with a paired
// device's token. What a window here would be is a viewer that records what
// it is pushed; what a window over there would be is a subscriber of the far
// service that records the same.

const FAR_CHAT = 'far-chat'
const MACHINE = 'mac-mini'

let cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

async function waitFor(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms
  while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(predicate(), what)
}

function dir(prefix: string): string {
  const made = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(made, { recursive: true, force: true }))
  return made
}

let nonce = 1
function element(id: string, extra: Partial<CanvasElement> = {}): CanvasElement {
  return {
    id,
    type: 'rectangle',
    version: 1,
    versionNonce: nonce++,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    isDeleted: false,
    updated: Date.now(),
    ...extra,
  }
}

/** A worker that answers an agent's edit with the boxes it was asked for: what an agent drawing looks like to the service. */
function agentWorker(): CanvasWorkerHost {
  return {
    call: (async (request: Record<string, unknown>) => {
      if (request.kind !== 'apply-edit') return { ok: false, error: { code: 'worker_unavailable', message: 'no' } }
      const edit = request.edit as { create?: Array<{ tempId?: string }> }
      const created = (edit.create ?? []).map((_, index) => element(`agent-box-${nonce}-${index}`))
      return {
        ok: true,
        value: {
          kind: 'apply-edit',
          requestId: 'r',
          ok: true,
          elements: [...(request.elements as CanvasElement[]), ...created],
          files: {},
          changed: [],
          result: { created: created.map((box) => box.id), updated: [], deleted: [], tempIds: {}, warnings: [] },
        },
      }
    }) as unknown as CanvasWorkerHost['call'],
    report: () => null,
    dispose: async () => undefined,
  }
}

type Push = { viewer: number; channel: string; payload: Record<string, unknown> }

/** The machine that holds the boards: a real gateway in front of a real canvas service. */
async function farMachine(options: { canvas?: boolean } = {}) {
  const project = dir('canvas-lane-project-')
  const userData = dir('canvas-lane-far-data-')
  const deviceDir = dir('canvas-lane-far-devices-')
  const workspaces = [{ id: FAR_CHAT, folderPath: project, name: 'Atlas' }]
  const remote = createCanvasRemoteSubscribers()
  const windowPushes: Array<{ subscriberId: number; channel: string; payload: CanvasScenePush }> = []
  const service: CanvasServiceInternal = createCanvasService({
    fs: createNodeCanvasFs(),
    now: () => Date.now(),
    resolveWorkspaceRoot: (id) => (id === FAR_CHAT ? project : null),
    resolveBoardStore: (_id, root) => canvasBoardStoreDir(userData, root),
    storeCatalogue: createCanvasStoreCatalogue({ userDataDir: userData, listWorkspaces: () => workspaces }),
    broadcast: (channel, payload) => remote.broadcast(channel, payload),
    sendTo: (subscriberId, channel, payload) => {
      if (isRemoteCanvasSubscriber(subscriberId)) remote.sendTo(subscriberId, channel, payload)
      else windowPushes.push({ subscriberId, channel, payload: payload as CanvasScenePush })
    },
    watch: watchCanvasDirectory,
    worker: agentWorker(),
  })
  cleanups.push(() => service.dispose())
  const devices: TailnetDeviceStore = createTailnetDeviceStore({ resolveUserDataDir: () => deviceDir })
  let server: TailnetGatewayServer | null = null
  const start = async (port = 0) => {
    server = createTailnetGatewayServer({
      bindAddress: '127.0.0.1',
      port,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: () => [],
      isMutation: () => false,
      devices,
      peers: createTailnetPeerResolver({ runWhois: async () => null }),
      ...(options.canvas === false ? {} : { canvas: remote.host(service) }),
    })
    await server.start()
    return server.address()!.port
  }
  const port = await start()
  cleanups.push(async () => {
    await server?.stop().catch(() => undefined)
  })
  const storeDir = canvasBoardStoreDir(userData, project)
  return {
    project,
    storeDir,
    service,
    devices,
    windowPushes,
    port,
    endpoint: { host: '127.0.0.1', port },
    stop: () => server!.stop(),
    restart: () => start(port),
    sceneOnDisk(name: string): CanvasElement[] {
      const text = readFileSync(join(storeDir, `${name}.excalidraw`), 'utf8')
      return (JSON.parse(text) as { elements: CanvasElement[] }).elements
    },
    filesOnDisk(name: string): Record<string, unknown> {
      const text = readFileSync(join(storeDir, `${name}.excalidraw`), 'utf8')
      return (JSON.parse(text) as { files: Record<string, unknown> }).files
    },
  }
}

/** This desktop: its half of the lane, holding a paired device's token for the far machine. */
async function pairedDesktop(
  far: Awaited<ReturnType<typeof farMachine>>,
  scopes: TailnetScope[] = ['workspace:read', 'workspace:operate'],
) {
  const offer = far.devices.offerPairing({ scopes })
  const paired = await pairWithMachine({
    endpoint: far.endpoint,
    pairingToken: offer.token,
    deviceName: 'dev-macbook-air',
  })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  let capabilities: string[] | null | undefined
  const sent: string[] = []
  const sockets: RemoteCanvasSocket[] = []
  const lane: TailnetRemoteCanvas = createTailnetRemoteCanvas({
    connection: (id) =>
      id === 'conn-1' ? { endpoint: far.endpoint, token: paired.value.deviceToken, machineName: MACHINE } : null,
    identity: async () => {
      const identity = await readRemoteIdentity({ endpoint: far.endpoint, token: paired.value.deviceToken })
      if (identity.ok) capabilities = identity.value.capabilities
      return identity.ok
        ? { ok: true, value: { scopes: identity.value.scopes, capabilities: identity.value.capabilities } }
        : identity
    },
    knownCapabilities: () => capabilities,
    // The real socket, with every message it sends counted.
    openSocket: async (input) => {
      const opened = await openRemoteCanvasSocket(input)
      if (!opened.ok) return opened
      const socket = opened.value
      sockets.push(socket)
      return {
        ok: true,
        value: {
          ...socket,
          sendText: (text: string) => {
            sent.push(text)
            socket.sendText(text)
          },
        },
      }
    },
    retry: { baseMs: 20, maxMs: 100 },
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
  return {
    lane,
    pushes,
    viewer,
    board,
    sent,
    sockets,
    deviceId: paired.value.deviceId,
    token: paired.value.deviceToken,
  }
}

const scenesFor = (pushes: Push[], viewer: number) =>
  pushes.filter((push) => push.viewer === viewer && push.channel === 'canvas:scene').map((push) => push.payload)

test('a paired desktop makes a board over there, draws on it, and that machine keeps it', async () => {
  const far = await farMachine()
  const here = await pairedDesktop(far)
  const access = await here.lane.access('conn-1')
  assert.deepEqual(access, { ok: true, live: true, canEdit: true })

  const opened = await here.lane.open(here.viewer(1), { ...here.board('plan'), create: true })
  assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
  assert.equal(opened.value.canEdit, true)
  assert.equal(opened.value.path, 'plan.excalidraw')
  assert.match(opened.value.id ?? '', /^canvas:\/\/ws_[0-9a-f]{24}\/plan\.excalidraw$/u)
  assert.ok(existsSync(join(far.storeDir, 'plan.excalidraw')), 'the new board is a file in that machine’s store')

  const box = element('person-box')
  const committed = await here.lane.commit(here.viewer(1), {
    ...here.board('plan'),
    baseRevision: opened.value.revision,
    elements: [box],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  })
  assert.ok(committed.ok, committed.ok ? '' : committed.error.message)
  assert.ok(committed.value.revision > opened.value.revision)
  assert.deepEqual(
    far.sceneOnDisk('plan').map((item) => item.id),
    ['person-box'],
  )
})

test("an agent's edit over there appears here as it lands, with the agent's presence", async () => {
  const far = await farMachine()
  const here = await pairedDesktop(far)
  await here.lane.access('conn-1')
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
  assert.deepEqual(presence.selectedElementIds, [])
})

test('two people drawing at once, one here and one over there, keep both drawings', async () => {
  const far = await farMachine()
  const here = await pairedDesktop(far)
  await here.lane.access('conn-1')
  const opened = await here.lane.open(here.viewer(1), { ...here.board('plan'), create: true })
  assert.ok(opened.ok)
  // A second window here, and a window over there, on the same board.
  const second = await here.lane.open(here.viewer(2), here.board('plan'))
  assert.ok(second.ok)
  const farRef = { workspaceId: FAR_CHAT, path: 'plan.excalidraw' }
  const farOpen = await far.service.openBoard(farRef, { subscriberId: 7 })
  assert.ok(farOpen.ok)

  // Both from the same base, at the same moment: neither has seen the other's.
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
  // Each side hears the other's, and the second window here hears the first's.
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
  // And one edit to the same element from both sides is decided the same way on each: the higher version wins.
  const shared = element('shared', { version: 5 })
  await here.lane.commit(here.viewer(1), {
    ...here.board('plan'),
    baseRevision: 0,
    elements: [shared],
    appState: {},
    files: {},
  })
  await far.service.commitScene(
    { ...farRef, baseRevision: 0, elements: [{ ...shared, version: 4, x: 999 }], appState: {}, files: {} },
    7,
  )
  assert.equal(far.sceneOnDisk('plan').find((item) => item.id === 'shared')?.x, 0, 'the newer edit stands')
})

test('a board too large for one message, with a large picture, crosses in parts and the picture once', async () => {
  const far = await farMachine()
  const here = await pairedDesktop(far)
  await here.lane.access('conn-1')
  const opened = await here.lane.open(here.viewer(1), { ...here.board('big'), create: true })
  assert.ok(opened.ok)
  // Well past the 1 MiB a WebSocket message may be: a drawing of 2.4 MB and a 3 MB picture.
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
  const pictureMessages = () => here.sent.filter((text) => text.length > 1024 * 1024).length
  assert.equal(pictureMessages(), 0, 'nothing sent is past the 1 MiB cap')
  const partsAfterFirst = here.sent.filter((text) => text.startsWith('{"type":"part"')).length
  assert.ok(partsAfterFirst > 5, 'the commit went in parts')

  // A second change to the same board sends its drawing, not its picture again.
  const sentBefore = here.sent.join('').length
  const second = await here.lane.commit(here.viewer(1), {
    ...here.board('big'),
    baseRevision: first.value.revision,
    elements: [...elements, element('one-more')],
    appState: {},
    files: { photo: picture },
  })
  assert.ok(second.ok)
  const sentSecond = here.sent.join('').length - sentBefore
  assert.ok(sentSecond < 4 * 1024 * 1024, `the picture is not sent again (${sentSecond} characters went)`)

  // Another desktop opening it gets all of it, picture and all, under the cap.
  const other = await pairedDesktop(far)
  await other.lane.access('conn-1')
  const reopened = await other.lane.open(other.viewer(1), other.board('big'))
  assert.ok(reopened.ok, reopened.ok ? '' : reopened.error.message)
  assert.equal(reopened.value.elements.length, 2_002)
  assert.equal((reopened.value.files.photo as { dataURL: string }).dataURL.length, picture.dataURL.length)
})

test('a pairing that may only look sees the board, and is told in words it cannot change it', async () => {
  const far = await farMachine()
  // A board that is already there.
  const seeded = await far.service.readBoard({ workspaceId: FAR_CHAT, path: 'plan.excalidraw' }, { create: true })
  assert.ok(seeded.ok)
  const here = await pairedDesktop(far, ['workspace:read'])
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

  // A new board is not made for it either, and it is told why.
  const made = await here.lane.open(here.viewer(1), { ...here.board('fresh'), create: true })
  assert.ok(!made.ok)
  assert.match(made.error.message, /can look at boards on mac-mini but not change them/u)
  assert.equal(existsSync(join(far.storeDir, 'fresh.excalidraw')), false)

  // Said straight to the lane, a change is refused there too, with its reason.
  const socket = await rawLane(far, here.token)
  socket.send({ type: 'open', id: 1, board: 1, ref: { workspaceId: FAR_CHAT, path: 'plan.excalidraw' } })
  await socket.next((message) => message.type === 'opened')
  socket.send({ type: 'file', board: 1, id: 'f', value: { dataURL: 'x' } })
  socket.send({ type: 'commit', id: 2, board: 1, baseRevision: 0, elements: [element('sneaked')], appState: {} })
  const answer = await socket.next((message) => message.type === 'committed')
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'read_only')
  assert.deepEqual(far.sceneOnDisk('plan'), [])
})

/** The lane spoken to directly, as a peer that writes its own messages would. */
async function rawLane(far: Awaited<ReturnType<typeof farMachine>>, token: string) {
  const messages: Array<Record<string, unknown>> = []
  const assembler = createCanvasLaneAssembler()
  const opened = await openRemoteCanvasSocket({
    endpoint: far.endpoint,
    token,
    handlers: {
      onFrame: (frame) => {
        const assembled = assembler.push(frame)
        if (assembled.kind === 'message') messages.push(assembled.message)
      },
      onClosed: () => undefined,
    },
  })
  assert.ok(opened.ok, opened.ok ? '' : opened.message)
  cleanups.push(() => opened.value.close('done'))
  let read = 0
  return {
    send: (message: Record<string, unknown>) => {
      for (const text of canvasLaneMessages(message, () => 1)) opened.value.sendText(text)
    },
    async next(match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      await waitFor(() => messages.slice(read).some(match), 'the lane answers')
      const index = messages.findIndex((message, at) => at >= read && match(message))
      read = index + 1
      return messages[index]
    },
  }
}

test('a crafted path cannot reach anything but a board in its store or project', async () => {
  const far = await farMachine()
  const here = await pairedDesktop(far)
  // Things a crafted path might hope to reach: a board beside the project, and a secret.
  const outside = dirname(far.project)
  writeFileSync(
    join(outside, 'beside.excalidraw'),
    JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }),
  )
  mkdirSync(join(far.project, '.git'), { recursive: true })
  cleanups.push(() => rmSync(join(outside, 'beside.excalidraw'), { force: true }))
  const socket = await rawLane(far, here.token)
  const crafted: Array<Record<string, unknown>> = [
    { workspaceId: FAR_CHAT, path: '../beside.excalidraw' },
    { workspaceId: FAR_CHAT, path: 'diagrams/../../beside' },
    { workspaceId: FAR_CHAT, path: '..\\..\\beside' },
    { workspaceId: FAR_CHAT, path: join(outside, 'beside.excalidraw') },
    { workspaceId: FAR_CHAT, path: '/etc/passwd' },
    { workspaceId: FAR_CHAT, path: 'C:/Windows/win.ini' },
    { workspaceId: FAR_CHAT, path: '.git/config' },
    { workspaceId: FAR_CHAT, path: 'node_modules/x' },
    { workspaceId: FAR_CHAT, path: 'notes.json' },
    { workspaceId: FAR_CHAT, path: `bad${String.fromCharCode(0)}.excalidraw` },
    { workspaceId: FAR_CHAT, path: 'beside', store: '../../' },
    { workspaceId: FAR_CHAT, path: 'beside', store: `ws_${'g'.repeat(24)}` },
    { workspaceId: FAR_CHAT, path: '../beside', store: `ws_${'a'.repeat(24)}` },
    { workspaceId: FAR_CHAT, path: 7 },
    { workspaceId: 'not-a-workspace-here', path: 'plan' },
  ]
  for (const [index, ref] of crafted.entries()) {
    socket.send({ type: 'open', id: index + 1, board: index + 1, ref, create: true })
    const answer = await socket.next((message) => message.type === 'opened' && message.id === index + 1)
    assert.equal(answer.ok, false, `refused: ${JSON.stringify(ref)}`)
  }
  // Nothing was made or touched outside the store and the project.
  assert.deepEqual(
    readdirSync(outside).filter((name) => name.endsWith('.excalidraw')),
    ['beside.excalidraw'],
  )
  assert.deepEqual(readdirSync(join(far.project, '.git')), [])
  assert.equal(
    existsSync(far.storeDir) ? readdirSync(far.storeDir).filter((name) => name.endsWith('.excalidraw')).length : 0,
    0,
  )
  // A board in the project's own folder is still a board: that much is allowed.
  socket.send({ type: 'open', id: 99, board: 99, ref: { workspaceId: FAR_CHAT, path: 'diagrams/flow' }, create: true })
  const allowed = await socket.next((message) => message.type === 'opened' && message.id === 99)
  assert.equal(allowed.ok, true)
  assert.ok(existsSync(join(far.project, 'diagrams', 'flow.excalidraw')))
})

test('a device with no read on workspaces cannot open the lane at all', async () => {
  const far = await farMachine()
  const offer = far.devices.offerPairing({ scopes: ['conversation:read'] })
  const paired = await pairWithMachine({
    endpoint: far.endpoint,
    pairingToken: offer.token,
    deviceName: 'android-phone',
  })
  assert.ok(paired.ok)
  const opened = await openRemoteCanvasSocket({
    endpoint: far.endpoint,
    token: paired.value.deviceToken,
    handlers: { onFrame: () => undefined, onClosed: () => undefined },
  })
  assert.ok(!opened.ok)
  assert.equal(opened.code, 'workspace_scope_required')
  assert.match(opened.message, /may not look at boards/u)
})

test('an older machine without the lane: its boards are pictures here, and the pane says why', async () => {
  // The far machine's Studio predates the lane, or runs no canvas service.
  const far = await farMachine({ canvas: false })
  const here = await pairedDesktop(far)
  const identity = await readRemoteIdentity({ endpoint: far.endpoint, token: here.token })
  assert.ok(identity.ok)
  assert.ok(identity.value.capabilities?.includes('canvas-machine-boards'), 'its list and pictures still answer')
  assert.ok(!identity.value.capabilities?.includes('canvas-live-boards'))
  const access = await here.lane.access('conn-1')
  assert.ok(access.ok)
  assert.equal(access.live, false)
  assert.match(access.reason ?? '', /mac-mini runs a Studio that shows its boards here as pictures only/u)
  const opened = await here.lane.open(here.viewer(1), here.board('plan'))
  assert.ok(!opened.ok)
  assert.match(opened.error.message, /Update it there to edit them here/u)
  // And the socket itself is not served there.
  const socket = await openRemoteCanvasSocket({
    endpoint: far.endpoint,
    token: here.token,
    handlers: { onFrame: () => undefined, onClosed: () => undefined },
  })
  assert.ok(!socket.ok)
  assert.equal(socket.code, 'canvas_unavailable')
})

test('a newer machine still answers an older desktop the way it always did', async () => {
  // The other direction: a desktop that has never heard of the lane asks for
  // the list and the picture through the canvas tools, which this change
  // leaves as they were, and the capability it does not read costs it nothing.
  const far = await farMachine()
  const here = await pairedDesktop(far)
  const identity = await readRemoteIdentity({ endpoint: far.endpoint, token: here.token })
  assert.ok(identity.ok)
  assert.ok(identity.value.capabilities?.includes('canvas-machine-boards'))
  assert.ok(identity.value.capabilities?.includes('canvas-live-boards'))
  assert.equal(identity.value.transportVersion, 2, 'no version moved for it')
})

test('the link drops and comes back: what was drawn meanwhile is saved, and the windows are told', async () => {
  const far = await farMachine()
  const here = await pairedDesktop(far)
  await here.lane.access('conn-1')
  const opened = await here.lane.open(here.viewer(1), { ...here.board('plan'), create: true })
  assert.ok(opened.ok)
  const links = () =>
    here.pushes
      .filter((push) => push.channel === CANVAS_REMOTE_LINK_CHANNEL)
      .map((push) => push.payload as unknown as CanvasRemoteLink)

  await far.stop()
  await waitFor(() => links().some((link) => link.state === 'reconnecting'), 'the window is told it is away')
  assert.match(links().at(-1)!.message ?? '', /mac-mini is out of reach\. What you draw is kept here/u)

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
  await far.restart()
  await far.service.edit(
    { workspaceId: FAR_CHAT, path: 'plan.excalidraw' },
    { create: [{ tempId: 'a', type: 'rectangle', x: 0, y: 0 }] },
    { kind: 'agent', workspaceId: FAR_CHAT, agentId: 'agent-1', agentName: 'Scout' },
  )
  await waitFor(() => links().at(-1)?.state === 'live', 'the window is told it is back', 10_000)
  await waitFor(
    () => far.sceneOnDisk('plan').some((item) => item.id === 'drawn-away'),
    'what was drawn away is saved there',
    10_000,
  )
  const ids = far.sceneOnDisk('plan').map((item) => item.id)
  assert.equal(ids.length, 2, 'the agent’s box and the person’s are both there')
  // The window is handed the board again, at a revision it has not seen.
  await waitFor(
    () =>
      scenesFor(here.pushes, 1).some(
        (scene) =>
          (scene.revision as number) > opened.value.revision &&
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
  const far = await farMachine()
  const here = await pairedDesktop(far)
  await here.lane.access('conn-1')
  const opened = await here.lane.open(here.viewer(1), { ...here.board('plan'), create: true })
  assert.ok(opened.ok)
  far.devices.revokeDevice(here.deviceId)
  await waitFor(
    () => here.pushes.some((push) => push.channel === CANVAS_REMOTE_LINK_CHANNEL && push.payload.state === 'gone'),
    'the window is told',
  )
  const gone = here.pushes.filter((push) => push.channel === CANVAS_REMOTE_LINK_CHANNEL).at(-1)!.payload
  assert.match(String(gone.message), /mac-mini no longer accepts this pairing/u)
  assert.equal(gone.canEdit, false)
})

test("an agent's canvas.open over there opens the board here, for the window showing that chat", async () => {
  const far = await farMachine()
  const here = await pairedDesktop(far)
  await here.lane.access('conn-1')
  await far.service.readBoard({ workspaceId: FAR_CHAT, path: 'plan.excalidraw' }, { create: true })
  // The window opens what it is asked to, which is what tells the agent it was shown.
  const viewer = here.viewer(1)
  const send = viewer.send
  let asked: Promise<unknown> | null = null
  viewer.send = (channel, payload) => {
    send(channel, payload)
    if (channel === 'canvas:remote-open-request')
      asked = here.lane.open(viewer, here.board((payload as { path: string }).path))
  }
  here.lane.watch(viewer, { connectionId: 'conn-1', workspaceId: FAR_CHAT })
  await waitFor(() => here.sockets.length > 0, 'the lane is open')
  // The watch has reached the far end once the lane answers anything after it.
  await new Promise((resolve) => setTimeout(resolve, 100))
  const revealed = await far.service.requestOpen({ workspaceId: FAR_CHAT, path: 'plan.excalidraw' })
  assert.ok(asked, 'the window was asked')
  await asked
  assert.ok(revealed.ok)
  assert.equal(revealed.value.revealed, true, 'the agent is told the board was shown')
  const request = here.pushes.find((push) => push.channel === 'canvas:remote-open-request')!.payload
  assert.deepEqual(request, { connectionId: 'conn-1', workspaceId: FAR_CHAT, path: 'plan.excalidraw' })
})

test('the mesh carries the lane for a paired machine, end to end', async () => {
  const far = await farMachine()
  const localDir = dir('canvas-lane-local-')
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => localDir,
    createStore: (options) => createTailnetMeshStore({ ...options, cipher: createSecretCipherStandIn() }),
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
    canvas: { retry: { baseMs: 20, maxMs: 100 }, lingerMs: 20 },
  })
  cleanups.push(() => mesh.shutdown())
  const offer = far.devices.offerPairing({ scopes: ['workspace:read', 'workspace:operate'] })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', far.port, offer.token) })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  const connectionId = paired.connection.id
  assert.deepEqual(await mesh.remoteCanvas.access(connectionId), { ok: true, live: true, canEdit: true })
  const pushes: Push[] = []
  const viewer = {
    id: 1,
    send: (channel: string, payload: unknown) =>
      pushes.push({ viewer: 1, channel, payload: payload as Record<string, unknown> }),
  }
  const ref = { connectionId, remoteWorkspaceId: FAR_CHAT, workspaceId: 'local-chat', path: 'plan' }
  const opened = await mesh.remoteCanvas.open(viewer, { ...ref, create: true })
  assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
  const committed = await mesh.remoteCanvas.commit(viewer, {
    ...ref,
    baseRevision: 0,
    elements: [element('via-mesh')],
    appState: {},
    files: {},
  })
  assert.ok(committed.ok)
  assert.deepEqual(
    far.sceneOnDisk('plan').map((item) => item.id),
    ['via-mesh'],
  )
  // Forgetting the machine ends the lane, and the window is told.
  mesh.forget(connectionId)
  assert.ok(pushes.some((push) => push.channel === CANVAS_REMOTE_LINK_CHANNEL && push.payload.state === 'gone'))
})

test('the wire cuts a long message into parts under the cap, and puts it back together', () => {
  const big = {
    type: 'commit',
    elements: Array.from({ length: 900 }, (_, i) => ({ id: `e${i}`, text: 'é✓'.repeat(1_000) })),
  }
  let stream = 1
  const parts = canvasLaneMessages(big, () => stream++)
  assert.ok(parts.length > 1)
  for (const part of parts) assert.ok(Buffer.byteLength(part) < 1024 * 1024)
  const assembler = createCanvasLaneAssembler()
  let result: ReturnType<typeof assembler.push> = { kind: 'pending' }
  for (const part of parts) result = assembler.push(JSON.parse(part) as Record<string, unknown>)
  assert.equal(result.kind, 'message')
  assert.deepEqual(result.kind === 'message' ? result.message : null, big)
  // Out of order, or past the ceiling, is refused.
  const shuffled = createCanvasLaneAssembler()
  assert.equal(shuffled.push(JSON.parse(parts[1]!) as Record<string, unknown>).kind, 'error')
  const small = createCanvasLaneAssembler(() => 1024)
  assert.equal(small.push(JSON.parse(parts[0]!) as Record<string, unknown>).kind, 'error')
})
