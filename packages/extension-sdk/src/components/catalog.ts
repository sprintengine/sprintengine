// The components catalogue: every component a components panel may draw, the
// props each takes, what it may hold, and the limits on one render. Shared by
// Studio's window (which checks each tree before it draws it), the guest
// runtime (`ui.has`, `ui.catalog`) and the CLI's `check`, so what an author
// checks and what Studio draws cannot disagree.
//
// Props are semantic only: tones, sizes and gaps, never classes, styles or
// colours. A prop Studio does not know, or a value it refuses, is dropped with
// a warning; a component it does not know, or one missing a required prop, is
// drawn as a neutral placeholder. Only structure and the limits refuse a
// render, and then the last good one stays on screen.
//
// Plain TypeScript with no dependencies: the guest runtime bundles parts of it.

/** Caps on one render. Generous for a panel, small enough to check on every render. */
export const COMPONENT_LIMITS = {
  maxNodes: 5000,
  maxDepth: 64,
  /** Approximate size: string lengths plus a fixed cost per node and prop. */
  maxTreeBytes: 512 * 1024,
  maxTextLength: 16 * 1024,
  maxLabelLength: 1024,
  maxPropsPerNode: 32,
  maxSelectOptions: 500,
  maxEventArgs: 8,
  maxCallbackIdLength: 64,
  maxRadioOptions: 50,
  maxTableColumns: 32,
  maxTableRows: 5000,
  /** Items across every level of one Tree, and how deep they nest. */
  maxTreeItems: 2000,
  maxTreeItemDepth: 16,
  maxKeyValueItems: 200,
  /** Markdown and CodeView text. */
  maxDocumentLength: 64 * 1024,
  /** Keys in one object-shaped event argument (a Table's selection). */
  maxEventArgItems: 5000,
} as const

/** Grows with the catalogue, so a panel can feature-detect with `ui.catalog`. */
export const COMPONENT_CATALOG_VERSION = 4

/** The one colour vocabulary. */
export const COMPONENT_TONES = ['neutral', 'accent', 'success', 'warning', 'danger'] as const
export type ComponentTone = (typeof COMPONENT_TONES)[number]

/**
 * Icon names a component may take. A name outside the list draws a neutral
 * fallback glyph; the manifest's panel icons are all here.
 */
export const COMPONENT_ICONS = [
  'add',
  'delete',
  'edit',
  'refresh',
  'search',
  'settings',
  'check',
  'close',
  'info',
  'warning',
  'error',
  'open-external',
  'copy',
  'download',
  'play',
  'stop',
  'more',
  'filter',
  'branch',
  'file',
  'folder',
  'terminal',
  'agent',
  'link',
  'rocket',
  'database',
  'extension',
  'chat',
  'schedule',
  'spark',
  'lock',
  'notes',
] as const
export type ComponentIconName = (typeof COMPONENT_ICONS)[number]
const ICON_SET: ReadonlySet<string> = new Set(COMPONENT_ICONS)
export function isComponentIcon(name: unknown): name is ComponentIconName {
  return typeof name === 'string' && ICON_SET.has(name)
}

/** The wire-only prop on value controls: the newest edit the panel had handled when it rendered. */
export const COMPONENT_EDIT_PROP = '$edit'

/** What a callback prop looks like on the wire. */
export const COMPONENT_CALLBACK_ID = /^[A-Za-z0-9_.:-]+$/u
export type ComponentCallback = { $callback: string }

// ── Props, checked without a schema library ─────────────────────────────────

type Parsed = { ok: true; value: unknown } | { ok: false }
type Parser = (value: unknown) => Parsed
export type PropSpec = { required: boolean; parse: Parser }

const ok = (value: unknown): Parsed => ({ ok: true, value })
const no: Parsed = { ok: false }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const str =
  (options: { min?: number; max: number; pattern?: RegExp; check?: (value: string) => boolean }): Parser =>
  (value) =>
    typeof value === 'string' &&
    value.length >= (options.min ?? 0) &&
    value.length <= options.max &&
    (!options.pattern || options.pattern.test(value)) &&
    (!options.check || options.check(value))
      ? ok(value)
      : no

