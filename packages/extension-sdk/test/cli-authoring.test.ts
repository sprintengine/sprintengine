import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'

import { CLI_ERROR_CODES } from '../src/cli-output.js'
import { EXTENSION_MANIFEST_SINCE } from '../src/extension-manifest.js'

// The authoring commands' contract with the agents that run them: with
// --json, one object, `{ ok, result }` or `{ ok: false, error: { code,
// message, data?, nextSteps? } }`, and the exit codes 0, 1, 2 (invalid) and
// 3 (approval). Codes are kept; words may change.

let workDir = ''
let cli = ''

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sprintengine-cli-authoring-'))
  const bin = join(workDir, 'bin')
  // As the package ships them: the CLI with its two helpers beside it.
  for (const [entry, out] of [
    ['cli.ts', 'cli.js'],
    ['check-worker.ts', 'check-worker.js'],
    ['test-register.ts', 'test-register.js'],
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
})

afterAll(() => rmSync(workDir, { recursive: true, force: true }))

type Answer = {
  ok: boolean
  result?: Record<string, unknown>
  error?: { code: string; message: string; data?: Record<string, unknown> }
}

function run(args: string[], cwd = workDir): { status: number | null; answer: Answer; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SPRINTENGINE_USER_DATA_DIR: join(workDir, 'no-studio') },
  })
  const line = stdout.trim().split('\n').at(-1) ?? ''
  return { status, answer: JSON.parse(line) as Answer, stderr }
}

function extension(name: string, files: Record<string, string>, over: Record<string, unknown> = {}): string {
  const dir = join(workDir, name)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'extension.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: name,
      version: '1.0.0',
      engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
      tier: 'worker',
      name,
      permissions: ['storage:own'],
      main: 'src/main.ts',
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'src/panel.ts' }] },
      ...over,
    }),
  )
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text)
  return dir
}

const GOOD = {
  'src/greet.ts': 'export function greet(name: string): string {\n  return `Hello, ${name}`\n}\n',
  'src/main.ts':
    "import { greet } from './greet'\nexport default function activate(studio: any): void {\n  studio.registerMethods({ hello: { access: 'read', params: (p: unknown) => ({ ok: true, params: p }), handler: async () => ({ ok: true, result: greet('x') }) } })\n}\n",
  'src/panel.ts':
    "import { greet } from './greet'\nexport function mount(root: HTMLElement): void {\n  root.textContent = greet('panel')\n}\n",
}

test('every code is one of the kept codes, and each has its exit code', () => {
  assert.ok(CLI_ERROR_CODES.includes('extension_invalid'))
  assert.ok(CLI_ERROR_CODES.includes('approval_required'))
})

test('validate and inspect answer what Studio would load and what it asks for', () => {
  const dir = extension('cli-good', GOOD)
  const valid = run(['validate', dir])
  assert.equal(valid.status, 0)
  assert.equal(valid.answer.ok, true)
  assert.equal(valid.answer.result?.key, 'local.cli-good')
  const inspected = run(['inspect', dir])
  assert.equal(inspected.status, 0)
  assert.equal(inspected.answer.result?.needsApproval, true)
  assert.deepEqual((inspected.answer.result?.access as { permissions: string[] }).permissions, ['storage:own'])
  assert.match(String(inspected.answer.result?.contentHash), /^[0-9a-f]{64}$/u)
})

test('an extension Studio cannot load is extension_invalid, exit 2, with each issue at its file and line', () => {
  const dir = extension('cli-broken', {
    ...GOOD,
    'src/panel.ts': "import React from 'react'\nexport function mount(root: HTMLElement {\n}\n",
  })
  const answer = run(['validate', dir])
  assert.equal(answer.status, 2)
  assert.equal(answer.answer.error?.code, 'extension_invalid')
  const issues = answer.answer.error?.data?.issues as Array<{ message: string }>
  assert.match(issues[0]!.message, /src\/panel\.ts:2:\d+/u)
})

test('check activates the worker and builds each surface; a worker that throws fails at its file and line', () => {
  const good = run(['check', extension('cli-check', GOOD)])
  assert.equal(good.status, 0)
  assert.deepEqual((good.answer.result?.worker as { methods: unknown[] }).methods, [{ name: 'hello', access: 'read' }])
  const throwing = run([
    'check',
    extension('cli-throws', {
      ...GOOD,
      'src/greet.ts': "export const greet = (n: string) => n\nthrow new Error('boom')\n",
    }),
  ])
  assert.equal(throwing.status, 1)
  assert.equal(throwing.answer.error?.code, 'extension_check_failed')
  assert.match(throwing.answer.error?.message ?? '', /src\/greet\.ts:2:7 boom/u)
})

test('test runs the project’s tests as written and exits with the runner’s code', () => {
  const dir = extension('cli-tests', GOOD)
  writeFileSync(
    join(dir, 'greet.test.ts'),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { greet } from './src/greet'\ntest('greets', () => assert.equal(greet('a'), 'Hello, a'))\n",
  )
  const passing = run(['test', dir])
  assert.equal(passing.status, 0)
  assert.deepEqual(passing.answer.result?.files, ['greet.test.ts'])
  writeFileSync(
    join(dir, 'fails.test.ts'),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fails', () => assert.equal(1, 2))\n",
  )
  const failing = run(['test', dir])
  assert.equal(failing.status, 1)
  assert.equal(failing.answer.error?.code, 'extension_tests_failed')
})

test('with no Studio running, dev and shot are studio_unavailable, exit 1', () => {
  const answer = run(['dev', 'list'])
  assert.equal(answer.status, 1)
  assert.equal(answer.answer.error?.code, 'studio_unavailable')
})

test('a wrong flag or subcommand is invalid_argument, exit 1', () => {
  assert.equal(run(['dev', 'frobnicate']).answer.error?.code, 'invalid_argument')
  const flag = run(['validate', '.', '--frob'])
  assert.equal(flag.status, 1)
  assert.equal(flag.answer.error?.code, 'invalid_argument')
})
