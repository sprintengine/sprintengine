// Every bundled template scaffolds into a project Studio would accept, and
// that project's own dev loop runs end to end.
//
// For each template: scaffold into a temporary folder; validate
// extension/extension.json with this package's validator, as an author's tools
// hold it; type-check the project against this package's SOURCE (a paths
// mapping, so the test never depends on dist/ being current); then run the
// project's real scripts — `npm run build`, `npm test` (the smoke test loads
// the built extension as Studio does), `npm run validate`, and
// `scripts/dev-install.mjs` into a throwaway extensions root — and check the
// installed copy is extension/ exactly, under `local.<id>`.
//
// The projects resolve packages through one shared node_modules: the
// repository's own react, @types and esbuild, symlinked, plus this SDK
// transpiled from source into @sprintengine/extension-sdk.
//
// Also: the scaffolder's refusals, the placeholder and tarball handling, the
// copies that must not drift — the build scripts the parts share with the
// templates — projects composed from parts (`parts`, `addModuleParts`) running
// the same loop, a signed install, and what the smoke test catches.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'

import {
  EXTENSION_MANIFEST_SINCE,
  isExtensionPermission,
  requiredExtensionTier,
  validateExtensionManifest,
} from '../src/index.js'
import {
  addModuleParts,
  listModuleParts,
  listModuleTemplates,
  sanitizeDisplayText,
  scaffoldModuleProject,
} from '../src/scaffold.js'

const REPO = process.cwd()
const SDK = join(REPO, 'packages/extension-sdk')
const TEMPLATES = join(SDK, 'templates')
const SDK_VERSION = '4.0.0-beta.1'

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
  mkdirSync(join(nodeModules, '.bin'), { recursive: true })
  for (const name of ['react', 'react-dom', 'scheduler', 'esbuild', '@types']) {
    symlinkSync(join(REPO, 'node_modules', name), join(nodeModules, name))
  }
  symlinkSync(join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'), join(nodeModules, '.bin', 'esbuild'))

  // The SDK as a project installs it, transpiled from source: one file per
  // source file, so `./signing`, `./testing` and the CLI exist as they do in dist/.
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
  run(join(REPO, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.scaffold-test.json'], dir, env)
  rmSync(join(dir, 'tsconfig.scaffold-test.json'))
}

function readManifest(dir: string) {
  const raw: unknown = JSON.parse(readFileSync(join(dir, 'extension/extension.json'), 'utf8'))
  const result = validateExtensionManifest(raw, { authoring: true })
  assert.ok(result.ok, `${dir}: ${JSON.stringify(result.ok ? [] : result.issues)}`)
  return result.manifest
}

// One test per template, and one each for the composed projects and the
// tarball, rather than one test for the lot: each template's dev loop is a
// handful of real `tsc`, `npm` and `node` processes (a few seconds alone), and
// summed over every template under one test's timeout they ran past it on a
// loaded machine. Split, each test's budget covers one project's loop.
const templates = listModuleTemplates(TEMPLATES)
const base = { templateId: 'blank', displayName: 'X', sdkVersion: SDK_VERSION, templatesRoot: TEMPLATES }
let work = ''
let env: NodeJS.ProcessEnv = {}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'sprintengine-scaffold-'))
  const nodeModules = sharedNodeModules(work)
  const { SPRINTENGINE_SIGNING_KEY: _ownKey, ...inherited } = process.env
  env = {
    ...inherited,
    PATH: `${join(nodeModules, '.bin')}:${process.env.PATH ?? ''}`,
    // Keep the dev loop away from the real ~/.sprintengine: no key is found,
    // and the install lands in a throwaway extensions root.
    HOME: join(work, 'home'),
    SPRINTENGINE_USER_EXTENSION_ROOT: join(work, 'installed'),
    npm_config_update_notifier: 'false',
  }
})

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true })
})

