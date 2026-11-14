import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioModuleSummary } from '../../../../packages/studio-protocol/src/public'
import { createStudioModuleSwitches } from './moduleSwitches'

// The window's copy of the module switches follows what its Studio holds:
// it takes the Studio's choice when it reads the list, and changes only once
// the Studio has a switch, so Settings never shows a module on that its
// Studio left off.

function summary(id: string, enabled: boolean, running = enabled): StudioModuleSummary {
  return { id, name: id, version: 1, source: 'bundled', enabled, running, methods: [] }
}

function harness(listed: StudioModuleSummary[]) {
  const overrides: Record<string, boolean> = {}
  const sets: Array<[string, boolean]> = []
  let answer: { ok: true; module: StudioModuleSummary | null } | { ok: false; message: string } = {
    ok: true,
    module: null,
  }
  let list = listed
  const switches = createStudioModuleSwitches({
    store: {
      overrides: () => overrides,
      set: (id, enabled) => {
        sets.push([id, enabled])
        overrides[id] = enabled
      },
    },
    list: async () => list,
    setEnabled: async () => answer,
  })
  return {
    switches,
    overrides,
    sets,
    answer: (next: typeof answer) => void (answer = next),
    list: (next: StudioModuleSummary[]) => void (list = next),
  }
}

test('reading the list takes the Studio’s choice for every module it holds, and only where the window differs', async () => {
  const h = harness([summary('canvas', false), summary('memory', true)])
  h.overrides.canvas = true
  h.overrides.memory = true
  h.overrides['window-only'] = false
  await h.switches.refresh()
  assert.deepEqual(h.sets, [['canvas', false]], 'the window adopts what runs; nothing else is written')
  assert.equal(h.overrides['window-only'], false, 'a module only the window has stays the window’s')
  assert.equal(h.switches.modules().get('canvas')?.enabled, false)
})

test('a switch the Studio refused leaves the window’s copy as it was and says why', async () => {
  const h = harness([summary('canvas', false)])
  await h.switches.refresh()
  h.answer({ ok: false, message: 'The choice could not be saved.' })
  const result = await h.switches.switchModule('canvas', true)
  assert.deepEqual(result, { ok: false, message: 'The choice could not be saved.' })
  assert.equal(h.overrides.canvas, false, 'still off, as the Studio holds it')
})

test('a switch the Studio took changes the window’s copy and what it shows', async () => {
  const h = harness([summary('canvas', false)])
  await h.switches.refresh()
  let heard = 0
  h.switches.onChange(() => void heard++)
  h.answer({ ok: true, module: summary('canvas', true, false) })
  h.list([summary('canvas', true, false)])
  assert.deepEqual(await h.switches.switchModule('canvas', true), { ok: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(h.overrides.canvas, true)
  assert.equal(h.switches.modules().get('canvas')?.running, false, 'on, and not yet running, as the Studio said')
  assert.equal(heard, 2, 'once for the switch, once for the read after it')
})

test('a list that cannot be read keeps what was last said; the later of two reads lands', async () => {
  const h = harness([summary('canvas', true)])
  await h.switches.refresh()
  h.list([summary('canvas', false)])
  const first = h.switches.refresh()
  h.list([summary('canvas', true)])
  const second = h.switches.refresh()
  await Promise.all([first, second])
  assert.equal(h.switches.modules().get('canvas')?.enabled, true)
})

test('a read that left before a switch does not undo it when it lands after', async () => {
  const overrides: Record<string, boolean> = { canvas: false }
  const pending: Array<(listed: StudioModuleSummary[]) => void> = []
  const switches = createStudioModuleSwitches({
    store: { overrides: () => overrides, set: (id, enabled) => void (overrides[id] = enabled) },
    list: () => new Promise((resolve) => pending.push(resolve)),
    setEnabled: async () => ({ ok: true, module: summary('canvas', true) }),
  })
  // A reconnect's read is on its way when the person switches the module on.
  const stale = switches.refresh()
  assert.deepEqual(await switches.switchModule('canvas', true), { ok: true })
  // The read that left first lands, saying what was held before the switch.
  pending[0]!([summary('canvas', false)])
  await stale
  assert.equal(overrides.canvas, true, 'the switch the Studio took stands')
  assert.equal(switches.modules().get('canvas')?.enabled, true)
  // The read the switch asked for says what the Studio holds now.
  pending[1]?.([summary('canvas', true)])
  assert.equal(overrides.canvas, true)
})
