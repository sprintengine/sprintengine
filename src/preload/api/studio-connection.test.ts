import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_WINDOW_TICKET_CHANNEL } from '../../shared/studio-connection'
import { createStudioConnectionApi } from './studio-connection'

// The preload lends the page one call: a ticket from main for the window's
// next connection. It asks main afresh every time, so a reconnect never reuses
// a spent ticket or an old server's address.

test('each connection asks main for a fresh ticket', async () => {
  const asked: string[] = []
  let minted = 0
  const api = createStudioConnectionApi(
    {
      invoke: async (channel) => {
        asked.push(channel)
        minted++
        return { url: `ws://127.0.0.1:4100/ws?ticket=t${minted}`, token: `t${minted}` }
      },
    },
    { mode: 'studio' },
  )
  assert.equal(api.studioChatTransport, 'studio')
  assert.deepEqual(await api.studioWindowTicket(), { url: 'ws://127.0.0.1:4100/ws?ticket=t1', token: 't1' })
  assert.deepEqual(await api.studioWindowTicket(), { url: 'ws://127.0.0.1:4100/ws?ticket=t2', token: 't2' })
  assert.deepEqual(asked, [STUDIO_WINDOW_TICKET_CHANNEL, STUDIO_WINDOW_TICKET_CHANNEL])
})

test('a refused ticket fails the connect, and the IPC stays the chat default', async () => {
  const api = createStudioConnectionApi({
    invoke: async () => {
      throw new Error('Studio server is not running yet, so this window cannot reach its chats yet.')
    },
  })
  assert.equal(api.studioChatTransport, 'ipc')
  await assert.rejects(api.studioWindowTicket(), /not running yet/)
})
