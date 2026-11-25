// What `sprintengine-extension test` preloads (`node --import`) into the test
// runner: TypeScript under the project loads as written, as Studio loads an
// extension's (source-hooks.ts), and `.tsx` and `.jsx` load with their types
// and JSX removed as Studio removes them from a surface's (source-jsx-hooks.ts:
// a components panel's JSX for `@sprintengine/extension-sdk/components`, every
// file of its module graph as `check` compiles it and any file importing the
// module; any other's classic `h()` and `Fragment`; every line kept). The
// worker's own hooks stay free of JSX: only tests and surfaces carry it.

import { resolve } from 'node:path'

import { installJsxHooks } from './source-jsx-hooks.js'
import { installTypeScriptHooks } from './source-hooks.js'

const root = resolve(process.env.SPRINTENGINE_EXTENSION_TEST_ROOT || process.cwd())
installTypeScriptHooks(root)
// The components panels' module graphs, as `test` read them from extension.json (as `check` does).
let components: string[] = []
try {
  const named = JSON.parse(process.env.SPRINTENGINE_EXTENSION_COMPONENT_FILES || '[]') as unknown
  if (Array.isArray(named)) components = named.filter((file): file is string => typeof file === 'string')
} catch {
  // None named: files importing the components module still compile for it.
}
// Registered after the TypeScript hooks, so these run first and hand on what they do not take.
installJsxHooks(root, { components: new Set(components) })
