import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build, type Plugin } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'

import { CLI_ERROR_CODES } from '../src/cli-output.js'
import { EXTENSION_MANIFEST_SINCE } from '../src/extension-manifest.js'

// The authoring commands' contract with the agents that run them: with
// --json, one object, `{ ok, result }` or `{ ok: false, error: { code,
// message, data?, nextSteps? } }`, and the exit codes 0, 1, 2 (invalid) and
// 3 (approval). Codes are kept; words may change.

let workDir = ''
let cli = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'sprintengine-cli-authoring-'))
  const bin = join(workDir, 'bin')
  // As the package ships them: the CLI with its two helpers beside it.
  // The components runtime is one module beside them, as in dist/: a panel and
  // check's child must share it, so every other bundle imports it.
  const ownRuntime: Plugin = {
    name: 'components-runtime',
    setup(on) {
      on.onResolve({ filter: /^\.\/components\/index\.js$/ }, () => ({
        path: './components/index.js',
        external: true,
      }))
    },
  }
  for (const [entry, out] of [
    ['cli.ts', 'cli.js'],
    ['check-worker.ts', 'check-worker.js'],
    ['check-panel.ts', 'check-panel.js'],
    ['test-register.ts', 'test-register.js'],
    ['testing.ts', 'testing.js'],
    ['components/index.ts', 'components/index.js'],
    // What the Vitest config `test` writes imports, beside it in dist/.
    ['source-modules.ts', 'source-modules.js'],
  ] as const)
    await build({
      entryPoints: [join(process.cwd(), 'packages/extension-sdk/src', entry)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: join(bin, out),
      external: ['react', 'react-dom', 'react-dom/*'],
      ...(entry === 'components/index.ts' ? {} : { plugins: [ownRuntime] }),
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

test('the guide’s code table lists every kept code, and only those', () => {
  const guide = readFileSync(join(process.cwd(), 'packages/extension-sdk/guide/dev-loop.md'), 'utf8')
  const start = guide.indexOf('| `error.code` |')
  const table = guide.slice(start, guide.indexOf('\n\n', start))
  const listed = [...table.matchAll(/^\| `([a-z_]+)` \|/gmu)].map((match) => match[1])
  assert.deepEqual([...listed].sort(), [...CLI_ERROR_CODES].sort())
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

const PANEL = `import { atom, read, update, Stack, Heading, Button, Text, host } from '@sprintengine/extension-sdk/components'

const count = atom('count', 0, { persist: 'plugin' })

export default function Panel() {
  return (
    <Stack gap="sm">
      <Heading>Counter</Heading>
      <Text>{read(count)} clicks</Text>
      <Button colour="red" onPress={() => update(count, (n: number) => n + 1)}>Add</Button>
    </Stack>
  )
}

// Named at run time, so only rendering finds it: Studio would refuse it, and the panel catches that.
const method = ['files', 'read'].join('.')
export function setup() {
  void host.call(method, { workspaceId: 'ws-app', path: 'x' }).catch(() => undefined)
}
`

function componentsExtension(name: string, files: Record<string, string>): string {
  return extension(
    name,
    { 'src/main.ts': GOOD['src/main.ts'], 'src/greet.ts': GOOD['src/greet.ts'], ...files },
    { contributes: { panels: [{ id: 'counter', title: 'Counter', entry: 'src/panel.tsx', ui: 'components' }] } },
  )
}

test('check renders a components panel once, or once per scenario, and says what it drew and what Studio would refuse', () => {
  const plain = run(['check', componentsExtension('cli-components', { 'src/panel.tsx': PANEL })])
  assert.equal(plain.status, 0, JSON.stringify(plain.answer))
  const panels = plain.answer.result?.panels as {
    ok: boolean
    panels: Array<{
      id: string
      results: Array<{
        name: string
        summary: string[]
        warnings: string[]
        refusals: Array<{ method: string }>
        tree: unknown
      }>
    }>
  }
  assert.equal(panels.ok, true)
  const [only] = panels.panels[0]!.results
  assert.equal(only!.name, 'default')
  assert.deepEqual(only!.summary, ['heading: Counter'])
  assert.deepEqual(only!.warnings, ['Button: ignored unknown prop "colour"'])
  assert.equal(only!.refusals[0]?.method, 'files.read')
  assert.match(JSON.stringify(only!.tree), /0 clicks/)

  const scenarios = run([
    'check',
    componentsExtension('cli-components-scenarios', {
      'src/panel.tsx': PANEL,
      'src/panel.check.ts':
        "import { defineCheck } from '@sprintengine/extension-sdk/testing'\nexport default defineCheck({ fresh: {}, 'clicked before': { persisted: { plugin: { count: 7 } } } })\n",
    }),
  ])
  assert.equal(scenarios.status, 0, JSON.stringify(scenarios.answer))
  const results = (scenarios.answer.result?.panels as typeof panels).panels[0]!.results
  assert.deepEqual(
    results.map((result) => result.name),
    ['fresh', 'clicked before'],
  )
  assert.match(JSON.stringify(results[1]!.tree), /7 clicks/)
})

test('check fails a components panel that throws, at its file and line, and one with no component to draw', () => {
  const throwing = run([
    'check',
    componentsExtension('cli-components-throws', {
      'src/panel.tsx':
        "import { Text } from '@sprintengine/extension-sdk/components'\n\nexport default function Panel() {\n  throw new Error('no data')\n  return <Text>never</Text>\n}\n",
    }),
  ])
  assert.equal(throwing.status, 1)
  assert.equal(throwing.answer.error?.code, 'extension_check_failed')
  assert.match(throwing.answer.error?.message ?? '', /src\/panel\.tsx:4:\d+ no data/u)

  const nothing = run([
    'validate',
    componentsExtension('cli-components-nothing', {
      'src/panel.tsx':
        "import { Text } from '@sprintengine/extension-sdk/components'\nexport const Panel = () => <Text>hi</Text>\n",
    }),
  ])
  assert.equal(nothing.status, 2)
  const issues = nothing.answer.error?.data?.issues as Array<{ message: string }>
  assert.match(issues[0]!.message, /default export/u)
  assert.doesNotMatch(issues[0]!.message, /mount\(root, studio\)/u)
})

test('test mounts a components panel from its .tsx with the SDK’s own runtime, under node:test', () => {
  const dir = componentsExtension('cli-components-tests', { 'src/panel.tsx': PANEL })
  writeFileSync(
    join(dir, 'panel.test.tsx'),
    [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { mountPanel } from '@sprintengine/extension-sdk/testing'",
      "import * as panel from './src/panel'",
      "test('counts', async () => {",
      "  const view = await mountPanel(panel, { manifest: { id: 'cli-components-tests', permissions: [] } })",
      "  await view.press({ role: 'button', text: 'Add' })",
      "  assert.ok(view.find({ text: '1 clicks' }))",
      '  assert.deepEqual(view.persisted.plugin, { count: 1 })',
      '  await view.unmount()',
      '})',
      '',
    ].join('\n'),
  )
  const passing = run(['test', dir])
  assert.equal(passing.status, 0, passing.stderr)
  assert.deepEqual(passing.answer.result?.files, ['panel.test.tsx'])
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

test('validate takes the manifest file itself, as well as its folder', () => {
  const dir = extension('cli-manifest-file', GOOD)
  const valid = run(['validate', join(dir, 'extension.json')])
  assert.equal(valid.status, 0)
  assert.equal(valid.answer.result?.key, 'local.cli-manifest-file')
})

test('a skill folder Studio would refuse fails validate and check, as it fails loading', () => {
  const over = {
    contributes: {
      panels: [{ id: 'p', title: 'P', entry: 'src/panel.ts' }],
      skills: [
        { id: 'missing', path: 'skills/missing' },
        { id: 'empty', path: 'skills/empty' },
      ],
    },
  }
  const dir = extension('cli-skills', GOOD, over)
  mkdirSync(join(dir, 'skills', 'empty'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'empty', 'notes.md'), 'no SKILL.md here\n')
  for (const command of ['validate', 'check']) {
    const answer = run([command, dir])
    assert.equal(answer.status, 2)
    assert.equal(answer.answer.error?.code, 'extension_invalid')
    const issues = answer.answer.error?.data?.issues as Array<{ path: string; message: string }>
    assert.deepEqual(
      issues.filter((issue) => issue.path.startsWith('contributes.skills')).map((issue) => issue.path),
      ['contributes.skills[0].path', 'contributes.skills[1].path'],
    )
    assert.match(issues.find((issue) => issue.path === 'contributes.skills[1].path')!.message, /SKILL\.md/u)
  }
  writeFileSync(join(dir, 'skills', 'empty', 'SKILL.md'), '---\nname: empty\ndescription: d\n---\n')
  mkdirSync(join(dir, 'skills', 'missing'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'missing', 'SKILL.md'), '---\nname: missing\ndescription: d\n---\n')
  assert.equal(run(['validate', dir]).status, 0)
})

test('validate checks the host calls written out, at their file and line', () => {
  const dir = extension('cli-host-calls', {
    ...GOOD,
    'src/panel.ts': [
      'export async function mount(root: HTMLElement, studio: any): Promise<void> {',
      "  await studio.host.call('storage.get', { key: 'k' })",
      "  await studio.host.call('files.read', { workspaceId: 'w', path: 'a' })",
      "  await studio.host.call('nope.method', {})",
      "  if (studio.host.has('later.method')) await studio.host.call('later.method', {})",
      "  // studio.host.call('also.nope', {})",
      '  await studio.document.get()',
      '}',
      '',
    ].join('\n'),
    'src/main.ts': 'export function activate(studio: any): void {\n  studio.listChatRuntimes()\n}\n',
  })
  const answer = run(['validate', dir])
  assert.equal(answer.status, 2)
  assert.equal(answer.answer.error?.code, 'extension_invalid')
  const messages = (answer.answer.error?.data?.issues as Array<{ message: string }>).map((issue) => issue.message)
  const all = messages.join('\n')
  assert.match(
    all,
    /src\/panel\.ts:3:9 studio\.host\.call\("files\.read"\) needs the "workspace-files:read" permission/u,
  )
  assert.match(all, /src\/panel\.ts:4:9 studio\.host\.call\("nope\.method"\) names no host method/u)
  assert.match(all, /src\/panel\.ts:7:9 studio\.document is there only in a custom editor's frame/u)
  assert.match(all, /src\/main\.ts:2:3 studio\.listChatRuntimes\(\) needs the "providers:read" permission/u)
  // Declared, feature-detected or in a comment: not issues.
  assert.doesNotMatch(all, /storage\.get|later\.method|also\.nope/u)
  // `check` refuses the same surface.
  const checked = run(['check', dir])
  assert.equal(checked.status, 2)
})

test('test runs .tsx and .jsx tests, their JSX removed as Studio removes it', () => {
  const dir = extension('cli-jsx-tests', GOOD)
  writeFileSync(
    join(dir, 'src', 'view.tsx'),
    'export const h = (tag: string, _props: unknown, ...children: unknown[]) => ({ tag, children })\nexport const View = (): unknown => <b>hi</b>\n',
  )
  writeFileSync(
    join(dir, 'view.test.tsx'),
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { View, h } from './src/view'\ntest('draws', () => assert.deepEqual(View(), { tag: 'b', children: ['hi'] }))\nvoid h\n",
  )
  const answer = run(['test', dir])
  assert.equal(answer.status, 0, answer.stderr)
  assert.equal(answer.answer.result?.runner, 'node:test')
  assert.deepEqual(answer.answer.result?.files, ['view.test.tsx'])
})

test('test uses the project’s own Vitest when it has one installed', () => {
  const vitest = join(process.cwd(), 'node_modules', 'vitest')
  if (!existsSync(join(vitest, 'vitest.mjs'))) return
  const dir = extension('cli-vitest', GOOD)
  writeFileSync(join(dir, 'package.json'), '{"name":"cli-vitest","private":true,"type":"module"}')
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(vitest, join(dir, 'node_modules', 'vitest'), 'dir')
  writeFileSync(
    join(dir, 'greet.test.ts'),
    "import { expect, test } from 'vitest'\nimport { greet } from './src/greet'\ntest('greets', () => expect(greet('a')).toBe('Hello, a'))\n",
  )
  const answer = run(['test', dir])
  assert.equal(answer.status, 0, answer.stderr)
  assert.equal(answer.answer.result?.runner, 'vitest')
}, 60_000)

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
