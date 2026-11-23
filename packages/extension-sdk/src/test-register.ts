// What `sprintengine-extension test` preloads (`node --import`) into the test
// runner: TypeScript under the project loads as written, as Studio loads an
// extension's (source-hooks.ts).

import { installTypeScriptHooks } from './source-hooks.js'

installTypeScriptHooks(process.env.SPRINTENGINE_EXTENSION_TEST_ROOT || process.cwd())
