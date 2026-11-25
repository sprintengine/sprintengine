// A components panel under test, in Node with no Studio window: the panel's
// own module runs on the real components runtime (atoms, `setup`, renders),
// and this file plays the window that draws it. It checks each render as
// Studio checks it (tree.ts), keeps what the person typed by the same edit
// protocol (componentValue.ts in the app), shows only what Studio would draw
// (the selected tab, an open Collapsible), and carries the panel's host calls
// to the fake Studio of `createFakeFrameStudio`, which refuses what Studio
// refuses.
//
//   const view = await mountPanel(panel, { manifest })
//   await view.press({ role: 'button', text: 'Add' })
//   assert.deepEqual(view.errors, [])
//
// `check` renders each components panel through `runPanelScenario`, once per
// scenario a `<entry>.check.ts` file declares with `defineCheck`.

import { COMPONENT_MESSAGES as M, type ComponentStoredValue } from './components/messages.js'
import { COMPONENT_EDIT_PROP, componentValueControl } from './components/catalog.js'
import { installComponentsRuntime, type ComponentsBridge } from './components/index.js'
import type { ComponentsRuntime, PanelModule } from './components/runtime/renderer.js'
import { parseComponentTree, type ComponentChild, type ComponentNode } from './components/tree.js'
import type { ExtensionFrameEventName } from './events.js'
import type { ExtensionFrameMethod } from './frame.js'
import { createFakeFrameStudio, type FakeFrameStudio, type FakeFrameStudioOptions } from './testing.js'

// ── Inputs ──────────────────────────────────────────────────────────────────

const STORED = Symbol.for('sprintengine.components.stored')

/** A persisted value as an earlier version of the panel stored it, to test `migrate`. */
export type StoredAtomValue = { readonly [STORED]: true; value: unknown; version: number }

/** `value` as the atom's `version` (default 1) stored it. */
export function stored(value: unknown, version = 1): StoredAtomValue {
  return { [STORED]: true, value, version }
}

function isStored(value: unknown): value is StoredAtomValue {
  return typeof value === 'object' && value !== null && (value as Partial<StoredAtomValue>)[STORED] === true
}

/** Persisted atoms an earlier run left, by key: a plain value is version 1. */
export type PersistedSeed = { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> }

export type MountPanelOptions = Partial<FakeFrameStudioOptions> & {
  /** A fake Studio made beforehand, to share with a worker or another surface. Default: one made from these options. */
  studio?: FakeFrameStudio
  /** The panel's id in extension.json. Default: `panel`. */
  panelId?: string
  /** The workspace it is open in; null for none. Default: the fake's first workspace. */
  workspaceId?: string | null
  /** Default: `light`. */
  theme?: 'light' | 'dark'
  /** Default: `en`. */
  locale?: string
  /** Default: `desktop`. */
  client?: 'desktop' | 'web'
  /** Whether the person can see it (`ctx.visible`). Default: true. */
  visible?: boolean
  persisted?: PersistedSeed
}

// ── What a test reads ───────────────────────────────────────────────────────

/** Matches on any field given: `text` and `label` exactly, or by RegExp. */
export type PanelQuery = {
  type?: string
  role?: string
  text?: string | RegExp
  /** A control's `label`, a card's, list item's or collapsible's `title`. */
  label?: string | RegExp
  /** The element's `key`. */
  testId?: string
}

/** One drawn element: a snapshot of the tree as it was when found. */
export type PanelElement = {
  readonly type: string
  readonly key: string
  /** Its props as drawn; a handler shows as `'[handler]'`. */
  readonly props: Readonly<Record<string, unknown>>
  /** Its text, and its children's, as drawn. */
  readonly text: string
}

/** A plain tree for snapshots: what Studio draws, handlers as `'[handler]'`. */
export type PanelTreeNode = {
  type: string
  key?: string
  props: Record<string, unknown>
  children: Array<PanelTreeNode | string>
}

export type PanelError = { message: string; stack?: string }

export type PanelRefusal = { method: string; code: string; message: string }

