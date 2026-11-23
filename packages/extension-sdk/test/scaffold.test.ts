// Every bundled template scaffolds into a project Studio would accept, loaded
// the way Studio loads it: from source, with no build step.
//
// For each template: scaffold into a temporary folder; validate
// extension/extension.json with this package's validator, as an author's tools
// hold it; check every file it names is source in extension/ and that nothing
// of a build is left (no dist/, no bundler, no React); type-check the project
// against this package's SOURCE (a paths mapping, so the test never depends on
// dist/ being current); build each surface's module graph as Studio's frame
// does; activate the worker from source against the fake main host, as
// `sprintengine-extension check` does; and run the project's own tests with
// `node --test` and the SDK's TypeScript hooks, as `sprintengine-extension
// test` does.
//
// The projects resolve packages through one shared node_modules: the
// repository's own @types and the SDK's runtime dependencies, symlinked, plus
// this SDK transpiled from source into @sprintengine/extension-sdk.
//
// Also: the scaffolder's refusals, the placeholder and tarball handling, and
// projects composed from parts (`parts`, `addModuleParts`) loading the same way.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'

import {
  EXTENSION_MANIFEST_SINCE,
  EXTENSION_SURFACE_POINTS,
  isExtensionPermission,
  requiredExtensionTier,
  validateExtensionManifest,
  type ExtensionManifest,
} from '../src/index.js'
import {
  addModuleParts,
  listModuleParts,
  listModuleTemplates,
  sanitizeDisplayText,
  scaffoldModuleProject,
} from '../src/scaffold.js'
import { buildSurfaceModules, formatSourceProblem } from '../src/source-modules.js'

const REPO = process.cwd()
const SDK = join(REPO, 'packages/extension-sdk')
const TEMPLATES = join(SDK, 'templates')
const SDK_VERSION = '4.0.0-beta.1'

