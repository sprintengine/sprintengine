// Runs in every test worker before each test file.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, vi } from 'vitest'
import { useFileTempFolder } from './temp-folders'

// The app exports its own SPRINTENGINE_* / SPRINTENGINE_* variables into every
// terminal it opens, and this repository is developed in the app — so a suite
// started from a Studio terminal would inherit a user-data dir, an agent id and
// a state socket that a CI shell never has. A test that needs one of these
// sets it itself; none may depend on which shell ran the suite.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('SPRINTENGINE_') || name.startsWith('SPRINTENGINE_')) delete process.env[name]
}

// Every `tmpdir()` the file makes lands in a scratch folder of its own, which
// is removed once the file is done, passed or failed (tests/temp-folders.ts).
// Registered first, this `afterAll` runs after the file's own, so the servers
// and processes a file stops in its hooks are stopped before the removal.
afterAll(useFileTempFolder(expect.getState().testPath ?? 'an unnamed test file'))

// The one variable set back: the home the app keeps each project's store in
// (`~/.sprintengine/workspaces`, main/workspace-store.ts). Every chat a suite
// runs writes its transcript there, so without this the suite would fill the
// home of whoever ran it. One folder per test file, in its scratch folder; a
// test that needs a store of its own sets the variable itself.
process.env.SPRINTENGINE_STORE_HOME = mkdtempSync(join(tmpdir(), 'se-store-home-'))

// `DEV` is false, as the app's own build compiles it; Vitest's default is a dev
// build. `PROD` is left false on purpose: the renderer keys its production
// channel on `PROD === true`, so the full module set stays active under test.
// The one suite that checks the production channel sets it itself.
vi.stubEnv('DEV', false)

// Node defines `navigator` as a getter-only global. The suites that stand up a
// JSDOM assign `globalThis.navigator = dom.window.navigator`; under the old
// sloppy-mode CommonJS bundles that assignment was silently dropped, and in
// strict ESM it throws. Writable, it now does what those suites always meant.
Object.defineProperty(globalThis, 'navigator', {
  value: globalThis.navigator,
  writable: true,
  configurable: true,
})

// Most suites predate Vitest and report failure the way a plain Node script
// does. `process.exit(n)` is already a failure under Vitest; `process.exitCode`
// is not, so a test that sets it fails here instead of passing silently.
afterEach(() => {
  const code = process.exitCode
  if (code !== undefined && code !== 0 && code !== '0') {
    process.exitCode = 0
    throw new Error(`the test set process.exitCode = ${String(code)}; see its output above`)
  }
})

// The window's files (`src/renderer/src/studio/files.ts`) go over the Studio
// protocol. Every suite gets their stand-in, which calls what the suite set on
// `window.api` under the names the window's IPC once had (`readfile`,
// `watchPath`, ...), else answers as an empty disk; the module's own suite
// asks for the real one (`vi.importActual`).
vi.mock('../src/renderer/src/studio/files', () => import('../src/renderer/src/studio/files.double'))
// The window's git (`src/renderer/src/studio/git.ts`), the same way.
vi.mock('../src/renderer/src/studio/git', () => import('../src/renderer/src/studio/git.double'))
// The worktrees its agents run in and settled chats (`src/renderer/src/studio/worktrees.ts`), the same way.
vi.mock('../src/renderer/src/studio/worktrees', () => import('../src/renderer/src/studio/worktrees.double'))
// A project's backlog by its folder (`src/renderer/src/studio/backlog.ts`), the same way.
vi.mock('../src/renderer/src/studio/backlog', () => import('../src/renderer/src/studio/backlog.double'))
// This machine's scheduled agents (`src/renderer/src/studio/schedules.ts`), the same way.
vi.mock('../src/renderer/src/studio/schedules', () => import('../src/renderer/src/studio/schedules.double'))
// Who may reach this machine's agents (`src/renderer/src/studio/access.ts`), the same way.
vi.mock('../src/renderer/src/studio/access', () => import('../src/renderer/src/studio/access.double'))
// The desktop's workspace registry (`src/renderer/src/studio/workspaceSync.ts`), the same way.
vi.mock('../src/renderer/src/studio/workspaceSync', () => import('../src/renderer/src/studio/workspaceSync.double'))
// The machines this computer offers (`src/renderer/src/studio/hosts.ts`), the same way.
vi.mock('../src/renderer/src/studio/hosts', () => import('../src/renderer/src/studio/hosts.double'))
// A web tab's paired browsers (`src/renderer/src/studio/webDevices.ts`), the same way.
vi.mock('../src/renderer/src/studio/webDevices', () => import('../src/renderer/src/studio/webDevices.double'))
// Who reaches this machine over the tailnet, and the machines it drives (`src/renderer/src/studio/tailnet.ts`), the same way.
vi.mock('../src/renderer/src/studio/tailnet', () => import('../src/renderer/src/studio/tailnet.double'))
