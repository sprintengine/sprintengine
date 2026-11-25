// The stationary rule for a components panel's presses. A press on one of
// Studio's own controls (a Button, IconButton, ListItem or Link) grants the
// panel one gesture-gated call, such as opening a URL, but only when that
// control has stood still for 500 ms: the same place in the tree, the same
// type, target and everything it draws (every prop and text inside it,
// compared whole), and the same position on screen. Anything that
// moves it, a sibling growing above it included, starts the wait again, so a
// panel cannot slide a control under the pointer just before a click. The
// person scrolling the panel is not a move: positions are measured on screen,
// with the panel's own scroll added back, and nothing else. A whole panel
// moving (an error banner appearing above its tree) moves every control in it.
//
// Two halves, both on an injected clock so they are testable without a
// window: what each accepted tree says about its controls (`observe`), and
// where each control sits on screen (`geometry`).

import { createContext, useContext } from 'react'

import type { ComponentChild, ComponentNode } from '../../../../../../packages/extension-sdk/src/components/tree'
import type { ComponentsTree } from './componentsViewTypes'

/** How long a control stands still before a press on it counts. */
export const COMPONENT_SETTLE_MS = 500

/** The controls whose press may grant a gesture, and Markdown, whose links open only once it is still. */
const TRACKED: ReadonlySet<string> = new Set(['Button', 'IconButton', 'ListItem', 'Link', 'Markdown'])

/**
 * Past this, a control's content is not kept to compare: every render of it
 * starts the wait again. Well above the largest Markdown (64 KiB), and a tree
 * is at most 512 KiB, so it binds only a control holding a large part of one,
 * and caps what nested controls cost to keep.
 */
export const COMPONENT_SIGNATURE_MAX_LENGTH = 160 * 1024

/** The ids a control is tracked under: its press handler, a Link's href, or a Markdown block. */
export const componentGestureId = {
  callback: (callback: string): string => `cb:${callback}`,
  href: (href: string): string => `href:${href}`,
  markdown: (content: string): string => `md:${content}`,
}

function callbackOf(node: ComponentNode): string | null {
  const onPress = node.props.onPress as { $callback?: unknown } | undefined
  return typeof onPress?.$callback === 'string' ? onPress.$callback : null
}

/** The id the view tracks a node under; null for a node that never grants. */
export function componentGestureIdOf(node: ComponentNode): string | null {
  if (!TRACKED.has(node.type)) return null
  if (node.type === 'Link' && typeof node.props.href === 'string') return componentGestureId.href(node.props.href)
  if (node.type === 'Markdown') return componentGestureId.markdown(String(node.props.content ?? ''))
  const callback = callbackOf(node)
  return callback === null ? null : componentGestureId.callback(callback)
}

// A value, canonically: object keys in order, so equal content always reads
// the same. A callback is only a marker: which handler a nested node holds
// does not change how the control looks, and the control's own is its id.
function canonical(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    parts.push('[')
    for (const item of value) {
      canonical(item, parts)
      parts.push(',')
    }
    parts.push(']')
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.$callback === 'string') {
      parts.push('$cb')
      return
    }
    parts.push('{')
    for (const name of Object.keys(record).sort()) {
      parts.push(JSON.stringify(name), ':')
      canonical(record[name], parts)
      parts.push(',')
    }
    parts.push('}')
  } else parts.push(JSON.stringify(value) ?? 'undefined')
}

const CLOSE: unique symbol = Symbol('close')

/**
 * Everything a control draws, kept whole: its type, every prop of it and of
 * every node inside it (labels, icons, tones, variants, an Image's source),
 * and all their text. Compared in full, never by a hash a panel could pick
 * a colliding label for. Null when it is over the cap.
 */
function contentOf(node: ComponentNode): string | null {
  const parts: string[] = []
  let length = 0
  const stack: (ComponentChild | typeof CLOSE)[] = [node]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    let part: string
    if (item === CLOSE) part = '>'
    else if (typeof item === 'string') part = JSON.stringify(item)
    else {
      const props: string[] = []
      canonical(item.props, props)
      part = `<${item.type}${props.join('')}`
      stack.push(CLOSE)
      for (let index = item.children.length - 1; index >= 0; index--) stack.push(item.children[index]!)
    }
    length += part.length
    if (length > COMPONENT_SIGNATURE_MAX_LENGTH) return null
    parts.push(part)
  }
  return parts.join('')
}

export type ComponentGestureStability = {
  /** Record every tracked control of a newly drawn tree. */
  observe(tree: ComponentsTree, now: number): void
  /** True when every control under this id has been unchanged for the wait (and one exists). */
  isSettled(id: string, now: number): boolean
}

