#!/usr/bin/env node
// Acceptance check for @sprintengine/extension-sdk:
// 1. The package builds standalone and `npm pack` produces a tarball.
// 2. The packed d.ts public surface contains no `any`.
// 3. Every entry point in the `exports` map resolves from the tarball, every
//    name it exports can be imported through the package, and no exported
//    declaration leans on a type the package does not export. The subpaths
//    the SDK no longer has stay gone, and `./extension.schema.json` ships.
// 4. The committed external fixture, an extension.json project, compiles
//    against the tarball types only.
// 5. The fixture builds the way the templates build an extension: each
//    surface a self-contained ESM bundle, the worker CommonJS. Run against
//    the tarball's own validator and fakes in plain Node, its manifest
//    validates, its worker serves what the manifest declares, and its probe
//    panel mounts and says it is ready.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { buildSync } from 'esbuild'

const repoRoot = process.cwd()
const sdkDir = join(repoRoot, 'packages', 'extension-sdk')
const fixtureDir = join(sdkDir, 'test-fixtures', 'external-project')

const run = (command, cwd) => {
  console.log(`$ ${command}`)
  execSync(command, { cwd, stdio: 'inherit' })
}

// `build` clears dist first, so a source file that was deleted or moved can
// never ship as a stale declaration.
run('npm run build', sdkDir)

const packOutput = execSync('npm pack --pack-destination test-fixtures', { cwd: sdkDir }).toString('utf8').trim()
const tarball = packOutput.split('\n').at(-1)
if (!tarball?.endsWith('.tgz')) {
  throw new Error(`npm pack did not report a tarball (got "${tarball}").`)
}
console.log(`packed ${tarball}`)

const publicTypes = readFileSync(join(sdkDir, 'dist', 'index.d.ts'), 'utf8')
const anyUses = publicTypes.match(/\bany\b/g) ?? []
if (anyUses.length > 0) {
  throw new Error(`SDK public surface contains ${anyUses.length} use(s) of \`any\`.`)
}
for (const forbiddenExport of ['AutomationsProviderRegistryToken', 'AutomationsProviderRegistry']) {
  if (publicTypes.includes(forbiddenExport)) {
    throw new Error(`SDK public surface exposes forbidden raw Automations registry contract: ${forbiddenExport}.`)
  }
}
console.log('public surface contains no `any`')

run(`npm install --no-save --no-package-lock --no-audit --no-fund ../${tarball}`, fixtureDir)

// Every entry point must be reachable the way an extension author reaches it:
// through the INSTALLED package's `exports` map, with declarations and code
// behind it. The JSON Schema is the one entry with neither: a plain file.
const installedDir = join(fixtureDir, 'node_modules', '@sprintengine', 'extension-sdk')
const installedManifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
const SCHEMA_SUBPATH = './extension.schema.json'
for (const subpath of ['.', './signing', './scaffold', './guide', './testing', SCHEMA_SUBPATH]) {
  if (!installedManifest.exports?.[subpath]) {
    throw new Error(`packed @sprintengine/extension-sdk does not export "${subpath}".`)
  }
}
// An extension bundles its own UI: the host-bridged kit and its testing
// stand-ins are gone, and must not come back by accident.
for (const subpath of ['./ui', './surface', './testing/kit', './testing/register']) {
  if (installedManifest.exports?.[subpath]) {
    throw new Error(`packed @sprintengine/extension-sdk still exports "${subpath}", which the SDK no longer has.`)
  }
}
const entryPoints = Object.entries(installedManifest.exports ?? {}).filter(([subpath]) => subpath !== SCHEMA_SUBPATH)
for (const [subpath, entry] of entryPoints) {
  if (!entry?.types || !entry?.default) {
    throw new Error(`packed @sprintengine/extension-sdk exports "${subpath}" without both types and default.`)
  }
  for (const relative of [entry.types, entry.default]) {
    if (!existsSync(join(installedDir, relative))) {
      throw new Error(
        `packed @sprintengine/extension-sdk exports "${subpath}" → ${relative}, which the tarball does not ship.`,
      )
    }
  }
}
console.log(`every entry point resolves from the tarball: ${entryPoints.map(([subpath]) => subpath).join(', ')}`)

