# Components panels: Studio's own controls

A components panel describes its UI as data. Its module runs hidden and
sandboxed and renders a tree of Studio's components; Studio checks the tree
and draws it with its own controls, so the panel matches the app in light and
dark, follows its keyboard and focus rules, and needs no HTML and no CSS. Use
one for lists, forms, tables, trees and status: most panels an extension
needs. Draw your own page (a panel without `ui`, the `styling` topic) only for
what the catalogue cannot draw: a canvas, a chart, a custom widget.

Start from the template: `extension.create` with `template: "components"`, or
`npx sprintengine-extension init my-panel --template components`. It makes a
checklist panel with its tests and check scenarios. The SDK's
`examples/components-sample/` folder has three more: a counter, a form, and a
table with a tree.

## The manifest

A panel with `"ui": "components"`. Its `entry` is the module: `.tsx`, `.ts`,
`.jsx` or `.mts` as written, or a bundled `.js` or `.mjs`.

```json
{
  "tier": "ui",
  "contributes": {
    "panels": [
      { "id": "checklist", "title": "Checklist", "icon": "check", "entry": "src/panel.tsx", "ui": "components" }
    ]
  }
}
```

It asks for no permission of its own. Persisted atoms need none either; what
it calls Studio for needs what that call needs (`storage:own` for storage,
`settings:own` for Settings values, `secrets:own` for secrets).

## Writing a panel

The entry's default export is a component: a function returning JSX of the
catalogue's components, which it imports by name from
`@sprintengine/extension-sdk/components`. Studio provides that module when it
loads the panel; the panel never bundles it.

```tsx
import { atom, read, update, Button, Stack, Text } from '@sprintengine/extension-sdk/components'

const count = atom('count', 0, { persist: 'plugin' })

export default function Counter() {
  return (
    <Stack gap="sm">
      <Text>Pressed {read(count)} times</Text>
      <Button onPress={() => update(count, (n) => n + 1)}>Press</Button>
    </Stack>
  )
}
```

- Studio compiles the `.tsx` with the automatic JSX runtime, its import source
  `@sprintengine/extension-sdk/components`. For TypeScript to check it the
  same way, the project's tsconfig.json has `"jsx": "react-jsx"` and
  `"jsxImportSource": "@sprintengine/extension-sdk/components"` (the template
  has them).
- There are no lowercase tags: a components panel never draws HTML. Your own
  function components are fine; they are called while rendering, and only
  the catalogue's components reach Studio.
- `mount(Component)` from the same module draws a component too, for an entry
  that does not default-export one. It is drawn where a default export is:
  after the stored atoms load and `setup` runs.
- The entry imports its own files by relative paths, as every surface does,
  and nothing else by a package name but the components module.
- A `key` on an element keeps its identity across renders (`list.map((item)
  => <ListItem key={item.id} …/>)`); two siblings with the same key refuse the
  render.
- An event handler is a prop (`onPress`, `onChange`, …). Studio runs the one
  bound in the tree the person saw, never one a newer render moved.

## State: atoms

There are no hooks. State lives in atoms; reading one while rendering draws
the panel again whenever it changes, at most about once a frame.

| Call | What it does |
| --- | --- |
| `atom(initial)` | An atom for this panel run |
| `atom(key, initial, { persist, version, migrate })` | A named atom: `key` is 1–128 letters, digits or `. _ : -`, unique in the extension |
| `derived(() => …)` | A read-only atom computed from others |
| `read(atom)` | Its value; while rendering, the render follows it |
| `set(atom, value)` | Store a value, from an event handler |
| `update(atom, (previous) => next)` | Replace the value with what the function returns |

`set` and `update` while rendering throw: a write there would render again for
ever. Call them from handlers, `setup`, or a promise's callback.

A named atom's `persist` says where its value lives:

| `persist` | Kept | Read by |
| --- | --- | --- |
| `memory` (the default) | This run. A development folder's reload hands keyed memory atoms to the next run, so half-typed text survives a save | The panel |
| `plugin` | Every run, the same in every workspace, stored by Studio for the extension | The panel |
| `workspace` | Every run, per workspace | The panel |
| `storage` | The extension's storage under the atom's key (needs `storage:own`) | The panel, and the worker with `getModuleStorage` |

