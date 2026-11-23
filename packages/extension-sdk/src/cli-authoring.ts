// `validate`, `inspect`, `test` and `check`: what an author (or their agent)
// runs on an extension folder on this machine, without Studio running. Each
// answers in words, or with `--json` one object (cli-output.ts).

import { spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'es-module-lexer/js'

import { providerOrigin } from './agent-contributions.js'
import { CliError } from './cli-output.js'
import { parseLanguageConfiguration, parseTextMateGrammar } from './content-syntaxes.js'
import {
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_SURFACE_POINTS,
  LOCAL_EXTENSION_PUBLISHER,
  extensionInstallKey,
  isReservedExtensionId,
  parseExtensionManifest,
  type ExtensionManifest,
} from './extension-manifest.js'
import { surfaceHostCallIssues, workerHostCallIssues } from './host-calls.js'
import { computeModuleFileDigestsSync, isDevelopmentSkippedPath } from './module-files.js'
import { extensionContentFingerprint } from './signing.js'
import { buildSurfaceModules, formatSourceProblem } from './source-modules.js'
import { skillFolderIssues } from './skill-folders.js'

type Issue = { path: string; message: string }

const WORKER_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts']
// The CLI's own folder (dist/, beside check-worker.js and test-register.js),
// through the link npm puts in node_modules/.bin.
const HERE = (() => {
  try {
    return dirname(realpathSync(process.argv[1] ?? ''))
  } catch {
    return process.cwd()
  }
})()

/** Every file extension.json names, with where it names it. */
export function declaredExtensionFiles(manifest: ExtensionManifest): Array<{ path: string; file: string }> {
  const files: Array<{ path: string; file: string }> = []
  if (manifest.main) files.push({ path: 'main', file: manifest.main })
  for (const point of EXTENSION_SURFACE_POINTS)
    manifest.contributes[point].forEach((surface, index) =>
      files.push({ path: `contributes.${point}[${index}].entry`, file: surface.entry }),
    )
  manifest.contributes.syntaxes.forEach((syntax, index) => {
    files.push({ path: `contributes.syntaxes[${index}].path`, file: syntax.path })
    if (syntax.configuration)
      files.push({ path: `contributes.syntaxes[${index}].configuration`, file: syntax.configuration })
  })
  if (manifest.icon) files.push({ path: 'icon', file: manifest.icon })
  if (manifest.cover) files.push({ path: 'cover', file: manifest.cover })
  manifest.screenshots?.forEach((file, index) => files.push({ path: `screenshots[${index}]`, file }))
  return files
}

/** A file of the folder as Studio reads a development folder's, or null. */
function reader(root: string): (path: string) => string | null {
  return (path) => {
    if (isDevelopmentSkippedPath(path)) return null
    const absolute = resolve(root, path)
    const inside = relative(root, absolute)
    if (!inside || inside.startsWith('..')) return null
    try {
      return lstatSync(absolute).isFile() ? readFileSync(absolute, 'utf8') : null
    } catch {
      return null
    }
  }
}

export type SurfaceCheck = {
  point: string
  id: string
  entry: string
  ok: boolean
  modules?: number
  problem?: string
}

/** Each surface's module graph as Studio builds it, and whether its entry exports `mount`. */
export function checkSurfaces(root: string, manifest: ExtensionManifest): SurfaceCheck[] {
  const read = reader(root)
  const checks: SurfaceCheck[] = []
  for (const point of EXTENSION_SURFACE_POINTS) {
    for (const surface of manifest.contributes[point]) {
      const graph = buildSurfaceModules(surface.entry, read)
      const base = { point, id: surface.id, entry: surface.entry }
      if (!graph.ok) {
        checks.push({ ...base, ok: false, problem: formatSourceProblem(graph.problem) })
        continue
      }
      const entry = graph.modules.at(-1)!
      let exportsMount = false
      try {
        exportsMount = parse(entry.code)[1].some((each) => (each as { name?: string }).name === 'mount')
      } catch {
        exportsMount = false
      }
      // The host calls its files write out, against what Studio offers this extension.
      const hostCalls = graph.modules.flatMap((module) =>
        surfaceHostCallIssues(module.path, read(module.path) ?? '', point, manifest),
      )
      const problems = [
        ...(exportsMount ? [] : [`${surface.entry} must export mount(root, studio).`]),
        ...hostCalls.map((issue) => formatSourceProblem(issue)),
      ]
      checks.push(
        problems.length === 0
          ? { ...base, ok: true, modules: graph.modules.length }
          : { ...base, ok: false, modules: graph.modules.length, problem: problems.join('; ') },
      )
    }
  }
  return checks
}

export type ValidatedExtension = {
  root: string
  manifest: ExtensionManifest
  key: string
  files: Record<string, string>
  warnings: string[]
  surfaces: SurfaceCheck[]
}

/**
 * The folder checked as Studio will load it, strictly: extension.json (every
 * field, the tier, `engines.studio` covering what it uses), every file it
 * names, the content it serves, its skill folders, the worker's file type,
 * each surface's imports, and the host calls its code writes out. `dir` is
 * the folder, or its manifest file. Throws `extension_invalid` with every issue.
 */
export function validateExtensionFolder(dir: string): ValidatedExtension {
  const named = resolve(dir)
  const isFile = (() => {
    try {
      return statSync(named).isFile()
    } catch {
      return false
    }
  })()
  const root = isFile ? dirname(named) : named
  const manifestPath = isFile ? named : join(root, EXTENSION_MANIFEST_FILENAME)
  if (!existsSync(manifestPath))
    throw new CliError('extension_invalid', `No ${EXTENSION_MANIFEST_FILENAME} in ${root}.`, {
      issues: [{ path: '', message: `${EXTENSION_MANIFEST_FILENAME} not found` }],
    })
  const parsed = parseExtensionManifest(readFileSync(manifestPath, 'utf8'), { authoring: true })
  if (!parsed.ok)
    throw new CliError('extension_invalid', `${manifestPath} is not a valid extension.json.`, {
      issues: parsed.issues,
    })
  const manifest = parsed.manifest
  const issues: Issue[] = []
  const warnings: string[] = []
  if (isReservedExtensionId(manifest.id))
    issues.push({ path: 'id', message: `"${manifest.id}" is kept for Studio's own extensions; choose another id.` })
  const scan = computeModuleFileDigestsSync(root, { walk: 'development' })
  if (!scan.ok) issues.push(...scan.issues)
  for (const { path, file } of declaredExtensionFiles(manifest)) {
    if (scan.files[file] === undefined) issues.push({ path, message: `names "${file}", which is not in the folder.` })
  }
  if (manifest.main && !WORKER_EXTENSIONS.some((extension) => manifest.main!.toLowerCase().endsWith(extension)))
    issues.push({ path: 'main', message: `a worker's main is ${WORKER_EXTENSIONS.join(', ')}.` })
  const workerSource = manifest.main ? reader(root)(manifest.main) : null
  if (manifest.main && workerSource !== null)
    for (const issue of workerHostCallIssues(manifest.main, workerSource, manifest))
      issues.push({ path: 'main', message: formatSourceProblem(issue) })
  // The skill folders it hands agents, checked as Studio checks them when it loads it.
  issues.push(...skillFolderIssues(manifest, root))
  manifest.contributes.syntaxes.forEach((syntax, index) => {
    const read = reader(root)
    const grammar = read(syntax.path)
    if (grammar !== null) {
      const checked = parseTextMateGrammar(grammar, syntax.scopeName)
      if (!checked.ok)
        for (const issue of checked.issues)
          issues.push({ path: `contributes.syntaxes[${index}].path`, message: `${syntax.path}: ${issue.message}` })
    }
    const configuration = syntax.configuration ? read(syntax.configuration) : null
    if (configuration !== null) {
      const checked = parseLanguageConfiguration(configuration)
      if (!checked.ok)
        for (const issue of checked.issues)
          issues.push({
            path: `contributes.syntaxes[${index}].configuration`,
            message: `${syntax.configuration}: ${issue.message}`,
          })
    }
  })
  const surfaces = checkSurfaces(root, manifest)
  for (const surface of surfaces)
    if (!surface.ok)
      issues.push({
        path: `contributes.${surface.point}`,
        message: `${surface.id}: ${surface.problem ?? 'cannot load.'}`,
      })
  if (existsSync(join(root, 'extension.sig')))
    warnings.push('extension.sig is not read in a development folder; sign the folder you pack.')
  if (issues.length > 0)
    throw new CliError(
      'extension_invalid',
      `${root} is not an extension Studio can load (${issues.length} issue${issues.length === 1 ? '' : 's'}).`,
      {
        issues,
      },
    )
  return {
    root,
    manifest,
    key: extensionInstallKey(LOCAL_EXTENSION_PUBLISHER, manifest.id),
    files: scan.files,
    warnings,
    surfaces,
  }
}

/** Whether Studio asks the person before it runs it (the app's `extensionNeedsApproval`). */
function needsApproval(manifest: ExtensionManifest): boolean {
  if (manifest.tier === 'content') return false
  if (manifest.tier !== 'declarative') return true
  const { commands, menus, topBarItems, mcpServers, providers } = manifest.contributes
  return (
    commands.length + menus.length + topBarItems.length + providers.length > 0 ||
    mcpServers.some((server) => server.transport === 'stdio')
  )
}

/** What a folder contributes and the access it asks for: what the person is asked to approve. */
export function inspectExtension(validated: ValidatedExtension): Record<string, unknown> {
  const { manifest } = validated
  const contributes: Record<string, string[]> = {}
  for (const [point, list] of Object.entries(manifest.contributes)) {
    if (!Array.isArray(list) || list.length === 0) continue
    contributes[point] = list.map((item) => {
      const entry = item as { id?: string; name?: string; point?: string; key?: string }
      return entry.id ?? entry.name ?? entry.point ?? entry.key ?? '?'
    })
  }
  return {
    key: validated.key,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    tier: manifest.tier,
    needsApproval: needsApproval(manifest),
    access: {
      permissions: [...manifest.permissions].sort(),
      worker: manifest.main ?? null,
      background: manifest.background === true,
      mcpTools: manifest.contributes.mcpTools.map((tool) => ({ name: tool.name, access: tool.access })),
      hooks: manifest.contributes.hooks.map((hook) => hook.point),
      commandsRunningActions: manifest.contributes.commands
        .filter((command) => command.action !== undefined)
        .map((command) => ({ id: command.id, action: command.action })),
      localMcpServers: manifest.contributes.mcpServers
        .filter((server) => server.transport === 'stdio')
        .map((server) => ({ id: server.id, command: server.command, args: server.args ?? [] })),
      providers: manifest.contributes.providers.map((provider) => ({
        id: provider.id,
        keySentTo: providerOrigin(provider.baseUrl),
      })),
    },
    contributes,
    files: Object.keys(validated.files).length,
    contentHash: extensionContentFingerprint(validated.files),
  }
}

// ── test ─────────────────────────────────────────────────────────────────────

const TEST_FILE = /\.test\.(?:ts|tsx|mts|js|jsx|mjs)$/u

function findTests(root: string): string[] {
  const found: string[] = []
  const visit = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (name === 'node_modules' || name.startsWith('.') || name === 'dist') continue
      const path = join(dir, name)
      let info
      try {
        info = lstatSync(path)
      } catch {
        continue
      }
      if (info.isDirectory()) visit(path)
      else if (info.isFile() && TEST_FILE.test(name)) found.push(path)
    }
  }
  visit(root)
  return found
}