// The schema an editor checks extension.json against, resolved through the
// exports map from the fixture as a tool would reach it.
const fixtureRequire = createRequire(join(fixtureDir, 'package.json'))
const schemaPath = fixtureRequire.resolve('@sprintengine/extension-sdk/extension.schema.json')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
if (typeof schema.$schema !== 'string' || schema.type !== 'object' || typeof schema.properties !== 'object') {
  throw new Error(`${SCHEMA_SUBPATH} in the tarball is not the extension.json JSON Schema.`)
}
console.log(`${SCHEMA_SUBPATH} ships and resolves through the exports map`)

// A declaration the emitted .d.ts keeps without `export` is one an exported
// declaration refers to (tsc drops the rest), so it is a type a module author
// meets in a signature and cannot name. The published surface has none.
const installedDist = join(installedDir, 'dist')
const unexported = []
for (const file of readdirSync(installedDist).filter((name) => name.endsWith('.d.ts'))) {
  const source = readFileSync(join(installedDist, file), 'utf8')
  for (const match of source.matchAll(
    /^(?:declare )?(?:abstract class|class|const|enum|function|interface|let|namespace|type|var) ([A-Za-z_$][\w$]*)/gm,
  )) {
    unexported.push(`${file}: ${match[1]}`)
  }
}
if (unexported.length > 0) {
  throw new Error(`the published surface refers to types it does not export:\n  ${unexported.join('\n  ')}`)
}
console.log('every type the published surface refers to is exported')

// The names each entry point declares, read off its emitted declarations,
// following the `export { … } from './x.js'` re-exports the root index uses.
const declaredNames = (file) => {
  const source = readFileSync(file, 'utf8')
  if (/^export \* from/m.test(source)) {
    throw new Error(`${file} uses \`export *\`; list the names so this check can see them.`)
  }
  const names = [
    ...source.matchAll(
      /^export (?:declare )?(?:abstract class|class|const|enum|function|interface|let|namespace|type|var) ([A-Za-z_$][\w$]*)/gm,
    ),
  ].map((match) => match[1])
  for (const match of source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
    for (const specifier of match[1].split(',')) {
      const name = specifier
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .at(-1)
      if (name) names.push(name)
    }
  }
  return [...new Set(names)].sort()
}

// Import every one of those names through the package specifier a module
// author writes, and compile it with the fixture below: a name that the
// declarations list but the `exports` map does not reach fails here.
const probePath = join(fixtureDir, 'src', 'export-probe.ts')
let probedNames = 0
const probeImports = entryPoints.map(([subpath, entry], index) => {
  const specifier = subpath === '.' ? '@sprintengine/extension-sdk' : `@sprintengine/extension-sdk/${subpath.slice(2)}`
  const names = declaredNames(join(installedDir, entry.types))
  if (subpath === '.' && names.length === 0) throw new Error('the root entry point declares no exports.')
  probedNames += names.length
  // Aliased per entry point: two entry points may export the same name, and
  // one file cannot import a name twice.
  const aliased = names.map((name) => `${name} as entry${index}_${name}`)
  return names.length > 0 ? `import type { ${aliased.join(', ')} } from '${specifier}'` : ''
})
writeFileSync(
  probePath,
  `// Generated by scripts/verify-extension-sdk-pack.mjs; removed after the check.\n${probeImports.filter(Boolean).join('\n')}\n`,
)

// Typechecks the fixture's extension (worker, surfaces, its own test against
// the fakes) and the export probe written above.
try {
  run('npx tsc -p tsconfig.json', fixtureDir)
} finally {
  rmSync(probePath, { force: true })
}
console.log(`every exported name (${probedNames}) imports through its entry point`)

