import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test } from 'vitest'

import { buildSurfaceModules } from '../../../packages/extension-sdk/src/source-modules'
import { COMPONENTS_RUNTIME_SOURCE } from '../../server/extensions/frames/components-runtime.generated'
import { buildExtensionFrameDocument } from '../../server/extensions/frames/frame-document'
import { desktopExtensionFrameUrl, EXTENSION_FRAME_CSP } from '../../shared/extension-frames'
import { EXTENSION_FRAME_THEMES } from '../../shared/extension-frame-themes.generated'
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

// A components panel's module runs in the same frame, served the same way. It
// is kept off the network by the policy the shell answers its document with
// (and the document repeats before any script): every directive a request
// could ride admits no network scheme and no host. This is the policy, not a
// browser refusing a live request: jsdom enforces no policy.
test('a components panel that calls fetch is served under a policy that admits no network request', async () => {
  const files: Record<string, string> = {
    'src/panel.tsx': [
      "import { Text } from '@sprintengine/extension-sdk/components'",
      "void fetch('https://example.com/collect', { method: 'POST', body: 'x' })",
      "void new WebSocket('wss://example.com/socket')",
      "void new EventSource('https://example.com/stream')",
      "navigator.sendBeacon('https://example.com/beacon', 'x')",
      "new Image().src = 'https://example.com/pixel.png'",
      'export default function Panel() {',
      '  return <Text>Offline</Text>',
      '}',
    ].join('\n'),
  }
  const graph = buildSurfaceModules('src/panel.tsx', (path) => files[path] ?? null, {
    jsx: 'components',
    componentsModule: COMPONENTS_RUNTIME_SOURCE,
  })
  assert.ok(graph.ok, graph.ok ? '' : graph.problem.message)
  // Code from the network is not even built in: only the extension's own files import.
  const remote = buildSurfaceModules(
    'src/panel.tsx',
    (path) => (path === 'src/panel.tsx' ? "void import('https://example.com/more.js')" : null),
    { jsx: 'components', componentsModule: COMPONENTS_RUNTIME_SOURCE },
  )
  assert.equal(remote.ok, false)
  assert.match(remote.ok ? '' : remote.problem.message, /cannot import "https:\/\/example\.com\/more\.js"/)
  const document = buildExtensionFrameDocument({
    surface: { point: 'panels', id: 'offline' },
    entryPath: 'src/panel.tsx',
    modules: graph.modules,
    token: graph.token,
    theme: EXTENSION_FRAME_THEMES.light!,
    components: true,
  })
  assert.ok(document.includes('example.com/collect'), 'the module’s fetch travels in the document')
  const documentHash = createHash('sha256').update(document).digest('hex')
  const staged = createStagedFrames()
  assert.equal(staged.stage(documentHash, document), true)
  let handler: ((request: Request) => Response | Promise<Response>) | null = null
  handleExtensionFrameScheme({ handle: (_scheme, given) => void (handler = given as never) }, staged)
  const served = await handler!(new Request(desktopExtensionFrameUrl(documentHash)))
  assert.equal(served.status, 200)
  const header = served.headers.get('Content-Security-Policy') ?? ''

  // The document states the same policy before its first script runs.
  const meta = document.indexOf(`<meta http-equiv="Content-Security-Policy" content="${EXTENSION_FRAME_CSP}">`)
  assert.ok(meta >= 0 && meta < document.indexOf('<script'), 'the policy comes before any script')

  const directives = new Map(
    header.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/u)
      return [name!, sources] as const
    }),
  )
  const sourcesFor = (directive: string) => directives.get(directive) ?? directives.get('default-src')!
  assert.deepEqual(directives.get('default-src'), ["'none'"])
  // fetch, XMLHttpRequest, WebSocket, EventSource and sendBeacon ride connect-src.
  assert.deepEqual(sourcesFor('connect-src'), ["'none'"])
  assert.deepEqual(directives.get('sandbox'), ['allow-scripts'], 'an opaque origin: no cookies, no storage')
  // Every other way a request leaves: none names a network scheme, a host or a wildcard.
  const local = new Set(["'none'", "'unsafe-inline'", 'data:', 'blob:'])
  for (const directive of [
    'script-src',
    'style-src',
    'img-src',
    'font-src',
    'media-src',
    'worker-src',
    'frame-src',
    'object-src',
    'manifest-src',
    'prefetch-src',
    'form-action',
    'base-uri',
  ]) {
    const sources = sourcesFor(directive)
    assert.ok(
      sources.every((source) => local.has(source)),
      `${directive} admits only the frame's own data: and blob: (${sources.join(' ')})`,
    )
  }
})