Studio reads the `plugin` and `workspace` atoms before the first render, and
stores a change about 400 ms after it, or at once when the panel is hidden or
closes. Values are plain JSON: a value that is not is refused with an error
and kept for this run only. A value is at most 512 KiB (about its size as
JSON), and each scope's atoms together at most 1 MiB; past either, the error
says so and the value is kept for this run only. A write Studio turned away
for coming too often is sent again shortly, with the atom's value then. A
`workspace` atom in a panel opened outside a workspace is kept for the run
alone.

**Versions.** When a stored shape changes, raise `version` (a whole number
from 1) and give `migrate(stored, fromVersion)`, which turns what an older
version stored into the new shape. Without `migrate`, a value of an older
version is not read and the atom starts from `initial`. A `migrate` that
throws is reported as the panel's error, and that atom alone starts from
`initial`. A value a newer version stored (another build of the extension) is
never migrated: the atom starts from `initial`, and the stored value stays
until the atom changes. A development folder's reload never migrates: a
memory atom whose version changed starts over.

```ts
const name = atom('name', { first: '', last: '' }, {
  persist: 'workspace',
  version: 2,
  migrate: (old, from) => (from === 1 ? { first: String(old), last: '' } : { first: '', last: '' }),
})
```

**`storage` atoms are read once.** The value is read from storage before the
first render (or when the atom is made, after it), and each change is written
back. It does not change while the panel runs when the worker writes that key:
have the worker `emit` an event and `set` the atom from `worker.on`, or read
the key again with `storage.get`.

## Lifetime and setup

A run starts when the panel opens and ends when it closes (or, in a
development folder, when a save reloads it). In order: the module loads,
Studio hands over the persisted atoms, `setup` runs, then the first render.

An optional named export `setup(ctx)` runs once per run, before the first
render, and may return a cleanup function, which runs when the run ends.

The module's top level runs before Studio starts the panel: `on()`,
`worker.on()` and `host.call()` there throw an error that says so. Call them
from `setup` or a handler.

| `ctx.` | What it is |
| --- | --- |
| `subscriptions` | Push a `Disposable` (`on(…)`, `worker.on(…)`) and it is disposed when the run ends |
| `signal` | An `AbortSignal` that aborts when the run ends: hand it to long calls |
| `visible` | A read-only atom: true while the person can see the panel. Read it while rendering, or pause polling while it is false |
| `panel` | `{ id, workspaceId? }`: which panel, in which workspace |

```ts
import { atom, set, worker, type PanelContext } from '@sprintengine/extension-sdk/components'

const progress = atom(0)
const status = atom<unknown>(null)

export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(worker.on('progress', (payload) => set(progress, payload as number)))
  void worker.read('status').then((answer) => set(status, answer))
}
```

## Talking to Studio

The same module exports what a panel reaches Studio with. Each call goes
through the window to Studio's gate, as a frame's calls do, and is checked
against the permissions in extension.json and against whoever opened the
panel.

| Export | What it reaches |
| --- | --- |
| `host.call(method, params, { signal?, timeoutMs? })`, `host.has(method)` | Any frame host method (the `api-renderer` topic): `workspace.list`, `files.read`, `chat.draft`, `toast`, … A refusal rejects with its `code` |
| `env.locale`, `env.theme`, `env.client` | Studio's language; `{ colorScheme }` (reading it while rendering draws again when the person switches light and dark); `'desktop'` (a local or paired desktop window) or `'web'` |
| `ui.catalog`, `ui.has(component, prop?)` | The catalogue version this Studio draws (now 4), and whether it draws a component or takes a prop on it |
| `storage.get(key)`, `.set(key, value)`, `.delete(key)`, `.keys({ prefix })` | The extension's storage, each taking `{ workspaceId }` for a workspace's (`storage:own`) |
| `settings.get(key?)`, `settings.set(key, value)` | Its Settings values (`settings:own`) |
| `secrets.has(key)`, `secrets.set(key, value, { allowedOrigins })`, `secrets.delete(key)` | Its secrets (`secrets:own`). The value goes in and never comes back to a panel: only whether one is set does. The worker sends it, with `fetchWithSecret`, to the origins given |
| `worker.read(method, params)`, `worker.operate(method, params)` | Its worker's declared methods (`registerMethods`), as `read` or `operate` |
| `worker.on(topic, handler)` | The worker's events (`studio.emit(topic, payload)`); `'*'` hears every topic as `{ topic, payload }` |
| `on(event, handler)` | Studio's events (`workspace.changed`, …, the `events` topic), with each event's read permission, and `'theme'` |
| `shell.openExternal(url)` | Open an `https:`, `http:` or `mailto:` URL in the system browser of the machine the window is on, after a press (below) |

