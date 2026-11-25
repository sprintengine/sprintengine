// Elements, and turning a panel's component into the tree it sends Studio.
//
// JSX makes plain data: `jsx` (automatic runtime) and `h` (classic) build
// frozen elements. Evaluating calls the function components and keeps the
// catalogue's tags as nodes, giving each node a key (the author's, else its
// slot) and each handler an id derived from the node's key path and the
// prop's name, so the same control keeps the same id across renders.

import { COMPONENT_EDIT_PROP, componentValueControl } from '../catalog.js'

export const ELEMENT = Symbol.for('sprintengine.components.element')
export const Fragment = Symbol.for('sprintengine.components.fragment')

export type Props = Record<string, unknown>
export type ComponentFunction = (props: Props) => unknown
export type ElementType = string | typeof Fragment | ComponentFunction

export type Element = {
  readonly $$typeof: typeof ELEMENT
  readonly type: ElementType
  readonly props: Props
  readonly key: string | undefined
}

export function isElement(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && (value as { $$typeof?: unknown }).$$typeof === ELEMENT
}

function createElement(type: ElementType, props: Props, key: unknown): Element {
  return Object.freeze({
    $$typeof: ELEMENT,
    type,
    props,
    key: key === undefined || key === null ? undefined : String(key),
  })
}

/** The automatic runtime (`jsx`, `jsxs`): children arrive inside `props`. */
export function jsx(type: ElementType, props: Props | null, key?: unknown): Element {
  const { key: propKey, ...rest } = props ?? {}
  return createElement(type, rest, key ?? propKey)
}

/** The classic runtime (`h`, a bundler's `jsxFactory`): children arrive as arguments. */
export function h(type: ElementType, props: Props | null, ...children: unknown[]): Element {
  const { key, ...rest } = props ?? {}
  if (children.length > 0) rest.children = children.length === 1 ? children[0] : children
  return createElement(type, rest, key)
}

export type WireNode = { type: string; key: string; props: Record<string, unknown>; children: (WireNode | string)[] }
export type Callback = (...args: unknown[]) => unknown
export type Evaluation = { tree: WireNode | null; callbacks: Map<string, Callback> }

// A clean error beats a stack overflow from a component that renders itself.
const MAX_EVALUATION_DEPTH = 512
// A Tree's items nest 16 deep, two JSON levels (array, object) each.
const MAX_PROP_DEPTH = 40
const IGNORED_PROPS: ReadonlySet<string> = new Set(['children', 'ref', 'key', COMPONENT_EDIT_PROP])

function describe(value: unknown): string {
  if (value === null || typeof value !== 'object') return typeof value === 'number' ? String(value) : typeof value
  return (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'object'
}

/** Throws unless `value` survives a JSON round trip unchanged. */
export function assertPlainJson(value: unknown, where: string, depth = 0): void {
  if (depth > MAX_PROP_DEPTH) throw new TypeError(`${where} is nested too deeply`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainJson(item, `${where}[${index}]`, depth + 1))
    return
  }
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype === Object.prototype || prototype === null) {
      for (const [name, item] of Object.entries(value))
        if (item !== undefined) assertPlainJson(item, `${where}.${name}`, depth + 1)
      return
    }
  }
  throw new TypeError(`${where} must be plain JSON data, not ${describe(value)}`)
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined)
  if (value === null || typeof value !== 'object') return value
  const copy: Record<string, unknown> = {}
  for (const [name, item] of Object.entries(value)) if (item !== undefined) copy[name] = withoutUndefined(item)
  return copy
}

function assertUniqueKeys(children: (WireNode | string)[], parent: string): void {
  const seen = new Set<string>()
  for (const child of children) {
    if (typeof child === 'string') continue
    if (seen.has(child.key))
      throw new Error(`duplicate key "${child.key.slice(0, 64)}" among the children of ${parent}`)
    seen.add(child.key)
  }
}

/** 64-bit FNV-1a over two lanes, base 36: short, stable callback ids. */
function hashId(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x5bd1e995)
  }
  return `c${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`
}

export function evaluateTree(
  component: ComponentFunction,
  /** The newest edit handled, per value control's change callback. */
  editsSeen: ReadonlyMap<string, number> = new Map(),
): Evaluation {
  const callbacks = new Map<string, Callback>()

  function callbackId(path: string, prop: string): string {
    const base = hashId(`${path}|${prop}`)
    let id = base
    for (let attempt = 1; callbacks.has(id); attempt++) id = `${base}.${attempt}`
    return id
  }

  function hostNode(type: string, props: Props, key: string, parentPath: string, depth: number): WireNode {
    if (!/^[A-Z]/u.test(type))
      throw new TypeError(`<${type.slice(0, 64)}> is not a Studio component: a components panel never draws HTML.`)
    const path = `${parentPath}/${key}`
    const wire: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(props)) {
      if (IGNORED_PROPS.has(name) || value === undefined) continue
      if (typeof value === 'function') {
        const id = callbackId(path, name)
        callbacks.set(id, value as Callback)
        wire[name] = { $callback: id }
      } else {
        assertPlainJson(value, `<${type}> prop "${name}"`)
        wire[name] = withoutUndefined(value)
      }
    }
    const control = componentValueControl(type)
    const onChange = control ? wire[control.change] : undefined
    if (typeof onChange === 'object' && onChange !== null) {
      // The window keeps typing this render has not seen yet: see the edit protocol.
      const id = (onChange as { $callback?: unknown }).$callback
      wire[COMPONENT_EDIT_PROP] = typeof id === 'string' ? (editsSeen.get(id) ?? 0) : 0
    }
    const children: (WireNode | string)[] = []
    const list = Array.isArray(props.children) ? props.children : [props.children]
    list.forEach((child, index) => emit(child, `#${index}`, '', children, path, depth + 1))
    assertUniqueKeys(children, `<${type}>`)
    return { type, key, props: wire, children }
  }

  /** `slot` names an unkeyed node; `scope` prefixes an author's key (nested arrays, components). */
  function emit(
    value: unknown,
    slot: string,
    scope: string,
    out: (WireNode | string)[],
    parentPath: string,
    depth: number,
  ): void {
    if (depth > MAX_EVALUATION_DEPTH) throw new Error(`the component tree is deeper than ${MAX_EVALUATION_DEPTH}`)
    if (value === null || value === undefined || typeof value === 'boolean') return
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => emit(item, `${slot}.${index}`, `${slot}.`, out, parentPath, depth + 1))
      return
    }
    if (!isElement(value)) throw new TypeError(`a ${describe(value)} is not a valid child; render a component or text`)
    const { type, props } = value
    const key = value.key === undefined ? slot : `${scope}${value.key}`
    if (type === Fragment) emit(props.children, key, `${key}.`, out, parentPath, depth + 1)
    else if (typeof type === 'function') emit(type(props), key, `${key}:`, out, parentPath, depth + 1)
    else if (typeof type === 'string') out.push(hostNode(type, props, key, parentPath, depth))
    else throw new TypeError('invalid element type; import components from "@sprintengine/extension-sdk/components"')
  }

  const root: (WireNode | string)[] = []
  emit(component({}), '#0', '', root, '', 0)
  const nodes: WireNode[] = root.map((child, index) =>
    typeof child === 'string' ? { type: 'Text', key: `#text${index}`, props: {}, children: [child] } : child,
  )
  assertUniqueKeys(nodes, 'the panel')
  const tree = nodes.length <= 1 ? (nodes[0] ?? null) : { type: 'Stack', key: '#root', props: {}, children: nodes }
  return { tree, callbacks }
}