const num =
  (options: { int?: boolean; min?: number; max?: number; positive?: boolean } = {}): Parser =>
  (value) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!options.int || Number.isInteger(value)) &&
    (options.min === undefined || value >= options.min) &&
    (options.max === undefined || value <= options.max) &&
    (!options.positive || value > 0)
      ? ok(value)
      : no

const bool: Parser = (value) => (typeof value === 'boolean' ? ok(value) : no)
const nul: Parser = (value) => (value === null ? ok(null) : no)

const oneOf =
  (values: readonly (string | number)[]): Parser =>
  (value) =>
    (typeof value === 'string' || typeof value === 'number') && values.includes(value) ? ok(value) : no

const anyOf =
  (...parsers: Parser[]): Parser =>
  (value) => {
    for (const parser of parsers) {
      const parsed = parser(value)
      if (parsed.ok) return parsed
    }
    return no
  }

const arr =
  (item: Parser, options: { min?: number; max: number; uniqueBy?: string }): Parser =>
  (value) => {
    if (!Array.isArray(value) || value.length < (options.min ?? 0) || value.length > options.max) return no
    const out: unknown[] = []
    const seen = new Set<unknown>()
    for (const each of value) {
      const parsed = item(each)
      if (!parsed.ok) return no
      if (options.uniqueBy !== undefined) {
        const key = (parsed.value as Record<string, unknown>)[options.uniqueBy]
        if (seen.has(key)) return no
        seen.add(key)
      }
      out.push(parsed.value)
    }
    return ok(out)
  }

/** A strict object: an unknown field, or a field its parser refuses, refuses it whole. */
const obj =
  (fields: Record<string, PropSpec>): Parser =>
  (value) => {
    if (!isPlainObject(value)) return no
    const out: Record<string, unknown> = {}
    for (const [name, item] of Object.entries(value)) {
      if (item === undefined) continue
      const field = fields[name]
      if (!field || !Object.hasOwn(fields, name)) return no
      const parsed = field.parse(item)
      if (!parsed.ok) return no
      out[name] = parsed.value
    }
    for (const [name, field] of Object.entries(fields)) if (field.required && !Object.hasOwn(out, name)) return no
    return ok(out)
  }

const record =
  (key: Parser, item: Parser, max: number): Parser =>
  (value) => {
    if (!isPlainObject(value)) return no
    const entries = Object.entries(value)
    if (entries.length > max) return no
    const out: Record<string, unknown> = {}
    for (const [name, each] of entries) {
      if (!key(name).ok) return no
      const parsed = item(each)
      if (!parsed.ok) return no
      out[name] = parsed.value
    }
    return ok(out)
  }

const opt = (parse: Parser): PropSpec => ({ required: false, parse })
const req = (parse: Parser): PropSpec => ({ required: true, parse })

const L = COMPONENT_LIMITS
const label = str({ max: L.maxLabelLength })
const requiredLabel = str({ min: 1, max: L.maxLabelLength })
const text = str({ max: L.maxTextLength })
const icon = str({ max: 64, pattern: /^[a-z0-9-]{1,64}$/u })
const callback = opt(
  obj({
    $callback: req(str({ min: 1, max: L.maxCallbackIdLength, pattern: COMPONENT_CALLBACK_ID })),
  }),
)
const flag = opt(bool)
const gap = opt(oneOf(['none', 'xs', 'sm', 'md', 'lg']))
const align = opt(oneOf(['start', 'center', 'end', 'stretch']))
const justify = opt(oneOf(['start', 'center', 'end', 'between']))
const tone = opt(oneOf(COMPONENT_TONES))
const size = opt(oneOf(['xs', 'sm', 'md']))
const variant = opt(oneOf(['solid', 'outline', 'ghost']))
const maxHeight = opt(oneOf(['sm', 'md', 'lg', 'none']))
const itemKey = str({ min: 1, max: L.maxLabelLength })
const editAck = { [COMPONENT_EDIT_PROP]: opt(num({ int: true, min: 0, max: Number.MAX_SAFE_INTEGER })) }

/** How a `RelativeTime` reads: `long` "5 minutes ago", `short` "5m ago", `duration` "5m". */
export const RELATIVE_TIME_FORMATS = ['long', 'short', 'duration'] as const
export type RelativeTimeFormat = (typeof RELATIVE_TIME_FORMATS)[number]
const relativeCell = obj({
  type: req(oneOf(['relative'])),
  at: req(num()),
  format: opt(oneOf(RELATIVE_TIME_FORMATS)),
})

