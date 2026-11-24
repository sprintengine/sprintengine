import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createControlRpc, type ControlRpc } from '../bootstrap/control-rpc'
import type { ExtensionOpenRequest } from '../../shared/extension-open'
import { serveExtensionOpen, shellExtensionOpenOverControl } from './extension-open-bridge'

// `extension.open`'s window half out of process: the server asks the shell
// over a real control channel pair, as the server and the shell hold it, and
// the shell answers with its own opener (its windows, in the app).

function pair(): { server: ControlRpc; shell: ControlRpc } {
  let server: ControlRpc | null = null
  let shell: ControlRpc | null = null
  server = createControlRpc((frame) => queueMicrotask(() => shell?.receive(frame)))
  shell = createControlRpc((frame) => queueMicrotask(() => server?.receive(frame)))
  return { server, shell }
}

const NO_WINDOW = { ok: false, code: 'no_window' } as const

test('the shell’s windows open it, and the outcome comes back as they said it', async () => {
  const { server, shell } = pair()
  const asked: ExtensionOpenRequest[] = []
  serveExtensionOpen(shell, async (request) => {
    asked.push(request)
    return request.panel === 'forecast'
      ? { ok: true, workspaceId: 'ws-1' }
      : { ok: false, code: 'not_found', message: 'No such panel in this window.' }
  })
  const open = shellExtensionOpenOverControl(server)
  assert.deepEqual(await open({ moduleId: 'local.weather-deck', panel: 'forecast', title: 'Forecast' }), {
    ok: true,
    workspaceId: 'ws-1',
  })
  assert.deepEqual(await open({ moduleId: 'local.weather-deck', file: '/Users/dev/notes/a.deck', editor: 'deck' }), {
    ok: false,
    code: 'not_found',
    message: 'No such panel in this window.',
  })
  assert.deepEqual(asked, [
    { moduleId: 'local.weather-deck', panel: 'forecast', title: 'Forecast' },
    { moduleId: 'local.weather-deck', file: '/Users/dev/notes/a.deck', editor: 'deck' },
  ])
})

test('only the fields a window acts on cross, and a malformed request is refused by the shell', async () => {
  const { server, shell } = pair()
  const asked: unknown[] = []
  serveExtensionOpen(shell, async (request) => {
    asked.push(request)
    return { ok: true, workspaceId: 'ws-1' }
  })
  const open = shellExtensionOpenOverControl(server)
  const extra = { moduleId: 'local.weather-deck', panel: 'forecast', workspaceId: 'ws-9' } as ExtensionOpenRequest
  assert.deepEqual(await open(extra), { ok: true, workspaceId: 'ws-1' })
  assert.deepEqual(asked, [{ moduleId: 'local.weather-deck', panel: 'forecast' }])

  // A panel and a file at once is not a request a window may act on: the
  // shell throws, and the server reads that as no window to show it in.
  const both = await open({ moduleId: 'local.weather-deck', panel: 'forecast', file: '/Users/dev/a.deck' })
  assert.equal(both.ok, false)
  assert.equal(!both.ok && both.code, 'no_window')
  await assert.rejects(server.call('shell.extension-open', { panel: 'forecast' }), /install key/u)
  assert.equal(asked.length, 1)
})

test('a shell that is gone, serves no such method or answers nonsense is no_window', async () => {
  const request = { moduleId: 'local.weather-deck' }

  // No shell at all: a server with nobody holding its control channel.
  assert.deepEqual(
    { ...(await shellExtensionOpenOverControl(null)(request)), message: undefined },
    {
      ...NO_WINDOW,
      message: undefined,
    },
  )

  // A closed channel.
  const closed = createControlRpc(null)
  const fromClosed = await shellExtensionOpenOverControl(closed)(request)
  assert.equal(!fromClosed.ok && fromClosed.code, 'no_window')
  assert.match(!fromClosed.ok ? fromClosed.message : '', /open Studio/u)

  // A shell that serves no extension.open (an older shell).
  const older = pair()
  const fromOlder = await shellExtensionOpenOverControl(older.server)(request)
  assert.equal(!fromOlder.ok && fromOlder.code, 'no_window')

  // A shell that answers in a shape no outcome has.
  const odd = pair()
  odd.shell.handle('shell.extension-open', () => ({ ok: 'yes' }))
  const fromOdd = await shellExtensionOpenOverControl(odd.server)(request)
  assert.equal(!fromOdd.ok && fromOdd.code, 'no_window')
})
