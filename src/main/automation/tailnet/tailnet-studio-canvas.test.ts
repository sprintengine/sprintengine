import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import type { StudioCanvasBoardNotice } from '../../../../packages/studio-protocol/src/public'
import { STUDIO_CANVAS_LIMITS } from '../../../../packages/studio-protocol/src/public'
import {
  FAR_CHAT,
  PICTURE_PNG_BASE64,
  element,
  farMachine,
  waitFor,
  type FarMachine,
} from './tailnet-canvas.test-helper'
import { refusalOf } from './tailnet-studio.test-helper'

// A machine's boards for a paired device, on `/tailnet/v1/studio` (`canvas.*`):
// the real tailnet listener handing the device's socket to a real Studio
// server, which serves the boards from a real canvas service over a real
// folder. What a device may do is its pairing, read at each request: a
// workspace read lists, pictures, opens and reads; `workspace:operate` draws.

let cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

async function machine(options: { canvas?: boolean } = {}): Promise<FarMachine> {
  const far = await farMachine(options)
  cleanups.push(() => far.dispose())
  return far
}

const board = (path: string) => ({ workspaceId: FAR_CHAT, path })

/** Follow a board: every notice it is sent, and how it ended. */
function follow(client: StudioClient, ref: { workspaceId: string; path: string; store?: string }, create = false) {
  const notices: StudioCanvasBoardNotice[] = []
  const ended: Array<{ code?: string; message?: string } | undefined> = []
  const stop = client.subscribe(
    'canvas.board',
    { ...ref, ...(create ? { create: true } : {}) },
    { onPayload: (notice) => notices.push(notice), onEnd: (error) => ended.push(error) },
  )
  cleanups.push(stop)
  return { notices, ended, stop }
}

test('an operating pairing opens a board, draws on it, and hears an agent draw and hold the pen', async () => {
  const far = await machine()
  const device = far.rig.pair(['workspace:read', 'workspace:operate'])
  const client = await far.rig.client(device.token)
  assert.equal(client.supports('canvas-boards'), true)

  const followed = follow(client, board('plan'), true)
  await waitFor(() => followed.notices.length > 0, 'the board opens')
  assert.deepEqual(followed.notices[0], { type: 'opened', revision: 0, canEdit: true })
  assert.ok(existsSync(join(far.storeDir, 'plan.excalidraw')), 'opening made it')

  const drawn = { elements: [element('drawn-there')], appState: {}, files: {} }
  const committed = await client.request('canvas.commit', {
    ...board('plan'),
    commandId: 'draw-1',
    baseRevision: 0,
    body: drawn,
  })
  assert.equal(committed.revision, 1)
  assert.deepEqual(
    far.sceneOnDisk('plan').map((item) => item.id),
    ['drawn-there'],
  )
  // Its own write is not told back to it as a scene.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(followed.notices.filter((notice) => notice.type === 'scene').length, 0)
  // A retry under the same command id merges once and answers as the first time.
  const retried = await client.request('canvas.commit', {
    ...board('plan'),
    commandId: 'draw-1',
    baseRevision: 0,
    body: drawn,
  })
  assert.deepEqual(retried, committed)

  // An agent over there draws: a notice with the new revision, never the scene.
  await far.service.edit(
    board('plan.excalidraw'),
    { create: [{ tempId: 'a', type: 'rectangle', x: 10, y: 10 }] },
    { kind: 'agent', workspaceId: FAR_CHAT, agentId: 'agent-1', agentName: 'Scout' },
  )
  await waitFor(() => followed.notices.some((notice) => notice.type === 'scene'), 'the agent’s write is told')
  const scene = followed.notices.find((notice) => notice.type === 'scene')!
  assert.deepEqual(scene, { type: 'scene', revision: 2, origin: 'agent' })
  await waitFor(
    () => followed.notices.some((notice) => notice.type === 'presence' && notice.controller === 'agent'),
    'the agent’s pen is told',
  )
  const presence = followed.notices.find((notice) => notice.type === 'presence')!
  assert.equal(presence.type === 'presence' && presence.agentName, 'Scout')

  // The scene is read by request.
  const read = await client.request('canvas.read', board('plan'))
  assert.equal(read.revision, 2)
  assert.equal(read.elements.length, 2)
  assert.deepEqual(read.fileIds, [])

  // The person takes the pen back.
  assert.deepEqual(await client.request('canvas.takePen', board('plan')), { taken: true })

  // And the machine's boards are listed, and a picture of one drawn.
  const listed = await client.request('canvas.list', { workspaceId: FAR_CHAT })
  assert.deepEqual(
    listed.boards.map((row) => [row.name, row.here, row.workspaceId]),
    [['plan', true, FAR_CHAT]],
  )
  assert.match(listed.boards[0]!.id, /^canvas:\/\/ws_[0-9a-f]{24}\/plan\.excalidraw$/u)
  const picture = await client.request('canvas.picture', { board: listed.boards[0]!.id, dark: true })
  assert.deepEqual(picture, { mimeType: 'image/png', dataBase64: PICTURE_PNG_BASE64, width: 1, height: 1 })
  assert.deepEqual(far.pictures.at(-1), { board: listed.boards[0]!.id, maxEdge: 1600, dark: true })
  assert.equal(await refusalOf(client.request('canvas.picture', { board: 'canvas://nowhere' })), 'not_found')
})