/** The project's own Vitest, when it has one installed: its CLI entry. */
function projectVitest(root: string): string | null {
  try {
    const manifest = createRequire(join(root, 'package.json')).resolve('vitest/package.json')
    const entry = join(dirname(manifest), 'vitest.mjs')
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

/**
 * The Vitest config `test` writes for a project with Vitest: its sources
 * transpiled as Studio transpiles them (types and classic `h()` JSX removed,
 * every line kept), and the test files `test` found.
 */
function vitestConfig(): string {
  const sourceModules = JSON.stringify(pathToFileURL(join(HERE, 'source-modules.js')).href)
  return `// Written by \`sprintengine-extension test\`. Do not edit.
import { transpileExtensionSource } from ${sourceModules}

const SOURCE = /\\.(?:ts|tsx|mts|jsx)$/
export default {
  // Studio's transpiler alone: neither of Vite's (esbuild before Vite 8, Oxc since).
  esbuild: false,
  oxc: false,
  plugins: [
    {
      name: 'sprintengine-extension-sources',
      enforce: 'pre',
      transform(code, id) {
        const file = id.split('?')[0]
        if (!SOURCE.test(file) || file.includes('/node_modules/')) return null
        return { code: transpileExtensionSource(file, code), map: null }
      },
    },
  ],
  test: {
    include: ['**/*.test.{ts,tsx,mts,js,jsx,mjs}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.*/**'],
  },
}
`
}

/**
 * Run the project's tests: every `*.test.ts` (`.tsx`, `.mts`, `.js`, `.jsx`,
 * `.mjs`) under `dir`, leaving out node_modules, dist and dotted folders.
 * With the project's own Vitest when it has one installed, else with `node
 * --test`; either way TypeScript and JSX load as Studio loads them. They run
 * on this machine, outside Studio: only on code you trust.
 */
export async function runExtensionTests(
  dir: string,
  json: boolean,
): Promise<{ runner: 'vitest' | 'node:test'; code: number; files: string[] }> {
  const root = resolve(dir)
  const files = findTests(root)
  if (files.length === 0)
    throw new CliError('not_found', `No test files (*.test.ts, .tsx, .mts, .js, .jsx, .mjs) under ${root}.`)
  const vitest = projectVitest(root)
  let args: string[]
  if (vitest) {
    // `.sprintengine/` is the CLI's own folder in a project, as its shots are.
    const configDir = join(root, '.sprintengine', 'test')
    mkdirSync(configDir, { recursive: true })
    const config = join(configDir, 'vitest.config.mjs')
    writeFileSync(config, vitestConfig())
    // Relative to the root, as Vitest matches them against the files it finds there.
    args = [vitest, 'run', '--config', config, '--root', root, ...files.map((file) => relative(root, file))]
  } else {
    args = ['--import', pathToFileURL(join(HERE, 'test-register.js')).href, '--test', ...files]
  }
  const code = await new Promise<number>((settle) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, SPRINTENGINE_EXTENSION_TEST_ROOT: root },
      // With --json the answer alone is on stdout; what the runner prints goes to stderr.
      stdio: json ? ['ignore', process.stderr, 'inherit'] : 'inherit',
    })
    child.on('close', (exit) => settle(exit ?? 1))
    child.on('error', () => settle(1))
  })
  return {
    runner: vitest ? 'vitest' : 'node:test',
    code,
    files: files.map((file) => relative(root, file).split(sep).join('/')),
  }
}

// ── check ────────────────────────────────────────────────────────────────────

export type WorkerCheck =
  | { ok: true; methods: unknown[]; tools: string[]; hooks: string[]; logs: string[] }
  | { ok: false; error: string; logs: string[] }

/** Activate the worker against the SDK's fake host in a child process, and say what it registered or where it failed. */
export function checkWorker(validated: ValidatedExtension): Promise<WorkerCheck | null> {
  const main = validated.manifest.main
  if (!main) return Promise.resolve(null)
  return new Promise((settle) => {
    const child = spawn(
      process.execPath,
      [join(HERE, 'check-worker.js'), validated.root, main, join(validated.root, EXTENSION_MANIFEST_FILENAME)],
      { cwd: validated.root, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
    const timer = setTimeout(() => child.kill(), 15_000)
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.trim().split('\n').at(-1) ?? ''
      try {
        settle(JSON.parse(line) as WorkerCheck)
      } catch {
        settle({
          ok: false,
          error: (err.trim() || 'The worker did not finish activating within 15 seconds.')
            .split('\n')
            .slice(0, 6)
            .join('\n'),
          logs: [],
        })
      }
    })
  })
}
