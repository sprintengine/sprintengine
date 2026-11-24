// The components panel runtime, as the hidden guest runs it: atoms and their
// persistence (memory, plugin, workspace; version and migrate), the edit
// protocol's `$edit`, the revision an event names, and a development folder's
// hand-over of keyed memory atoms to the next run.

import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import {
  atom,
  derived,
  installComponentsRuntime,
  jsx,
  read,
  set,
  update,
  type ComponentsBridge,
} from '../src/components/index.js'
import { forgetKeyedAtoms } from '../src/components/runtime/atoms.js'
import { COMPONENT_MESSAGES as M } from '../src/components/messages.js'
import { parseComponentTree } from '../src/components/tree.js'

type Posted = { event: string; payload: Record<string, unknown> }

function fakeBridge(stored: { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> } = {}) {
  const posted: Posted[] = []
  const calls: Array<{ method: string; params: unknown }> = []
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const bridge: ComponentsBridge = {
    post: (event, payload) => posted.push({ event, payload: payload as Record<string, unknown> }),
    on(event, handler) {
      let set = handlers.get(event)
      if (!set) handlers.set(event, (set = new Set()))
      set.add(handler)
      return { dispose: () => set!.delete(handler) }
    },
    async call(method, params) {
      calls.push({ method, params })
      if (method === 'atoms.read') return { plugin: stored.plugin ?? {}, workspace: stored.workspace ?? {} }
      return { ok: true }
    },
    has: () => true,
    listen: () => ({ dispose: () => undefined }),
    surface: { id: 'todos', workspaceId: 'ws-1' },
    colorScheme: 'light',
    locale: 'en',
    client: 'desktop',
  }
  const send = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }
  const renders = () => posted.filter((each) => each.event === M.render)
  return { bridge, posted, calls, send, renders }
}

const sync = (flush: () => void) => flush()

afterEach(() => forgetKeyedAtoms())

test('a counter renders, a press runs its handler against the tree shown, and the next render follows', async () => {
  const fake = fakeBridge()
  const count = atom('count', 0)
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({
    default: () =>
      jsx('Stack', {
        children: [
          jsx('Text', { children: `Clicked ${read(count)} times` }),
          jsx('Button', { onPress: () => update(count, (n) => n + 1), children: 'Click' }),
        ],
      }),
  })
  const first = fake.renders()[0]!.payload
  const checked = parseComponentTree(first.tree)
  assert.ok(checked.ok)
  const button = (first.tree as { children: Array<{ props: { onPress?: { $callback: string } } }> }).children[1]!
  const callback = button.props.onPress!.$callback
  // An event for a revision the window never saw does nothing.
  assert.equal(runtime.dispatchEvent({ document: runtime.document, revision: 99, callback, args: [] }), false)
  assert.equal(runtime.dispatchEvent({ document: 'another', revision: 1, callback, args: [] }), false)
  assert.ok(runtime.dispatchEvent({ document: runtime.document, revision: first.revision, callback, args: [] }))
  const second = fake.renders().at(-1)!.payload
  assert.equal(second.revision, 2)
  assert.match(JSON.stringify(second.tree), /Clicked 1 times/)
  runtime.dispose()
})

test('set and update refuse while rendering; a derived atom follows what it reads', async () => {
  const fake = fakeBridge()
  const a = atom(2)
  const doubled = derived(() => read(a) * 2)
  const errors: string[] = []
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  let throwOnce = true
  await runtime.boot({
    default: () => {
      if (throwOnce) {
        throwOnce = false
        set(a, 3)
      }
      return jsx('Text', { children: String(read(doubled)) })
    },
  })
  for (const each of fake.posted) if (each.event === M.error) errors.push(String(each.payload.message))
  assert.match(errors[0] ?? '', /while rendering/)
  runtime.rerender()
  assert.match(JSON.stringify(fake.renders().at(-1)!.payload.tree), /"4"/)
  runtime.dispose()
})

test('persisted atoms load before the first render, are saved a moment after they change, per scope', async () => {
  const fake = fakeBridge({
    plugin: { theme: { version: 1, value: 'dense' } },
    workspace: { draft: { version: 1, value: 'half typed' } },
  })
  const theme = atom('theme', 'roomy', { persist: 'plugin' })
  const draft = atom('draft', '', { persist: 'workspace' })
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({ default: () => jsx('Text', { children: `${read(theme)} ${read(draft)}` }) })
  assert.match(JSON.stringify(fake.renders()[0]!.payload.tree), /dense half typed/)
  set(theme, 'compact')
  set(draft, 'done')
  runtime.flush()
  const write = fake.calls.find((each) => each.method === 'atoms.write')
  assert.deepEqual(write?.params, {
    workspaceId: 'ws-1',
    entries: [
      { scope: 'plugin', key: 'theme', version: 1, value: 'compact' },
      { scope: 'workspace', key: 'draft', version: 1, value: 'done' },
    ],
  })
  runtime.dispose()
})

