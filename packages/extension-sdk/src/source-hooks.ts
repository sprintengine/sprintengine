// TypeScript as written, in Node: what Studio's worker process installs before
// it loads an extension's `main`, and what `sprintengine-extension test` and
// `check` install before they load an extension's code, so a worker, its
// tests and Studio load the same files the same way.
//
// - A `.ts`, `.mts` or `.cts` file under `root` is stripped of its types as it
//   loads (Node's own `stripTypeScriptTypes`), every line and column kept, so
//   an error's place is the place in the file. Only types: an `enum` or a
//   `namespace` needs code, and fails saying so. No JSX.
// - A relative import under `root` that names no file is tried with the
//   source extensions: `./util` finds `util.ts`, and TypeScript's ESM style
//   `./util.js` finds `util.ts` too, then `<dir>/index.*`.
//
// Node's own module hooks (`registerHooks`, synchronous, so `require` honours
// them as `import` does). Imports nothing but Node's own modules: the worker
// entry that bundles it must stay one file of Node built-ins.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.cts'])
const RESOLVE_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.cjs', '.cts']
const SOURCE_FOR_OUTPUT: Record<string, string[]> = { '.js': ['.ts'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether this Node can load TypeScript as written: it has `registerHooks` and `stripTypeScriptTypes`. */
export function canLoadTypeScript(): boolean {
  const { registerHooks, stripTypeScriptTypes } = nodeModule as Partial<typeof nodeModule>
  return typeof registerHooks === 'function' && typeof stripTypeScriptTypes === 'function'
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** A package's file for `specifier` (`name` or `name/sub`), by its package.json `exports`. */
function packageFile(packageDir: string, subpath: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as {
      exports?: Record<string, string | { default?: string; require?: string; import?: string }>
      main?: string
    }
    const entry = manifest.exports?.[subpath] ?? (subpath === '.' && manifest.main ? manifest.main : undefined)
    const target = typeof entry === 'string' ? entry : (entry?.default ?? entry?.import ?? entry?.require)
    return target ? resolve(packageDir, target) : null
  } catch {
    return null
  }
}

export type TypeScriptHookOptions = {
  /**
   * Packages to load from Studio's own copy when the extension does not carry
   * one, by name: a worker's `import … from '@sprintengine/extension-sdk'`
   * resolves to the SDK of the Studio running it. That copy ships without
   * the SDK's own dependencies, so a subpath that needs them
   * (`FALLBACK_REFUSED_SUBPATHS`) is refused, saying so.
   */
  fallbackPackages?: Record<string, string>
}

/**
 * Subpaths of a fallback package Studio's copy cannot serve: they import the
 * SDK's dependencies (sucrase, es-module-lexer), which that copy leaves out.
 * An extension that uses one carries the SDK in its own node_modules.
 */
export const FALLBACK_REFUSED_SUBPATHS: ReadonlySet<string> = new Set(['./source'])

/**
 * Load TypeScript under `root` as written, from now on, in this process.
 * Returns false on a Node without the hooks (before 22.15), where plain
 * JavaScript still loads and TypeScript fails to parse.
 */
export function installTypeScriptHooks(root: string, options: TypeScriptHookOptions = {}): boolean {
  const { registerHooks, stripTypeScriptTypes } = nodeModule as Partial<typeof nodeModule>
  if (typeof registerHooks !== 'function' || typeof stripTypeScriptTypes !== 'function') return false
  // Node names a loaded file by its real path: a root reached through a link
  // (macOS's /tmp is /private/tmp) is compared as that.
  const roots = [...new Set([resolve(root), real(root)])]
  const inside = (file: string) =>
    roots.some((each) => {
      const path = relative(each, file)
      return path !== '' && !path.startsWith('..') && !isAbsolute(path)
    })
  const fallback = Object.entries(options.fallbackPackages ?? {})
  // Node warns that its transpiler is experimental at every file: not the author's concern.
  const emitWarning = process.emitWarning.bind(process)
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (text.includes('stripTypeScriptTypes') || text.includes('Type Stripping')) return
    ;(emitWarning as (...args: unknown[]) => void)(warning, ...rest)
  }) as typeof process.emitWarning
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        for (const [name, dir] of fallback) {
          if (specifier !== name && !specifier.startsWith(`${name}/`)) continue
          const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`
          if (FALLBACK_REFUSED_SUBPATHS.has(subpath))
            throw new Error(
              `${specifier} needs the SDK's own dependencies, which the copy Studio lends a worker leaves out: add ${name} to the extension's dependencies to use it.`,
            )
          const file = packageFile(dir, subpath)
          if (file && isFile(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
        }
        const parentUrl = context.parentURL
        if (!parentUrl?.startsWith('file:') || !(specifier.startsWith('./') || specifier.startsWith('../'))) throw error
        const parent = fileURLToPath(parentUrl)
        if (!inside(parent) && !inside(real(parent))) throw error
        const target = resolve(dirname(parent), specifier.split(/[?#]/u)[0]!)
        const extension = extname(target).toLowerCase()
        const stem = target.slice(0, target.length - extension.length)
        const candidates = [
          ...(SOURCE_FOR_OUTPUT[extension] ?? []).map((each) => stem + each),
          ...RESOLVE_EXTENSIONS.map((each) => target + each),
          ...RESOLVE_EXTENSIONS.map((each) => resolve(target, `index${each}`)),
        ]
        const found = candidates.find((candidate) => inside(candidate) && isFile(candidate))
        if (!found) throw error
        return { url: pathToFileURL(found).href, shortCircuit: true }
      }
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context)
      const file = fileURLToPath(url)
      const extension = extname(file).toLowerCase()
      if (!TYPESCRIPT_EXTENSIONS.has(extension) || !inside(file)) return nextLoad(url, context)
      const code = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' })
      const format =
        extension === '.mts'
          ? 'module'
          : extension === '.cts'
            ? 'commonjs'
            : /^\s*(?:import|export)[\s{*]/mu.test(code)
              ? 'module'
              : 'commonjs'
      return { format, source: code, shortCircuit: true }
    },
  })
  return true
}

/**
 * Where in `root`'s files an error was thrown, as `file:line:col` relative to
 * it: the first frame of its stack that is one of them, or ''.
 */
export function placeInFolder(error: unknown, root: string): string {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : ''
  if (!stack) return ''
  for (const line of stack.split('\n')) {
    const found = /(?:\(|\s)(file:\/\/[^\s()]+|[^\s()]+?):(\d+):(\d+)\)?\s*$/u.exec(line)
    if (!found) continue
    let file = found[1]!
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file)
      } catch {
        continue
      }
    }
    for (const base of new Set([resolve(root), real(root)])) {
      const inside = relative(base, file)
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue
      return `${inside.split('\\').join('/')}:${found[2]}:${found[3]}`
    }
  }
  return ''
}
