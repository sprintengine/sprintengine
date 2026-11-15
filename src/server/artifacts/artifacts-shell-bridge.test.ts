import assert from 'node:assert/strict'

import { test } from 'vitest'

import { artifactsSetupQuestion } from '../../main/artifacts/artifacts-setup-consent'
import { createControlRpc, type ControlRpc } from '../bootstrap/control-rpc'
import { serveArtifactsShell, shellArtifactsOverControl } from './artifacts-shell-bridge'

// The artifacts domain's two asks of the desktop's shell, out of process: a
// page's picture and the set-up question with no window showing, each over a
// real control channel pair, as the server and the shell hold it.

function pair(): { server: ControlRpc; shell: ControlRpc } {
  let server: ControlRpc | null = null
  let shell: ControlRpc | null = null
  server = createControlRpc((frame) => queueMicrotask(() => shell?.receive(frame)))
  shell = createControlRpc((frame) => queueMicrotask(() => server?.receive(frame)))
  return { server, shell }
}

const QUESTION = artifactsSetupQuestion({ provider: 'github-pages', repositoryUrl: 'acme/artifacts' }, null)

test('a page’s picture is drawn by the shell and comes back as the same bytes', async () => {
  const { server, shell } = pair()
  const asked: unknown[] = []
  serveArtifactsShell(shell, {
    thumbnailer: async (input) => {
      asked.push(input)
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255])
    },
    askNatively: async () => false,
  })
  const artifacts = shellArtifactsOverControl(server, () => true)
  const png = await artifacts.thumbnailer!({ file: '/Users/dev/site/page/index.html', width: 1280, height: 800 })
  assert.deepEqual(png && [...png], [0x89, 0x50, 0x4e, 0x47, 0, 255])
  assert.deepEqual(asked, [{ file: '/Users/dev/site/page/index.html', width: 1280, height: 800 }])
  // A request the shell will not draw (a relative file) is no picture, not an error.
  assert.equal(await artifacts.thumbnailer!({ file: 'index.html', width: 1280, height: 800 }), null)
  assert.equal(asked.length, 1)
})

test('with no window showing, the shell asks natively and its yes comes back', async () => {
  const { server, shell } = pair()
  const asked: string[] = []
  serveArtifactsShell(shell, {
    thumbnailer: async () => null,
    askNatively: async (question) => {
      asked.push(question.message)
      return true
    },
  })
  const artifacts = shellArtifactsOverControl(server, () => false)
  assert.equal(artifacts.hasWindow(), false)
  assert.equal(await artifacts.askNatively(QUESTION, new AbortController().signal), true)
  assert.deepEqual(asked, ['Publish artifacts with GitHub Pages?'])
})

test('a cancelled call closes the shell’s question, and is a no', async () => {
  const { server, shell } = pair()
  let shellSignal: AbortSignal | null = null
  serveArtifactsShell(shell, {
    thumbnailer: async () => null,
    askNatively: (_question, signal) =>
      new Promise<boolean>((resolve) => {
        shellSignal = signal
        // A message box closed by its signal answers its cancel button.
        signal.addEventListener('abort', () => resolve(true), { once: true })
      }),
  })
  const artifacts = shellArtifactsOverControl(server, () => false)
  const controller = new AbortController()
  const answer = artifacts.askNatively(QUESTION, controller.signal)
  for (let tries = 0; !shellSignal && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.ok(shellSignal, 'the shell was asked')
  controller.abort()
  assert.equal(await answer, false)
  for (let tries = 0; !(shellSignal as AbortSignal | null)?.aborted && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal((shellSignal as AbortSignal | null)?.aborted, true, 'the shell’s question was closed')
})

test('a shell that cannot be reached is a no, and no picture', async () => {
  const server = createControlRpc(null)
  const artifacts = shellArtifactsOverControl(server, () => false)
  assert.equal(await artifacts.askNatively(QUESTION, new AbortController().signal), false)
  assert.equal(await artifacts.thumbnailer!({ file: '/Users/dev/a.html', width: 10, height: 10 }), null)
})
