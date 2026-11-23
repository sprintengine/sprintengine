// How an extension's source loads without a build step: TypeScript and JSX
// are transpiled as Studio reads them, and a surface's relative imports are
// gathered into the one document its frame is drawn from.
//
// Reached through the `@sprintengine/extension-sdk/source` subpath. Studio
// builds frames with it, and `sprintengine-extension check` checks surfaces
// with it, so what an author checks and what Studio draws cannot disagree.
//
// - `.ts`, `.mts`, `.tsx` and `.jsx` load as written. Types and JSX are
//   removed with every line kept where it was, so an error's line in the
//   frame is the line in the file. Transpiling never type-checks: run `tsc`.
// - JSX is the classic form: `<b>x</b>` calls `h('b', null, 'x')`, and `<>`
//   is `Fragment`. Import both from a file of your own; there is no runtime.
// - A surface imports relative files only (`./list` finds `list.tsx`,
//   `list.ts`, … then `list/index.*`; `./list.js` finds `list.ts` too). A bare
//   name such as `react` is refused: nothing bundles it. Copy its ESM files
//   in, or bundle it yourself and import the bundle.
// - A worker's `main` is `.js`, `.cjs`, `.mjs`, `.ts` or `.mts`; Studio strips
//   its types with Node's own transpiler (no JSX), so the same rules hold.

import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { parse } from 'es-module-lexer/js'
import { transform } from 'sucrase'

/** Tried in order for an import with no extension, then as `<dir>/index.<ext>`. */
export const EXTENSION_MODULE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs'] as const

/** What Studio transpiles before it runs it. */
export const TRANSPILED_SOURCE_EXTENSIONS = ['.ts', '.mts', '.tsx', '.jsx'] as const

/** The largest source file Studio transpiles. */
export const MAX_TRANSPILED_SOURCE_BYTES = 1024 * 1024
/** The most modules one surface may load. */
export const MAX_SURFACE_MODULES = 500

// TypeScript's ESM style imports `./util.js` for `util.ts`.
const SOURCE_FOR_OUTPUT_EXTENSION: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
}

const TRANSFORMS: Record<string, Array<'typescript' | 'jsx'>> = {
  '.ts': ['typescript'],
  '.mts': ['typescript'],
  '.tsx': ['typescript', 'jsx'],
  '.jsx': ['jsx'],
}

/** Where a problem is in the author's own file: path relative to the extension, 1-based line and column. */
export type SourceLocation = { file: string; line?: number; column?: number }

export type SourceProblem = SourceLocation & { message: string }

/** `file:line:col message`, the way every Studio surface reports a problem in an extension's code. */
export function formatSourceProblem(problem: SourceProblem): string {
  const where = [problem.file, problem.line, problem.line !== undefined ? problem.column : undefined]
    .filter((part) => part !== undefined)
    .join(':')
  return `${where} ${problem.message}`
}

/** Whether Studio transpiles a file of this name before it runs it. */
export function isTranspiledSource(path: string): boolean {
  return (TRANSPILED_SOURCE_EXTENSIONS as readonly string[]).includes(posix.extname(path).toLowerCase())
}

/**
 * One file's source as it runs: types and JSX removed, every line where it
 * was. Throws a `SourceProblem` (with `file`, `line`, `column`) on a syntax error.
 */
export function transpileExtensionSource(path: string, source: string): string {
  const transforms = TRANSFORMS[posix.extname(path).toLowerCase()]
  if (!transforms) return source
  try {
    return transform(source, {
      transforms,
      jsxRuntime: 'classic',
      jsxPragma: 'h',
      jsxFragmentPragma: 'Fragment',
      production: true,
      // Chromium and Node run modern syntax as written; only types and JSX go.
      disableESTransforms: true,
      // An import used only as a type is dropped, as TypeScript drops it.
      keepUnusedImports: false,
      filePath: path,
    }).code
  } catch (error) {
    throw syntaxProblem(path, source, error)
  }
}

function syntaxProblem(path: string, source: string, error: unknown): SourceProblem {
  const message = error instanceof Error ? error.message : String(error)
  // Sucrase says `Unexpected token (3:7)`, or gives the offset in `pos`.
  const at = /\((\d+):(\d+)\)\s*$/u.exec(message)
  const text = message.replace(/\s*\(\d+:\d+\)\s*$/u, '').replace(/^Error transforming [^:]*: /u, '')
  if (at) return { file: path, line: Number(at[1]), column: Number(at[2]) + 1, message: text }
  const pos = (error as { pos?: unknown })?.pos
  if (typeof pos === 'number') {
    const before = source.slice(0, pos).split('\n')
    return { file: path, line: before.length, column: (before.at(-1)?.length ?? 0) + 1, message: text }
  }
  return { file: path, message: text }
}

/** The files a `/`-separated import target may name, most specific first. */
export function moduleCandidatePaths(target: string): string[] {
  const extension = posix.extname(target).toLowerCase()
  const stem = target.slice(0, target.length - extension.length)
  return [
    ...(extension ? [target] : []),
    ...(SOURCE_FOR_OUTPUT_EXTENSION[extension] ?? []).map((source) => stem + source),
    ...(extension ? [] : EXTENSION_MODULE_EXTENSIONS.map((each) => target + each)),
    ...EXTENSION_MODULE_EXTENSIONS.map((each) => posix.join(target, `index${each}`)),
  ]
}

/** Reads one of the extension's files, by its path relative to the extension; null when there is none. */
export type ExtensionFileReader = (relativePath: string) => string | null

export type SurfaceModule = {
  /** Its path in the extension. */
  path: string
  /** Its code as it runs, each import of another module replaced by that module's token. */
  code: string
}

