import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'

import { afterEach, test } from 'vitest'

import { createLoopbackRoute, MAX_CARRIED_SOCKETS, type LoopbackRoute } from './environment-route'

// Main's loopback route to a machine's Studio: bytes both ways onto a fresh
// stream per socket, nothing when the machine is not there, and one port for
// the run whatever happens to the machine's server.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A far end that echoes in upper case, standing in for a front-door stream. */
function farEnd(): { stream: Duplex; ended: Promise<void> } {
  const into = new PassThrough()
  let finish: () => void = () => undefined
  const ended = new Promise<void>((resolve) => (finish = resolve))
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      into.write(chunk)
      callback()
    },
    destroy(error, callback) {
      finish()
      callback(error)
    },
  })
  into.on('data', (chunk: Buffer) => stream.push(Buffer.from(chunk.toString('utf8').toUpperCase())))
  return { stream, ended }
}

function route(open: () => Promise<Duplex>): LoopbackRoute {
  const made = createLoopbackRoute({ open })
  cleanups.push(() => made.close())
  return made
}

async function dial(port: number): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  cleanups.push(() => socket.destroy())
  return socket
}

const read = (socket: Socket) =>
  new Promise<string>((resolve) => socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))))
const closed = (socket: Socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()))

test('each socket on the route is carried both ways onto a stream of its own', async () => {
  const opened: Array<ReturnType<typeof farEnd>> = []
  const loopback = route(async () => {
    const far = farEnd()
    opened.push(far)
    return far.stream
  })
  const port = await loopback.port()
  const first = await dial(port)
  const second = await dial(port)
  first.write('hello')
  assert.equal(await read(first), 'HELLO')
  second.write('again')
  assert.equal(await read(second), 'AGAIN')
  assert.equal(opened.length, 2)

  // One side gone is both gone.
  first.destroy()
  await opened[0]!.ended
})

test('a socket that arrives while the machine is not there is closed at once', async () => {
  let up = false
  const loopback = route(async () => {
    if (!up) throw new Error('build-box is not connected.')
    return farEnd().stream
  })
  const port = await loopback.port()
  const refused = await dial(port)
  await closed(refused)

  up = true
  const carried = await dial(port)
  carried.write('back')
  assert.equal(await read(carried), 'BACK')
})

test('the route keeps its port for the run, and closing it ends what it carries', async () => {
  let generation = 0
  const loopback = route(async () => {
    generation += 1
    return farEnd().stream
  })
  const port = await loopback.port()
  const before = await dial(port)
  before.write('one')
  assert.equal(await read(before), 'ONE')
  // The machine's server restarted: the next stream is a new one, on the same port.
  assert.equal(await loopback.port(), port)
  const after = await dial(port)
  after.write('two')
  assert.equal(await read(after), 'TWO')
  assert.equal(generation, 2)

  const ending = Promise.all([closed(before), closed(after)])
  await loopback.close()
  await ending
  await assert.rejects(loopback.port(), /closed/u)
})

test('a route carries a bounded number of sockets at once', async () => {
  const loopback = route(async () => farEnd().stream)
  const port = await loopback.port()
  const held: Socket[] = []
  for (let index = 0; index < MAX_CARRIED_SOCKETS; index++) held.push(await dial(port))
  // Every one of those is carried: the last answers.
  held.at(-1)!.write('last')
  assert.equal(await read(held.at(-1)!), 'LAST')
  const over = await dial(port)
  await closed(over)
  held[0]!.destroy()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const room = await dial(port)
  room.write('room')
  assert.equal(await read(room), 'ROOM')
})
