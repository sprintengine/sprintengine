import { afterEach, expect, test, vi } from 'vitest'

import { checkStillPaired, WEB_STUDIO_SETUP } from './webStudio'
import { WEB_STUDIO_REOPENED_EVENT } from './webReconnect'

// A web tab's connections, as a browser removed while its tab slept meets
// them: the server refuses the socket at its upgrade (401), which the page
// hears only as a close that never opened, so it asks whether it is still
// paired and goes back to pairing if it is not. A reconnect that opens says
// the server may have been replaced.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch

test('a session the server no longer holds goes back to pairing; a paired one and a server not there stay', async () => {
  vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:4791/' } })
  const back = vi.fn()
  await checkStillPaired(answer(401), back)
  expect(back).toHaveBeenCalledTimes(1)
  await checkStillPaired(answer(200), back)
  await checkStillPaired(
    (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch,
    back,
  )
  expect(back).toHaveBeenCalledTimes(1)
})

test('a socket that never opened asks the session; one that opened and closed plainly does not', async () => {
  const asked: string[] = []
  vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:4791/', replace: () => undefined } })
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(String(url))
    return new Response('{}', { status: 200 })
  })
  WEB_STUDIO_SETUP.onSocketClose?.(1006, { opened: false })
  WEB_STUDIO_SETUP.onSocketClose?.(1006, { opened: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(asked).toEqual(['http://127.0.0.1:4791/api/session'])
})

test('a reconnect that opens tells the build check', () => {
  const heard: string[] = []
  vi.stubGlobal('window', { dispatchEvent: (event: Event) => void heard.push(event.type) })
  WEB_STUDIO_SETUP.onReopen?.()
  expect(heard).toEqual([WEB_STUDIO_REOPENED_EVENT])
})