test('a large change goes in parts, and each picture crosses once each way', async () => {
  const far = await machine()
  const drawer = await far.rig.client(far.rig.pair(['workspace:read', 'workspace:operate']).token)
  follow(drawer, board('big'), true)
  await waitFor(() => existsSync(join(far.storeDir, 'big.excalidraw')), 'the board is made')
  // Past what one client frame carries: a drawing of 2.4 MB and a 3 MB picture.
  const elements = Array.from({ length: 2_000 }, (_, index) =>
    element(`box-${index}`, { text: `note ${index} ${'x'.repeat(1_200)}` }),
  )
  elements.push(element('photo-element', { type: 'image', fileId: 'photo' }))
  const picture = {
    id: 'photo',
    mimeType: 'image/png',
    dataURL: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`,
    created: 1,
  }
  const text = JSON.stringify({ elements, appState: {}, files: { photo: picture } })
  const size = STUDIO_CANVAS_LIMITS.stagePartChars
  const total = Math.ceil(text.length / size)
  // Out of order on purpose: a part's place is its index.
  for (const index of [...Array(total).keys()].reverse())
    await drawer.request('canvas.stage', {
      ...board('big'),
      stageId: 'stage-1',
      index,
      total,
      text: text.slice(index * size, (index + 1) * size),
    })
  const committed = await drawer.request('canvas.commit', {
    ...board('big'),
    commandId: 'big-1',
    baseRevision: 0,
    stageId: 'stage-1',
  })
  assert.equal(committed.revision, 1)
  assert.equal(far.sceneOnDisk('big').length, 2_001)
  assert.deepEqual(Object.keys(far.filesOnDisk('big')), ['photo'])
  // A stage is spent by its commit.
  assert.equal(
    await refusalOf(
      drawer.request('canvas.commit', { ...board('big'), commandId: 'big-2', baseRevision: 1, stageId: 'stage-1' }),
    ),
    'invalid_params',
  )

  // Another device reads the scene without the picture, then the picture by its id.
  const reader = await far.rig.client(far.rig.pair(['workspace:read']).token)
  const read = await reader.request('canvas.read', board('big'))
  assert.deepEqual(read.fileIds, ['photo'])
  assert.equal(JSON.stringify(read).includes('AAAA'), false, 'the scene names its picture, never carries it')
  const files = await reader.request('canvas.files', { ...board('big'), ids: ['photo', 'gone'] })
  assert.equal((files.files.photo as { dataURL: string }).dataURL.length, picture.dataURL.length)
  assert.deepEqual(files.missing, ['gone'])
  assert.deepEqual(files.more, [])
})

test('a pairing that may only look reads boards, and is refused every change', async () => {
  const far = await machine()
  await far.service.readBoard(board('plan.excalidraw'), { create: true })
  const client = await far.rig.client(far.rig.pair(['workspace:read']).token)
  const followed = follow(client, board('plan'))
  await waitFor(() => followed.notices.length > 0, 'the board opens')
  assert.deepEqual(followed.notices[0], { type: 'opened', revision: 0, canEdit: false })
  assert.equal((await client.request('canvas.read', board('plan'))).revision, 0)
  const change = { elements: [element('should-not-land')], appState: {}, files: {} }
  assert.equal(
    await refusalOf(
      client.request('canvas.commit', { ...board('plan'), commandId: 'c', baseRevision: 0, body: change }),
    ),
    'scope_required',
  )
  assert.equal(
    await refusalOf(client.request('canvas.stage', { ...board('plan'), stageId: 's', index: 0, total: 1, text: '{}' })),
    'scope_required',
  )
  assert.equal(await refusalOf(client.request('canvas.takePen', board('plan'))), 'scope_required')
  assert.deepEqual(far.sceneOnDisk('plan'), [])
  // Asking to make a board it may not change makes none.
  const fresh = follow(client, board('fresh'), true)
  await waitFor(() => fresh.ended.length > 0, 'the open is refused')
  assert.equal(fresh.ended[0]?.code, 'not_found')
  assert.equal(existsSync(join(far.storeDir, 'fresh.excalidraw')), false)
})

test('a chats-only pairing reaches no board; a narrowed one is refused at once; a revoked one is closed', async () => {
  const far = await machine()
  const chats = await far.rig.client(far.rig.pair(['conversation:read']).token)
  assert.equal(await refusalOf(chats.request('canvas.list', {})), 'scope_required')
  assert.equal(await refusalOf(chats.request('canvas.read', board('plan'))), 'scope_required')

  const device = far.rig.pair(['workspace:read', 'workspace:operate'])
  const client = await far.rig.client(device.token)
  const followed = follow(client, board('plan'), true)
  await waitFor(() => followed.notices.length > 0, 'the board opens')
  far.rig.devices.updateDeviceScopes(device.id, ['workspace:read'])
  const change = { elements: [element('late')], appState: {}, files: {} }
  assert.equal(
    await refusalOf(
      client.request('canvas.commit', { ...board('plan'), commandId: 'n', baseRevision: 0, body: change }),
    ),
    'scope_required',
  )
  far.rig.devices.revokeDevice(device.id)
  await waitFor(() => client.state !== 'open', 'the revoked connection closes')
})

test('a crafted path reaches nothing but a board in its store or its project', async () => {
  const far = await machine()
  const client = await far.rig.client(far.rig.pair(['workspace:read', 'workspace:operate']).token)
  const outside = dirname(far.project)
  writeFileSync(
    join(outside, 'beside.excalidraw'),
    JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }),
  )
  cleanups.push(() => rmSync(join(outside, 'beside.excalidraw'), { force: true }))
  mkdirSync(join(far.project, '.git'), { recursive: true })
  const crafted: Array<Record<string, unknown>> = [
    { workspaceId: FAR_CHAT, path: '../beside.excalidraw' },
    { workspaceId: FAR_CHAT, path: 'diagrams/../../beside' },
    { workspaceId: FAR_CHAT, path: '..\\..\\beside' },
    { workspaceId: FAR_CHAT, path: join(outside, 'beside.excalidraw') },
    { workspaceId: FAR_CHAT, path: '/etc/passwd' },
    { workspaceId: FAR_CHAT, path: 'C:/Windows/win.ini' },
    { workspaceId: FAR_CHAT, path: '.git/config' },
    { workspaceId: FAR_CHAT, path: 'notes.json' },
    { workspaceId: FAR_CHAT, path: `bad${String.fromCharCode(0)}.excalidraw` },
    { workspaceId: FAR_CHAT, path: 'beside', store: '../../' },
    { workspaceId: FAR_CHAT, path: 'beside', store: `ws_${'g'.repeat(24)}` },
    { workspaceId: FAR_CHAT, path: 7 },
    { workspaceId: 'not-a-workspace-here', path: 'plan' },
  ]
  for (const ref of crafted) {
    const change = { elements: [element('x')], appState: {}, files: {} }
    const code = await refusalOf(
      // Sent as a peer that writes its own params would: whatever the ref is.
      client.request('canvas.commit', {
        ...ref,
        commandId: `c-${Math.random()}`,
        baseRevision: 0,
        body: change,
      } as never),
    )
    assert.notEqual(code, null, `commit refused: ${JSON.stringify(ref)}`)
    assert.notEqual(
      await refusalOf(client.request('canvas.read', ref as never)),
      null,
      `read refused: ${JSON.stringify(ref)}`,
    )
    const opened = follow(client, ref as never, true)
    await waitFor(() => opened.ended.length > 0, `open refused: ${JSON.stringify(ref)}`)
  }
  assert.deepEqual(
    readdirSync(outside).filter((name) => name.endsWith('.excalidraw')),
    ['beside.excalidraw'],
  )
  assert.deepEqual(readdirSync(join(far.project, '.git')), [])
  assert.equal(
    existsSync(far.storeDir) ? readdirSync(far.storeDir).filter((name) => name.endsWith('.excalidraw')).length : 0,
    0,
  )
  // A board in the project's own folder is a board: that much is allowed.
  const allowed = follow(client, board('diagrams/flow'), true)
  await waitFor(() => allowed.notices.length > 0, 'a project board opens')
  assert.ok(existsSync(join(far.project, 'diagrams', 'flow.excalidraw')))
})

test("an agent's canvas.open reaches a device following that chat's workspace, and no other", async () => {
  const far = await machine()
  await far.service.readBoard(board('plan.excalidraw'), { create: true })
  const client = await far.rig.client(far.rig.pair(['workspace:read']).token)
  const here: unknown[] = []
  const elsewhere: unknown[] = []
  cleanups.push(
    client.subscribe('canvas.openRequests', { workspaceIds: [FAR_CHAT] }, { onPayload: (ref) => here.push(ref) }),
  )
  cleanups.push(
    client.subscribe(
      'canvas.openRequests',
      { workspaceIds: ['other-chat'] },
      { onPayload: (ref) => elsewhere.push(ref) },
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  await far.service.requestOpen(board('plan.excalidraw'))
  await waitFor(() => here.length > 0, 'the device is asked to show it')
  assert.deepEqual(here, [{ workspaceId: FAR_CHAT, path: 'plan.excalidraw' }])
  assert.deepEqual(elsewhere, [])
})

test('a Studio given no canvas does not advertise boards, and answers them unavailable', async () => {
  const far = await machine({ canvas: false })
  const client = await far.rig.client(far.rig.pair(['workspace:read', 'workspace:operate']).token)
  assert.equal(client.supports('canvas-boards'), false)
})
