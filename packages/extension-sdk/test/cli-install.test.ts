import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'

// `install`, `update` and `open` against a Studio that answers like one: each
// source form reaches it as written, each refusal leaves with its code, an
// install that waits for approval exits 3 with nothing that approves it, and
// `open` with no window says so.

let workDir = ''
let cli = ''
let dataDir = ''
let server: Server
const calls: Array<{ name: string; args: Record<string, unknown> }> = []

type Answer = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string }

/** What the fake Studio answers each install source with. */
const ALL_UPDATED: unknown[] = [
  { key: 'acme.notes', from: '1.0.0', to: '1.1.0', status: 'updated' },
  { key: 'acme.tools', from: '2.0.0', status: 'up_to_date' },
]
/** What `update --all` answers; a test sets it and puts it back. */
let allUpdates: unknown[] = ALL_UPDATED

const INSTALLS: Record<string, Answer> = {
  'acme.notes': {
    ok: true,
    result: { moduleId: 'acme.notes', approval: { state: 'pending', fingerprint: 'sha256-x' } },
  },
  'acme/notes@v1': { ok: true, result: { moduleId: 'acme.notes', approval: { state: 'not-needed' } } },
  'https://git.example.com/acme/notes.git#main': {
    ok: true,
    result: { moduleId: 'acme.notes', approval: { state: 'approved', fingerprint: 'sha256-x' } },
  },
  'https://github.com/acme/tools/tree/main/notes': {
    ok: true,
    result: { moduleId: 'acme.notes', approval: { state: 'not-needed' } },
  },
  'acme.killed': { ok: false, code: 'killed', message: 'Studio’s kill list removed acme.killed 1.0.0.' },
  'acme.locked': { ok: false, code: 'release_lock_mismatch', message: 'acme.locked 1.0.0 is locked to commit abc.' },
  'acme.moved': { ok: false, code: 'owner_mismatch', message: 'It lists acme.moved from a repository owned by bob.' },
}

beforeAll(async () => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'se-cli-install-')))
  const bin = join(workDir, 'bin')
  buildSync({
    entryPoints: [join(process.cwd(), 'packages/extension-sdk/src/cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(bin, 'cli.js'),
    external: ['react', 'react-dom', 'react-dom/*'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'silent',
  })
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}')
  cli = join(bin, 'cli.js')
  dataDir = join(workDir, 'data')
  mkdirSync(dataDir)
  const socketPath = join(workDir, 's.sock')
  const answer = (name: string, args: Record<string, unknown>): Answer => {
    calls.push({ name, args })
    if (name === 'extension.install')
      return INSTALLS[String(args.source)] ?? { ok: false, code: 'install_failed', message: 'unknown' }
    if (name === 'extension.update')
      return args.all
        ? { ok: true, result: { updates: allUpdates } }
        : {
            ok: true,
            result: {
              updates: [
                {
                  key: String(args.moduleId),
                  from: '1.0.0',
                  to: '1.1.0',
                  status: 'held',
                  code: 'approval_required',
                  reason: 'It asks for more than was approved.',
                  growth: ['a worker'],
                },
              ],
            },
          }
    if (name === 'extension.open')
      return { ok: false, code: 'no_window', message: 'No Studio window is open on this machine.' }
    return { ok: false, code: 'unavailable', message: name }
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
        let result: Record<string, unknown> = {}
        if (message.method === 'tools/call') {
          const given = answer(
            String(message.params?.name),
            (message.params?.arguments ?? {}) as Record<string, unknown>,
          )
          result = given.ok
            ? { structuredContent: given.result }
            : {
                isError: true,
                structuredContent: { ok: false, error: { code: given.code, message: given.message } },
                content: [{ type: 'text', text: given.message }],
              }
        }
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

function run(args: string[]): Promise<{ status: number | null; last: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, '--json', '--data-dir', dataDir], {
      env: { ...process.env, SPRINTENGINE_MCP_CHANNEL_TOKEN: '', SPRINTENGINE_AGENT_ID: '' },
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (out += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      const lines = out.trim().split('\n').filter(Boolean)
      resolve({ status, last: lines.length ? (JSON.parse(lines.at(-1)!) as Record<string, unknown>) : {} })
    })
  })
}