export type MountedPanel = {
  /** The fake Studio behind the panel: its calls, toasts, logs, opened URLs. */
  readonly studio: FakeFrameStudio
  find(query: PanelQuery): PanelElement | null
  findAll(query: PanelQuery): PanelElement[]
  /** Press a Button, IconButton, Link or ListItem: it grants one gesture, as a press on a still control does. */
  press(target: PanelTarget): Promise<void>
  /** Type into an Input or Textarea, one edit per character. */
  type(target: PanelTarget, text: string, options?: { replace?: boolean; submit?: boolean }): Promise<void>
  submit(target: PanelTarget): Promise<void>
  /** A Switch, Checkbox or Collapsible. */
  toggle(target: PanelTarget): Promise<void>
  /** A Select's, RadioGroup's or Tabs' value. */
  select(target: PanelTarget, value: string): Promise<void>
  slide(target: PanelTarget, value: number): Promise<void>
  sort(table: PanelTarget, column: string): Promise<void>
  selectRows(table: PanelTarget, keys: string[]): Promise<void>
  activateRow(table: PanelTarget, key: string): Promise<void>
  loadMore(table: PanelTarget): Promise<void>
  expand(tree: PanelTarget, key: string): Promise<void>
  collapse(tree: PanelTarget, key: string): Promise<void>
  selectItem(tree: PanelTarget, key: string): Promise<void>
  activateItem(tree: PanelTarget, key: string): Promise<void>
  /** What Studio shows in a value control now, by the edit protocol. */
  valueOf(target: PanelTarget): unknown
  /** A Table's row keys, in the order drawn. */
  rowsOf(table: PanelTarget): string[]
  /** A Tree's open items. */
  expandedOf(tree: PanelTarget): string[]
  /** The drawn tree, or null before the first render (or after `unmount`). */
  tree(): PanelTreeNode | null
  /** What the panel threw, and renders Studio would refuse. */
  readonly errors: PanelError[]
  /** Props and components Studio would drop, once each. */
  readonly warnings: string[]
  /** Every call Studio refused, even one the panel caught. */
  readonly refusals: PanelRefusal[]
  /** Its persisted atoms as stored (`plugin`, this workspace's), and its storage. */
  readonly persisted: {
    plugin: Record<string, unknown>
    workspace: Record<string, unknown>
    storage: Record<string, unknown>
  }
  /** Deliver `theme` (`{ colorScheme }`) or one of Studio's events. */
  emit(event: 'theme' | ExtensionFrameEventName, payload?: unknown): Promise<void>
  /** The worker's event (`MainHost.emit`), as `worker.on(topic)` hears it. */
  post(topic: string, payload?: unknown): Promise<void>
  setVisible(visible: boolean): Promise<void>
  rerender(): Promise<void>
  /** Resolves once the panel's renders, host calls and persisted writes are done. */
  settled(): Promise<void>
  /** End the run: `setup`'s cleanup runs. */
  unmount(): Promise<void>
}

export type PanelTarget = PanelElement | PanelQuery

// ── The window's side ───────────────────────────────────────────────────────

const ROLES: Record<string, string> = {
  Button: 'button',
  IconButton: 'button',
  Link: 'link',
  Input: 'textbox',
  Textarea: 'textbox',
  Switch: 'switch',
  Checkbox: 'checkbox',
  Select: 'combobox',
  RadioGroup: 'radiogroup',
  Slider: 'slider',
  Tabs: 'tablist',
  Tab: 'tab',
  Table: 'table',
  Tree: 'tree',
  Heading: 'heading',
  List: 'list',
  ListItem: 'listitem',
  Progress: 'progressbar',
  Spinner: 'status',
  Image: 'img',
  Callout: 'note',
  Toolbar: 'toolbar',
  Collapsible: 'group',
}

const DEFAULT_PROP: Record<string, string> = {
  value: 'defaultValue',
  checked: 'defaultChecked',
  open: 'defaultOpen',
  selected: 'defaultSelected',
}

type ControlState = { local: unknown; remote: unknown; acked: number; sent: number }

type Located = { node: ComponentNode; path: string }

function isCallbackRef(value: unknown): value is { $callback: string } {
  return typeof value === 'object' && value !== null && typeof (value as { $callback?: unknown }).$callback === 'string'
}

function callbackOf(node: ComponentNode, prop: string): string | undefined {
  const value = node.props[prop]
  return isCallbackRef(value) ? value.$callback : undefined
}

function firstEnabledTab(node: ComponentNode): string {
  const tab = node.children.find(
    (child): child is ComponentNode =>
      typeof child === 'object' && child.type === 'Tab' && child.props.disabled !== true,
  )
  return tab ? String(tab.props.value ?? '') : ''
}

function fallbackValue(node: ComponentNode): unknown {
  switch (node.type) {
    case 'Switch':
    case 'Checkbox':
    case 'Collapsible':
      return false
    case 'Slider':
      return typeof node.props.min === 'number' ? node.props.min : 0
    case 'Table':
      return []
    case 'Tabs':
      return firstEnabledTab(node)
    default:
      return ''
  }
}

function describeQuery(query: PanelQuery): string {
  return JSON.stringify(query, (_key, value: unknown) => (value instanceof RegExp ? String(value) : value))
}

function matchesText(actual: string | undefined, wanted: string | RegExp): boolean {
  if (actual === undefined) return false
  return typeof wanted === 'string' ? actual === wanted : wanted.test(actual)
}

function plainProps(node: ComponentNode): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(node.props)) {
    if (name === COMPONENT_EDIT_PROP) continue
    props[name] = isCallbackRef(value) ? '[handler]' : structuredClone(value)
  }
  return props
}

