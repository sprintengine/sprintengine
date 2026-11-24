// What `sprintengine-extension test` preloads (`node --import`) into the test
// runner: TypeScript under the project loads as written, as Studio loads an
// extension's (source-hooks.ts), and `.tsx` and `.jsx` load with their types
// and JSX removed as Studio removes them from a surface's (classic `h()` and
// `Fragment`, every line kept; source-modules.ts). The worker's own hooks stay
// free of JSX: only tests and surfaces carry it.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { installTypeScriptHooks } from './source-hooks.js'
import { formatSourceProblem, transpileExtensionSource, type SourceProblem } from './source-modules.js'

const root = resolve(process.env.SPRINTENGINE_EXTENSION_TEST_ROOT || process.cwd())
installTypeScriptHooks(root)

const JSX_EXTENSIONS = new Set(['.tsx', '.jsx'])
const JSX_FOR_OUTPUT: Record<string, string[]> = { '.js': ['.tsx', '.jsx'] }

// Node names a loaded file by its real path: a root reached through a link is compared as that too.
const roots = [root]
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
const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const { registerHooks } = nodeModule as Partial<typeof nodeModule>
// Registered after the TypeScript hooks, so these run first and hand on what they do not take.
registerHooks?.({
  resolve(specifier, context, nextResolve) {
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
    let source: string
    try {
      source = transpileExtensionSource(file, readFileSync(file, 'utf8'))
    } catch (problem) {
      // A syntax error, at its file, line and column.
      throw new SyntaxError(formatSourceProblem(problem as SourceProblem))
    }
    return { format: 'module', source, shortCircuit: true }
  },
})
