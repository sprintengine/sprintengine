// Smoke test: the BUILT extension loads the way SprintEngine Studio loads it.
// Run `npm run build` first (`npm run check` does, in order).
//
// - extension/extension.json passes the SDK's own validator, held as an
//   author's tools hold it (`engines.studio` covers every field it uses).
// - Each panel's, door's and settings section's entry exists, loads as a
//   module with nothing beside it (Studio imports the file on its own, so it
//   must carry everything it imports) and exports `mount`.
// - The worker (`main`) loads with require, exports `activate`, and activates
//   against the SDK's fake main host, which holds it to Studio's rules: every
//   command without an `action` has an `operate` method of the same name,
//   every MCP tool extension.json declares is served, and nothing is used
//   that extension.json does not declare.
//
// Your own tests are TypeScript, in test/*.test.ts: `npm test` builds them
// with esbuild (`npm run build:test`) and runs them beside this file.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { EXTENSION_SURFACE_POINTS, validateExtensionManifest } from '@sprintengine/extension-sdk'
import { createFakeMainHost } from '@sprintengine/extension-sdk/testing'

const extensionDir = fileURLToPath(new URL('../extension/', import.meta.url))
const raw = JSON.parse(readFileSync(join(extensionDir, 'extension.json'), 'utf8'))
const validated = validateExtensionManifest(raw, { authoring: true })
const manifest = validated.ok ? validated.manifest : undefined

const POINT_NAMES = { panels: 'panel', doors: 'door', settingsSections: 'settings section' }

const undeclaredMessage = (uses) =>
  uses
    .map(
      (use) =>
        `${use.what} needs ${use.needs.length > 1 ? 'one of ' : ''}${use.needs.map((p) => `"${p}"`).join(', ')}` +
        (use.checked ? ' (Studio refuses it without)' : ' (declare it: the person is told what the extension does)'),
    )
    .join('\n')

/** A built file, read; fails with what to run when it is missing. */
function built(file) {
  const path = join(extensionDir, file)
  assert.ok(existsSync(path), `extension/${file} is missing: run \`npm run build\` first.`)
  return { path, source: readFileSync(path, 'utf8') }
}

test('extension.json is one Studio accepts', () => {
  assert.ok(validated.ok, JSON.stringify(validated.ok ? [] : validated.issues, null, 2))
})

for (const point of EXTENSION_SURFACE_POINTS) {
  for (const surface of manifest?.contributes[point] ?? []) {
    test(`${POINT_NAMES[point]} "${surface.id}": ${surface.entry} loads on its own and exports mount`, async () => {
      const { source } = built(surface.entry)
      // A data: URL resolves no import, as the module Studio makes of the file
      // resolves none: an import left in the bundle fails here.
      let loaded
      try {
        loaded = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
      } catch (error) {
        assert.fail(
          `${surface.entry} does not load on its own, as Studio loads it: bundle everything it imports. ` +
            `(${error instanceof Error ? error.message : error})`,
        )
      }
      assert.equal(typeof loaded.mount, 'function', `${surface.entry} must export mount(root, studio).`)
    })
  }
}

if (manifest?.main) {
  test(`the worker (${manifest.main}) activates and serves what extension.json declares`, async () => {
    const { path, source } = built(manifest.main)
    assert.ok(!/require\(["']react/.test(source), `${manifest.main} requires React; the worker has no window.`)
    const loaded = createRequire(import.meta.url)(path)
    const activate = typeof loaded.activate === 'function' ? loaded.activate : loaded.default
    assert.equal(
      typeof activate,
      'function',
      `${manifest.main} must export activate(studio), named or as its default export.`,
    )

    const main = createFakeMainHost({ manifest })
    try {
      await activate(main.host)
      await main.startup()

      const methods = main.methods.declared()
      for (const command of manifest.contributes.commands.filter((entry) => entry.action === undefined)) {
        const method = methods.find((entry) => entry.name === command.id)
        assert.ok(
          method,
          `command "${command.id}" has no action, so running it calls the worker's "${command.id}" method; activate registers none.`,
        )
        assert.equal(
          method.access,
          'operate',
          `"${command.id}" must be an operate method: a command may change things.`,
        )
      }
      const served = main.tools.list().map((tool) => tool.name)
      for (const tool of manifest.contributes.mcpTools) {
        assert.ok(served.includes(tool.name), `MCP tool "${tool.name}" is declared, but activate does not serve it.`)
      }
      assert.equal(main.undeclared.length, 0, undeclaredMessage(main.undeclared))
    } finally {
      await main.shutdown()
      main.dispose()
    }
  })
}