// Build the fixture as the templates build an extension: each surface a
// self-contained ESM bundle (Studio imports its text as a blob module, which
// can resolve no import), the worker CommonJS for Node's require.
const buildDir = join(fixtureDir, 'node_modules', '.fixture-build')
rmSync(buildDir, { recursive: true, force: true })
mkdirSync(buildDir, { recursive: true })
const fixtureManifest = JSON.parse(readFileSync(join(fixtureDir, 'extension', 'extension.json'), 'utf8'))
const surfaces = ['panels', 'doors', 'settingsSections'].flatMap((point) =>
  (fixtureManifest.contributes?.[point] ?? []).map((surface) => ({ point, ...surface })),
)
for (const surface of surfaces) {
  const name = surface.entry.replace(/^dist\//, '').replace(/\.m?js$/, '')
  const outfile = join(buildDir, `${name}.mjs`)
  buildSync({
    absWorkingDir: fixtureDir,
    entryPoints: [join('src', `${name}.ts`)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome130',
    outfile,
    logLevel: 'warning',
  })
  const source = readFileSync(outfile, 'utf8')
  if (/^\s*import\b|\bfrom\s*["'][^"']+["']/m.test(source)) {
    throw new Error(`${surface.entry} imports something at runtime; a surface bundle must hold everything it uses.`)
  }
  surface.built = outfile
}
const workerPath = join(buildDir, 'main.cjs')
buildSync({
  absWorkingDir: fixtureDir,
  entryPoints: [join('src', 'main.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  outfile: workerPath,
  logLevel: 'warning',
})
console.log(`the fixture builds: ${surfaces.map((surface) => surface.entry).join(', ')} and ${fixtureManifest.main}`)

// The built fixture against the tarball's own validator and fakes, in plain
// Node, the way a scaffolded project's smoke test runs. The probe panel is
// mounted, as its frame would mount it, into a small stand-in document: it is plain DOM, and it must draw
// its 200 rows and say it is ready.
const runtimeProbe = join(fixtureDir, 'runtime-probe.mjs')
writeFileSync(
  runtimeProbe,
  `${[
    "import assert from 'node:assert/strict'",
    "import { readFileSync } from 'node:fs'",
    "import { createRequire } from 'node:module'",
    "import { pathToFileURL } from 'node:url'",
    "import { validateExtensionManifest } from '@sprintengine/extension-sdk'",
    "import { createFakeFrameStudio, createFakeMainHost } from '@sprintengine/extension-sdk/testing'",
    `const surfaces = ${JSON.stringify(surfaces)}`,
    "const result = validateExtensionManifest(JSON.parse(readFileSync('extension/extension.json', 'utf8')), { authoring: true })",
    'assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues))',
    'const { manifest } = result',
    `const worker = createRequire(import.meta.url)(${JSON.stringify(workerPath)})`,
    'const activate = worker.activate ?? worker.default',
    "assert.equal(typeof activate, 'function', 'the worker exports activate')",
    'const main = createFakeMainHost({ manifest })',
    'await activate(main.host)',
    'const declared = main.methods.declared()',
    'for (const command of manifest.contributes.commands.filter((command) => !command.action)) {',
    "  assert.ok(declared.some((method) => method.name === command.id && method.access === 'operate'), command.id)",
    '}',
    'const tools = main.tools.list().map((tool) => tool.name)',
    'for (const tool of manifest.contributes.mcpTools) assert.ok(tools.includes(tool.name), tool.name)',
    'assert.deepEqual(main.undeclared, [])',
    'const element = (tag) => ({',
    '  tag, children: [], style: {}, textContent: "", attributes: {},',
    '  setAttribute(name, value) { this.attributes[name] = value },',
    '  append(...nodes) { this.children.push(...nodes) },',
    '  replaceChildren(...nodes) { this.children = nodes },',
    '  remove() {},',
    '})',
    "const root = { ...element('div'), ownerDocument: { createElement: element } }",
    'const frame = createFakeFrameStudio({ manifest, main })',
    'for (const surface of surfaces) {',
    '  const entry = await import(pathToFileURL(surface.built).href)',
    "  assert.equal(typeof entry.mount, 'function', surface.entry)",
    "  if (surface.id !== 'probe') continue",
    "  const close = await frame.mount(entry, { point: surface.point, id: surface.id, workspaceId: 'ws-app' }, root)",
    "  assert.equal(root.children.at(-1).children.length, 200, 'the probe draws 200 rows')",
    "  assert.deepEqual(frame.readied.map((ready) => ready.id), ['probe'])",
    '  close()',
    '}',
    'assert.deepEqual(frame.undeclared, [])',
  ].join('\n')}\n`,
)
try {
  run('node runtime-probe.mjs', fixtureDir)
} finally {
  rmSync(runtimeProbe, { force: true })
  rmSync(buildDir, { recursive: true, force: true })
}
console.log(
  "the built fixture runs on the tarball's fakes: the worker serves what it declares, the probe draws and is ready",
)

console.log('extension-sdk pack verification passed')