export function createComponentGestureStability(): ComponentGestureStability {
  let records = new Map<string, { id: string; signature: string | null; since: number }>()
  return {
    observe(tree, now) {
      const next = new Map<string, { id: string; signature: string | null; since: number }>()
      const stack: { node: ComponentNode; path: string }[] =
        tree && tree.type !== 'Unsupported' ? [{ node: tree, path: '' }] : []
      for (let item = stack.pop(); item; item = stack.pop()) {
        const { node, path } = item
        const id = componentGestureIdOf(node)
        if (id !== null) {
          // Over the cap, there is nothing to compare: the wait starts again.
          const signature = contentOf(node)
          const previous = records.get(path)
          const same = signature !== null && previous?.signature === signature && previous.id === id
          next.set(path, { id, signature, since: same ? previous.since : now })
        }
        node.children.forEach((child, index) => {
          if (typeof child !== 'string' && child.type !== 'Unsupported')
            stack.push({ node: child, path: `${path}/${child.key ?? `#${index}`}` })
        })
      }
      records = next
    },
    isSettled(id, now) {
      let found = false
      for (const record of records.values()) {
        if (record.id !== id) continue
        if (now - record.since < COMPONENT_SETTLE_MS) return false
        found = true
      }
      return found
    },
  }
}

/** Where each tracked control sits on screen, the panel's own scroll added back. */
export type ComponentGestureGeometry = {
  /** Stable per id, so React does not attach it again (and reset it) on every render. */
  refFor(id: string): (element: Element | null) => void
  setContainer(element: Element | null): void
  /** Measure every control again: after each commit, and just before a press is judged. */
  sample(now?: number): void
  /** True when every control under this id has kept its place for `settleMs` (and one exists). */
  isSettled(id: string, now: number, settleMs?: number): boolean
}

export function createComponentGestureGeometry(clock: () => number): ComponentGestureGeometry {
  const placements = new Map<Element, { id: string; rect: string; since: number }>()
  const refs = new Map<string, (element: Element | null) => void>()
  const attached = new Map<string, Set<Element>>()
  let container: Element | null = null

  // The window's viewport is the reference: it does not move. Only the
  // panel's scrolling is taken out; the panel itself moving is a move.
  const rectOf = (element: Element): string => {
    const box = element.getBoundingClientRect()
    const left = box.left + (container?.scrollLeft ?? 0)
    const top = box.top + (container?.scrollTop ?? 0)
    return `${left},${top},${box.width},${box.height}`
  }

  return {
    refFor(id) {
      let ref = refs.get(id)
      if (!ref) {
        ref = (element) => {
          const elements = attached.get(id) ?? new Set<Element>()
          attached.set(id, elements)
          if (element) {
            elements.add(element)
            placements.set(element, { id, rect: rectOf(element), since: clock() })
            return
          }
          // React detaches with null, without saying which element: drop the disconnected ones.
          for (const known of elements) {
            if (known.isConnected) continue
            elements.delete(known)
            placements.delete(known)
          }
        }
        refs.set(id, ref)
      }
      return ref
    },
    setContainer(element) {
      container = element
    },
    sample(now = clock()) {
      for (const [element, placement] of placements) {
        if (!element.isConnected) {
          placements.delete(element)
          continue
        }
        const rect = rectOf(element)
        if (rect !== placement.rect) placements.set(element, { ...placement, rect, since: now })
      }
    },
    isSettled(id, now, settleMs = COMPONENT_SETTLE_MS) {
      let found = false
      for (const placement of placements.values()) {
        if (placement.id !== id) continue
        if (now - placement.since < settleMs) return false
        found = true
      }
      return found
    },
  }
}

/** Both halves, judged together: the one question a press asks. */
export type ComponentGestures = {
  stability: ComponentGestureStability
  geometry: ComponentGestureGeometry
  clock: () => number
}

export function isComponentControlSettled(gestures: ComponentGestures, id: string): boolean {
  const now = gestures.clock()
  gestures.geometry.sample(now)
  return gestures.stability.isSettled(id, now) && gestures.geometry.isSettled(id, now)
}

export const ComponentGesturesContext = createContext<ComponentGestures | null>(null)

/** The ref that tracks an element's place under `id`, when the view tracks gestures. */
export function useGestureRef(id: string | null): ((element: Element | null) => void) | undefined {
  const gestures = useContext(ComponentGesturesContext)
  return id === null ? undefined : gestures?.geometry.refFor(id)
}