**The gesture rule.** Opening a URL needs the person: a press on one of
Studio's own controls (a `Button`, `IconButton`, `ListItem` or `Link`) grants
the panel one `shell.openExternal`, and only when that control has stood still
for 500 ms: the same place in the tree, the same type, label and target, and
the same position on screen. Anything that moves it, a sibling growing above
it included, starts the wait again, so a panel cannot slide a control under
the pointer just before a click. Scrolling the panel is not a move. Studio
asks the person before a web address opens. A `Link` with an `href`, and a
link in `Markdown`, open the same way without a handler. There is no file save
dialog: write a workspace's file with `files.write` (`workspace-files:write`),
or hand the data to the worker.

## Hot reload

In a development folder (`npm run dev`), a save starts a new run of the panel
and Studio keeps the old tree on screen until the new one draws:

- keyed memory atoms are handed to the new run, so what was typed, the tab
  shown and the row picked stay (plain JSON only; another value, or a changed
  `version`, starts that atom over); `plugin` and `workspace` atoms are read
  from where they are stored, as always;
- the new run's first tree replaces the old one with a brief "Reloaded" mark;
- a save that does not load (a syntax error, a throw before the first render)
  leaves the last good tree on screen, inert, under the error at its
  `file:line:column`. The next good save takes over.

An unkeyed `atom(initial)` starts over on every reload: key what should
survive one.

## No build step, or a bundle

Studio loads the `.tsx` as written, compiling its types and JSX away with every
line kept, so an error's line is your line. To bundle instead (a library of
your own, many files into one), bundle to a `.js` or `.mjs` entry with the
components module left out of the bundle, so the panel uses the one Studio
provides:

```sh
esbuild src/panel.tsx --bundle --format=esm --outfile=extension/dist/panel.js \
  --jsx=automatic --jsx-import-source=@sprintengine/extension-sdk/components \
  --external:@sprintengine/extension-sdk/components*
```

A bundle that includes its own copy of the module draws nothing: its atoms and
components belong to a runtime Studio never started.

## Testing

`mountPanel` from `@sprintengine/extension-sdk/testing` boots the panel as
Studio does, in Node with no window: the panel's own module on the real
components runtime, against the SDK's fake Studio (which refuses what Studio
refuses), each render checked as Studio checks it. `npm test`
(`sprintengine-extension test`) runs `test/*.test.ts` and `.tsx` with `node
--test`, or the project's own Vitest, the panel's JSX compiled as Studio
compiles it and the components module and the testing kit the SDK's own
copies, so the panel and the test share one runtime. Import `test` and
`assert` from the runner (`node:test`, `node:assert/strict`, or Vitest): the
testing module does not re-export them.

```tsx
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mountPanel, stored } from '@sprintengine/extension-sdk/testing'
import * as panel from '../extension/src/panel'
import { manifest } from './manifest'

test('an item typed and added is kept for the workspace', async () => {
  const view = await mountPanel(panel, { manifest, panelId: 'checklist' })
  await view.type({ label: 'New item' }, 'Water the plants', { submit: true })
  assert.ok(view.find({ role: 'checkbox', label: 'Water the plants' }))
  assert.equal(view.valueOf({ label: 'New item' }), '')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
```

`mountPanel(module | Component, options)` takes the fake Studio's options
(`manifest`, `settings`, `secrets`, `results` by host method, `workspaces`,
`files`, `backlogItems`, `invoker`, `main` for a worker from
`createFakeMainHost`), or `studio` (one made beforehand), and `panelId`
(default `panel`), `workspaceId` (null for none), `theme`, `locale`, `client`,
`visible` and `persisted` (`{ plugin, workspace }`: values an earlier run
stored; `stored(value, version)` stores one as an older version did, to test
`migrate`). It resolves once the panel has drawn. One panel runs at a time.