// An image file inside the extension: relative, `/`-separated, no `.` or `..`, never a URL.
const IMAGE_FILE = /\.(?:png|jpe?g|webp)$/iu
export function isComponentImagePath(path: string): boolean {
  return (
    IMAGE_FILE.test(path) &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path) &&
    !/[\\\0?#]/u.test(path) &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
}

/** Widths below which a Table column with `hideBelow` drops out (CSS pixels). */
export const TABLE_BREAKPOINTS = { sm: 360, md: 480 } as const

export type TreeItemData = {
  key: string
  label: string
  description?: string
  icon?: string
  disabled?: boolean
  hasChildren?: boolean
  children?: TreeItemData[]
}

const treeItemFields: Record<string, PropSpec> = {
  key: req(itemKey),
  label: req(requiredLabel),
  description: opt(label),
  icon: opt(icon),
  disabled: flag,
  hasChildren: flag,
  children: opt((value) => (Array.isArray(value) ? ok(value) : no)),
}

/** A Tree's items, iteratively: no stack for a deep list; over its caps or keys repeated, refused. */
const treeItems: Parser = (raw) => {
  if (!Array.isArray(raw)) return no
  const root: TreeItemData[] = []
  const keys = new Set<string>()
  const pending: { raw: unknown[]; out: TreeItemData[]; depth: number }[] = [{ raw, out: root, depth: 1 }]
  let count = 0
  const parseItem = obj(treeItemFields)
  for (let level = pending.pop(); level; level = pending.pop()) {
    if (level.depth > L.maxTreeItemDepth) return no
    for (const entry of level.raw) {
      if (++count > L.maxTreeItems) return no
      const parsed = parseItem(entry)
      if (!parsed.ok) return no
      const { children, ...fields } = parsed.value as TreeItemData & { children?: unknown[] }
      if (keys.has(fields.key)) return no
      keys.add(fields.key)
      const item: TreeItemData = fields
      level.out.push(item)
      if (children) {
        item.children = []
        pending.push({ raw: children, out: item.children, depth: level.depth + 1 })
      }
    }
  }
  return ok(root)
}

// Box lengths: pixels 0–4096 or a whole percent. Nothing else reaches the window's CSS.
const boxLength = opt(anyOf(num({ min: 0, max: 4096 }), str({ max: 4, pattern: /^(100|[1-9]?[0-9])%$/u })))

/**
 * What a component holds: `inline` is text plus Text, Link, Code, Badge and
 * RelativeTime; `items` and `tabs` hold only ListItem and Tab.
 */
export type ComponentChildPolicy = 'none' | 'text' | 'inline' | 'items' | 'tabs' | 'any'

type Entry = { props: Record<string, PropSpec>; children: ComponentChildPolicy; since: number }
const entry = (props: Record<string, PropSpec>, children: ComponentChildPolicy, since = 1): Entry => ({
  props,
  children,
  since,
})

export const COMPONENT_CATALOG = {
  Stack: entry({ gap, align }, 'any'),
  Row: entry({ gap, align, justify, wrap: flag }, 'any'),
  Text: entry(
    { tone, muted: flag, size, weight: opt(oneOf(['regular', 'medium', 'semibold'])), truncate: flag },
    'inline',
  ),
  Heading: entry({ level: opt(oneOf([1, 2, 3])) }, 'inline'),
  Button: entry(
    { variant, tone, size, icon: opt(icon), tooltip: opt(label), disabled: flag, onPress: callback },
    'text',
  ),
  IconButton: entry(
    {
      icon: req(icon),
      label: req(requiredLabel),
      tooltip: opt(label),
      variant,
      tone,
      size,
      disabled: flag,
      onPress: callback,
    },
    'none',
  ),
  Badge: entry({ tone }, 'text'),
  Card: entry({ title: opt(label), description: opt(label) }, 'any'),
  List: entry({ label: opt(label) }, 'items'),
  ListItem: entry(
    {
      title: opt(label),
      description: opt(label),
      icon: opt(icon),
      current: flag,
      disabled: flag,
      onPress: callback,
    },
    'any',
  ),
  Input: entry(
    {
      label: req(requiredLabel),
      labelHidden: flag,
      value: opt(text),
      defaultValue: opt(text),
      placeholder: opt(label),
      type: opt(oneOf(['text', 'search', 'password'])),
      maxLength: opt(num({ int: true, positive: true, max: L.maxTextLength })),
      invalid: flag,
      disabled: flag,
      onChange: callback,
      onSubmit: callback,
      ...editAck,
    },
    'none',
  ),
  Switch: entry(
    {
      label: req(requiredLabel),
      checked: flag,
      defaultChecked: flag,
      disabled: flag,
      onChange: callback,
      ...editAck,
    },
    'none',
  ),
  Select: entry(
    {
      label: req(requiredLabel),
      labelHidden: flag,
      value: opt(label),
      defaultValue: opt(label),
      placeholder: opt(label),
      // Over its cap the whole render is refused (tree.ts), as the limits say.
      options: req(
        arr(obj({ value: req(requiredLabel), label: req(requiredLabel), disabled: flag }), {
          max: Number.MAX_SAFE_INTEGER,
        }),
      ),
      disabled: flag,
      onChange: callback,
      ...editAck,
    },
    'none',
  ),
  Separator: entry({ orientation: opt(oneOf(['horizontal', 'vertical'])) }, 'none'),
  Progress: entry({ label: req(requiredLabel), labelHidden: flag, value: opt(num({ min: 0, max: 100 })) }, 'none'),
  Spinner: entry({ label: req(requiredLabel), labelHidden: flag }, 'none'),
  EmptyState: entry({ title: req(requiredLabel), description: opt(label), icon: opt(icon) }, 'any'),
  Link: entry(
    {
      // The window opens it in the system browser, never in Studio: no `javascript:` or `file:`.
      href: opt(str({ max: 2048, pattern: /^(https?:\/\/|mailto:)/iu })),
      onPress: callback,
    },
    'text',
  ),
  Code: entry({ block: flag }, 'text'),
  // ── Catalogue 2 ──
  Textarea: entry(
    {
      label: req(requiredLabel),
      labelHidden: flag,
      value: opt(text),
      defaultValue: opt(text),
      placeholder: opt(label),
      rows: opt(num({ int: true, min: 2, max: 20 })),
      maxLength: opt(num({ int: true, positive: true, max: L.maxTextLength })),
      invalid: flag,
      disabled: flag,
      onChange: callback,
      onSubmit: callback,
      ...editAck,
    },
    'none',
    2,
  ),
  Checkbox: entry(
    {
      label: req(requiredLabel),
      description: opt(label),
      checked: flag,
      defaultChecked: flag,
      disabled: flag,
      onChange: callback,
      ...editAck,
    },
    'none',
    2,
  ),
  RadioGroup: entry(
    {
      label: req(requiredLabel),
      labelHidden: flag,
      value: opt(label),
      defaultValue: opt(label),
      options: req(
        arr(
          obj({
            value: req(requiredLabel),
            label: req(requiredLabel),
            description: opt(label),
            disabled: flag,
          }),
          { max: L.maxRadioOptions },
        ),
      ),
      orientation: opt(oneOf(['vertical', 'horizontal'])),
      disabled: flag,
      onChange: callback,
      ...editAck,
    },
    'none',
    2,
  ),
  Slider: entry(
    {
      label: req(requiredLabel),
      labelHidden: flag,
      value: opt(num()),
      defaultValue: opt(num()),
      min: opt(num()),
      max: opt(num()),
      step: opt(num({ positive: true })),
      showValue: flag,
      disabled: flag,
      onChange: callback,
      ...editAck,
    },
    'none',
    2,
  ),
  Field: entry({ label: req(requiredLabel), description: opt(label), error: opt(label), required: flag }, 'any', 2),
  Tabs: entry(
    { label: req(requiredLabel), value: opt(label), defaultValue: opt(label), onChange: callback, ...editAck },
    'tabs',
    2,
  ),
  Tab: entry({ value: req(requiredLabel), label: req(requiredLabel), icon: opt(icon), disabled: flag }, 'any', 2),
  Collapsible: entry(
    {
      title: req(requiredLabel),
      description: opt(label),
      open: flag,
      defaultOpen: flag,
      disabled: flag,
      onChange: callback,
      ...editAck,
    },
    'any',
    2,
  ),
  Toolbar: entry({ label: req(requiredLabel), gap }, 'any', 2),
  Grid: entry(
    {
      columns: opt(num({ int: true, min: 1, max: 6 })),
      minItemWidth: opt(oneOf(['xs', 'sm', 'md', 'lg'])),
      gap,
    },
    'any',
    2,
  ),
  Table: entry(
    {
      label: req(requiredLabel),
      columns: req(
        arr(
          obj({
            key: req(str({ min: 1, max: 64 })),
            label: req(requiredLabel),
            align: opt(oneOf(['start', 'center', 'end'])),
            width: opt(oneOf(['auto', 'xs', 'sm', 'md', 'lg'])),
            minWidth: opt(oneOf(['auto', 'xs', 'sm', 'md'])),
            hideBelow: opt(oneOf(['sm', 'md'])),
            sortable: flag,
          }),
          { min: 1, max: L.maxTableColumns, uniqueBy: 'key' },
        ),
      ),
      rows: req(
        arr(
          obj({
            key: req(itemKey),
            cells: req(
              record(str({ min: 1, max: 64 }), anyOf(label, num(), bool, nul, relativeCell), L.maxTableColumns),
            ),
            disabled: flag,
          }),
          { max: L.maxTableRows, uniqueBy: 'key' },
        ),
      ),
      sort: opt(obj({ column: req(str({ min: 1, max: 64 })), direction: req(oneOf(['asc', 'desc'])) })),
      selectionMode: opt(oneOf(['none', 'single', 'multiple'])),
      selected: opt(arr(itemKey, { max: L.maxTableRows })),
      defaultSelected: opt(arr(itemKey, { max: L.maxTableRows })),
      hasMore: flag,
      loading: flag,
      emptyText: opt(label),
      maxHeight,
      onSortChange: callback,
      onSelectionChange: callback,
      onRowAction: callback,
      onLoadMore: callback,
      ...editAck,
    },
    'none',
    2,
  ),
  Tree: entry(
    {
      label: req(requiredLabel),
      items: req(treeItems),
      selected: opt(label),
      defaultSelected: opt(label),
      expanded: opt(arr(itemKey, { max: L.maxTreeItems })),
      defaultExpanded: opt(arr(itemKey, { max: L.maxTreeItems })),
      maxHeight,
      onSelect: callback,
      onToggle: callback,
      onAction: callback,
      ...editAck,
    },
    'none',
    2,
  ),
  Markdown: entry({ content: req(str({ max: L.maxDocumentLength })) }, 'none', 2),
  CodeView: entry(
    {
      code: req(str({ max: L.maxDocumentLength })),
      language: opt(str({ max: 64, pattern: /^[A-Za-z0-9_+#.-]{1,64}$/u })),
      label: opt(label),
      lineNumbers: flag,
      wrap: flag,
      maxHeight,
    },
    'none',
    2,
  ),
  Image: entry(
    {
      src: req(str({ min: 1, max: 512, check: isComponentImagePath })),
      alt: req(label),
      size: opt(oneOf(['xs', 'sm', 'md', 'lg', 'full'])),
      fit: opt(oneOf(['contain', 'cover'])),
      rounded: flag,
    },
    'none',
    2,
  ),
  KeyValue: entry(
    {
      label: opt(label),
      items: req(
        arr(
          obj({
            label: req(requiredLabel),
            value: req(anyOf(label, num(), bool, nul)),
            tone,
            code: flag,
          }),
          { max: L.maxKeyValueItems },
        ),
      ),
    },
    'none',
    2,
  ),
  Callout: entry({ tone, title: opt(label), icon: opt(icon) }, 'any', 2),
  Skeleton: entry(
    {
      shape: opt(oneOf(['text', 'block', 'circle'])),
      lines: opt(num({ int: true, min: 1, max: 10 })),
      label: opt(label),
    },
    'none',
    2,
  ),
  // ── Catalogue 3 ──
  RelativeTime: entry({ at: req(num()), format: opt(oneOf(RELATIVE_TIME_FORMATS)), tone, muted: flag }, 'none', 3),
  // ── Catalogue 4 ──
  Box: entry(
    {
      direction: opt(oneOf(['row', 'column'])),
      gap,
      padding: gap,
      paddingX: gap,
      paddingY: gap,
      margin: gap,
      align,
      justify,
      wrap: flag,
      grow: flag,
      shrink: flag,
      width: boxLength,
      height: boxLength,
      minWidth: boxLength,
      minHeight: boxLength,
      maxWidth: boxLength,
      maxHeight: boxLength,
      columns: opt(num({ int: true, min: 1, max: 6 })),
      scroll: opt(oneOf(['x', 'y', 'both'])),
      border: opt(anyOf(bool, oneOf(COMPONENT_TONES))),
      radius: opt(oneOf(['none', 'sm', 'md', 'lg', 'full'])),
      background: opt(oneOf(['none', 'muted', 'card', ...COMPONENT_TONES])),
    },
    'any',
    4,
  ),
} as const satisfies Record<string, Entry>

export type ComponentName = keyof typeof COMPONENT_CATALOG

export const COMPONENT_NAMES = Object.keys(COMPONENT_CATALOG) as ComponentName[]

export function isComponentName(name: unknown): name is ComponentName {
  return typeof name === 'string' && Object.hasOwn(COMPONENT_CATALOG, name)
}

/** Each component's prop names, for `ui.has(component, prop)`. */
export function componentPropNames(name: ComponentName): string[] {
  return Object.keys(COMPONENT_CATALOG[name].props).filter((prop) => prop !== COMPONENT_EDIT_PROP)
}

export const COMPONENT_INLINE: ReadonlySet<string> = new Set<ComponentName>([
  'Text',
  'Link',
  'Code',
  'Badge',
  'RelativeTime',
])

/** Controls a pressable ListItem may not hold: one row, one press target. */
export const COMPONENT_INTERACTIVE: ReadonlySet<string> = new Set<ComponentName>([
  'Button',
  'IconButton',
  'Input',
  'Switch',
  'Select',
  'Link',
  'ListItem',
  'Textarea',
  'Checkbox',
  'RadioGroup',
  'Slider',
  'Tabs',
  'Collapsible',
  'Table',
  'Tree',
  'Markdown',
])

/** The one child type a slot holds, and that child's one parent. */
export const COMPONENT_SLOT_CHILDREN = { items: 'ListItem', tabs: 'Tab' } as const

/**
 * Controls whose value Studio owns while the person edits: the prop holding
 * the value and the callback reporting each edit. The runtime tags their
 * renders with the edits it has handled (`$edit`), so the window can tell an
 * echo of what the person typed from a deliberate reset.
 */
export const COMPONENT_VALUE_CONTROLS = {
  Input: { value: 'value', change: 'onChange' },
  Textarea: { value: 'value', change: 'onChange' },
  Switch: { value: 'checked', change: 'onChange' },
  Checkbox: { value: 'checked', change: 'onChange' },
  Select: { value: 'value', change: 'onChange' },
  RadioGroup: { value: 'value', change: 'onChange' },
  Slider: { value: 'value', change: 'onChange' },
  Tabs: { value: 'value', change: 'onChange' },
  Collapsible: { value: 'open', change: 'onChange' },
  Table: { value: 'selected', change: 'onSelectionChange' },
  Tree: { value: 'selected', change: 'onSelect' },
} as const satisfies Partial<Record<ComponentName, { value: string; change: string }>>

export function componentValueControl(type: string): { value: string; change: string } | null {
  return Object.hasOwn(COMPONENT_VALUE_CONTROLS, type)
    ? COMPONENT_VALUE_CONTROLS[type as keyof typeof COMPONENT_VALUE_CONTROLS]
    : null
}

/** Controls whose press may grant one gesture-gated call (the stationary rule). */
export const COMPONENT_GESTURE_CONTROLS: ReadonlySet<string> = new Set<ComponentName>([
  'Button',
  'IconButton',
  'ListItem',
  'Link',
])

/** Parse one prop by its component's spec; `required` is the spec's own word. */
export function componentPropSpec(type: ComponentName, prop: string): PropSpec | undefined {
  const props: Record<string, PropSpec> = COMPONENT_CATALOG[type].props
  return Object.hasOwn(props, prop) ? props[prop] : undefined
}
