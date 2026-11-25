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
  mount,
  read,
  set,
  update,
  type ComponentsBridge,
} from '../src/components/index.js'
import { forgetKeyedAtoms } from '../src/components/runtime/atoms.js'
import { COMPONENT_MESSAGES as M } from '../src/components/messages.js'
import { createComponentsSdk } from '../src/components/runtime/sdk.js'
import { parseComponentTree } from '../src/components/tree.js'

type Posted = { event: string; payload: Record<string, unknown> }

function fakeBridge(
  stored: { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> } = {},
  answer?: (method: string, params: unknown) => unknown,
) {
  const posted: Posted[] = []
  const calls: Array<{ method: string; params: unknown }> = []
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const leaving = new Set<() => void>()
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
      if (answer) {
        const answered = await answer(method, params)
        if (answered !== undefined) return answered
      }
      if (method === 'atoms.read') return { plugin: stored.plugin ?? {}, workspace: stored.workspace ?? {} }
      return { ok: true }
    },
    has: () => true,
    listen: () => ({ dispose: () => undefined }),
    surface: { id: 'todos', workspaceId: 'ws-1' },
    colorScheme: 'light',
    locale: 'en',
    client: 'desktop',
    onLeave(flush) {
      leaving.add(flush)
      return { dispose: () => leaving.delete(flush) }
    },
  }
  /** The frame's document unloads, as the bootstrap's pagehide runs it. */
  const leave = () => {
    for (const flush of [...leaving]) flush()
  }
  const send = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }
  const renders = () => posted.filter((each) => each.event === M.render)
  const writes = () => calls.filter((each) => each.method === 'atoms.write')
  return { bridge, posted, calls, send, renders, leave, writes }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

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

test('a change in the last moment before the frame unloads is sent before it says it is leaving', async () => {
  const fake = fakeBridge()
  const done = atom('done', false, { persist: 'workspace' })
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({ default: () => jsx('Switch', { label: 'Done', checked: read(done) }) })
  set(done, true)
  // Closed well within the 400 ms a change waits.
  fake.leave()
  assert.deepEqual(fake.writes().at(-1)?.params, {
    workspaceId: 'ws-1',
    entries: [{ scope: 'workspace', key: 'done', version: 1, value: true }],
  })
  runtime.dispose()
  assert.equal(fake.writes().length, 1, 'nothing is sent twice')
})

test('a panel hidden sends what changed at once, and a reload’s memory atoms with it', async () => {
  const fake = fakeBridge()
  const theme = atom('theme', 'roomy', { persist: 'plugin' })
  const draft = atom('draft', '')
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync, awaitHydration: true })
  const booted = runtime.boot({ default: () => jsx('Text', { children: `${read(theme)} ${read(draft)}` }) })
  const ready = fake.posted.find((each) => each.event === M.ready)!
  fake.send(M.hydrate, { document: ready.payload.document, visible: true, retain: true })
  await booted
  set(theme, 'dense')
  set(draft, 'half')
  fake.send(M.visibility, { document: runtime.document, visible: false })
  assert.deepEqual((fake.writes().at(-1)?.params as { entries: unknown }).entries, [
    { scope: 'plugin', key: 'theme', version: 1, value: 'dense' },
  ])
  const retained = fake.posted.filter((each) => each.event === M.retain).flatMap((each) => each.payload.entries as [])
  assert.deepEqual(retained.at(-1), { key: 'draft', version: 1, value: 'half' })
  runtime.dispose()
})