export type SurfaceModuleGraph =
  | {
      ok: true
      /** Every module the entry loads, each after the modules it imports, the entry last. */
      modules: SurfaceModule[]
      /**
       * What stands in each module's code for the module at index `n` of
       * `modules`: `<token><n>`. The frame swaps it for that module's URL.
       */
      token: string
    }
  | { ok: false; problem: SourceProblem }

type Resolved = { ok: true; path: string } | { ok: false; reason: string }

function resolveImport(fromPath: string, specifier: string, read: ExtensionFileReader): Resolved {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return {
      ok: false,
      reason: `cannot import "${specifier}": an extension loads without a bundler, so only its own files can be imported by a relative path (./ or ../). Copy the package's ESM files in, or bundle it and import the bundle.`,
    }
  }
  const [pathPart = ''] = specifier.split(/[?#]/u, 1)
  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return { ok: false, reason: `cannot import "${specifier}": it is not a well-formed path.` }
  }
  const target = posix.normalize(posix.join(posix.dirname(fromPath), decoded)).replace(/\/$/u, '')
  if (target === '..' || target.startsWith('../') || posix.isAbsolute(target)) {
    return { ok: false, reason: `cannot import "${specifier}": it is outside the extension.` }
  }
  for (const candidate of moduleCandidatePaths(target)) {
    if (read(candidate) !== null) return { ok: true, path: candidate }
  }
  return {
    ok: false,
    reason: `cannot import "${specifier}": the extension has no such file (tried ${EXTENSION_MODULE_EXTENSIONS.join(', ')} and index files).`,
  }
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset).split('\n')
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
}

/**
 * The modules a surface's entry loads, each transpiled, its relative imports
 * resolved to the extension's own files, in an order that loads each after
 * what it imports. A bare import, a missing file, a file outside the
 * extension, an import cycle or a syntax error is a problem at its file and
 * line, and nothing loads.
 */
export function buildSurfaceModules(entry: string, read: ExtensionFileReader): SurfaceModuleGraph {
  type Node = { path: string; code: string; imports: Array<{ start: number; end: number; path: string }> }
  const nodes = new Map<string, Node>()
  const order: string[] = []
  const visiting = new Set<string>()

  const visit = (path: string, from?: SourceLocation): SourceProblem | null => {
    if (order.includes(path)) return null
    if (visiting.has(path))
      return { ...(from ?? { file: path }), message: `imports ${path}, which imports it back: cycles cannot load.` }
    if (nodes.size >= MAX_SURFACE_MODULES)
      return { file: path, message: `a surface loads at most ${MAX_SURFACE_MODULES} modules.` }
    const source = read(path)
    if (source === null) return { ...(from ?? { file: path }), message: `${path} could not be read.` }
    if (Buffer.byteLength(source, 'utf8') > MAX_TRANSPILED_SOURCE_BYTES && isTranspiledSource(path))
      return {
        file: path,
        message: `is larger than ${MAX_TRANSPILED_SOURCE_BYTES / 1024 / 1024} MiB; bundle or split it.`,
      }
    let code: string
    try {
      code = transpileExtensionSource(path, source)
    } catch (problem) {
      return problem as SourceProblem
    }
    let found: ReturnType<typeof parse>[0]
    try {
      found = parse(code)[0]
    } catch (error) {
      const offset = (error as { idx?: unknown })?.idx
      return {
        file: path,
        ...(typeof offset === 'number' ? lineAndColumn(code, offset) : {}),
        message: 'could not be read as a JavaScript module.',
      }
    }
    visiting.add(path)
    const imports: Node['imports'] = []
    for (const each of found) {
      if (each.specifier === undefined || each.specifier === null) {
        // `import(variable)`: nothing to resolve ahead of time, so nothing can load.
        if (each.type === 'dynamic') {
          visiting.delete(path)
          return {
            file: path,
            ...lineAndColumn(code, each.start),
            message: 'imports a module named at run time; import a relative path written out.',
          }
        }
        continue
      }
      if ('typeOnly' in each && each.typeOnly) continue
      const resolved = resolveImport(path, each.specifier, read)
      const at = { file: path, ...lineAndColumn(code, each.start) }
      if (!resolved.ok) {
        visiting.delete(path)
        return { ...at, message: resolved.reason }
      }
      const problem = visit(resolved.path, at)
      if (problem) {
        visiting.delete(path)
        return problem
      }
      // The specifier's text, inside its quotes for a static import and a literal dynamic one.
      const quoted = /^['"]/u.test(code.slice(each.start, each.start + 1))
      imports.push({
        start: quoted ? each.start + 1 : each.start,
        end: quoted ? each.end - 1 : each.end,
        path: resolved.path,
      })
    }
    visiting.delete(path)
    nodes.set(path, { path, code, imports })
    order.push(path)
    return null
  }

  const problem = visit(entry)
  if (problem) return { ok: false, problem }
  // A token no source can hold by accident: derived from every module's text,
  // so the same sources always build the same document.
  const digest = createHash('sha256')
  for (const path of order) digest.update(`${path}\0${nodes.get(path)!.code}\0`)
  const token = `se-module-${digest.digest('hex').slice(0, 16)}-`
  const index = new Map(order.map((path, at) => [path, at]))
  const modules = order.map((path) => {
    const node = nodes.get(path)!
    let code = ''
    let last = 0
    for (const each of [...node.imports].sort((a, b) => a.start - b.start)) {
      code += node.code.slice(last, each.start) + `${token}${index.get(each.path)}`
      last = each.end
    }
    return { path, code: code + node.code.slice(last) }
  })
  return { ok: true, modules, token }
}
