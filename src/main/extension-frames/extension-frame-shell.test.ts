import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test } from 'vitest'

import { createStagedFrames, handleExtensionFrameScheme } from './extension-frame-shell'

// A desktop window stages a frame's document with the shell, which serves it
// only under the hash of its own bytes, with the frame's policy and sandbox.

const html = '<!doctype html><title>frame</title>'
const hash = createHash('sha256').update(html).digest('hex')

test('a document is kept only under the hash of its bytes', () => {
  const staged = createStagedFrames()
  assert.equal(staged.stage('0'.repeat(64), html), false)
  assert.equal(staged.stage('not-a-hash', html), false)
  assert.equal(staged.stage(hash, 42), false)
  assert.equal(staged.stage(hash, html), true)
  assert.equal(staged.get(hash), html)
})

test('the scheme answers a staged document with the frame’s policy and sandbox, and nothing else', async () => {
  const staged = createStagedFrames()
  staged.stage(hash, html)
  let handler: ((request: Request) => Response | Promise<Response>) | null = null
  handleExtensionFrameScheme({ handle: (_scheme, given) => void (handler = given as never) }, staged)
  const served = await handler!(new Request(`studio-ext://frame/${hash}`))
  assert.equal(served.status, 200)
  assert.equal(await served.text(), html)
  assert.match(served.headers.get('Content-Security-Policy') ?? '', /sandbox allow-scripts/)
  assert.equal((await handler!(new Request(`studio-ext://frame/${'1'.repeat(64)}`))).status, 404)
  assert.equal((await handler!(new Request(`studio-ext://other/${hash}`))).status, 404)
})
