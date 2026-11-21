import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import { loadMainModules } from '../../main/module-host/load-modules'
import { extensionContentSync } from '../../main/modules/module-signature'
import {
  NEEDS_ELECTRON_MAIN,
  planThirdPartyMainModules,
  skippedForElectronMain,
} from '../../main/modules/third-party-main-loader'
import type { InstalledModule } from '../../main/modules/user-module-registry'
import { capabilityManifestOf, parseExtensionManifest } from '../../shared/modules/third-party-manifest'
import { extensionManifest, writeExtensionFolder } from '../../../tests/extension-folder'
import { installElectronRequireGuard } from './electron-require-guard'

// Extensions whose worker needs Electron, where the worker runs in the Studio
// server: the require is refused by name, the load says why rather than
// reporting a crash, and the host says it cannot provide `electron-main`.

const scratch = mkdtempSync(join(tmpdir(), 'se-electron-guard-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function trustedExtension(id: string, worker: string): InstalledModule {
  const key = `local.${id}`
  const moduleRoot = writeExtensionFolder(join(scratch, key), {
    manifest: extensionManifest({ id }),
    files: { 'dist/main.cjs': worker },
  })
  const parsed = parseExtensionManifest(JSON.stringify(extensionManifest({ id })))
  assert.ok(parsed.ok)
  const content = extensionContentSync(moduleRoot)
  assert.ok(content.ok)
  return {
    key,
    publisher: 'local',
    manifest: capabilityManifestOf(key, 'local', parsed.manifest),
    extension: parsed.manifest,
    moduleRoot,
    trust: {
      status: 'trusted',
      via: 'grant',
      verifiedFiles: content.files,
      contentFingerprint: content.fingerprint,
    },
  }
}

test('a module that requires electron from its own folder is refused by name; code elsewhere is not', () => {
  const inside = join(scratch, 'guarded')
  mkdirSync(inside, { recursive: true })
  writeFileSync(join(inside, 'reaches.cjs'), "module.exports = () => require('electron/main')\n")
  const undo = installElectronRequireGuard(() => [inside])
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reaches = require(join(inside, 'reaches.cjs')) as () => unknown
    assert.throws(reaches, (error: unknown) => {
      assert.equal((error as Error).name, 'ElectronUnavailableError', String(error))
      assert.match((error as Error).message, new RegExp(NEEDS_ELECTRON_MAIN))
      return true
    })
  } finally {
    undo()
  }
})

test('a require of electron during activate is reported as needing electron-main, not as a crash', () => {
  const reaching = trustedExtension(
    'reaches-for-electron',
    "exports.activate = (studio) => { studio.onStartup(() => undefined); require('electron') }\n",
  )
  const plan = planThirdPartyMainModules({ modules: [reaching], rejected: [] }, { electronMain: false })
  // Planned like any other worker: whether it needs Electron is found out by running it.
  assert.equal(typeof plan.modules[0].registerMain, 'function')
  const undo = installElectronRequireGuard(() => Object.values(plan.moduleRoots))
  try {
    const loaded = loadMainModules({
      modules: plan.modules,
      moduleRoots: plan.moduleRoots,
      electronMain: false,
    })
    const error = loaded.report.errors.find((entry) => entry.id === 'local.reaches-for-electron')
    assert.ok(error, JSON.stringify(loaded.report))
    assert.match(error.message, new RegExp(NEEDS_ELECTRON_MAIN))
    assert.equal(skippedForElectronMain('local.reaches-for-electron'), true)
  } finally {
    undo()
  }
})

test("the server's host says it cannot provide electron-main; the desktop's says it can", () => {
  for (const [electronMain, expected] of [
    [false, false],
    [undefined, true],
  ] as const) {
    let answer: boolean | null = null
    loadMainModules({
      modules: [
        {
          manifest: { id: 'probe', displayName: 'Probe', version: 1, defaultEnabled: true },
          registerMain(host) {
            answer = host.supports('electron-main')
          },
        },
      ],
      ...(electronMain === undefined ? {} : { electronMain }),
    })
    assert.equal(answer, expected)
  }
})
