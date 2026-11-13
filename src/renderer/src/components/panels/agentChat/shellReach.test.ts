import { afterEach, expect, test, vi } from 'vitest'

import { installStudioLoopback } from '../../../../../../tests/studio-chat-loopback'
import { configureWindowStudio, windowStudioWelcome } from '../../../studio/windowStudioClient'
import { shellReachOf } from './shellReach'

// What a window and its shell reach of a chat's disk, by the chat's
// environment: the window reads the files of its own Studio's, and the shell
// the disk of the Studio it started. A web tab's Studio is another machine's.

afterEach(() => {
  vi.unstubAllGlobals()
})

async function welcomedWindow(setup: { anotherMachine?: boolean; drags?: boolean } = {}) {
  const api: Record<string, unknown> = {
    platform: 'darwin',
    ...(setup.drags ? { clientCapabilities: ['drag-paths', 'reveal-in-folder'] } : {}),
  }
  vi.stubGlobal('window', { api })
  await installStudioLoopback({ api }, { environmentId: 'studio-here' }).welcomed()
  if (setup.anotherMachine) configureWindowStudio(api, { anotherMachine: true })
  expect(windowStudioWelcome(api)?.environment.id).toBe('studio-here')
  return api
}

test("a chat of the desktop window's own Studio is read through the window and on the shell's disk", async () => {
  const api = await welcomedWindow()
  expect(shellReachOf('studio-here', api)).toMatchObject({ openDocument: true, sameDisk: true })
})

test("a web tab reads its Studio's chats through the window, but its shell is on another machine", async () => {
  const api = await welcomedWindow({ anotherMachine: true })
  expect(shellReachOf('studio-here', api)).toEqual({
    openDocument: true,
    sameDisk: false,
    dragPaths: false,
    revealInFolder: false,
  })
})

test('a chat that names another environment, or none, is reached by neither', async () => {
  const api = await welcomedWindow()
  for (const environmentId of ['studio-elsewhere', null])
    expect(shellReachOf(environmentId, api)).toEqual({
      openDocument: false,
      sameDisk: false,
      dragPaths: false,
      revealInFolder: false,
    })
})

test('before the window is welcomed nothing is reached', () => {
  const api = { platform: 'darwin' }
  vi.stubGlobal('window', { api })
  expect(shellReachOf('studio-here', api)).toMatchObject({ openDocument: false, sameDisk: false })
})

test("the window's transport names its Studio's environment, unnamed: the chat is the window's own", async () => {
  await welcomedWindow()
  const { localConversationTransport } = await import('./conversationTransport')
  const environment = localConversationTransport.environment
  expect(environment).toEqual({ id: 'studio-here', label: null, lane: null })
  expect(localConversationTransport.environment).toBe(environment)
  expect(shellReachOf(environment.id, window.api as object)).toMatchObject({ openDocument: true, sameDisk: true })
})