function keyMatches(key: string | undefined, testId: string): boolean {
  if (key === undefined) return false
  // An author's key is scoped by the components and arrays around it (`#0:row-1`).
  return key === testId || key.endsWith(`:${testId}`) || key.endsWith(`.${testId}`)
}

/**
 * Boot a components panel as Studio does and resolve once it has drawn:
 * persisted atoms load, `setup` runs, then the first render. `panel` is the
 * module (`import * as panel from './panel'`) or its component. One panel runs
 * at a time; mounting another ends the one before.
 */
export async function mountPanel(
  panel: PanelModule | ((props: Record<string, never>) => unknown),
  options: MountPanelOptions = {},
): Promise<MountedPanel> {
  const studio =
    options.studio ??
    createFakeFrameStudio({
      ...options,
      ...(options.moduleId || options.manifest || options.main ? {} : { moduleId: 'local.extension' }),
      colorScheme: options.theme ?? 'light',
    } as FakeFrameStudioOptions)
  if (options.studio && options.theme) studio.setColorScheme(options.theme)
  const panelId = options.panelId ?? 'panel'
  const workspaceId =
    options.workspaceId === null ? undefined : (options.workspaceId ?? studio.services.workspaces.all()[0]?.id)
  const seed = (scope: 'plugin' | 'workspace', values: Record<string, unknown> | undefined) => {
    if (!values) return
    const entries: Record<string, ComponentStoredValue> = {}
    for (const [key, value] of Object.entries(values))
      entries[key] = isStored(value) ? { version: value.version, value: value.value } : { version: 1, value }
    if (scope === 'workspace' && !workspaceId) throw new Error('Workspace atoms need a panel open in a workspace.')
    studio.seedAtoms(scope, entries, scope === 'workspace' ? workspaceId : undefined)
  }
  seed('plugin', options.persisted?.plugin)
  seed('workspace', options.persisted?.workspace)

  const surface = { point: 'panels' as const, id: panelId, ...(workspaceId ? { workspaceId } : {}) }
  const frameStudio = studio.studio(surface)
  const errors: PanelError[] = []
  const warnings = new Set<string>()
  const refusals: PanelRefusal[] = []
  const toGuest = new Map<string, Set<(payload: unknown) => void>>()
  const inFlight = new Set<Promise<unknown>>()
  let activity = 0
  let tree: ComponentNode | null = null
  let revision = 0
  let ended = false
  const controls = new Map<string, ControlState>()
  // A Tree's open items that the panel does not hold itself.
  const ownExpanded = new Map<string, Set<string>>()

  const refused = (method: string, code: string, message: string) => {
    if (!refusals.some((each) => each.method === method && each.code === code && each.message === message))
      refusals.push({ method, code, message })
  }

  const bridge: ComponentsBridge = {
    post(event, payload) {
      activity += 1
      receive(event, payload as Record<string, unknown>)
    },
    on(event, handler) {
      if (event === 'theme') return frameStudio.on('theme', handler as never)
      let set = toGuest.get(event)
      if (!set) toGuest.set(event, (set = new Set()))
      set.add(handler)
      const owned = set
      return { dispose: () => owned.delete(handler) }
    },
    call(method, params) {
      activity += 1
      const call = frameStudio.host
        .call(method as ExtensionFrameMethod, params as never)
        .then((answer: unknown) => {
          const record = answer as { ok?: unknown; code?: unknown; message?: unknown } | null
          // A worker's own `ok: false` is its answer, not a refusal by Studio.
          if (record?.ok === false && typeof record.code === 'string' && !method.startsWith('worker.'))
            refused(method, record.code, String(record.message ?? ''))
          return answer
        })
        .catch((error: { code?: unknown; message?: unknown }) => {
          refused(method, typeof error?.code === 'string' ? error.code : 'unavailable', String(error?.message ?? error))
          throw error
        })
      const tracked = call.finally(() => {
        inFlight.delete(tracked)
        activity += 1
      })
      tracked.catch(() => undefined)
      inFlight.add(tracked)
      return call
    },
    has: (method) => frameStudio.host.has(method),
    listen: (event, handler) => frameStudio.on(event as never, handler as never),
    surface: { id: panelId, ...(workspaceId ? { workspaceId } : {}) },
    get colorScheme() {
      return frameStudio.theme.colorScheme
    },
    locale: options.locale ?? 'en',
    client: options.client ?? 'desktop',
  }

  const send = (event: string, payload: unknown) => {
    for (const handler of [...(toGuest.get(event) ?? [])]) handler(payload)
  }

  function receive(event: string, payload: Record<string, unknown>): void {
    if (event === M.error) {
      errors.push({
        message: String(payload.message ?? ''),
        ...(typeof payload.stack === 'string' ? { stack: payload.stack } : {}),
      })
      return
    }
    if (event !== M.render) return
    const at = payload.revision as number
    const checked = parseComponentTree(payload.tree)
    if (!checked.ok) {
      errors.push({ message: `Studio would not draw this render: ${checked.error}` })
      send(M.ack, { document: payload.document, revision: at, accepted: false })
      return
    }
    for (const warning of checked.warnings) warnings.add(warning)
    tree = checked.tree && checked.tree.type !== 'Unsupported' ? (checked.tree as ComponentNode) : null
    if (checked.tree?.type === 'Unsupported') warnings.add(`unknown component ${checked.tree.props.name}`)
    revision = at
    syncControls()
    send(M.ack, { document: payload.document, revision: at, accepted: true })
  }

  // ── The edit protocol, as the window keeps it ──
  function walk(visit: (node: ComponentNode, path: string) => void): void {
    const visitAll = (children: ComponentChild[], parent: string) => {
      children.forEach((child, index) => {
        if (typeof child !== 'object' || child.type === 'Unsupported') return
        const node = child as ComponentNode
        const path = `${parent}/${node.key ?? `#${index}`}`
        visit(node, path)
        visitAll(node.children, path)
      })
    }
    if (tree) visitAll([tree], '')
  }

  function syncControls(): void {
    const seen = new Set<string>()
    walk((node, path) => {
      const control = componentValueControl(node.type)
      if (!control) return
      const id = `${node.type}${path}`
      seen.add(id)
      const value = node.props[control.value]
      const acked =
        typeof node.props[COMPONENT_EDIT_PROP] === 'number' ? (node.props[COMPONENT_EDIT_PROP] as number) : 0
      const state = controls.get(id)
      if (!state) {
        const fallback = node.props[DEFAULT_PROP[control.value]!]
        controls.set(id, { local: value ?? fallback ?? fallbackValue(node), remote: value, acked, sent: 0 })
        return
      }
      if (!Object.is(state.remote, value) || state.acked !== acked) {
        const caughtUp = acked >= state.sent
        state.local = value !== undefined && caughtUp ? value : state.local
        state.remote = value
        state.acked = acked
      }
    })
    for (const id of [...controls.keys()]) if (!seen.has(id)) controls.delete(id)
  }

  // ── Finding what is drawn ──
  type Drawn = { node: ComponentNode; path: string; text: string; children: Drawn[] }

  function drawn(): Drawn | null {
    const build = (node: ComponentNode, path: string): Drawn => {
      const parts: string[] = []
      const children: Drawn[] = []
      let shown = node.children
      if (node.type === 'Tabs') {
        const selected = controlState(node, path)?.local
        shown = node.children.map((child) =>
          typeof child === 'object' && child.type === 'Tab' && (child as ComponentNode).props.value !== selected
            ? { ...(child as ComponentNode), children: [] }
            : child,
        )
      }
      if (node.type === 'Collapsible' && controlState(node, path)?.local !== true) shown = []
      shown.forEach((child, index) => {
        if (typeof child === 'string') {
          parts.push(child)
          return
        }
        if (child.type === 'Unsupported') return
        const built = build(child as ComponentNode, `${path}/${child.key ?? `#${index}`}`)
        children.push(built)
        if (built.text) parts.push(` ${built.text} `)
      })
      return { node, path, text: parts.join('').replace(/\s+/gu, ' ').trim(), children }
    }
    return tree ? build(tree, `/${tree.key ?? '#0'}`) : null
  }

  function controlState(node: ComponentNode, path: string): ControlState | undefined {
    return controls.get(`${node.type}${path}`)
  }

  function matches(item: Drawn, query: PanelQuery): boolean {
    const { node } = item
    if (query.type !== undefined && node.type !== query.type) return false
    if (query.role !== undefined && ROLES[node.type] !== query.role) return false
    if (query.text !== undefined && !matchesText(item.text, query.text)) return false
    if (query.label !== undefined) {
      const label = typeof node.props.label === 'string' ? node.props.label : node.props.title
      if (!matchesText(typeof label === 'string' ? label : undefined, query.label)) return false
    }
    if (query.testId !== undefined && !keyMatches(node.key, query.testId)) return false
    return true
  }

  const located = new WeakMap<PanelElement, string>()
  function element(item: Drawn): PanelElement {
    const made: PanelElement = Object.freeze({
      type: item.node.type,
      key: item.node.key ?? '',
      props: Object.freeze(plainProps(item.node)),
      text: item.text,
    })
    located.set(made, item.path)
    return made
  }

  function search(query: PanelQuery): Drawn[] {
    const found: Drawn[] = []
    // Innermost: a match none of whose descendants match.
    const visit = (item: Drawn): boolean => {
      let below = false
      for (const child of item.children) below = visit(child) || below
      if (below) return true
      if (matches(item, query)) {
        found.push(item)
        return true
      }
      return false
    }
    const root = drawn()
    if (root) visit(root)
    return found
  }

  function searchAll(query: PanelQuery): Drawn[] {
    const found: Drawn[] = []
    const visit = (item: Drawn) => {
      if (matches(item, query)) found.push(item)
      item.children.forEach(visit)
    }
    const root = drawn()
    if (root) visit(root)
    return found
  }

  function resolve(target: PanelTarget): Located {
    const path = located.get(target as PanelElement)
    if (path !== undefined) {
      const type = (target as PanelElement).type
      const found = searchAll({ type }).find((item) => item.path === path)
      if (!found) throw new Error(`That ${type} is no longer drawn.`)
      return { node: found.node, path }
    }
    const found = search(target as PanelQuery)[0]
    if (!found) throw new Error(`Nothing drawn matches ${describeQuery(target as PanelQuery)}.`)
    return { node: found.node, path: found.path }
  }

  function need(at: Located, types: string[], act: string): void {
    if (!types.includes(at.node.type)) throw new Error(`${act} takes a ${types.join(', ')}; this is a ${at.node.type}.`)
    if (at.node.props.disabled === true) throw new Error(`This ${at.node.type} is disabled.`)
  }

  function dispatch(callback: string | undefined, args: unknown[], edit?: number): void {
    if (!callback) return
    send(M.event, {
      document: runtime.document,
      revision,
      callback,
      args,
      ...(edit === undefined ? {} : { edit }),
    })
  }

  function change(at: Located, next: unknown, args: unknown[]): void {
    const control = componentValueControl(at.node.type)!
    const callback = callbackOf(at.node, control.change)
    const state = controlState(at.node, at.path)!
    if (at.node.props[control.value] !== undefined && !callback)
      throw new Error(`This ${at.node.type} shows the panel's value and takes no edits (it has no ${control.change}).`)
    state.local = next
    state.sent += 1
    dispatch(callback, args, state.sent)
  }

  // ── Settling ──
  async function settled(): Promise<void> {
    for (let round = 0; round < 200; round++) {
      const before = activity
      await new Promise((done) => setTimeout(done, 0))
      runtime.flush()
      if (inFlight.size > 0) await Promise.allSettled([...inFlight])
      if (activity === before && inFlight.size === 0) return
    }
  }

  async function act(run: () => void): Promise<void> {
    if (ended) throw new Error('The panel was unmounted.')
    run()
    await settled()
  }

  const runtime: ComponentsRuntime = installComponentsRuntime({
    bridge,
    // Renders follow at once: a test has no display frame to wait for.
    schedule: (flush, delayMs) => (delayMs > 0 ? setTimeout(flush, 0) : queueMicrotask(flush)),
  })
  runtime.hydrate({ visible: options.visible ?? true })
  try {
    await runtime.boot(typeof panel === 'function' ? { default: panel } : panel)
  } catch (error) {
    errors.push({
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    })
  }
  await settled()

  const persisted = () => {
    const atoms = studio.atoms()
    const values = (stored: Record<string, ComponentStoredValue> | undefined) =>
      Object.fromEntries(Object.entries(stored ?? {}).map(([key, entry]) => [key, entry.value]))
    const storage = studio.services.storage
    return {
      plugin: values(atoms.plugin),
      workspace: values(workspaceId ? atoms.workspace[workspaceId] : undefined),
      storage: Object.fromEntries(storage.keys().map((key) => [key, storage.peek(key)])),
    }
  }

  const plainTree = (node: ComponentNode): PanelTreeNode => ({
    type: node.type,
    ...(node.key === undefined ? {} : { key: node.key }),
    props: plainProps(node),
    // Adjacent texts are one run of text on screen (`{count} clicks`), and one string here.
    children: node.children.reduce<Array<PanelTreeNode | string>>((out, child) => {
      const last = out.length - 1
      if (typeof child === 'string' && typeof out[last] === 'string') out[last] += child
      else
        out.push(
          typeof child === 'string'
            ? child
            : child.type === 'Unsupported'
              ? { type: 'Unsupported', props: { ...child.props }, children: [] }
              : plainTree(child as ComponentNode),
        )
      return out
    }, []),
  })

  const view: MountedPanel = {
    studio,
    find: (query) => {
      const found = search(query)[0]
      return found ? element(found) : null
    },
    findAll: (query) => searchAll(query).map(element),
    press: (target) =>
      act(() => {
        const at = resolve(target)
        need(at, ['Button', 'IconButton', 'Link', 'ListItem'], 'press')
        studio.grantGesture()
        const callback = callbackOf(at.node, 'onPress')
        const href = at.node.props.href
        if (!callback && at.node.type === 'Link' && typeof href === 'string') studio.openedUrls.push(href)
        else if (!callback) throw new Error(`This ${at.node.type} has no onPress.`)
        dispatch(callback, [])
      }),
    type: (target, text, typing = {}) =>
      act(() => {
        const at = resolve(target)
        need(at, ['Input', 'Textarea'], 'type')
        const state = controlState(at.node, at.path)!
        let value = typing.replace ? '' : String(state.local ?? '')
        if (typing.replace) change(at, value, [value])
        for (const character of text) {
          value += character
          change(at, value, [value])
        }
        if (typing.submit) {
          const submit = callbackOf(at.node, 'onSubmit')
          if (!submit) throw new Error(`This ${at.node.type} has no onSubmit.`)
          dispatch(submit, [value])
        }
      }),
    submit: (target) =>
      act(() => {
        const at = resolve(target)
        need(at, ['Input', 'Textarea'], 'submit')
        const submit = callbackOf(at.node, 'onSubmit')
        if (!submit) throw new Error(`This ${at.node.type} has no onSubmit.`)
        dispatch(submit, [String(controlState(at.node, at.path)?.local ?? '')])
      }),
    toggle: (target) =>
      act(() => {
        const at = resolve(target)
        need(at, ['Switch', 'Checkbox', 'Collapsible'], 'toggle')
        const next = controlState(at.node, at.path)?.local !== true
        change(at, next, [next])
      }),
    select: (target, value) =>
      act(() => {
        const at = resolve(target)
        need(at, ['Select', 'RadioGroup', 'Tabs'], 'select')
        const choices =
          at.node.type === 'Tabs'
            ? at.node.children
                .filter((child): child is ComponentNode => typeof child === 'object' && child.type === 'Tab')
                .map((tab) => ({ value: tab.props.value, disabled: tab.props.disabled }))
            : ((at.node.props.options ?? []) as Array<{ value: string; disabled?: boolean }>)
        const choice = choices.find((each) => each.value === value)
        if (!choice) throw new Error(`This ${at.node.type} has no option "${value}".`)
        if (choice.disabled === true) throw new Error(`The option "${value}" is disabled.`)
        change(at, value, [value])
      }),
    slide: (target, value) =>
      act(() => {
        const at = resolve(target)
        need(at, ['Slider'], 'slide')
        const min = typeof at.node.props.min === 'number' ? at.node.props.min : 0
        const max = typeof at.node.props.max === 'number' ? at.node.props.max : 100
        if (!(value >= min && value <= max)) throw new Error(`${value} is outside ${min}–${max}.`)
        change(at, value, [value])
      }),
    sort: (table, column) =>
      act(() => {
        const at = resolve(table)
        need(at, ['Table'], 'sort')
        const columns = (at.node.props.columns ?? []) as Array<{ key: string; sortable?: boolean }>
        if (!columns.some((each) => each.key === column && each.sortable === true))
          throw new Error(`The column "${column}" is not sortable.`)
        const sort = at.node.props.sort as { column: string; direction: string } | undefined
        const direction = sort?.column === column && sort.direction === 'asc' ? 'desc' : 'asc'
        dispatch(callbackOf(at.node, 'onSortChange'), [{ column, direction }])
      }),
    selectRows: (table, keys) =>
      act(() => {
        const at = resolve(table)
        need(at, ['Table'], 'selectRows')
        const mode = at.node.props.selectionMode ?? 'none'
        if (mode === 'none') throw new Error('This Table has no selection (selectionMode).')
        if (mode === 'single' && keys.length > 1) throw new Error('This Table selects one row at a time.')
        const rows = new Set(((at.node.props.rows ?? []) as Array<{ key: string }>).map((row) => row.key))
        const missing = keys.find((key) => !rows.has(key))
        if (missing !== undefined) throw new Error(`This Table has no row "${missing}".`)
        change(at, [...keys], [{ keys: [...keys] }])
      }),
    activateRow: (table, key) =>
      act(() => {
        const at = resolve(table)
        need(at, ['Table'], 'activateRow')
        dispatch(callbackOf(at.node, 'onRowAction'), [{ key }])
      }),
    loadMore: (table) =>
      act(() => {
        const at = resolve(table)
        need(at, ['Table'], 'loadMore')
        if (at.node.props.hasMore !== true) throw new Error('This Table has no more rows to load (hasMore).')
        dispatch(callbackOf(at.node, 'onLoadMore'), [])
      }),
    expand: (target, key) => act(() => toggleItem(target, key, true)),
    collapse: (target, key) => act(() => toggleItem(target, key, false)),
    selectItem: (target, key) =>
      act(() => {
        const at = resolve(target)
        need(at, ['Tree'], 'selectItem')
        treeItem(at, key)
        change(at, key, [{ key }])
      }),
    activateItem: (target, key) =>
      act(() => {
        const at = resolve(target)
        need(at, ['Tree'], 'activateItem')
        treeItem(at, key)
        dispatch(callbackOf(at.node, 'onAction'), [{ key }])
      }),
    valueOf(target) {
      const at = resolve(target)
      const state = controlState(at.node, at.path)
      if (!state) throw new Error(`A ${at.node.type} holds no value.`)
      return structuredClone(state.local)
    },
    rowsOf(table) {
      const at = resolve(table)
      if (at.node.type !== 'Table') throw new Error(`rowsOf takes a Table; this is a ${at.node.type}.`)
      return ((at.node.props.rows ?? []) as Array<{ key: string }>).map((row) => row.key)
    },
    expandedOf(target) {
      const at = resolve(target)
      if (at.node.type !== 'Tree') throw new Error(`expandedOf takes a Tree; this is a ${at.node.type}.`)
      return [...expandedOf(at)]
    },
    tree: () => (tree ? plainTree(tree) : null),
    errors,
    get warnings() {
      return [...warnings]
    },
    refusals,
    get persisted() {
      return persisted()
    },
    emit: (event, payload) =>
      act(() => {
        if (event === 'theme') {
          const scheme = (payload as { colorScheme?: unknown } | undefined)?.colorScheme
          if (scheme !== 'light' && scheme !== 'dark') throw new Error('theme takes { colorScheme: "light" | "dark" }.')
          studio.setColorScheme(scheme)
        } else studio.studioEvent(event, payload as never)
      }),
    post: (topic, payload) => act(() => studio.emit(topic, payload)),
    setVisible: (visible) => act(() => send(M.visibility, { visible })),
    rerender: () => act(() => runtime.rerender()),
    settled,
    async unmount() {
      if (ended) return
      runtime.flush()
      await settled()
      runtime.dispose()
      ended = true
      tree = null
      await Promise.allSettled([...inFlight])
    },
  }

  function treeItem(
    at: Located,
    key: string,
  ): { key: string; hasChildren?: boolean; children?: unknown[]; disabled?: boolean } {
    type Item = { key: string; hasChildren?: boolean; children?: Item[]; disabled?: boolean }
    const pending = [...((at.node.props.items ?? []) as Item[])]
    for (let item = pending.shift(); item; item = pending.shift()) {
      if (item.key === key) {
        if (item.disabled === true) throw new Error(`The item "${key}" is disabled.`)
        return item
      }
      pending.push(...(item.children ?? []))
    }
    throw new Error(`This Tree has no item "${key}".`)
  }

  function expandedOf(at: Located): Set<string> {
    const controlled = at.node.props.expanded
    if (Array.isArray(controlled)) return new Set(controlled as string[])
    let own = ownExpanded.get(at.path)
    if (!own) {
      const initial = at.node.props.defaultExpanded
      ownExpanded.set(at.path, (own = new Set(Array.isArray(initial) ? (initial as string[]) : [])))
    }
    return own
  }

  function toggleItem(target: PanelTarget, key: string, expanded: boolean): void {
    const at = resolve(target)
    need(at, ['Tree'], expanded ? 'expand' : 'collapse')
    const item = treeItem(at, key)
    if (!(item.hasChildren === true || (item.children?.length ?? 0) > 0))
      throw new Error(`The item "${key}" has no children.`)
    const open = expandedOf(at)
    if (open.has(key) === expanded) return
    if (!Array.isArray(at.node.props.expanded)) {
      if (expanded) open.add(key)
      else open.delete(key)
    }
    dispatch(callbackOf(at.node, 'onToggle'), [{ key, expanded }])
  }

  return view
}

// ── check's scenarios ───────────────────────────────────────────────────────

/** One state `check` renders a panel in. Everything is optional: `{}` is an empty Studio. */
export type CheckScenario = Pick<
  MountPanelOptions,
  | 'results'
  | 'settings'
  | 'secrets'
  | 'workspaces'
  | 'files'
  | 'backlogItems'
  | 'invoker'
  | 'persisted'
  | 'theme'
  | 'visible'
  | 'workspaceId'
> & {
  /** The extension's storage, by key, as an earlier run left it. */
  storage?: Record<string, unknown>
  /** Studio's events and the theme, delivered in order after the first draw. */
  events?: Array<{ event: 'theme' | ExtensionFrameEventName; payload?: unknown }>
}

/** A panel's check scenarios, by name: the default export of `<entry>.check.ts`. */
export function defineCheck<S extends Record<string, CheckScenario>>(scenarios: S): S {
  return scenarios
}

export type PanelScenarioResult = {
  errors: PanelError[]
  warnings: string[]
  refusals: PanelRefusal[]
  /** What the panel drew, in a few lines. */
  summary: string[]
  tree: PanelTreeNode | null
}

/** Render `panel` in one scenario as `check` does, and say what it drew and what went wrong. */
export async function runPanelScenario(
  panel: PanelModule,
  scenario: CheckScenario,
  base: Partial<FakeFrameStudioOptions> & { panelId: string },
): Promise<PanelScenarioResult> {
  const studio = createFakeFrameStudio({
    ...base,
    ...(scenario.results ? { results: scenario.results } : {}),
    ...(scenario.settings ? { settings: scenario.settings } : {}),
    ...(scenario.secrets ? { secrets: scenario.secrets } : {}),
    ...(scenario.workspaces ? { workspaces: scenario.workspaces } : {}),
    ...(scenario.files ? { files: scenario.files } : {}),
    ...(scenario.backlogItems ? { backlogItems: scenario.backlogItems } : {}),
    ...(scenario.invoker ? { invoker: scenario.invoker } : {}),
    colorScheme: scenario.theme ?? 'light',
  } as FakeFrameStudioOptions)
  for (const [key, value] of Object.entries(scenario.storage ?? {})) studio.services.storage.seed(key, value)
  const view = await mountPanel(panel, {
    studio,
    panelId: base.panelId,
    ...(scenario.persisted ? { persisted: scenario.persisted } : {}),
    ...(scenario.visible === undefined ? {} : { visible: scenario.visible }),
    ...(scenario.workspaceId === undefined ? {} : { workspaceId: scenario.workspaceId }),
  })
  for (const each of scenario.events ?? []) {
    try {
      await view.emit(each.event, each.payload)
    } catch (error) {
      view.errors.push({ message: `event ${each.event}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  const tree = view.tree()
  const result: PanelScenarioResult = {
    errors: dedupe(view.errors, (each) => each.message),
    warnings: view.warnings,
    refusals: [...view.refusals],
    summary: summarizePanel(tree),
    tree,
  }
  await view.unmount()
  return result
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const id = key(item)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function textOf(node: PanelTreeNode | string): string {
  if (typeof node === 'string') return node
  return node.children.map(textOf).join('').replace(/\s+/gu, ' ').trim()
}

const WARNING_TONES = new Set(['danger', 'warning'])

/** A few lines on what a tree draws: headings, notices, empty states, tables and trees, tabs, loading, warnings. */
export function summarizePanel(tree: PanelTreeNode | null): string[] {
  if (!tree) return ['nothing drawn']
  const lines: string[] = []
  const visit = (node: PanelTreeNode | string) => {
    if (typeof node === 'string') return
    const p = node.props
    switch (node.type) {
      case 'Heading':
        lines.push(`heading: ${textOf(node)}`)
        break
      case 'Callout':
        lines.push(`${String(p.tone ?? 'neutral')} callout: ${[p.title, textOf(node)].filter(Boolean).join(' — ')}`)
        break
      case 'EmptyState':
        lines.push(`empty state: ${String(p.title ?? '')}`)
        break
      case 'Table': {
        const rows = Array.isArray(p.rows) ? p.rows.length : 0
        lines.push(
          `table "${String(p.label ?? '')}": ${rows} row${rows === 1 ? '' : 's'}${p.loading === true ? ', loading' : ''}${p.hasMore === true ? ', more to load' : ''}`,
        )
        break
      }
      case 'Tree': {
        let count = 0
        const pending = [...((p.items ?? []) as Array<{ children?: unknown[] }>)]
        for (let item = pending.shift(); item; item = pending.shift()) {
          count += 1
          pending.push(...((item.children ?? []) as Array<{ children?: unknown[] }>))
        }
        lines.push(`tree "${String(p.label ?? '')}": ${count} item${count === 1 ? '' : 's'}`)
        break
      }
      case 'Tabs': {
        const tabs = node.children.filter(
          (child): child is PanelTreeNode => typeof child === 'object' && child.type === 'Tab',
        )
        const value = p.value ?? p.defaultValue ?? tabs[0]?.props.value
        const tab = tabs.find((each) => each.props.value === value)
        lines.push(`tabs "${String(p.label ?? '')}": ${String(tab?.props.label ?? value ?? '')} selected`)
        break
      }
      case 'Skeleton':
      case 'Spinner':
        lines.push(`loading${typeof p.label === 'string' ? `: ${p.label}` : ''}`)
        break
      case 'Text':
        if (WARNING_TONES.has(String(p.tone))) lines.push(`${String(p.tone)} text: ${textOf(node)}`)
        break
      case 'Box':
        if (WARNING_TONES.has(String(p.border)) || WARNING_TONES.has(String(p.background)))
          lines.push(`${String(WARNING_TONES.has(String(p.border)) ? p.border : p.background)} box: ${textOf(node)}`)
        break
      case 'Unsupported':
        lines.push(`placeholder: ${String(p.name ?? '')}`)
        break
    }
    node.children.forEach(visit)
  }
  visit(tree)
  return lines.length > 0 ? lines.slice(0, 40) : [`${tree.type}: ${textOf(tree).slice(0, 120)}`]
}