test('the templates on offer, the copies that must not drift, and the refusals', async () => {
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
    'chat-companion',
    'top-bar-item',
    'settings-section',
    'backlog-action',
    'file-action',
    'mcp-tools',
  ])

  // ── Copies that must not drift ─────────────────────────────────────────────
  // A part builds what it adds exactly as the templates do.
  const scriptsOf = (path: string) =>
    (JSON.parse(readFileSync(join(TEMPLATES, path), 'utf8')) as { scripts: Record<string, string> }).scripts
  const companion = scriptsOf('chat-companion/package.json')
  assert.equal(scriptsOf('_parts/main/part.json')['build:main'], companion['build:main'])
  assert.equal(scriptsOf('_parts/door/part.json')['build:ui'], companion['build:ui'])
  assert.equal(scriptsOf('_parts/settings/part.json')['build:ui'], companion['build:ui'])
  assert.deepEqual(
    listModuleParts(TEMPLATES).map((part) => part.id),
    ['main', 'mcp', 'settings', 'door'],
  )

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
  test(`template "${template.id}" scaffolds a project Studio accepts, and its dev loop runs`, async () => {
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
      'test/smoke.test.mjs',
      'test/manifest.ts',
      'test/module.test.ts',
      'scripts/build-ui.mjs',
      'scripts/check-toolchain.mjs',
      'scripts/dev-install.mjs',
      'scripts/validate.mjs',
    ]) {
      assert.ok(files.includes(required), `${template.id}: ${required} is missing`)
    }
    for (const gone of ['plugin.json', 'module/manifest.json']) {
      assert.ok(!files.includes(gone), `${template.id}: ${gone} is a layout extensions no longer have`)
    }
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8')
      assert.ok(!/\{\{\w+\}\}/.test(text), `${template.id}: ${file} still has a placeholder`)
    }
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md')
    if (idea) assert.equal(readFileSync(join(dir, 'IDEA.md'), 'utf8'), `${idea}\n`)
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    for (const pattern of ['node_modules/', 'packed/', '*.key', '*.pem', '.DS_Store']) {
      assert.ok(gitignore.includes(pattern), `${template.id}: .gitignore does not ignore ${pattern}`)
    }
    // extension/ is what ships, build included: nothing may ignore its dist.
    for (const line of gitignore.split('\n').map((entry) => entry.trim())) {
      if (!line || line.startsWith('#')) continue
      assert.ok(!/(^|\/)dist\/?$/.test(line), `${template.id}: .gitignore ignores the build (${line})`)
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
    for (const script of ['typecheck', 'build', 'test', 'validate', 'check', 'dev:install', 'keygen']) {
      assert.ok(pkg.scripts[script], `${template.id}: package.json has no "${script}" script`)
    }

    typecheckAgainstSource(dir, env)

    // The project's own dev loop. The build never rewrites extension.json.
    const manifestPath = join(dir, 'extension/extension.json')
    const declared = readFileSync(manifestPath, 'utf8')
    run('npm', ['run', 'build', '--silent'], dir, env)
    assert.equal(readFileSync(manifestPath, 'utf8'), declared, `${template.id}: the build rewrote extension.json`)
    for (const point of ['panels', 'doors', 'settingsSections'] as const) {
      for (const surface of manifest.contributes[point]) {
        assert.ok(existsSync(join(dir, 'extension', surface.entry)), `${template.id}: ${surface.entry} was not built`)
      }
    }
    if (manifest.main) assert.ok(existsSync(join(dir, 'extension', manifest.main)), `${template.id}: no worker`)
    run('npm', ['test', '--silent'], dir, env)
    run('npm', ['run', 'validate', '--silent'], dir, env)
    const installed = run(process.execPath, ['scripts/dev-install.mjs'], dir, env)
    assert.match(installed, new RegExp(`Installed ${id} 0\\.1\\.0 \\(unsigned`), installed)

    const installedDir = join(work, 'installed', `local.${id}`)
    assert.deepEqual(
      walk(installedDir).sort(),
      walk(join(dir, 'extension')).sort(),
      `${template.id}: installed as built`,
    )
    assert.equal(readFileSync(join(installedDir, 'extension.json'), 'utf8'), declared)
    assert.equal(readFileSync(manifestPath, 'utf8'), declared, `${template.id}: dev:install rewrote extension.json`)
  })
}

