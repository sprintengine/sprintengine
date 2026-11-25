// Checking a tree a components panel rendered, before Studio draws it. The
// tree comes from the extension's own code, so it is untrusted: this returns a
// fresh copy holding only known fields. Structure and the limits refuse a
// render (the last good one stays on screen); an unknown prop or value is
// dropped with a warning; an unknown component, one missing a required prop,
// or one whose data is over its own cap is drawn as a placeholder.
//
// Iterative, so a hostile depth cannot overflow the window's stack.

import {
  COMPONENT_CATALOG,
  COMPONENT_EDIT_PROP,
  COMPONENT_INLINE,
  COMPONENT_INTERACTIVE,
  COMPONENT_LIMITS as LIMITS,
  COMPONENT_SLOT_CHILDREN,
  isComponentIcon,
  isComponentName,
  type ComponentChildPolicy,
  type ComponentName,
  type PropSpec,
} from './catalog.js'

/** A component Studio does not draw (a newer catalogue, a typo, a missing required prop, data over its cap). */
export type UnsupportedNode = { type: 'Unsupported'; key?: string; props: { name: string }; children: [] }

export type ComponentNode = {
  type: ComponentName
  key?: string
  props: Record<string, unknown>
  children: ComponentChild[]
}

/** Numbers are turned into text as the tree is checked. */
export type ComponentChild = ComponentNode | UnsupportedNode | string

export type ComponentTreeResult =
  | { ok: true; tree: ComponentNode | UnsupportedNode | null; nodes: number; warnings: string[] }
  | { ok: false; error: string }

const NODE_FIELDS: ReadonlySet<string> = new Set(['type', 'key', 'props', 'children'])
// A flat cost per node keeps the byte budget meaningful for trees of empty nodes.
const NODE_OVERHEAD_BYTES = 32
// A floor per string: thousands of empty texts are not free to check.
const TEXT_OVERHEAD_BYTES = 8
const UNKNOWN_COMPONENT_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/u
const MAX_WARNINGS = 20
const SLOT_POLICY: ReadonlyMap<string, ComponentChildPolicy> = new Map([
  [COMPONENT_SLOT_CHILDREN.items, 'items'],
  [COMPONENT_SLOT_CHILDREN.tabs, 'tabs'],
])
const SLOT_PARENT: Record<string, string> = { ListItem: 'List', Tab: 'Tabs' }

function slotChild(policy: ComponentChildPolicy): string | undefined {
  return policy === 'items' || policy === 'tabs' ? COMPONENT_SLOT_CHILDREN[policy] : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

class TreeRefusal extends Error {}

function refuse(path: string, message: string): never {
  throw new TreeRefusal(`${path}: ${message}`)
}

/** Props as the catalogue reads them; null when the component is drawn as a placeholder. */
function readProps(
  type: ComponentName,
  raw: Record<string, unknown>,
  warn: (message: string) => void,
): Record<string, unknown> | null {
  const specs: Record<string, PropSpec> = COMPONENT_CATALOG[type].props
  const props: Record<string, unknown> = {}
  let placeholder = false
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!Object.hasOwn(specs, name)) {
      warn(`${type}: ignored unknown prop "${name.slice(0, 64)}"`)
      continue
    }
    const spec = specs[name]!
    const parsed = spec.parse(value)
    if (!parsed.ok) {
      // A required prop over its own cap (a Table's 5001st row) draws a placeholder, said as such.
      if (spec.required) {
        warn(`${type}: ${name} is invalid or over its limit; showing a placeholder`)
        placeholder = true
      } else if (name !== COMPONENT_EDIT_PROP) warn(`${type}: ignored invalid ${name}`)
      continue
    }
    props[name] = parsed.value
  }
  if (placeholder) return null
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.required && !Object.hasOwn(props, name)) {
      warn(`${type}: missing required ${name}; showing a placeholder`)
      return null
    }
  }
  if (typeof props.icon === 'string' && !isComponentIcon(props.icon))
    warn(`${type}: unknown icon "${props.icon}"; showing a fallback glyph`)
  return props
}

type Pending = {
  raw: unknown
  depth: number
  parentType: string | null
  policy: ComponentChildPolicy
  /** Inside a ListItem with onPress, which stays the row's only press target. */
  inPressable: boolean
  siblingKeys: Set<string>
  out: ComponentChild[]
  path: string
}

