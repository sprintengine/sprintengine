import assert from 'node:assert/strict'
import { test } from 'vitest'

import { canvasFail, canvasOk, type CanvasBoardRef } from '../../shared/canvas/types'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createControlRpc, type ControlRpc } from '../bootstrap/control-rpc'
import type { StudioCanvasHost } from './canvas-domain'
import { serveCanvasShell, shellCanvasOverControl } from './canvas-shell-bridge'

// The machine's boards cross the control channel between the shell, whose
// canvas service they are, and the server, which serves them to other devices.

function channel(): { shell: ControlRpc; server: ControlRpc } {
  const shell: ControlRpc = createControlRpc((frame) => setImmediate(() => server.receive(frame)))
  const server: ControlRpc = createControlRpc((frame) => setImmediate(() => shell.receive(frame)))
  return { shell, server }
}

const settle = async () => {
  for (let pass = 0; pass < 10; pass += 1) await new Promise((resolve) => setImmediate(resolve))
}

const REF: CanvasBoardRef = { workspaceId: 'acme', path: 'architecture.excalidraw' }

/** The shell's canvas host, recording what it was asked and by which of its own subscribers. */
function shellHost() {
  const pushers = new Map<number, (channel: string, payload: unknown) => void>()
  const openListeners = new Set<(ref: CanvasBoardRef) => void>()
  const asked: string[] = []
  let next = -1
  const tool = (name: string): McpToolRegistration => ({
    name,
    description: name,
    inputSchema: {},
    handler: async (args) => ({ content: [{ type: 'text', text: `${name} ${JSON.stringify(args)}` }] }),
  })
  const host: StudioCanvasHost = {
    subscribe(deliver) {
      const id = next--
      pushers.set(id, deliver)
      asked.push(`subscribe ${id}`)
      return id
    },
    unsubscribe(id) {
      pushers.delete(id)
      asked.push(`unsubscribe ${id}`)
    },
    onOpenRequest(listener) {
      openListeners.add(listener)
      return () => openListeners.delete(listener)
    },
    // A link in the project that points outside it is refused where the file really is.
    confine: async (ref) =>
      ref.path === 'linked.excalidraw' ? canvasFail('forbidden', 'Outside the project.') : canvasOk(undefined),
    openBoard: async (ref, opts) => {
      asked.push(`open ${ref.path} by ${opts.subscriberId}${opts.create ? ' (create)' : ''}`)
      return canvasOk({ revision: 3 } as never)
    },
    readBoard: async () => canvasOk({ revision: 3 } as never),
    commitScene: async (input, subscriberId) => {
      asked.push(`commit ${input.path} at ${input.baseRevision} by ${subscriberId}`)
      return canvasOk({ revision: 4, elements: null })
    },
    noteHumanInput: (ref, subscriberId) => void asked.push(`input ${ref.path} by ${subscriberId}`),
    tools: () => [tool('canvas.list'), tool('canvas.screenshot'), tool('canvas.edit')],
  }
  return { host, asked, pushers, openListeners }
}

test("a board another device opens is a subscriber of the shell's service, and hears its pushes", async () => {
  const { shell, server } = channel()
  const far = shellHost()
  serveCanvasShell(shell, far.host)
  const canvas = shellCanvasOverControl(server)

  const heard: Array<[string, unknown]> = []
  const subscriber = canvas.subscribe((name, payload) => heard.push([name, payload]))
  const opened = await canvas.openBoard(REF, { create: true, subscriberId: subscriber })
  assert.equal(opened.ok, true)
  // The shell made one subscriber of its own for the server's, and uses it from then on.
  const committed = await canvas.commitScene(
    { ...REF, baseRevision: 3, elements: [], appState: {}, files: {} },
    subscriber,
  )
  assert.deepEqual(committed, { ok: true, value: { revision: 4, elements: null } })
  canvas.noteHumanInput(REF, subscriber)
  await settle()
  assert.deepEqual(far.asked, [
    'subscribe -1',
    'open architecture.excalidraw by -1 (create)',
    'commit architecture.excalidraw at 3 by -1',
    'input architecture.excalidraw by -1',
  ])

  // What the service pushes to its subscriber reaches the server's.
  far.pushers.get(-1)?.('canvas:scene', { revision: 5 })
  await settle()
  assert.deepEqual(heard, [['canvas:scene', { revision: 5 }]])

  // Closed from the far side: the shell's subscriber goes too.
  canvas.unsubscribe(subscriber)
  await settle()
  assert.equal(far.asked.at(-1), 'unsubscribe -1')
})

test("an agent's canvas.open reaches the server's clients, and a board outside its project is refused there", async () => {
  const { shell, server } = channel()
  const far = shellHost()
  serveCanvasShell(shell, far.host)
  const canvas = shellCanvasOverControl(server)
  const requests: CanvasBoardRef[] = []
  canvas.onOpenRequest((ref) => requests.push(ref))
  await settle()
  for (const listener of far.openListeners) listener(REF)
  await settle()
  assert.deepEqual(requests, [REF])

  const refused = await canvas.confine({ workspaceId: 'acme', path: 'linked.excalidraw' })
  assert.deepEqual(refused, { ok: false, error: { code: 'forbidden', message: 'Outside the project.' } })
})

test('only the list and picture tools are run for the server, over the held view', async () => {
  const { shell, server } = channel()
  serveCanvasShell(shell, shellHost().host)
  const canvas = shellCanvasOverControl(server)
  assert.deepEqual(
    canvas.tools().map((tool) => tool.name),
    ['canvas.list', 'canvas.screenshot'],
  )
  const listed = await canvas.tools()[0]!.handler({ scope: 'machine' })
  assert.deepEqual(listed.content, [{ type: 'text', text: 'canvas.list {"scope":"machine"}' }])
})

test('a server that is gone takes its subscribers with it; the next one makes its own', async () => {
  const { shell, server } = channel()
  const far = shellHost()
  const served = serveCanvasShell(shell, far.host)
  const canvas = shellCanvasOverControl(server)
  await canvas.openBoard(REF, { create: false, subscriberId: canvas.subscribe(() => undefined) })
  served.reset()
  assert.equal(far.asked.at(-1), 'unsubscribe -1')
  assert.equal(far.pushers.size, 0, 'nothing is pushed for a server that is not there')

  const restarted = shellCanvasOverControl(server)
  await restarted.openBoard(REF, { create: false, subscriberId: restarted.subscribe(() => undefined) })
  assert.equal(far.asked.at(-1), 'open architecture.excalidraw by -2')
})

test('a shell that does not answer is said in words, not thrown', async () => {
  // The channel is down: the shell is gone, or not there yet.
  const lonely = createControlRpc(null)
  const canvas = shellCanvasOverControl(lonely)
  const read = await canvas.readBoard(REF)
  assert.equal(read.ok, false)
  assert.match(read.ok ? '' : read.error.message, /desktop app's, which did not answer/)
  const listed = await canvas.tools()[0]!.handler({})
  assert.equal(listed.isError, true)
})
