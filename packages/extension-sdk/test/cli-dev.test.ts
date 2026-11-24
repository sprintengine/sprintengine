import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'

import { EXTENSION_MANIFEST_SINCE } from '../src/extension-manifest.js'

// `dev load` and `dev watch` against a Studio that answers like one: nothing
// on the command line approves a folder. `dev load` exits 3 while it waits,
// with no line to copy that would approve it; `dev watch` says it is waiting
// for approval in Studio, goes on once the person approved it there, and
// Ctrl-C takes back the folder it added.

let workDir = ''
let cli = ''
let dataDir = ''
let server: Server
let folder = ''
const calls: Array<{ name: string; args: Record<string, unknown> }> = []
let approvedAfterLists = Number.POSITIVE_INFINITY

beforeAll(async () => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'se-cli-dev-')))
  const bin = join(workDir, 'bin')
  for (const [entry, out] of [
    ['cli.ts', 'cli.js'],
    ['check-worker.ts', 'check-worker.js'],
  ] as const)
    buildSync({
      entryPoints: [join(process.cwd(), 'packages/extension-sdk/src', entry)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: join(bin, out),
      external: ['react', 'react-dom', 'react-dom/*'],
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: 'silent',
    })
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}')
  cli = join(bin, 'cli.js')

  folder = join(workDir, 'notes')
  mkdirSync(join(folder, 'src'), { recursive: true })
  writeFileSync(
    join(folder, 'extension.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'notes',
      version: '1.0.0',
      engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
      tier: 'ui',
      name: 'Notes',
      permissions: [],
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'src/panel.ts' }] },
    }),
  )
  writeFileSync(
    join(folder, 'src', 'panel.ts'),
    'export function mount(root: HTMLElement) { root.textContent = "1" }\n',
  )

  dataDir = join(workDir, 'data')
  mkdirSync(dataDir)
  const socketPath = join(workDir, 's.sock')
  let lists = 0
  const answer = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
    calls.push({ name, args })
    const pending = { state: 'pending', fingerprint: 'sha256-x', growth: [] }
    if (name === 'extension.dev.load')
      return { moduleId: 'local.notes', path: folder, added: true, approval: pending, latestEvent: 0 }
    if (name === 'extension.dev.list') {
      lists += 1
      const approved = lists > approvedAfterLists
      return {
        folders: [
          {
            path: folder,
            moduleId: 'local.notes',
            approval: approved ? { state: 'approved', fingerprint: 'sha256-x' } : pending,
          },
        ],
      }
    }
    if (name === 'extension.dev.events') return { events: [], latest: 0 }
    return { ok: true, path: folder }
  }
  server = createServer((socket) => {
    let buffered = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffered += chunk
      let at: number
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
        if (message.id === undefined) continue
        const result =
          message.method === 'tools/call'
            ? {
                structuredContent: answer(
                  String(message.params?.name),
                  (message.params?.arguments ?? {}) as Record<string, unknown>,
                ),
              }
            : {}
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
      }
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  writeFileSync(join(dataDir, 'sprintengine-studio-mcp-info.json'), JSON.stringify({ socketPath }))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(workDir, { recursive: true, force: true })
})

/** Run the CLI; `until` ends it with SIGTERM once a line of stdout matches. */
function run(
  args: string[],
  until?: RegExp,
): Promise<{ status: number | null; lines: Array<Record<string, unknown>> }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, '--json', '--data-dir', dataDir], {
      env: { ...process.env, SPRINTENGINE_MCP_CHANNEL_TOKEN: '', SPRINTENGINE_AGENT_ID: '' },
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      if (until?.test(out)) child.kill('SIGTERM')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({
        status,
        lines: out
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      })
    })
  })
}

test('dev load exits 3 while the folder waits for approval in Studio, with nothing to copy that approves it', async () => {
  const { status, lines } = await run(['dev', 'load', folder])
  assert.equal(status, 3)
  const error = (lines.at(-1) as { error: { code: string; message: string; nextSteps?: string[] } }).error
  assert.equal(error.code, 'approval_required')
  assert.match(error.message, /waiting for approval in Studio/)
  assert.ok(!JSON.stringify(lines).includes('--approve'), 'no approve line')
  const refused = await run(['dev', 'load', folder, '--approve', 'sha256-x'])
  assert.equal(refused.status, 1)
  assert.equal((refused.lines.at(-1) as { error: { code: string } }).error.code, 'invalid_argument')
})

test('dev watch waits for the approval, goes on once given, and Ctrl-C takes back the folder it added', async () => {
  calls.splice(0)
  approvedAfterLists = 1
  const { lines } = await run(['dev', 'watch', folder], /"type":"approved"/)
  const types = lines.map((line) => line.type)
  assert.deepEqual(types.slice(0, 3), ['loaded', 'waiting', 'approved'])
  assert.ok(
    calls.some((call) => call.name === 'extension.dev.unload' && call.args.path === folder),
    'the folder it added is removed again',
  )
  assert.ok(!calls.some((call) => 'approve' in call.args))
})