const PROJECT_SCRIPTS = ['typecheck', 'test', 'validate', 'check', 'dev', 'pack', 'keygen']
const BUILD_SCRIPTS = ['build', 'build:ui', 'build:main', 'build:server', 'build:test', 'dev:install']
const PROJECT_DEV_DEPENDENCIES = ['@sprintengine/extension-sdk', '@types/node', 'typescript']

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(join(dir, entry.name), path) : [path]
  })
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed in ${cwd}:\n${output}`)
  return output
}

/** A node_modules the scaffolded projects resolve through. */
function sharedNodeModules(root: string): string {
  const nodeModules = join(root, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  for (const name of ['@types', 'sucrase', 'es-module-lexer']) {
    symlinkSync(join(REPO, 'node_modules', name), join(nodeModules, name))
  }

  // The SDK as a project installs it, transpiled from source: one file per
  // source file, so `./signing`, `./testing` and the source hooks exist as
  // they do in dist/.
  const sdkPackage = join(nodeModules, '@sprintengine', 'extension-sdk')
  const sources = readdirSync(join(SDK, 'src')).filter((name) => name.endsWith('.ts'))
  buildSync({
    entryPoints: sources.map((name) => join(SDK, 'src', name)),
    outdir: join(sdkPackage, 'dist'),
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const sub = (name: string) => ({ default: `./dist/${name}.js` })
  writeFileSync(
    join(sdkPackage, 'package.json'),
    JSON.stringify({
      name: '@sprintengine/extension-sdk',
      version: SDK_VERSION,
      type: 'module',
      main: './dist/index.js',
      exports: {
        '.': sub('index'),
        './signing': sub('signing'),
        './source': sub('source-modules'),
        './testing': sub('testing'),
      },
      bin: { 'sprintengine-extension': './dist/cli.js' },
    }),
  )
  return nodeModules
}

/** Type-check a project against this package's source, tests included. */
function typecheckAgainstSource(dir: string, env: NodeJS.ProcessEnv): void {
  writeFileSync(
    join(dir, 'tsconfig.scaffold-test.json'),
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: {
        paths: {
          '@sprintengine/extension-sdk': [join(SDK, 'src/index.ts')],
          '@sprintengine/extension-sdk/testing': [join(SDK, 'src/testing.ts')],
        },
      },
    }),
  )
  try {
    run(join(REPO, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.scaffold-test.json'], dir, env)
  } finally {
    rmSync(join(dir, 'tsconfig.scaffold-test.json'))
  }
}

function readManifest(dir: string): ExtensionManifest {
  const raw: unknown = JSON.parse(readFileSync(join(dir, 'extension/extension.json'), 'utf8'))
  const result = validateExtensionManifest(raw, { authoring: true })
  assert.ok(result.ok, `${dir}: ${JSON.stringify(result.ok ? [] : result.issues)}`)
  return result.manifest
}

/** A file of the extension folder, as Studio reads a development folder's, or null. */
function extensionReader(extensionDir: string): (path: string) => string | null {
  return (path) => {
    const file = join(extensionDir, path)
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null
  }
}

/** Each surface's module graph builds as the frame builds it: relative imports only, every one found. */
function buildSurfaces(dir: string, manifest: ExtensionManifest): void {
  const read = extensionReader(join(dir, 'extension'))
  for (const point of EXTENSION_SURFACE_POINTS) {
    for (const surface of manifest.contributes[point]) {
      const graph = buildSurfaceModules(surface.entry, read)
      assert.ok(graph.ok, `${dir}: ${surface.entry}: ${graph.ok ? '' : formatSourceProblem(graph.problem)}`)
      assert.equal(graph.modules.at(-1)?.path, surface.entry)
    }
  }
}

// Set up in beforeAll: the preloads below live in the shared work folder.
let testHooks = ''
let activateProbe = ''

/** The project's tests, run as `sprintengine-extension test` runs them: node --test, TypeScript as written. */
function runProjectTests(dir: string): string {
  const files = walk(join(dir, 'test'))
    .filter((file) => /\.test\.(?:ts|mts|js|mjs)$/.test(file))
    .map((file) => join('test', file))
  assert.ok(files.length > 0, `${dir}: no tests`)
  return run(process.execPath, ['--import', pathToFileURL(testHooks).href, '--test', ...files], dir, env)
}

/** The worker, loaded from source and activated against the fake main host, as `check` does. */
function activateWorker(dir: string): void {
  run(process.execPath, [activateProbe, join(dir, 'extension')], dir, env)
}

function assertNoBuild(dir: string, label: string, manifest: ExtensionManifest): void {
  const files = walk(dir).filter((file) => !file.startsWith('node_modules/'))
  assert.ok(!files.some((file) => /(^|\/)dist\//.test(file)), `${label}: a dist/ folder was written`)
  for (const file of files) {
    if (!/\.(?:ts|mts|mjs|js)$/.test(file)) continue
    const text = readFileSync(join(dir, file), 'utf8')
    assert.ok(!/from ['"](?:react|react-dom|esbuild)/.test(text), `${label}: ${file} imports a build tool or React`)
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
    devDependencies: Record<string, string>
  }
  for (const script of PROJECT_SCRIPTS) assert.ok(pkg.scripts[script], `${label}: package.json has no "${script}"`)
  for (const script of BUILD_SCRIPTS) assert.equal(pkg.scripts[script], undefined, `${label}: "${script}" is a build`)
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), PROJECT_DEV_DEPENDENCIES, `${label}: devDependencies`)

  // Every file extension.json names is in extension/, as written.
  const declared = [
    ...(manifest.main ? [manifest.main] : []),
    ...EXTENSION_SURFACE_POINTS.flatMap((point) => manifest.contributes[point].map((surface) => surface.entry)),
    ...manifest.contributes.skills.map((skill) => `${skill.path.replace(/\/+$/, '')}/SKILL.md`),
    ...manifest.contributes.mcpServers.flatMap((server) =>
      server.transport === 'stdio'
        ? [server.command ?? '', ...(server.args ?? [])]
            .filter((part) => part.startsWith('${extensionPath}/'))
            .map((part) => part.slice('${extensionPath}/'.length))
        : [],
    ),
  ]
  for (const file of declared) {
    assert.ok(existsSync(join(dir, 'extension', file)), `${label}: extension/${file} is named but missing`)
    assert.ok(!file.startsWith('dist/'), `${label}: ${file} names a build output`)
  }
}

// One test per template, and one each for the composed projects and the
// tarball, rather than one test for the lot: each template's loop is a few
// real `tsc` and `node` processes (a few seconds alone), and summed over every
// template under one test's timeout they ran past it on a loaded machine.
// Split, each test's budget covers one project.
const templates = listModuleTemplates(TEMPLATES)
const base = { templateId: 'blank', displayName: 'X', sdkVersion: SDK_VERSION, templatesRoot: TEMPLATES }
let work = ''
let env: NodeJS.ProcessEnv = {}

beforeAll(() => {
  // Its real path: the source hooks hold a file to the folder they are rooted
  // at by path, and the temporary folder may sit behind a symbolic link.
  work = realpathSync(mkdtempSync(join(tmpdir(), 'sprintengine-scaffold-')))
  sharedNodeModules(work)
  const { SPRINTENGINE_SIGNING_KEY: _ownKey, ...inherited } = process.env
  env = {
    ...inherited,
    // Keep everything away from the real ~/.sprintengine.
    HOME: join(work, 'home'),
    SPRINTENGINE_USER_EXTENSION_ROOT: join(work, 'installed'),
    npm_config_update_notifier: 'false',
  }
  const hooks = pathToFileURL(join(work, 'node_modules/@sprintengine/extension-sdk/dist/source-hooks.js')).href
  testHooks = join(work, 'test-hooks.mjs')
  writeFileSync(testHooks, `import { installTypeScriptHooks } from '${hooks}'\ninstallTypeScriptHooks(process.cwd())\n`)
  activateProbe = join(work, 'activate-probe.mjs')
  writeFileSync(
    activateProbe,
    [
      "import assert from 'node:assert/strict'",
      "import { readFileSync } from 'node:fs'",
      "import { join, resolve } from 'node:path'",
      "import { pathToFileURL } from 'node:url'",
      `import { installTypeScriptHooks } from '${hooks}'`,
      "import { validateExtensionManifest } from '@sprintengine/extension-sdk'",
      "import { createFakeMainHost } from '@sprintengine/extension-sdk/testing'",
      'const root = resolve(process.argv[2])',
      'installTypeScriptHooks(root)',
      "const result = validateExtensionManifest(JSON.parse(readFileSync(join(root, 'extension.json'), 'utf8')), { authoring: true })",
      'assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues))',
      'const { manifest } = result',
      'const entry = await import(pathToFileURL(join(root, manifest.main)).href)',
      'const activate = entry.activate ?? entry.default',
      "assert.equal(typeof activate, 'function', `${manifest.main} exports activate`)",
      'const main = createFakeMainHost({ manifest })',
      'await activate(main.host)',
      'await main.startup()',
      'const methods = main.methods.declared()',
      'for (const command of manifest.contributes.commands.filter((command) => !command.action)) {',
      "  assert.ok(methods.some((method) => method.name === command.id && method.access === 'operate'), command.id)",
      '}',
      'const tools = main.tools.list().map((tool) => tool.name)',
      'for (const tool of manifest.contributes.mcpTools) assert.ok(tools.includes(tool.name), tool.name)',
      'assert.deepEqual(main.undeclared, [])',
      'await main.shutdown()',
      'main.dispose()',
      '',
    ].join('\n'),
  )
})

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true })
})

test('the templates on offer, what no template or part carries, and the refusals', async () => {
  // ── The templates on offer ─────────────────────────────────────────────────
  const templateIds = templates.map((template) => template.id)
  const dirs = readdirSync(TEMPLATES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
  assert.deepEqual([...templateIds].sort(), [...dirs].sort(), 'every template folder is listed, once')
  assert.deepEqual(templateIds, [
    'blank',
    'panel',
    'door',
    'editor',
    'chat-companion',
    'top-bar-item',
    'settings-section',
    'backlog-action',
    'file-action',
    'mcp-tools',
    'hook-guard',
    'agent-kit',
  ])
  assert.deepEqual(
    listModuleParts(TEMPLATES).map((part) => part.id),
    ['main', 'mcp', 'settings', 'door'],
  )

  // ── Nothing to build ───────────────────────────────────────────────────────
  // Every project shares one package.json, and a part adds no script or
  // dependency: there is no build for it to join.
  for (const id of templateIds) {
    assert.equal(existsSync(join(TEMPLATES, id, 'package.json')), false, `${id}: the shared package.json is the one`)
  }
  for (const part of listModuleParts(TEMPLATES)) {
    const raw = JSON.parse(readFileSync(join(TEMPLATES, '_parts', part.id, 'part.json'), 'utf8')) as {
      main?: string
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    assert.deepEqual(raw.scripts, {}, `${part.id}: a part adds no script`)
    assert.deepEqual(raw.devDependencies, {}, `${part.id}: a part adds no dependency`)
    if (raw.main !== undefined) assert.equal(raw.main, 'src/main.ts')
  }
  assert.deepEqual(readdirSync(join(TEMPLATES, '_shared', 'scripts')), ['check-toolchain.mjs'])

  // ── Refusals ───────────────────────────────────────────────────────────────
  const refused = async (options: Partial<Parameters<typeof scaffoldModuleProject>[0]>, code: string) => {
    const result = await scaffoldModuleProject({ ...base, id: 'fine-id', dir: join(work, 'refused'), ...options })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, code, result.message)
  }
  await refused({ id: 'Not_Kebab' }, 'invalid_id')
  await refused({ id: 'double--dash' }, 'invalid_id')
  await refused({ id: 'trailing-' }, 'invalid_id')
  await refused({ id: 'constructor' }, 'invalid_id')
  await refused({ id: 'studio-notes' }, 'invalid_id')
  await refused({ id: 'sprintengine-notes' }, 'invalid_id')
  await refused({ templateId: 'no-such-template' }, 'unknown_template')
  await refused({ templateId: 'workspace-type' }, 'unknown_template')
  await refused({ templateId: '_shared' }, 'unknown_template')
  await refused({ parts: ['renderer'] }, 'unknown_part')
  mkdirSync(join(work, 'occupied'))
  writeFileSync(join(work, 'occupied', 'keep.txt'), 'mine')
  await refused({ dir: join(work, 'occupied') }, 'dir_not_empty')
  const forced = await scaffoldModuleProject({ ...base, id: 'forced', dir: join(work, 'occupied'), force: true })
  assert.ok(forced.ok)
  assert.equal(readFileSync(join(work, 'occupied', 'keep.txt'), 'utf8'), 'mine', 'force leaves unrelated files')

  assert.equal(sanitizeDisplayText(` Bob's  "Big" {tool} <x> \`$y\\ `), 'Bob’s Big tool x y')
  // A long name is cut to what extension.json takes, and still validates.
  const long = await scaffoldModuleProject({
    ...base,
    id: '9-lives',
    displayName: 'A'.repeat(100),
    templateId: 'mcp-tools',
    dir: join(work, 'long'),
  })
  assert.ok(long.ok, long.ok ? '' : long.message)
  const longManifest = readManifest(join(work, 'long'))
  assert.equal(longManifest.name, 'A'.repeat(64))
  assert.deepEqual(
    longManifest.contributes.mcpTools.map((tool) => tool.name),
    ['ext_9_lives_word_count', 'ext_9_lives_open_workspaces'],
    'a tool name starts with a letter, whatever the id starts with',
  )
})

