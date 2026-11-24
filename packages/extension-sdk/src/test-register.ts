// What `sprintengine-extension test` preloads (`node --import`) into the test
// runner: TypeScript under the project loads as written, as Studio loads an
// extension's (source-hooks.ts), and `.tsx` and `.jsx` load with their types
// and JSX removed as Studio removes them from a surface's (source-jsx-hooks.ts:
// a components panel's JSX for `@sprintengine/extension-sdk/components`, any
// other's classic `h()` and `Fragment`, every line kept). The worker's own
// hooks stay free of JSX: only tests and surfaces carry it.

import { resolve } from 'node:path'

import { installJsxHooks } from './source-jsx-hooks.js'
import { installTypeScriptHooks } from './source-hooks.js'

const root = resolve(process.env.SPRINTENGINE_EXTENSION_TEST_ROOT || process.cwd())
installTypeScriptHooks(root)
// Registered after the TypeScript hooks, so these run first and hand on what they do not take.
installJsxHooks(root)