const codeOf = (last: Record<string, unknown>) => (last.error as { code?: string } | undefined)?.code

test('each source form reaches Studio as written; what is ready exits 0', async () => {
  for (const source of [
    'acme/notes@v1',
    'https://git.example.com/acme/notes.git#main',
    'https://github.com/acme/tools/tree/main/notes',
  ]) {
    calls.splice(0)
    const { status, last } = await run(['install', source])
    assert.equal(status, 0, source)
    assert.equal(last.ok, true, source)
    assert.deepEqual(calls, [{ name: 'extension.install', args: { source } }])
  }
})

test('an install that waits for approval exits 3, and nothing on the command line approves it', async () => {
  const { status, last } = await run(['install', 'acme.notes'])
  assert.equal(status, 3)
  assert.equal(codeOf(last), 'approval_required')
  assert.match(String((last.error as { message: string }).message), /waiting for approval in Studio/)
  assert.ok(!JSON.stringify(last).includes('--approve'))
  const refused = await run(['install', 'acme.notes', '--approve', 'sha256-x'])
  assert.equal(refused.status, 1)
  assert.equal(codeOf(refused.last), 'invalid_argument')
})

test('each refusal leaves with its code: killed, the release lock, another owner', async () => {
  for (const [source, code] of [
    ['acme.killed', 'killed'],
    ['acme.locked', 'release_lock_mismatch'],
    ['acme.moved', 'owner_mismatch'],
  ]) {
    const { status, last } = await run(['install', source!])
    assert.equal(status, 1, source)
    assert.equal(codeOf(last), code, source)
  }
})

test('a source that is none of the forms never reaches Studio', async () => {
  calls.splice(0)
  const { status, last } = await run(['install', 'notes'])
  assert.equal(status, 1)
  assert.equal(codeOf(last), 'invalid_argument')
  assert.deepEqual(calls, [])
})

test('update --all prints a row per extension; one held for approval exits 3', async () => {
  const all = await run(['update', '--all'])
  assert.equal(all.status, 0)
  assert.deepEqual((all.last.result as { updates: unknown[] }).updates, ALL_UPDATED)
  const held = await run(['update', 'acme.notes'])
  assert.equal(held.status, 3)
  assert.equal(codeOf(held.last), 'approval_required')
  assert.equal((await run(['update'])).status, 1)
})

test('update --all fails when any was not updated: 3 when one waits for approval, else 1, every row kept', async () => {
  const refused = { key: 'acme.gone', from: '1.0.0', to: '1.2.0', status: 'refused', code: 'killed', reason: 'Killed.' }
  const waiting = { key: 'acme.more', from: '1.0.0', to: '1.1.0', status: 'held', code: 'approval_required' }
  try {
    allUpdates = [...ALL_UPDATED, refused]
    const failed = await run(['update', '--all'])
    assert.equal(failed.status, 1)
    assert.equal(codeOf(failed.last), 'update_failed')
    assert.deepEqual((failed.last.error as { data: { updates: unknown[] } }).data.updates, allUpdates)

    allUpdates = [...ALL_UPDATED, refused, waiting]
    const held = await run(['update', '--all'])
    assert.equal(held.status, 3)
    assert.equal(codeOf(held.last), 'approval_required')
    assert.deepEqual((held.last.error as { data: { updates: unknown[] } }).data.updates, allUpdates)
  } finally {
    allUpdates = ALL_UPDATED
  }
})

test('open with no window says so', async () => {
  const { status, last } = await run(['open', 'acme.notes', '--panel', 'main'])
  assert.equal(status, 1)
  assert.equal(codeOf(last), 'no_window')
})
