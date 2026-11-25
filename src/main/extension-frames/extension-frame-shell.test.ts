import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { test } from 'vitest'

import { buildSurfaceModules } from '../../../packages/extension-sdk/src/source-modules'
import { COMPONENTS_RUNTIME_SOURCE } from '../../server/extensions/frames/components-runtime.generated'
import { buildExtensionFrameDocument, frameDocumentCsp } from '../../server/extensions/frames/frame-document'
import { desktopExtensionFrameUrl, EXTENSION_FRAME_CSP, extensionFrameHeaderCsp } from '../../shared/extension-frames'
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
  const script = document.slice(document.indexOf('<script>') + '<script>'.length, document.lastIndexOf('</script>'))
  const documentHash = createHash('sha256').update(document).digest('hex')
  const staged = createStagedFrames()
  assert.equal(staged.stage(documentHash, document), true)
  let handler: ((request: Request) => Response | Promise<Response>) | null = null
  handleExtensionFrameScheme({ handle: (_scheme, given) => void (handler = given as never) }, staged)
  const served = await handler!(new Request(desktopExtensionFrameUrl(documentHash)))
  assert.equal(served.status, 200)
  const header = served.headers.get('Content-Security-Policy') ?? ''

  // The document states the same policy before its first script runs.
  // It names its one inline script by hash, so a child frame, which inherits the policy, runs none.
  const meta = document.indexOf(`<meta http-equiv="Content-Security-Policy" content="${frameDocumentCsp(script)}">`)
  assert.ok(meta >= 0 && meta < document.indexOf('<script'), 'the policy comes before any script')
  assert.match(frameDocumentCsp(script), /script-src 'sha256-[A-Za-z0-9+/]+=*' blob:/u)
  assert.equal(frameDocumentCsp(script).replace(/'sha256-[^']+'/u, "'unsafe-inline'"), EXTENSION_FRAME_CSP)

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

// The policy has no directive for peer connections, so this one is watched
// live: the frame's document, served with its header, in a real Electron
// window under the app windows' WebRTC policy, with a UDP and a TCP listener
// standing in for an extension's STUN and TURN servers. The window's own page
// is the control: the same peer connection from it does reach the TCP
// listener (TURN over TCP is not the window policy's to stop), so a quiet
// listener means the frame could not build one, not that nothing was watched.
const ELECTRON_MAIN = String.raw`
const { app, BrowserWindow, protocol } = require('electron')
const dgram = require('node:dgram')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[process.argv.length - 1]
const input = JSON.parse(fs.readFileSync(path.join(dir, 'input.json'), 'utf8'))
protocol.registerSchemesAsPrivileged([{ scheme: 'studio-ext', privileges: { standard: true, secure: true } }])
const heard = { udp: 0, tcp: 0 }
const udp = dgram.createSocket('udp4')
udp.on('message', () => void heard.udp++)
const tcp = net.createServer((socket) => { heard.tcp++; socket.destroy() })
const done = (result) => { process.stdout.write('PROBE ' + JSON.stringify(result) + '\n', () => app.exit(0)) }
setTimeout(() => done({ error: 'timed out' }), 20000)
app.whenReady().then(async () => {
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve))
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  const servers = { stun: 'stun:127.0.0.1:' + udp.address().port, turn: 'turn:127.0.0.1:' + tcp.address().port + '?transport=tcp' }
  protocol.handle('studio-ext', () => new Response(input.document, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': input.header } }))
  const win = new BrowserWindow({ show: false })
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  fs.writeFileSync(path.join(dir, 'host.html'), '<body><iframe sandbox="allow-scripts" src="studio-ext://frame/probe"></iframe><script>' +
    'window.reports = []; const servers = ' + JSON.stringify(servers) + ';' +
    'addEventListener("message", (event) => { const m = event.data;' +
    ' if (m && m.report) reports.push(m.report);' +
    ' if (m && m.want === "servers") event.source.postMessage({ servers }, "*");' +
    ' if (m && m.se === 1 && m.kind === "evt" && m.event === "ready") event.source.postMessage({ se: 1, kind: "evt", event: "hello", payload: {} }, "*") });' +
    'window.control = async (servers) => { const pc = new RTCPeerConnection({ iceServers: [{ urls: servers.stun }, { urls: servers.turn, username: "u", credential: "c" }] });' +
    ' pc.createDataChannel("x"); await pc.setLocalDescription(await pc.createOffer()); return "built" };' +
    '</script></body>')
  await win.loadFile(path.join(dir, 'host.html'))
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const frame = { reports: await win.webContents.executeJavaScript('reports'), ...heard }
  const control = await win.webContents.executeJavaScript('control(' + JSON.stringify(servers) + ')')
  await new Promise((resolve) => setTimeout(resolve, 3000))
  done({ frame, control, controlHeard: { udp: heard.udp - frame.udp, tcp: heard.tcp - frame.tcp } })
})
`

// The extension's own code: a peer connection from its realm, from a child
// frame's script, and through a child frame's window.
const PROBE_ENTRY = String.raw`
const report = (entry) => window.top.postMessage({ report: entry }, '*')
const attempt = (scope, build) => {
  try { build(); report(scope + ': built') } catch (error) { report(scope + ': refused') }
}
const peer = (R) => {
  const pc = new R({ iceServers: [{ urls: servers.stun }, { urls: servers.turn, username: 'u', credential: 'c' }] })
  pc.createDataChannel('x')
  void pc.createOffer().then((offer) => pc.setLocalDescription(offer))
}
// The listeners' addresses come from the window: the document is pinned by hash, so it cannot be edited to carry them.
let servers = null
export function mount() {
  window.addEventListener('message', (event) => {
    if (servers || !event.data || !event.data.servers) return
    servers = event.data.servers
    probe()
  })
  window.top.postMessage({ want: 'servers' }, '*')
}
function probe() {
  attempt('frame', () => peer(window.RTCPeerConnection))
  attempt('frame (webkit)', () => peer(window.webkitRTCPeerConnection))
  const child = document.createElement('iframe')
  child.srcdoc = '<script>window.top.postMessage({ report: "srcdoc child ran script" }, "*")<\/script>'
  document.body.appendChild(child)
  const blank = document.createElement('iframe')
  document.body.appendChild(blank)
  attempt('blank child', () => peer(blank.contentWindow.RTCPeerConnection))
  attempt('window[1]', () => peer(window[1].RTCPeerConnection))
  report('done')
}
`

function electronBinary(): string | null {
  try {
    const root = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
    const binary = join(root, 'dist', readFileSync(join(root, 'path.txt'), 'utf8').trim())
    return existsSync(binary) ? binary : null
  } catch {
    return null
  }
}

// Electron needs a display: on a Linux runner without one, there is no window to probe.
const ELECTRON = process.platform === 'linux' && !process.env.DISPLAY ? null : electronBinary()

test.skipIf(!ELECTRON)(
  'live: extension code cannot build a peer connection, not even through a child frame, and no STUN or TURN server hears from it',
  async () => {
    const graph = buildSurfaceModules('src/entry.js', (path) => (path === 'src/entry.js' ? PROBE_ENTRY : null), {})
    assert.ok(graph.ok, graph.ok ? '' : graph.problem.message)
    const document = buildExtensionFrameDocument({
      surface: { point: 'panels', id: 'probe' },
      entryPath: 'src/entry.js',
      modules: graph.modules,
      token: graph.token,
      theme: EXTENSION_FRAME_THEMES.light!,
    })
    const dir = mkdtempSync(join(tmpdir(), 'frame-webrtc-'))
    try {
      writeFileSync(join(dir, 'main.cjs'), ELECTRON_MAIN)
      writeFileSync(join(dir, 'input.json'), JSON.stringify({ document, header: extensionFrameHeaderCsp(null) }))
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          ELECTRON!,
          [...(process.platform === 'linux' ? ['--no-sandbox'] : []), join(dir, 'main.cjs'), dir],
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        )
        let text = ''
        child.stdout.on('data', (chunk: Buffer) => void (text += chunk.toString('utf8')))
        child.on('error', reject)
        child.on('exit', () => resolve(text))
      })
      const line = output.split('\n').find((entry) => entry.startsWith('PROBE '))
      assert.ok(line, `the probe answered: ${output.slice(0, 500)}`)
      const result = JSON.parse(line.slice('PROBE '.length)) as {
        frame: { reports: string[]; udp: number; tcp: number }
        control: string
        controlHeard: { udp: number; tcp: number }
      }
      assert.deepEqual(result.frame.reports, [
        'frame: refused',
        'frame (webkit): refused',
        'blank child: refused',
        'window[1]: refused',
        'done',
      ])
      assert.deepEqual({ udp: result.frame.udp, tcp: result.frame.tcp }, { udp: 0, tcp: 0 })
      // The control: the window's own peer connection reaches TURN over TCP, never over UDP.
      assert.equal(result.control, 'built')
      assert.ok(result.controlHeard.tcp > 0, 'the listeners hear a peer connection that is built')
      assert.equal(result.controlHeard.udp, 0, 'the window policy sends no UDP around a proxy')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30_000,
)
