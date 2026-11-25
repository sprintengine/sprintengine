// The stationary rule for a components panel's presses. A press on one of
// Studio's own controls (a Button, IconButton, ListItem or Link) grants the
// panel one gesture-gated call, such as opening a URL, but only when that
// control has stood still for 500 ms: the same place in the tree, the same
// type, label and target, and the same position on screen. Anything that
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

/** 32-bit FNV-1a: a short id for long content. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  return (hash >>> 0).toString(36)
}

/** The ids a control is tracked under: its press handler, a Link's href, or a Markdown block. */
export const componentGestureId = {
  callback: (callback: string): string => `cb:${callback}`,
  href: (href: string): string => `href:${href}`,
  markdown: (content: string): string => `md:${content.length}:${contentHash(content)}`,
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

// Every visible prop a node inside a control can draw its words or marks with.
const VISIBLE = ['label', 'title', 'description', 'icon', 'href', 'variant', 'tone', 'content', 'value', 'name', 'alt']

/** Everything a control shows, nested Text and Badges included: a short id of its whole content. */
function contentOf(children: ComponentChild[]): string {
  const parts: string[] = []
  const walk = (list: ComponentChild[]) => {
    for (const child of list) {
      if (typeof child === 'string') parts.push(child)
      else {
        const props = child.props as Record<string, unknown>
        parts.push(`<${child.type}`, ...VISIBLE.map((name) => String(props[name] ?? '')), '>')
        walk(child.children)
        parts.push('</>')
      }
    }
  }
  walk(children)
  const text = parts.join('\u0000')
  return `${text.length}:${contentHash(text)}`
}

/** What the person sees and what a press does: any change starts the wait again. */
function signatureOf(node: ComponentNode, path: string): string {
  const visible = VISIBLE.map((name) => String(node.props[name] ?? '')).join('\u0000')
  return `${path}\u0001${node.type}\u0001${visible}\u0001${contentOf(node.children)}`
}

export type ComponentGestureStability = {
  /** Record every tracked control of a newly drawn tree. */
  observe(tree: ComponentsTree, now: number): void
  /** True when every control under this id has been unchanged for the wait (and one exists). */
  isSettled(id: string, now: number): boolean
}

export function createComponentGestureStability(): ComponentGestureStability {
  let records = new Map<string, { id: string; signature: string; since: number }>()
  return {
    observe(tree, now) {
      const next = new Map<string, { id: string; signature: string; since: number }>()
      const stack: { node: ComponentNode; path: string }[] =
        tree && tree.type !== 'Unsupported' ? [{ node: tree, path: '' }] : []
      for (let item = stack.pop(); item; item = stack.pop()) {
        const { node, path } = item
        const id = componentGestureIdOf(node)
        if (id !== null) {
          const signature = signatureOf(node, path)
          const previous = records.get(path)
          next.set(path, {
            id,
            signature,
            since: previous?.signature === signature && previous.id === id ? previous.since : now,
          })
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