// ── Projects composed from parts ───────────────────────────────────────────
test('projects composed from parts run the same loop, and a signed install verifies', async () => {
  // The door is added to the mcp-tools project its template test above built.
  assert.ok(existsSync(join(work, 'mcp-tools', 'extension', 'extension.json')), 'the mcp-tools template test ran first')
  // Every part on the smallest template, and a door added to a project with
  // no surface at all: each runs the whole loop, its parts' tests included.
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
  assert.equal(composedManifest.main, 'dist/main.cjs')
  assert.deepEqual(composedManifest.permissions, ['tools:contribute', 'settings:own'])
  assert.deepEqual(
    composedManifest.contributes.mcpTools.map((tool) => tool.name),
    ['demo_composed_about'],
  )
  assert.match(readFileSync(join(composed, 'src/main.ts'), 'utf8'), /^ {2}registerTools\(studio\)$/m)

  const toolsDir = join(work, 'mcp-tools')
  const addedDoor = await addModuleParts({ dir: toolsDir, parts: ['door'], templatesRoot: TEMPLATES })
  assert.ok(addedDoor.ok, addedDoor.ok ? '' : addedDoor.message)
  assert.deepEqual(addedDoor.ok && addedDoor.added, ['door'])
  const toolsPkg = JSON.parse(readFileSync(join(toolsDir, 'package.json'), 'utf8'))
  assert.equal(toolsPkg.scripts['build:ui'], 'node scripts/build-ui.mjs', 'the door brought its build')
  assert.ok(toolsPkg.devDependencies.react, 'and React')
  for (const dir of [composed, toolsDir]) {
    typecheckAgainstSource(dir, env)
    run('npm', ['run', 'build', '--silent'], dir, env)
    run('npm', ['test', '--silent'], dir, env)
    run('npm', ['run', 'validate', '--silent'], dir, env)
  }
  const composedTests = run('npm', ['test'], composed, env)
  for (const name of [
    'the door renders',
    'an agent can ask which extension this is',
    'the section shows what was saved',
    'a surface can ask when the worker started',
    'door "door": dist/door.js loads on its own and exports mount',
    'settings section "settings": dist/settings.js loads on its own and exports mount',
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

  // A signed install: dev:install signs the installed copy with the key it
  // finds, and the SDK's verify accepts it.
  const cli = join(work, 'node_modules/@sprintengine/extension-sdk/dist/cli.js')
  const key = join(work, 'signing.key')
  run(process.execPath, [cli, 'keygen', '--out', key], work, env)
  const signed = run(process.execPath, ['scripts/dev-install.mjs'], composed, {
    ...env,
    SPRINTENGINE_SIGNING_KEY: key,
  })
  assert.match(signed, /Installed demo-composed 0\.1\.0 \(signed/, signed)
  const installedComposed = join(work, 'installed', 'local.demo-composed')
  run(process.execPath, [cli, 'verify', installedComposed], work, env)
  assert.equal(existsSync(join(composed, 'extension', 'extension.sig')), false, 'the project itself is not signed')

  // ── What the smoke test catches ────────────────────────────────────────────
  const manifestPath = join(composed, 'extension', 'extension.json')
  const declared = readFileSync(manifestPath, 'utf8')
  const smoke = () => spawnSync('node', ['--test', 'test/smoke.test.mjs'], { cwd: composed, env, encoding: 'utf8' })

  // A worker that calls into Studio for what its manifest does not ask for.
  const unasked = JSON.parse(declared) as { permissions: string[]; contributes: Record<string, unknown> }
  unasked.permissions = unasked.permissions.filter((permission) => permission !== 'tools:contribute')
  unasked.contributes.mcpTools = []
  writeFileSync(manifestPath, JSON.stringify(unasked, null, 2))
  const refused = smoke()
  assert.notEqual(refused.status, 0)
  assert.match(refused.stdout, /was not approved for "tools:contribute"/)

  // A command without an action that the worker does not serve.
  const withCommand = JSON.parse(declared) as { contributes: Record<string, unknown> }
  withCommand.contributes.commands = [{ id: 'refresh', title: 'Refresh' }]
  writeFileSync(manifestPath, JSON.stringify(withCommand, null, 2))
  const unserved = smoke()
  assert.notEqual(unserved.status, 0)
  assert.match(unserved.stdout, /command "refresh" has no action/)

  // A surface that leaves an import in its bundle.
  writeFileSync(manifestPath, declared)
  writeFileSync(join(composed, 'extension/dist/door.js'), "import { x } from 'react'\nexport function mount() {}\n")
  const unbundled = smoke()
  assert.notEqual(unbundled.status, 0)
  assert.match(unbundled.stdout, /does not load on its own/)
  run('npm', ['run', 'build', '--silent'], composed, env)
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