// ── Every template ─────────────────────────────────────────────────────────
for (const template of templates) {
  test(`template "${template.id}" scaffolds a project Studio loads from source, and its tests pass`, async () => {
    const id = `demo-${template.id}`
    const dir = join(work, template.id)
    const idea = template.id === 'panel' ? '# My idea\n\nA scratchpad.' : undefined
    const scaffolded = await scaffoldModuleProject({
      dir,
      templateId: template.id,
      id,
      displayName: `Demo's ${template.title}`,
      sdkVersion: SDK_VERSION,
      templatesRoot: TEMPLATES,
      ideaMarkdown: idea,
    })
    assert.ok(scaffolded.ok, scaffolded.ok ? '' : scaffolded.message)
    if (!scaffolded.ok) return

    // The files, filled in.
    const files = walk(dir)
    assert.deepEqual(scaffolded.files, [...files].sort(), `${template.id}: the result lists what was written`)
    for (const required of [
      'package.json',
      'tsconfig.json',
      'extension/extension.json',
      'IDEA.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.gitignore',
      'test/manifest.ts',
      'test/module.test.ts',
      'scripts/check-toolchain.mjs',
    ]) {
      assert.ok(files.includes(required), `${template.id}: ${required} is missing`)
    }
    for (const gone of [
      'plugin.json',
      'module/manifest.json',
      'test/smoke.test.mjs',
      'scripts/build-ui.mjs',
      'scripts/dev-install.mjs',
      'scripts/validate.mjs',
    ]) {
      assert.ok(!files.includes(gone), `${template.id}: ${gone} is a layout extensions no longer have`)
    }
    assert.ok(
      files.every((file) => !file.startsWith('src/')),
      `${template.id}: source lives in extension/src, not src/`,
    )
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8')
      assert.ok(!/\{\{\w+\}\}/.test(text), `${template.id}: ${file} still has a placeholder`)
    }
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md')
    if (idea) assert.equal(readFileSync(join(dir, 'IDEA.md'), 'utf8'), `${idea}\n`)
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    for (const pattern of ['node_modules/', 'packed/', '.sprintengine/', '*.key', '*.pem', '.DS_Store']) {
      assert.ok(gitignore.includes(pattern), `${template.id}: .gitignore does not ignore ${pattern}`)
    }

    // The manifest, as Studio reads it.
    const manifest = readManifest(dir)
    assert.equal(manifest.id, id)
    assert.equal(manifest.name, `Demo’s ${template.title}`)
    assert.equal(manifest.engines.studio, `>=${EXTENSION_MANIFEST_SINCE}`)
    assert.equal(manifest.tier, requiredExtensionTier(manifest), `${template.id}: the least tier that carries it`)
    assert.deepEqual(manifest.permissions, template.permissions, `${template.id}: template.json permissions`)
    for (const permission of manifest.permissions) {
      assert.ok(isExtensionPermission(permission), `${template.id}: unknown permission ${permission}`)
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkg.devDependencies['@sprintengine/extension-sdk'], `^${SDK_VERSION}`)
    assertNoBuild(dir, template.id, manifest)

    // Loaded as Studio loads it, and its own tests.
    typecheckAgainstSource(dir, env)
    buildSurfaces(dir, manifest)
    if (manifest.main) activateWorker(dir)
    runProjectTests(dir)
    assert.ok(!walk(dir).some((file) => /(^|\/)dist\//.test(file)), `${template.id}: testing wrote a dist/`)
  })
}

// ── Projects composed from parts ───────────────────────────────────────────
test('projects composed from parts load the same way', async () => {
  // The door is added to the mcp-tools project its template test above made.
  assert.ok(existsSync(join(work, 'mcp-tools', 'extension', 'extension.json')), 'the mcp-tools template test ran first')
  // Every part on the smallest template, and a door added to a project with
  // no surface at all: each loads and runs its tests, its parts' included.
  const composed = join(work, 'composed')
  const scaffoldedComposed = await scaffoldModuleProject({
    dir: composed,
    templateId: 'blank',
    id: 'demo-composed',
    displayName: 'Composed',
    sdkVersion: SDK_VERSION,
    templatesRoot: TEMPLATES,
    parts: ['door', 'mcp', 'settings', 'main'],
  })
  assert.ok(scaffoldedComposed.ok, scaffoldedComposed.ok ? '' : scaffoldedComposed.message)
  const composedManifest = readManifest(composed)
  assert.equal(composedManifest.tier, 'worker', 'the worker raised the tier')
  assert.equal(composedManifest.main, 'src/main.ts')
  assert.deepEqual(composedManifest.permissions, ['tools:contribute', 'settings:own'])
  assert.deepEqual(
    composedManifest.contributes.mcpTools.map((tool) => tool.name),
    ['demo_composed_about'],
  )
  assert.match(readFileSync(join(composed, 'extension/src/main.ts'), 'utf8'), /^ {2}registerTools\(studio\)$/m)

  const toolsDir = join(work, 'mcp-tools')
  const addedDoor = await addModuleParts({ dir: toolsDir, parts: ['door'], templatesRoot: TEMPLATES })
  assert.ok(addedDoor.ok, addedDoor.ok ? '' : addedDoor.message)
  assert.deepEqual(addedDoor.ok && addedDoor.added, ['door'])
  assert.ok(existsSync(join(toolsDir, 'extension/src/door.ts')), 'the door brought its source')
  for (const [dir, label] of [
    [composed, 'composed'],
    [toolsDir, 'mcp-tools with a door'],
  ] as const) {
    const manifest = readManifest(dir)
    assertNoBuild(dir, label, manifest)
    typecheckAgainstSource(dir, env)
    buildSurfaces(dir, manifest)
    activateWorker(dir)
    runProjectTests(dir)
  }
  const composedTests = runProjectTests(composed)
  for (const name of [
    'the door is declared, and its source exports mount',
    'an agent can ask which extension this is',
    'the section shows what was saved',
    'a surface can ask when the worker started',
  ]) {
    assert.ok(composedTests.includes(name), `the composed project ran "${name}"`)
  }

  // Refusals: a part the project has, a contribution id it already uses.
  const refusedPart = await scaffoldModuleProject({
    ...base,
    id: 'twice',
    dir: join(work, 'twice'),
    templateId: 'chat-companion',
    parts: ['main'],
  })
  assert.equal(!refusedPart.ok && refusedPart.code, 'already_present')
  assert.equal(existsSync(join(work, 'twice')), false, 'a refused part leaves no half-made project')
  const doorAgain = await addModuleParts({ dir: toolsDir, parts: ['door'], templatesRoot: TEMPLATES })
  assert.equal(!doorAgain.ok && doorAgain.code, 'already_present')
  // mcp on a project with no worker brings the worker with it.
  const blankDir = join(work, 'blank')
  const addedMcp = await addModuleParts({ dir: blankDir, parts: ['mcp'], templatesRoot: TEMPLATES })
  assert.deepEqual(addedMcp.ok && addedMcp.added, ['main', 'mcp'])
  assert.equal(readManifest(blankDir).tier, 'worker')
  activateWorker(blankDir)

  // A worker that is not where the template puts it is still the one wired.
  const moved = join(work, 'moved')
  assert.ok((await scaffoldModuleProject({ ...base, id: 'moved', dir: moved, parts: ['main'] })).ok)
  const movedManifest = JSON.parse(readFileSync(join(moved, 'extension/extension.json'), 'utf8'))
  movedManifest.main = 'src/worker.ts'
  writeFileSync(join(moved, 'extension/extension.json'), JSON.stringify(movedManifest, null, 2))
  writeFileSync(join(moved, 'extension/src/worker.ts'), readFileSync(join(moved, 'extension/src/main.ts'), 'utf8'))
  const addedToMoved = await addModuleParts({ dir: moved, parts: ['mcp'], templatesRoot: TEMPLATES })
  assert.ok(addedToMoved.ok && addedToMoved.files.includes('extension/src/worker.ts'))
  assert.match(readFileSync(join(moved, 'extension/src/worker.ts'), 'utf8'), /registerTools\(studio\)/)
})

test('a local SDK tarball stands in for the npm release', async () => {
  const tarball = join(work, 'sprintengine-extension-sdk-9.9.9.tgz')
  writeFileSync(tarball, 'not really a tarball')
  const local = await scaffoldModuleProject({
    ...base,
    id: 'local-sdk',
    dir: join(work, 'local'),
    sdkTarballPath: tarball,
  })
  assert.ok(local.ok)
  assert.ok(existsSync(join(work, 'local/vendor/sprintengine-extension-sdk-9.9.9.tgz')))
  const localPkg = JSON.parse(readFileSync(join(work, 'local/package.json'), 'utf8'))
  assert.equal(
    localPkg.devDependencies['@sprintengine/extension-sdk'],
    'file:vendor/sprintengine-extension-sdk-9.9.9.tgz',
  )
})