| On the view | What it does |
| --- | --- |
| `find(query)`, `findAll(query)` | Elements as drawn, by `{ type, role, text, label, testId }`: `text` and `label` exact or a RegExp, `label` a control's label or a card's, list item's or collapsible's title, `testId` the element's `key` |
| `press`, `type(target, text, { replace?, submit? })`, `submit`, `toggle`, `select(target, value)`, `slide(target, value)` | Act as the person: a press on a Button, IconButton, Link or ListItem; typing one edit per character; a Switch, Checkbox or Collapsible; a Select, RadioGroup or Tabs |
| `sort(table, column)`, `selectRows(table, keys)`, `activateRow(table, key)`, `loadMore(table)` | A Table |
| `expand(tree, key)`, `collapse`, `selectItem`, `activateItem` | A Tree |
| `valueOf(target)`, `rowsOf(table)`, `expandedOf(tree)`, `tree()` | What Studio shows: a control's value by the edit protocol, a Table's rows in the order drawn, a Tree's open items, the whole tree with handlers as `'[handler]'` |
| `errors`, `warnings`, `refusals` | What the panel threw and the renders Studio would refuse; the props and components it would drop; every call it refused, even one the panel caught |
| `persisted` | `{ plugin, workspace, storage }` as stored |
| `emit(event, payload)`, `post(topic, payload)`, `setVisible(visible)` | Studio's event or the theme; the worker's event; whether the person can see it |
| `rerender()`, `settled()`, `unmount()` | Render again; wait for renders, calls and stored writes; end the run (`setup`'s cleanup runs) |
| `studio` | The fake Studio behind it: its `calls`, `toasts`, `undeclared`, … |

A `results` entry may be a function of the params that throws
`hostError(code)` (from the same module), to see the panel handle a refusal.
Every press grants a gesture: the 500 ms stationary rule is Studio's window's,
and the test kit does not apply it.

## Check scenarios

`sprintengine-extension check` (and `npm run check`, and `npm run dev`'s
`--check` after every save) renders each components panel against the fake
Studio: once against an empty Studio, or once per scenario when the entry has
a `<entry-stem>.check.ts` beside it (`src/panel.check.ts` for
`src/panel.tsx`). Its default export is `defineCheck({ … })`, scenarios by
name:

```ts
import { defineCheck, hostError } from '@sprintengine/extension-sdk/testing'

export default defineCheck({
  empty: {},
  'with items': { persisted: { workspace: { items: [{ id: 'milk', text: 'Buy milk', done: false }] } } },
  'worker down': { results: { 'worker.read': () => { throw hostError('unavailable') } } },
})
```

A scenario takes `persisted`, `storage` (the extension's storage, by key),
`settings`, `secrets`, `results`, `theme`, `visible`, `workspaceId`,
`workspaces`, `files`, `backlogItems`, `invoker`, and `events` (`[{ event,
payload }]`, delivered in order after the first draw). With a worker, it is
activated first, so `worker.read` reaches its methods.

For each scenario `check` prints a few lines of what was drawn (headings,
notices, empty states, tables and trees with their row counts, the tab
selected, loading, placeholders), then its errors, which fail the check (a
throw, at its `file:line:column`; a render Studio would refuse), and its
warnings, which do not (props and components Studio would drop, and calls it
would refuse). `--json` answers them in `panels` (`{ ok, panels: [{ id,
entry, scenarios?, results: [{ name, summary, errors, warnings, refusals, tree
}] }], logs }`), the tree included.

## Shots

`sprintengine-extension shot` (and `npm run dev`'s `--shot`) draws a
components panel's tree with Studio's own renderer, as the window draws it, in
the theme asked for: open the PNG to see the panel. Its host calls are
answered by Studio. `shot <dir> --scenario <name>` pictures the panel in one
of its `.check.ts` scenarios instead: rendered on this machine as `check`
renders it, then drawn by Studio from that tree, so the scenario never
reaches the live panel or its worker.

## Inputs: Studio owns what is typed

A value control (`Input`, `Textarea`, `Switch`, `Checkbox`, `Select`,
`RadioGroup`, `Slider`, `Tabs`, `Collapsible`, a Table's selection, a Tree's
selected item) is either:

- **controlled**: `value` (or `checked`, `open`, `selected`) and its change
  handler. The panel holds the value in an atom and sets it in the handler.
  Studio owns what the person types while they type: each edit goes to the
  panel numbered, and a render that has not caught up with the person's
  typing is an echo and leaves the text alone, so no keystroke is lost to a
  slow render. A render that has seen every edit is the panel's word: setting
  the atom to `''` after a submit clears the box. A `value` with no handler is
  read-only.
- **uncontrolled**: `defaultValue` (`defaultChecked`, …), with or without a
  handler. Studio keeps the value; the panel hears it change.

`Input`'s `onSubmit` is Enter; `Textarea`'s is Cmd+Enter (Ctrl+Enter off
macOS). A Table's sort is the panel's: Studio draws the column a click asked
for and reports it with `onSortChange`, and the panel hands the rows over in
that order.

## The catalogue

Props are semantic only: tones, sizes and gaps, never classes, styles or
colours. `ui.has` says what this Studio draws; the catalogue version a
component arrived in is in the table. A prop Studio does not know, or a value
it refuses, is dropped with a warning; a component it does not know, or one
missing a required prop, is drawn as a neutral placeholder. The types in
`@sprintengine/extension-sdk/components` are the authority on each prop.

The shared vocabulary: `Gap` is `'none' | 'xs' | 'sm' | 'md' | 'lg'`, `Align`
`'start' | 'center' | 'end' | 'stretch'`, `Justify` `'start' | 'center' |
'end' | 'between'`, `Size` `'xs' | 'sm' | 'md'`, `Variant` `'solid' |
'outline' | 'ghost'`, `MaxHeight` `'sm' | 'md' | 'lg' | 'none'`, `Tone`
`'neutral' | 'accent' | 'success' | 'warning' | 'danger'`, `BoxLength`
pixels from 0 to 4096 or a whole percent (`'50%'`), `RelativeTimeFormat`
`'long'` ("5 minutes ago"), `'short'` ("5m ago") or `'duration'` ("5m").
`IconName` is one of `add`, `delete`, `edit`, `refresh`, `search`,
`settings`, `check`, `close`, `info`, `warning`, `error`, `open-external`,
`copy`, `download`, `play`, `stop`, `more`, `filter`, `branch`, `file`,
`folder`, `terminal`, `agent`, `link`, `rocket`, `database`, `extension`,
`chat`, `schedule`, `spark`, `lock`, `notes`; `search`, `close`, `info`,
`download`, `filter`, `link`, `rocket` and `database` have no glyph in the app
yet and draw the neutral extension mark, as any other name does (with a
warning).

| Component | Catalogue | Holds | Props |
| --- | --- | --- | --- |
| `Stack` | 1 | any component | `gap?: Gap` · `align?: Align` |
| `Row` | 1 | any component | `gap?: Gap` · `align?: Align` · `justify?: Justify` · `wrap?: boolean` |
| `Text` | 1 | text, Text, Link, Code, Badge, RelativeTime | `tone?: Tone` · `muted?: boolean` · `size?: Size` · `weight?: 'regular' \| 'medium' \| 'semibold'` · `truncate?: boolean` |
| `Heading` | 1 | text, Text, Link, Code, Badge, RelativeTime | `level?: 1 \| 2 \| 3` |
| `Button` | 1 | text | `variant?: Variant` · `tone?: Tone` · `size?: Size` · `icon?: IconName` · `tooltip?: string` · `disabled?: boolean` · `onPress?: () => void \| Promise<void>` |
| `IconButton` | 1 | nothing | `icon: IconName` · `label: string` · `tooltip?: string` · `variant?: Variant` · `tone?: Tone` · `size?: Size` · `disabled?: boolean` · `onPress?: () => void \| Promise<void>` |
| `Badge` | 1 | text | `tone?: Tone` |
| `Card` | 1 | any component | `title?: string` · `description?: string` |
| `List` | 1 | ListItem only | `label?: string` |
| `ListItem` | 1 | any component | `title?: string` · `description?: string` · `icon?: IconName` · `current?: boolean` · `disabled?: boolean` · `onPress?: () => void \| Promise<void>` |
| `Input` | 1 | nothing | `label: string` · `labelHidden?: boolean` · `value?: string` · `defaultValue?: string` · `placeholder?: string` · `type?: 'text' \| 'search' \| 'password'` · `maxLength?: number` · `invalid?: boolean` · `disabled?: boolean` · `onChange?: (value: string) => void` · `onSubmit?: (value: string) => void` |
| `Switch` | 1 | nothing | `label: string` · `checked?: boolean` · `defaultChecked?: boolean` · `disabled?: boolean` · `onChange?: (checked: boolean) => void` |
| `Select` | 1 | nothing | `label: string` · `labelHidden?: boolean` · `value?: string` · `defaultValue?: string` · `placeholder?: string` · `options: SelectOption[]` · `disabled?: boolean` · `onChange?: (value: string) => void` |
| `Separator` | 1 | nothing | `orientation?: 'horizontal' \| 'vertical'` |
| `Progress` | 1 | nothing | `label: string` · `labelHidden?: boolean` · `value?: number` |
| `Spinner` | 1 | nothing | `label: string` · `labelHidden?: boolean` |
| `EmptyState` | 1 | any component | `title: string` · `description?: string` · `icon?: IconName` |
| `Link` | 1 | text | `href?: string` · `onPress?: () => void \| Promise<void>` |
| `Code` | 1 | text | `block?: boolean` |
| `Textarea` | 2 | nothing | `label: string` · `labelHidden?: boolean` · `value?: string` · `defaultValue?: string` · `placeholder?: string` · `rows?: number` · `maxLength?: number` · `invalid?: boolean` · `disabled?: boolean` · `onChange?: (value: string) => void` · `onSubmit?: (value: string) => void` |
| `Checkbox` | 2 | nothing | `label: string` · `description?: string` · `checked?: boolean` · `defaultChecked?: boolean` · `disabled?: boolean` · `onChange?: (checked: boolean) => void` |
| `RadioGroup` | 2 | nothing | `label: string` · `labelHidden?: boolean` · `value?: string` · `defaultValue?: string` · `options: RadioOption[]` · `orientation?: 'vertical' \| 'horizontal'` · `disabled?: boolean` · `onChange?: (value: string) => void` |
| `Slider` | 2 | nothing | `label: string` · `labelHidden?: boolean` · `value?: number` · `defaultValue?: number` · `min?: number` · `max?: number` · `step?: number` · `showValue?: boolean` · `disabled?: boolean` · `onChange?: (value: number) => void` |
| `Field` | 2 | any component | `label: string` · `description?: string` · `error?: string` · `required?: boolean` |
| `Tabs` | 2 | Tab only | `label: string` · `value?: string` · `defaultValue?: string` · `onChange?: (value: string) => void` |
| `Tab` | 2 | any component | `value: string` · `label: string` · `icon?: IconName` · `disabled?: boolean` |
| `Collapsible` | 2 | any component | `title: string` · `description?: string` · `open?: boolean` · `defaultOpen?: boolean` · `disabled?: boolean` · `onChange?: (open: boolean) => void` |
| `Toolbar` | 2 | any component | `label: string` · `gap?: Gap` |
| `Grid` | 2 | any component | `columns?: number` · `minItemWidth?: 'xs' \| 'sm' \| 'md' \| 'lg'` · `gap?: Gap` |
| `Table` | 2 | nothing | `label: string` · `columns: TableColumn[]` · `rows: TableRow[]` · `sort?: TableSort` · `selectionMode?: 'none' \| 'single' \| 'multiple'` · `selected?: string[]` · `defaultSelected?: string[]` · `hasMore?: boolean` · `loading?: boolean` · `emptyText?: string` · `maxHeight?: MaxHeight` · `onSortChange?: (sort: TableSort) => void` · `onSelectionChange?: (selection: { keys: string[] }) => void` · `onRowAction?: (row: { key: string }) => void` · `onLoadMore?: () => void` |
| `Tree` | 2 | nothing | `label: string` · `items: TreeItem[]` · `selected?: string` · `defaultSelected?: string` · `expanded?: string[]` · `defaultExpanded?: string[]` · `maxHeight?: MaxHeight` · `onSelect?: (item: { key: string }) => void` · `onToggle?: (item: { key: string; expanded: boolean }) => void` · `onAction?: (item: { key: string }) => void` |
| `Markdown` | 2 | nothing | `content: string` |
| `CodeView` | 2 | nothing | `code: string` · `language?: string` · `label?: string` · `lineNumbers?: boolean` · `wrap?: boolean` · `maxHeight?: MaxHeight` |
| `Image` | 2 | nothing | `src: string` · `alt: string` · `size?: 'xs' \| 'sm' \| 'md' \| 'lg' \| 'full'` · `fit?: 'contain' \| 'cover'` · `rounded?: boolean` |
| `KeyValue` | 2 | nothing | `label?: string` · `items: KeyValueItem[]` |
| `Callout` | 2 | any component | `tone?: Tone` · `title?: string` · `icon?: IconName` |
| `Skeleton` | 2 | nothing | `shape?: 'text' \| 'block' \| 'circle'` · `lines?: number` · `label?: string` |
| `RelativeTime` | 3 | nothing | `at: number` · `format?: RelativeTimeFormat` · `tone?: Tone` · `muted?: boolean` |
| `Box` | 4 | any component | `direction?: 'row' \| 'column'` · `gap?: Gap` · `padding?: Gap` · `paddingX?: Gap` · `paddingY?: Gap` · `margin?: Gap` · `align?: Align` · `justify?: Justify` · `wrap?: boolean` · `grow?: boolean` · `shrink?: boolean` · `width?: BoxLength` · `height?: BoxLength` · `minWidth?: BoxLength` · `minHeight?: BoxLength` · `maxWidth?: BoxLength` · `maxHeight?: BoxLength` · `columns?: number` · `scroll?: 'x' \| 'y' \| 'both'` · `border?: boolean \| Tone` · `radius?: 'none' \| 'sm' \| 'md' \| 'lg' \| 'full'` · `background?: 'none' \| 'muted' \| 'card' \| Tone` |

More of the shapes, as Studio checks them:

- `SelectOption` is `{ value, label, disabled? }`; `RadioOption` adds
  `description?`. `TableColumn` is `{ key, label, align?, width?, minWidth?,
  hideBelow?: 'sm' | 'md', sortable? }` (a column with `hideBelow` drops out
  below 360 or 480 pixels); `TableRow` is `{ key, cells, disabled? }`, a cell
  being text, a number, a boolean, null, or `{ type: 'relative', at, format?
  }`; `TableSort` is `{ column, direction: 'asc' | 'desc' }`. `TreeItem` is
  `{ key, label, description?, icon?, disabled?, hasChildren?, children? }`.
  `KeyValueItem` is `{ label, value, tone?, code? }`.
- `Progress`'s `value` is 0–100 (none: it runs without an end); `Grid` and
  `Box` take 1–6 `columns`; `Textarea`'s `rows` is 2–20; `Skeleton`'s `lines`
  1–10.
- A `Slider` has at most 1001 stops: a `step` finer than that over its range
  is widened.
- `CodeView` takes `lineNumbers`, and Studio does not draw line numbers yet.
- `Link`'s `href` is `https:`, `http:` or `mailto:`. `Image`'s `src` is a
  PNG, JPEG or WebP file in the extension (a relative path, never a URL), at
  most 8 MiB.
- A `ListItem` with `onPress` is one press target: it cannot hold another
  control.
- `Tabs` holds only `Tab`, and `List` only `ListItem`; each lives only there.

## Limits

One render is checked whole before Studio draws it. Structure and these limits
refuse a render, and then the last good one stays on screen and the panel's
log says why (a test's `errors`):

| Limit | |
| --- | --- |
| Nodes (components and texts) | 5000 |
| Depth | 64 |
| Size (text lengths plus a fixed cost per node and prop) | 512 KiB |
| A text | 16 KiB |
| A label, title, description or placeholder | 1024 characters |
| Props on one component | 32 |
| `Select` options | 500: more refuses the whole render |

A component's own data over its cap draws that component alone as a
placeholder, with a warning, and the rest of the panel draws:

| Data | Cap |
| --- | --- |
| A `Table`'s columns, rows | 32, 5000 |
| A `Tree`'s items (every level), depth | 2000, 16 |
| `RadioGroup` options | 50 |
| `KeyValue` items | 200 |
| `Markdown` and `CodeView` text | 64 KiB |

Renders are sent at most about once a frame, and share a budget of 640 KiB a
message and 200 messages every 10 seconds. Stored atoms have a budget of their
own, 640 KiB a write and 60 writes every 10 seconds; Studio splits a large
change across writes to fit.

## Isolation

The panel's module runs in a hidden, sandboxed frame of its own, as every
surface does: no network, no Node, nothing of Studio's window, and no DOM it
can show. All it hands Studio is the tree, which comes from the extension's
code and so is untrusted: Studio checks every render against the catalogue,
keeps only the props it knows, and draws them with its own controls. A press
runs only a handler bound in the tree on screen; links open only in the system
browser, after the gesture rule; images are only the extension's own files.
What the panel calls is checked at Studio's gate as the extension and as
whoever opened the panel.

## Clients

A components panel draws in the desktop window, in a paired desktop's window
and in the web client, by the same path as every extension frame; `env.client`
says `'desktop'` or `'web'`. `shell.openExternal` opens on the machine the
window is on. The phone does not show extension panels.
