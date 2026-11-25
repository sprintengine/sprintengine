import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createExtensionShotTool, type ExtensionShotInput } from './extension-shot-tool'

// `visual.extension_shot` with a scenario's tree (`shot --scenario`): the tree
// the author's CLI rendered is checked here, as the window checks a posted
// one, before anything draws it, and handed on to the shot as data.

function shotTool() {
  const shots: ExtensionShotInput[] = []
  const tool = createExtensionShotTool(async (input) => {
    shots.push(input)
    return { path: input.out, width: 1, height: 1, theme: input.theme, settled: true, pendingRequests: 0, errors: [] }
  })
  return { tool, shots }
}

const base = { moduleId: 'local.notes', point: 'panels', id: 'counter', out: '/Users/dev/a.png' }
const tree = { type: 'Text', props: {}, children: ['7 clicks'] }
const code = (answer: { structuredContent?: unknown }) =>
  (answer.structuredContent as { error?: { code: string; message: string } }).error

test('a scenario’s tree is handed to the shot, with its name', async () => {
  const { tool, shots } = shotTool()
  const answer = await tool.handler({ ...base, tree, scenario: 'clicked before' })
  assert.notEqual(answer.isError, true)
  assert.deepEqual(shots[0]?.tree, tree)
  assert.equal(shots[0]?.scenario, 'clicked before')

  await tool.handler(base)
  assert.equal('tree' in shots[1]!, false, 'without a tree the live panel is pictured')
})

test('a tree Studio would not draw, a tree for anything but a panel, or a scenario with no tree is refused', async () => {
  const { tool, shots } = shotTool()
  const bad = await tool.handler({ ...base, tree: { type: 'Text', props: {}, children: 'x' }, scenario: 's' })
  assert.equal(code(bad)?.code, 'invalid_arguments')
  assert.match(code(bad)?.message ?? '', /not one Studio draws/u)
  assert.equal(code(await tool.handler({ ...base, point: 'doors', tree }))?.code, 'invalid_arguments')
  assert.equal(code(await tool.handler({ ...base, scenario: 's' }))?.code, 'invalid_arguments')
  assert.equal(code(await tool.handler({ ...base, tree, scenario: 'x'.repeat(201) }))?.code, 'invalid_arguments')
  assert.equal(shots.length, 0)
})