test('a migrate that throws starts its atom over and reports it; the rest load, each scope on its own', async () => {
  const fake = fakeBridge({
    plugin: { broken: { version: 1, value: 'x' }, fine: { version: 1, value: 'kept' } },
    workspace: { draft: { version: 1, value: 'typed' } },
  })
  const broken = atom('broken', 'initial', {
    persist: 'plugin',
    version: 2,
    migrate: () => {
      throw new Error('cannot read v1')
    },
  })
  const fine = atom('fine', '', { persist: 'plugin' })
  const draft = atom('draft', '', { persist: 'workspace' })
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({ default: () => jsx('Text', { children: 'x' }) })
  assert.equal(read(broken), 'initial')
  assert.equal(read(fine), 'kept')
  assert.equal(read(draft), 'typed')
  const error = fake.posted.find((each) => each.event === M.error)
  assert.match(String(error?.payload.message), /migrate\(\) for the atom "broken" threw.*cannot read v1/u)
  runtime.dispose()
})

test('a value a newer version stored is not migrated, and not written until the atom changes', async () => {
  const fake = fakeBridge({ plugin: { layout: { version: 3, value: { columns: 4 } } } })
  const migrated: number[] = []
  const layout = atom(
    'layout',
    { columns: 2 },
    {
      persist: 'plugin',
      version: 2,
      migrate: (_stored, from) => {
        migrated.push(from)
        return { columns: 1 }
      },
    },
  )
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({ default: () => jsx('Text', { children: String(read(layout).columns) }) })
  assert.deepEqual(read(layout), { columns: 2 })
  assert.deepEqual(migrated, [])
  runtime.flush()
  fake.leave()
  assert.equal(fake.writes().length, 0)
  set(layout, { columns: 3 })
  runtime.flush()
  assert.equal(fake.writes().length, 1)
  runtime.dispose()
})

test('a storage read that answers after the panel set the atom leaves the edit, and the edit is written', async () => {
  let answerRead: (value: unknown) => void = () => undefined
  const fake = fakeBridge({}, (method) =>
    method === 'storage.get' ? new Promise((resolve) => (answerRead = resolve)) : undefined,
  )
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({ default: () => jsx('Text', { children: 'x' }) })
  // Made after boot: its read goes out now, and is slow.
  const note = atom('note', '', { persist: 'storage' })
  set(note, 'typed meanwhile')
  answerRead({ found: true, value: 'stored before' })
  await tick()
  assert.equal(read(note), 'typed meanwhile')
  runtime.flush()
  await tick()
  assert.deepEqual(fake.calls.filter((each) => each.method === 'storage.set').at(-1)?.params, {
    key: 'note',
    value: 'typed meanwhile',
  })
  runtime.dispose()
})

test('a large atom is stored, writes are split to fit the lane, and one over the cap stays in the run', async () => {
  const fake = fakeBridge()
  const big = atom('big', '', { persist: 'plugin' })
  const half = atom('half', '', { persist: 'plugin' })
  const other = atom('other', '', { persist: 'plugin' })
  const huge = atom('huge', '', { persist: 'plugin' })
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({ default: () => jsx('Text', { children: 'x' }) })
  // About 70 KiB: more than a frame call carries.
  set(big, 'b'.repeat(70 * 1024))
  runtime.flush()
  await tick()
  assert.equal((fake.writes()[0]?.params as { entries: Array<{ value: string }> }).entries[0]?.value.length, 70 * 1024)
  // Two of 400 KiB do not fit one write: each goes in its own.
  set(half, 'h'.repeat(400 * 1024))
  set(other, 'o'.repeat(400 * 1024))
  runtime.flush()
  await tick()
  const split = fake.writes().slice(1)
  assert.deepEqual(
    split.map((each) => (each.params as { entries: Array<{ key: string }> }).entries.map((entry) => entry.key)),
    [['half'], ['other']],
  )
  set(huge, 'x'.repeat(600 * 1024))
  runtime.flush()
  await tick()
  assert.equal(fake.writes().length, 3)
  assert.match(
    String(fake.posted.filter((each) => each.event === M.error).at(-1)?.payload.message),
    /"huge" is over 512 KiB/u,
  )
  runtime.dispose()
})

