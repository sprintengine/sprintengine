// The SDK's sample components panels (examples/components-sample): the folder
// is one Studio loads as written, and each panel renders cleanly and does
// what its README says when the person uses it. Each panel's `.tsx` is
// compiled with Studio's own transpiler (its JSX for the components module),
// and that module is pointed at this package's source, so the panel and the
// testing kit share one runtime, as they do in an extension's own tests.
// Each panel's module is loaded once, as in Studio: its keyed atoms stay
// registered, and every mount starts them over.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { test } from 'vitest'

import { checkSurfaces, validateExtensionFolder } from '../src/cli-authoring.js'
import type { PanelModule } from '../src/components/runtime/renderer.js'
import { transpileExtensionSource } from '../src/source-modules.js'
import { mountPanel, runPanelScenario, type CheckScenario } from '../src/testing-components.js'

const SAMPLE = join(process.cwd(), 'packages/extension-sdk/examples/components-sample')
const SOURCE = join(process.cwd(), 'packages/extension-sdk/src')
// What Studio and `sprintengine-extension test` resolve to the SDK's own files.
const OWN: Array<[RegExp, string]> = [
  [/(['"])@sprintengine\/extension-sdk\/components(?:\/jsx-runtime)?\1/gu, join(SOURCE, 'components/index.ts')],
  [/(['"])@sprintengine\/extension-sdk\/testing\1/gu, join(SOURCE, 'testing.ts')],
]

/** A file of the sample as Studio compiles it, the SDK's modules this package's source. */
async function load(path: string): Promise<Record<string, unknown>> {
  let code = transpileExtensionSource(path, readFileSync(join(SAMPLE, path), 'utf8'), 'components')
  for (const [specifier, file] of OWN) code = code.replace(specifier, JSON.stringify(file))
  const out = join(tmpdir(), `${path.replace(/[^\w]/gu, '-')}.mjs`)
  writeFileSync(out, code)
  return (await import(/* @vite-ignore */ pathToFileURL(out).href)) as Record<string, unknown>
}

const loadPanel = (entry: string): Promise<PanelModule> => load(entry) as Promise<PanelModule>

const { manifest } = validateExtensionFolder(SAMPLE)

test('the sample is a folder Studio loads: three components panels, each with a default export', () => {
  assert.equal(manifest.tier, 'ui')
  assert.deepEqual(manifest.permissions, [])
  const surfaces = checkSurfaces(SAMPLE, manifest)
  assert.deepEqual(
    surfaces.map((surface) => [surface.id, surface.ui, surface.ok, surface.problem]),
    [
      ['counter', 'components', true, undefined],
      ['form', 'components', true, undefined],
      ['files', 'components', true, undefined],
    ],
  )
})

test('every panel renders with nothing thrown, dropped or refused, in each of its check scenarios', async () => {
  const counterScenarios = (await load('src/counter.check.ts')).default as Record<string, CheckScenario>
  assert.deepEqual(Object.keys(counterScenarios), ['fresh', 'pressed before', 'dark'])
  for (const panel of manifest.contributes.panels) {
    const module = await loadPanel(panel.entry)
    const scenarios = panel.id === 'counter' ? counterScenarios : { default: {} }
    for (const [name, scenario] of Object.entries(scenarios)) {
      const result = await runPanelScenario(module, scenario, { manifest, panelId: panel.id })
      const label = `${panel.id} [${name}]`
      assert.deepEqual(result.errors, [], label)
      assert.deepEqual(result.warnings, [], label)
      assert.deepEqual(result.refusals, [], label)
      assert.ok(result.tree, label)
      if (panel.id === 'counter' && name === 'pressed before') assert.match(JSON.stringify(result.tree), /7 presses/u)
    }
  }
})

test('counter: presses count, and the count is stored for the extension', async () => {
  const view = await mountPanel(await loadPanel('src/counter.tsx'), {
    manifest,
    panelId: 'counter',
    persisted: { plugin: { 'counter.count': 2 } },
  })
  assert.ok(view.find({ text: '2 presses' }))
  await view.press({ role: 'button', text: 'Add one' })
  assert.ok(view.find({ text: '3 presses' }))
  await view.press({ role: 'button', text: 'Reset' })
  assert.ok(view.find({ text: '0 presses' }))
  assert.equal(view.find({ role: 'button', text: 'Reset' })?.props.disabled, true)
  assert.deepEqual(view.persisted.plugin, { 'counter.count': 0 })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('form: a title, a kind and urgency make a sent request, and the form starts over', async () => {
  const view = await mountPanel(await loadPanel('src/form.tsx'), { manifest, panelId: 'form' })
  assert.equal(view.find({ role: 'button', text: 'Send' })?.props.disabled, true, 'nothing to send yet')
  await view.type({ role: 'textbox', label: 'Title' }, 'Export does nothing')
  await view.select({ label: 'Kind' }, 'idea')
  await view.toggle({ role: 'switch', label: 'Urgent' })
  await view.press({ role: 'button', text: 'Send' })
  const sent = view.find({ type: 'ListItem', label: 'Export does nothing' })
  assert.equal(sent?.props.description, 'Idea')
  assert.ok(view.find({ type: 'Badge', text: 'Urgent' }))
  assert.equal(view.valueOf({ role: 'textbox', label: 'Title' }), '')
  assert.equal(view.valueOf({ label: 'Kind' }), 'bug')
  assert.equal(view.valueOf({ role: 'switch', label: 'Urgent' }), false)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('files: the table sorts and selects, and the tree reports the item picked', async () => {
  const view = await mountPanel(await loadPanel('src/files.tsx'), { manifest, panelId: 'files' })
  const table = { type: 'Table' }
  assert.equal(view.rowsOf(table)[0], 'README.md')
  await view.sort(table, 'size')
  assert.deepEqual(view.rowsOf(table).slice(0, 2), ['extension.json', 'src/icons/add.png'])
  await view.sort(table, 'size')
  assert.equal(view.rowsOf(table)[0], 'src/panel.tsx', 'a second click sorts the other way')
  await view.selectRows(table, ['README.md', 'src/list.ts'])
  assert.ok(view.find({ text: '2 selected' }))

  const tree = { type: 'Tree' }
  assert.deepEqual(view.expandedOf(tree), ['src'])
  await view.expand(tree, 'src/icons')
  await view.selectItem(tree, 'src/icons/add.png')
  assert.ok(view.find({ text: 'Picked src/icons/add.png' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})
