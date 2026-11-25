// The testing kit for components panels (`mountPanel`, `defineCheck`): a
// panel's module on the real runtime, drawn as Studio draws it, acted on as
// the person would, against a fake Studio that refuses what Studio refuses.

import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import { atom, env, host, jsx, read, set, settings, shell, update, type Atom } from '../src/components/index.js'
import { forgetKeyedAtoms } from '../src/components/runtime/atoms.js'
import { hostError } from '../src/testing.js'
import { defineCheck, mountPanel, runPanelScenario, stored } from '../src/testing-components.js'

afterEach(() => forgetKeyedAtoms())

const manifest = { id: 'kit', permissions: ['settings:own'] }

test('a counter with a persisted atom: press, then the stored value', async () => {
  const count = atom('count', 0, { persist: 'plugin' })
  const Panel = () =>
    jsx('Stack', {
      children: [
        jsx('Text', { children: ['Clicked ', read(count), ' times'] }),
        jsx('Button', { onPress: () => update(count, (n: number) => n + 1), children: 'Click' }),
        jsx('Button', { variant: 'ghost', onPress: () => set(count, 0), children: 'Reset' }),
      ],
    })
  const view = await mountPanel({ default: Panel }, { manifest, persisted: { plugin: { count: 4 } } })
  assert.ok(view.find({ text: 'Clicked 4 times' }))
  await view.press({ role: 'button', text: 'Click' })
  await view.press({ role: 'button', text: 'Click' })
  assert.ok(view.find({ text: /Clicked 6/ }))
  assert.deepEqual(view.persisted.plugin, { count: 6 })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('an atom stored by an older version is migrated', async () => {
  const name = atom(
    'name',
    { first: '', last: '' },
    {
      persist: 'workspace',
      version: 2,
      migrate: (old, from) => (from === 1 ? { first: String(old), last: '' } : { first: '', last: '' }),
    },
  )
  const view = await mountPanel(() => jsx('Text', { children: read(name).first }), {
    manifest,
    persisted: { workspace: { name: stored('Ada', 1) } },
  })
  assert.equal(view.tree()?.children[0], 'Ada')
  await view.unmount()
})

test('a form: typed text survives renders that lag it, a submit resets it, a Select and a Switch report', async () => {
  const draft = atom('draft', '')
  const items = atom<string[]>([])
  const kind = atom('kind', 'bug')
  const urgent = atom('urgent', false)
  const Panel = () =>
    jsx('Stack', {
      children: [
        jsx('Input', {
          label: 'Title',
          value: read(draft),
          onChange: (value: string) => set(draft, value),
          onSubmit: (value: string) => {
            update(items, (now: string[]) => [...now, value])
            set(draft, '')
          },
        }),
        jsx('Select', {
          label: 'Kind',
          value: read(kind),
          options: [
            { value: 'bug', label: 'Bug' },
            { value: 'idea', label: 'Idea' },
            { value: 'gone', label: 'Gone', disabled: true },
          ],
          onChange: (value: string) => set(kind, value),
        }),
        jsx('Switch', { label: 'Urgent', checked: read(urgent), onChange: (value: boolean) => set(urgent, value) }),
        jsx('List', {
          label: 'Items',
          children: read(items).map((item, index) => jsx('ListItem', { title: item }, index)),
        }),
      ],
    })
  const view = await mountPanel(Panel, { manifest })
  await view.type({ label: 'Title' }, 'Ship')
  assert.equal(view.valueOf({ label: 'Title' }), 'Ship')
  await view.type({ label: 'Title' }, ' it', { submit: true })
  assert.equal(view.valueOf({ label: 'Title' }), '')
  assert.ok(view.find({ role: 'listitem', label: 'Ship it' }))
  await view.select({ label: 'Kind' }, 'idea')
  assert.equal(view.valueOf({ label: 'Kind' }), 'idea')
  await assert.rejects(view.select({ label: 'Kind' }, 'gone'), /disabled/)
  await view.toggle({ role: 'switch' })
  assert.equal(view.valueOf({ label: 'Urgent' }), true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a panel that ignores edits keeps what the person typed (uncontrolled), and a read-only value refuses typing', async () => {
  const view = await mountPanel(
    () =>
      jsx('Stack', {
        children: [
          jsx('Input', { label: 'Free', onChange: () => undefined }),
          jsx('Input', { label: 'Fixed', value: 'set by the panel' }),
        ],
      }),
    { manifest },
  )
  await view.type({ label: 'Free' }, 'abc')
  assert.equal(view.valueOf({ label: 'Free' }), 'abc')
  await assert.rejects(view.type({ label: 'Fixed' }, 'x'), /takes no edits/)
  await view.unmount()
})

test('a Table sorts, selects, activates and loads more; a Tree expands and selects', async () => {
  const sort = atom<{ column: string; direction: 'asc' | 'desc' }>({ column: 'name', direction: 'asc' })
  const picked = atom<string[]>([])
  const opened = atom<string[]>([])
  const more = atom(0)
  const rows = [
    { key: 'a', cells: { name: 'Alpha', size: 3 } },
    { key: 'b', cells: { name: 'Beta', size: 1 } },
  ]
  const Panel = () => {
    const { column, direction } = read(sort)
    const ordered = [...rows].sort((x, y) => {
      const order = String(x.cells[column as 'name']).localeCompare(String(y.cells[column as 'name']))
      return direction === 'asc' ? order : -order
    })
    return jsx('Stack', {
      children: [
        jsx('Table', {
          label: 'Files',
          columns: [
            { key: 'name', label: 'Name', sortable: true },
            { key: 'size', label: 'Size' },
          ],
          rows: ordered,
          sort: read(sort),
          selectionMode: 'multiple',
          selected: read(picked),
          hasMore: read(more) === 0,
          onSortChange: (next: { column: string; direction: 'asc' | 'desc' }) => set(sort, next),
          onSelectionChange: ({ keys }: { keys: string[] }) => set(picked, keys),
          onRowAction: ({ key }: { key: string }) => update(opened, (now: string[]) => [...now, key]),
          onLoadMore: () => update(more, (n: number) => n + 1),
        }),
        jsx('Tree', {
          label: 'Folders',
          items: [{ key: 'src', label: 'src', children: [{ key: 'src/a', label: 'a.ts' }] }],
          onSelect: ({ key }: { key: string }) => update(opened, (now: string[]) => [...now, `tree:${key}`]),
        }),
      ],
    })
  }
  const view = await mountPanel(Panel, { manifest })
  assert.deepEqual(view.rowsOf({ role: 'table' }), ['a', 'b'])
  await view.sort({ role: 'table' }, 'name')
  assert.deepEqual(view.rowsOf({ role: 'table' }), ['b', 'a'])
  await assert.rejects(view.sort({ role: 'table' }, 'size'), /not sortable/)
  await view.selectRows({ role: 'table' }, ['a', 'b'])
  assert.deepEqual(view.valueOf({ role: 'table' }), ['a', 'b'])
  await view.activateRow({ role: 'table' }, 'b')
  await view.loadMore({ role: 'table' })
  await assert.rejects(view.loadMore({ role: 'table' }), /no more rows/)
  await view.expand({ role: 'tree' }, 'src')
  assert.deepEqual(view.expandedOf({ role: 'tree' }), ['src'])
  await view.selectItem({ role: 'tree' }, 'src/a')
  assert.deepEqual(read(opened), ['b', 'tree:src/a'])
  await view.unmount()
})

test('finders see what Studio draws: the selected tab, an open Collapsible', async () => {
  const view = await mountPanel(
    () =>
      jsx('Stack', {
        children: [
          jsx('Tabs', {
            label: 'Views',
            onChange: () => undefined,
            children: [
              jsx('Tab', { value: 'one', label: 'One', children: jsx('Text', { children: 'first' }) }),
              jsx('Tab', { value: 'two', label: 'Two', children: jsx('Text', { children: 'second' }) }),
            ],
          }),
          jsx('Collapsible', {
            title: 'More',
            onChange: () => undefined,
            children: jsx('Text', { children: 'hidden' }),
          }),
        ],
      }),
    { manifest },
  )
  assert.ok(view.find({ text: 'first' }))
  assert.equal(view.find({ text: 'second' }), null)
  await view.select({ role: 'tablist' }, 'two')
  assert.ok(view.find({ text: 'second' }))
  assert.equal(view.find({ text: 'hidden' }), null)
  await view.toggle({ label: 'More' })
  assert.ok(view.find({ text: 'hidden' }))
  await view.unmount()
})

test('errors, warnings and refusals: what Studio would refuse, drop, or the panel threw', async () => {
  const boom = atom(false)
  const Panel = () => {
    if (read(boom)) throw new Error('kaboom')
    return jsx('Stack', {
      children: [
        jsx('Button', { colour: 'red', onPress: () => set(boom, true), children: 'Break' }),
        jsx('Button', {
          onPress: async () => {
            // Caught by the panel, still a refusal: the manifest does not ask for files.
            await host.call('files.read', { workspaceId: 'ws-app', path: 'a' }).catch(() => undefined)
          },
          children: 'Read',
        }),
      ],
    })
  }
  const view = await mountPanel(Panel, { manifest })
  assert.deepEqual(view.warnings, ['Button: ignored unknown prop "colour"'])
  await view.press({ text: 'Read' })
  assert.equal(view.refusals[0]?.method, 'files.read')
  assert.equal(view.refusals[0]?.code, 'not_permitted')
  await view.press({ text: 'Break' })
  assert.match(view.errors[0]?.message ?? '', /kaboom/)
  // The last good tree stays.
  assert.ok(view.find({ text: 'Break' }))
  await view.unmount()

  const refused = await mountPanel(() => jsx('Text', { children: jsx('Button', { children: 'no' }) }), { manifest })
  assert.match(refused.errors[0]?.message ?? '', /Studio would not draw this render/)
  await refused.unmount()
})

test('setup runs before the first render and its cleanup on unmount; visibility and theme reach the panel', async () => {
  const log: string[] = []
  let visible: Atom<boolean> | null = null
  const view = await mountPanel(
    {
      setup(ctx: { visible: Atom<boolean> }) {
        log.push('setup')
        visible = ctx.visible
        return () => log.push('cleanup')
      },
      default: () => jsx('Text', { children: `${env.theme.colorScheme} ${read(visible!) ? 'shown' : 'hidden'}` }),
    },
    { manifest, theme: 'dark' },
  )
  assert.equal(view.tree()?.children[0], 'dark shown')
  await view.emit('theme', { colorScheme: 'light' })
  await view.setVisible(false)
  assert.equal(view.tree()?.children[0], 'light hidden')
  await view.unmount()
  assert.deepEqual(log, ['setup', 'cleanup'])
})

test('a press grants one gesture: openExternal works after it, not before', async () => {
  const Panel = () =>
    jsx('Button', {
      onPress: () => void shell.openExternal('https://example.com/docs'),
      children: 'Docs',
    })
  const view = await mountPanel(Panel, { manifest })
  await view.press({ text: 'Docs' })
  assert.deepEqual(view.studio.openedUrls, ['https://example.com/docs'])
  await assert.rejects(shell.openExternal('https://example.com/again') as Promise<unknown>, /press/)
  await view.unmount()
})

test('a scenario: stubbed results, storage and events, summarized', async () => {
  const scenarios = defineCheck({
    empty: {},
    full: {
      results: { 'settings.get': () => ({ greeting: 'hi' }) },
      storage: { note: 'kept' },
      events: [{ event: 'theme', payload: { colorScheme: 'dark' } }],
    },
    broken: { results: { 'settings.get': () => Promise.reject(hostError('unavailable')) } },
  })
  const greeting = atom('greeting', '')
  const note = atom('note', '', { persist: 'storage' })
  const panel = {
    setup() {
      void settings
        .get('greeting')
        .then((value) => set(greeting, String(value ?? '')))
        // Refused in one scenario: the panel shows its empty state, and the refusal is recorded.
        .catch(() => undefined)
    },
    default: () =>
      read(greeting)
        ? jsx('Stack', {
            children: [
              jsx('Heading', { children: read(greeting) }),
              jsx('Text', { tone: 'danger', children: read(note) }),
              jsx('Text', { children: env.theme.colorScheme }),
            ],
          })
        : jsx('EmptyState', { title: 'Nothing yet' }),
  }
  const base = { manifest: { ...manifest, permissions: ['settings:own', 'storage:own'] }, panelId: 'panel' }
  const empty = await runPanelScenario(panel, scenarios.empty, base)
  assert.deepEqual(empty.summary, ['empty state: Nothing yet'])
  const full = await runPanelScenario(panel, scenarios.full, base)
  assert.deepEqual(full.summary, ['heading: hi', 'danger text: kept'])
  assert.match(JSON.stringify(full.tree), /dark/)
  const broken = await runPanelScenario(panel, scenarios.broken, base)
  assert.deepEqual(broken.summary, ['empty state: Nothing yet'])
  assert.equal(broken.refusals[0]?.code, 'unavailable')
})