test('a refused write is sent again after the wait it names, with the value then', async () => {
  let refusals = 1
  const fake = fakeBridge({}, (method) => {
    if (method !== 'atoms.write' || refusals === 0) return undefined
    refusals -= 1
    throw Object.assign(new Error('This frame sent too many messages.'), {
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 20,
    })
  })
  const count = atom('count', 0, { persist: 'plugin' })
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({ default: () => jsx('Text', { children: String(read(count)) }) })
  set(count, 1)
  runtime.flush()
  await tick()
  assert.equal(fake.writes().length, 1)
  // Changed while the refusal waits: the retry carries the newest value.
  set(count, 2)
  await tick(80)
  assert.deepEqual((fake.writes().at(-1)?.params as { entries: unknown }).entries, [
    { scope: 'plugin', key: 'count', version: 1, value: 2 },
  ])
  assert.equal(fake.writes().length, 2)
  assert.equal(fake.posted.filter((each) => each.event === M.error).length, 0)
  runtime.dispose()
})

test('mount(Panel) draws in every runtime started after it, once setup ran, as a default export does', async () => {
  const order: string[] = []
  const Panel = () => {
    order.push('render')
    return jsx('Text', { children: 'mounted' })
  }
  // At the module's top level: before Studio starts a runtime.
  mount(Panel)
  for (const run of [1, 2]) {
    const fake = fakeBridge()
    const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync, awaitHydration: true })
    const booted = runtime.boot({ setup: () => void order.push(`setup ${run}`) })
    const ready = fake.posted.find((each) => each.event === M.ready)!
    order.push(`ready ${run}`)
    assert.equal(fake.renders().length, 0, 'nothing renders before the window hydrates')
    fake.send(M.hydrate, { document: ready.payload.document, visible: true })
    await booted
    assert.match(JSON.stringify(fake.renders()[0]?.payload.tree), /mounted/)
    runtime.dispose()
  }
  assert.deepEqual(order, ['ready 1', 'setup 1', 'render', 'ready 2', 'setup 2', 'render'])
})

test('an async onChange: the edit counts as handled once the handler settles, so typed text is never dropped', async () => {
  const fake = fakeBridge()
  const draft = atom('')
  let release: () => void = () => undefined
  const runtime = installComponentsRuntime({ bridge: fake.bridge, schedule: sync })
  await runtime.boot({
    default: () =>
      jsx('Input', {
        label: 'Draft',
        value: read(draft),
        onChange: async (value: string) => {
          await new Promise<void>((done) => (release = done))
          set(draft, value)
        },
      }),
  })
  const tree = fake.renders()[0]!.payload.tree as { props: Record<string, unknown> }
  const callback = (tree.props.onChange as { $callback: string }).$callback
  runtime.dispatchEvent({ document: runtime.document, revision: 1, callback, args: ['ab'], edit: 1 })
  // Whatever renders while the handler waits has not seen the edit: an echo the window leaves alone.
  runtime.rerender()
  for (const each of fake.renders()) assert.equal((each.payload.tree as { props: { $edit: number } }).props.$edit, 0)
  release()
  await tick()
  const after = fake.renders().at(-1)!.payload.tree as { props: Record<string, unknown> }
  assert.equal(after.props.value, 'ab')
  assert.equal(after.props.$edit, 1)
  runtime.dispose()
})

test('on(), worker.on() and host.call() before the panel runs throw, naming where to call them', () => {
  const sdk = createComponentsSdk({ bridge: () => null, theme: () => ({ colorScheme: 'dark' }) })
  assert.throws(
    () => sdk.on('workspace.changed', () => undefined),
    /on\("workspace\.changed"\) was called before the panel runs; call it from setup\(ctx\)/u,
  )
  assert.throws(() => sdk.worker.on('*', () => undefined), /worker\.on\("\*"\) was called before the panel runs/u)
  assert.throws(
    () => sdk.host.call('workspace.list'),
    /host\.call\("workspace\.list"\) was called before the panel runs/u,
  )
})