/** Check an untrusted tree: a fresh, known-only copy, or why it is refused. */
export function parseComponentTree(raw: unknown): ComponentTreeResult {
  if (raw === null) return { ok: true, tree: null, nodes: 0, warnings: [] }
  const warnings = new Set<string>()
  const warn = (message: string): void => {
    if (warnings.size < MAX_WARNINGS) warnings.add(message)
  }
  const root: ComponentChild[] = []
  const stack: Pending[] = [
    {
      raw,
      depth: 1,
      parentType: null,
      policy: 'any',
      inPressable: false,
      siblingKeys: new Set(),
      out: root,
      path: 'tree',
    },
  ]
  let nodes = 0
  let texts = 0
  let bytes = 0
  try {
    for (let next = stack.pop(); next; next = stack.pop()) {
      const { raw: item, depth, parentType, policy, inPressable, siblingKeys, out, path } = next
      if (typeof item === 'string' || typeof item === 'number') {
        if (policy === 'none' || slotChild(policy) || parentType === null)
          refuse(path, `${parentType ?? 'the root'} does not take text`)
        if (typeof item === 'number' && !Number.isFinite(item)) refuse(path, 'numbers must be finite')
        const text = String(item)
        if (text.length > LIMITS.maxTextLength) refuse(path, `a text is longer than ${LIMITS.maxTextLength}`)
        if (nodes + ++texts > LIMITS.maxNodes) refuse(path, `more than ${LIMITS.maxNodes} nodes`)
        bytes += TEXT_OVERHEAD_BYTES + text.length
        if (bytes > LIMITS.maxTreeBytes) refuse(path, `the tree is larger than ${LIMITS.maxTreeBytes / 1024} KiB`)
        out.push(text)
        continue
      }
      if (!isPlainObject(item)) refuse(path, 'expected a component, a string or a number')
      const type = item.type
      const known = isComponentName(type)
      if (!known && (typeof type !== 'string' || !UNKNOWN_COMPONENT_NAME.test(type)))
        refuse(path, `invalid component name ${JSON.stringify(String(type)).slice(0, 80)}`)
      if (policy === 'none' || policy === 'text') refuse(path, `${parentType} takes only text`)
      if (policy === 'inline' && known && !COMPONENT_INLINE.has(type))
        refuse(path, `${parentType} takes only text, Text, Link, Code, Badge and RelativeTime`)
      const slot = slotChild(policy)
      const ownSlot = SLOT_POLICY.get(type as string)
      if (slot !== undefined && type !== slot) refuse(path, `${parentType} holds only ${slot}`)
      if (ownSlot !== undefined && ownSlot !== policy)
        refuse(path, `${type as string} must be a direct child of ${SLOT_PARENT[type as string] ?? 'its container'}`)
      if (inPressable && COMPONENT_INTERACTIVE.has(type as string))
        refuse(path, `a ListItem with onPress cannot hold a ${type as string}`)
      if (++nodes + texts > LIMITS.maxNodes) refuse(path, `more than ${LIMITS.maxNodes} nodes`)
      if (depth > LIMITS.maxDepth) refuse(path, `deeper than ${LIMITS.maxDepth}`)
      for (const field of Object.keys(item))
        if (!NODE_FIELDS.has(field)) refuse(path, `unknown node field ${field.slice(0, 64)}`)
      const key = item.key
      if (key !== undefined) {
        if (typeof key !== 'string' || key.length > LIMITS.maxLabelLength) refuse(path, 'a key is a short string')
        if (siblingKeys.has(key)) refuse(path, `duplicate key ${JSON.stringify(key.slice(0, 64))} among siblings`)
        siblingKeys.add(key)
      }
      const keyField = key === undefined ? {} : { key: key as string }
      if (!known) {
        warn(`unknown component ${type as string}; showing a placeholder`)
        out.push({ type: 'Unsupported', ...keyField, props: { name: type as string }, children: [] })
        bytes += NODE_OVERHEAD_BYTES + (type as string).length
        continue
      }
      const rawProps = item.props ?? {}
      if (!isPlainObject(rawProps) || Object.keys(rawProps).length > LIMITS.maxPropsPerNode)
        refuse(path, `props are an object of at most ${LIMITS.maxPropsPerNode} fields`)
      for (const [name, value] of Object.entries(rawProps)) {
        // Labels are capped whole-render: a 1 KiB label is a structural limit, not a component's data.
        if (
          typeof value === 'string' &&
          (name === 'label' || name === 'title' || name === 'description' || name === 'placeholder') &&
          value.length > LIMITS.maxLabelLength
        )
          refuse(path, `${type}'s ${name} is longer than ${LIMITS.maxLabelLength}`)
      }
      if (type === 'Select' && Array.isArray(rawProps.options) && rawProps.options.length > LIMITS.maxSelectOptions)
        refuse(path, `a Select has more than ${LIMITS.maxSelectOptions} options`)
      const rawChildren = item.children === undefined ? [] : item.children
      if (!Array.isArray(rawChildren)) refuse(path, 'children must be an array')
      if (rawChildren.length > LIMITS.maxNodes) refuse(path, `more than ${LIMITS.maxNodes} children`)
      const props = readProps(type, rawProps, warn)
      if (!props) {
        out.push({ type: 'Unsupported', ...keyField, props: { name: type }, children: [] })
        bytes += NODE_OVERHEAD_BYTES + type.length
        continue
      }
      bytes += NODE_OVERHEAD_BYTES + JSON.stringify(props).length
      if (bytes > LIMITS.maxTreeBytes) refuse(path, `the tree is larger than ${LIMITS.maxTreeBytes / 1024} KiB`)
      const children: ComponentChild[] = []
      out.push({ type, ...keyField, props, children })
      const childKeys = new Set<string>()
      const childInPressable = inPressable || (type === 'ListItem' && props.onPress !== undefined)
      // Pushed in reverse, so they pop in document order.
      for (let index = rawChildren.length - 1; index >= 0; index--) {
        stack.push({
          raw: rawChildren[index],
          depth: depth + 1,
          parentType: type,
          policy: COMPONENT_CATALOG[type].children,
          inPressable: childInPressable,
          siblingKeys: childKeys,
          out: children,
          path: `${path}.children.${index}`,
        })
      }
    }
  } catch (error) {
    if (error instanceof TreeRefusal) return { ok: false, error: error.message }
    throw error
  }
  const tree = root[0]
  return typeof tree === 'object'
    ? { ok: true, tree, nodes: nodes + texts, warnings: [...warnings] }
    : { ok: false, error: 'tree: expected a component' }
}

/** Every callback id a checked tree binds, for the window to know what a press may name. */
export function componentTreeCallbacks(tree: ComponentChild | null): Set<string> {
  const ids = new Set<string>()
  const pending: unknown[] = tree ? [tree] : []
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next !== 'object' || next === null) continue
    const node = next as ComponentNode
    for (const value of Object.values(node.props ?? {})) {
      if (isPlainObject(value) && typeof value.$callback === 'string') ids.add(value.$callback)
    }
    if (Array.isArray(node.children)) pending.push(...node.children)
  }
  return ids
}