test('a version bump migrates a stored value; without migrate it starts from initial', async () => {
  const fake = fakeBridge({
    plugin: { todos: { version: 1, value: ['a', 'b'] }, filter: { version: 1, value: 'all' } },
  })
  const todos = atom<Array<{ title: string }>>('todos', [], {
    persist: 'plugin',
    version: 2,
    migrate: (stored, from) => (from === 1 ? (stored as string[]).map((title) => ({ title })) : []),
  })
  const filter = atom('filter', 'open', { persist: 'plugin', version: 2 })
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({ default: () => jsx('Text', { children: 'x' }) })
  assert.deepEqual(read(todos), [{ title: 'a' }, { title: 'b' }])
  assert.equal(read(filter), 'open')
  runtime.dispose()
})

test('a development folder: keyed memory atoms are handed over, and come back in the next run', async () => {
  const first = fakeBridge()
  const draft = atom('draft', '')
  const runtime = installComponentsRuntime({ bridge: first.bridge, schedule: sync, awaitHydration: true })
  const booted = runtime.boot({ default: () => jsx('Input', { label: 'Draft', value: read(draft) }) })
  const ready = first.posted.find((each) => each.event === M.ready)!
  first.send(M.hydrate, { document: ready.payload.document, visible: true, retain: true })
  await booted
  set(draft, 'half a sen')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const retained = first.posted.filter((each) => each.event === M.retain).flatMap((each) => each.payload.entries as [])
  assert.deepEqual(retained.at(-1), { key: 'draft', version: 1, value: 'half a sen' })
  runtime.dispose()
  forgetKeyedAtoms()

  // The next run of the saved file: the window hands the atom back before the first render.
  const second = fakeBridge()
  const draftAgain = atom('draft', '')
  const next = installComponentsRuntime({ bridge: second.bridge, schedule: sync, awaitHydration: true })
  const bootedAgain = next.boot({ default: () => jsx('Input', { label: 'Draft', value: read(draftAgain) }) })
  const readyAgain = second.posted.find((each) => each.event === M.ready)!
  second.send(M.hydrate, {
    document: readyAgain.payload.document,
    visible: true,
    retain: true,
    memory: { draft: { version: 1, value: 'half a sen' } },
  })
  await bootedAgain
  assert.match(JSON.stringify(second.renders()[0]!.payload.tree), /half a sen/)
  next.dispose()
})

test('a value control carries the newest edit its panel handled', async () => {
  const fake = fakeBridge()
  const text = atom('')
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({
    default: () => jsx('Input', { label: 'Name', value: read(text), onChange: (value: string) => set(text, value) }),
  })
  const tree = fake.renders()[0]!.payload.tree as { props: Record<string, unknown> }
  assert.equal(tree.props.$edit, 0)
  const callback = (tree.props.onChange as { $callback: string }).$callback
  runtime.dispatchEvent({ document: runtime.document, revision: 1, callback, args: ['ab'], edit: 2 })
  const after = fake.renders().at(-1)!.payload.tree as { props: Record<string, unknown> }
  assert.equal(after.props.$edit, 2)
  assert.equal(after.props.value, 'ab')
  runtime.dispose()
})

test('props must be plain JSON, and siblings cannot share a key: the render is not sent', async () => {
  const fake = fakeBridge()
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({ default: () => jsx('Text', { tone: new Date() as never, children: 'x' }) })
  assert.equal(fake.renders().length, 0)
  assert.match(String(fake.posted.find((each) => each.event === M.error)?.payload.message), /plain JSON/)
  runtime.mount(() =>
    jsx('Stack', { children: [jsx('Text', { children: 'a' }, 'k'), jsx('Text', { children: 'b' }, 'k')] }),
  )
  assert.equal(fake.renders().length, 0)
  runtime.mount(() => jsx('div', { children: 'no' }))
  assert.match(String(fake.posted.at(-1)?.payload.message), /never draws HTML/)
  runtime.dispose()
})

test('a refused render keeps the shown tree’s handlers, and retries when asked', async () => {
  const fake = fakeBridge()
  const n = atom(0)
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({
    default: () => jsx('Button', { onPress: () => update(n, (x) => x + 1), children: String(read(n)) }),
  })
  const first = fake.renders()[0]!.payload
  runtime.acknowledge({ document: runtime.document, revision: first.revision, accepted: true })
  const callback = (first.tree as { props: { onPress: { $callback: string } } }).props.onPress.$callback
  runtime.dispatchEvent({ document: runtime.document, revision: 1, callback, args: [] })
  runtime.acknowledge({ document: runtime.document, revision: 2, accepted: false })
  // The shown tree is still revision 1, and its press still works.
  assert.ok(runtime.dispatchEvent({ document: runtime.document, revision: 1, callback, args: [] }))
  assert.equal(read(n), 2)
  runtime.dispose()
})
