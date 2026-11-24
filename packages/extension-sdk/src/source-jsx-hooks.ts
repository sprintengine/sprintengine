// JSX as written, in Node: what `sprintengine-extension test` and `check`
// install after the TypeScript hooks (source-hooks.ts), so an extension's
// `.tsx` and `.jsx` load as Studio loads a surface's (source-modules.ts):
// types and JSX removed, every line kept.
//
// - A file that imports `@sprintengine/extension-sdk/components` (a
//   components panel's, or its test's) compiles its JSX for that module, as
//   Studio compiles a components panel; any other keeps the classic `h()` and
//   `Fragment` a frame that draws itself uses. `components` names more files
//   to compile for it (`check` passes each components panel's modules).
// - `@sprintengine/extension-sdk/components` (and its JSX runtimes) and
//   `@sprintengine/extension-sdk/testing` resolve to this SDK's own files,
//   whatever the project has installed, so a panel and the test that mounts
//   it share one runtime.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  COMPONENTS_MODULE,
  formatSourceProblem,
  transpileExtensionSource,
  type SourceProblem,
} from './source-modules.js'

const JSX_EXTENSIONS = new Set(['.tsx', '.jsx'])
const JSX_FOR_OUTPUT: Record<string, string[]> = { '.js': ['.tsx', '.jsx'] }
// This SDK's own copies, beside this file in dist/.
const HERE = dirname(fileURLToPath(import.meta.url))
const OWN: Record<string, string> = {
  [COMPONENTS_MODULE]: join(HERE, 'components', 'index.js'),
  [`${COMPONENTS_MODULE}/jsx-runtime`]: join(HERE, 'components', 'index.js'),
  [`${COMPONENTS_MODULE}/jsx-dev-runtime`]: join(HERE, 'components', 'index.js'),
  '@sprintengine/extension-sdk/testing': join(HERE, 'testing.js'),
}
// A static import of the components module, its JSX runtime included.
const IMPORTS_COMPONENTS = /\bfrom\s*['"]@sprintengine\/extension-sdk\/components(?:\/[\w-]+)?['"]/u

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Files (absolute) a components panel loads, so their JSX compiles for its module even without a direct import. */
export type JsxHookOptions = { components?: ReadonlySet<string> }

/** Load `.tsx` and `.jsx` under `root` as Studio does, from now on, in this process. False without Node's hooks. */
export function installJsxHooks(root: string, options: JsxHookOptions = {}): boolean {
  const { registerHooks } = nodeModule as Partial<typeof nodeModule>
  if (typeof registerHooks !== 'function') return false
  const roots = [resolve(root)]
  try {
    roots.push(realpathSync(root))
  } catch {
    // Kept as named.
  }
  const inside = (file: string) =>
    roots.some((each) => {
      const path = relative(each, file)
      return path !== '' && !path.startsWith('..') && !isAbsolute(path)
    })
  const components = new Set([...(options.components ?? [])].flatMap((file) => [file, realOf(file)]))
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const own = OWN[specifier]
      if (own && isFile(own)) return { url: pathToFileURL(own).href, shortCircuit: true }
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        const parentUrl = context.parentURL
        if (!parentUrl?.startsWith('file:') || !(specifier.startsWith('./') || specifier.startsWith('../'))) throw error
        const target = resolve(dirname(fileURLToPath(parentUrl)), specifier.split(/[?#]/u)[0]!)
        const extension = extname(target).toLowerCase()
        const stem = target.slice(0, target.length - extension.length)
        const candidates = [
          ...(JSX_FOR_OUTPUT[extension] ?? []).map((each) => stem + each),
          ...[...JSX_EXTENSIONS].map((each) => target + each),
          ...[...JSX_EXTENSIONS].map((each) => resolve(target, `index${each}`)),
        ]
        const found = candidates.find((candidate) => inside(candidate) && isFile(candidate))
        if (!found) throw error
        return { url: pathToFileURL(found).href, shortCircuit: true }
      }
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context)
      const file = fileURLToPath(url)
      if (!JSX_EXTENSIONS.has(extname(file).toLowerCase()) || !inside(file)) return nextLoad(url, context)
      const text = readFileSync(file, 'utf8')
      const jsx = components.has(file) || IMPORTS_COMPONENTS.test(text) ? 'components' : 'html'
      let source: string
      try {
        source = transpileExtensionSource(file, text, jsx)
      } catch (problem) {
        // A syntax error, at its file, line and column.
        throw new SyntaxError(formatSourceProblem(problem as SourceProblem))
      }
      return { format: 'module', source, shortCircuit: true }
    },
  })
  return true
}

function realOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The project's own Vitest's aliases for the same modules, as `test` writes its config. */
export function ownModuleAliases(): Record<string, string> {
  return Object.fromEntries(Object.entries(OWN).filter(([, file]) => isFile(file)))
}
