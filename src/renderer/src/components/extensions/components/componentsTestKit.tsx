// Drawing a checked tree in a test, as the panel's host does: the tree goes
// through the catalogue's checker first, and every press, edit, grant and
// opened link is recorded.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { parseComponentTree } from '../../../../../../packages/extension-sdk/src/components/tree'
import { ComponentsView } from './ComponentsView'
import type { ComponentsTree, ComponentsViewProps } from './componentsViewTypes'

export type Sent = { callback: string; args: unknown[]; edit?: number }

/** A node on the wire, as the runtime sends it. */
export function n(type: string, props: Record<string, unknown> = {}, children: unknown[] = [], key?: string) {
  return { type, ...(key === undefined ? {} : { key }), props, children }
}

/** A callback prop, as the runtime sends a handler. */
export const cb = (id: string) => ({ $callback: id })

export function checked(raw: unknown): ComponentsTree {
  const parsed = parseComponentTree(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.tree
}

export type Drawn = {
  host: HTMLElement
  sent: Sent[]
  grants: number
  opened: string[]
  draw(raw: unknown, options?: { inert?: boolean }): void
  unmount(): void
}

export function draw(
  raw: unknown,
  options: { inert?: boolean; images?: Record<string, string | null>; clock?: () => number } = {},
): Drawn {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  let revision = 0
  const drawn: Drawn = {
    host,
    sent: [],
    grants: 0,
    opened: [],
    draw(next, again = {}) {
      revision += 1
      const props: ComponentsViewProps = {
        tree: checked(next),
        revision,
        dispatch: (callback, args, extra) =>
          drawn.sent.push({ callback, args, ...(extra?.edit === undefined ? {} : { edit: extra.edit }) }),
        grantGesture: () => {
          drawn.grants += 1
        },
        openLink: (href) => drawn.opened.push(href),
        readImage: async (src) => options.images?.[src] ?? null,
        inert: again.inert ?? options.inert ?? false,
        locale: 'en',
      }
      act(() => root.render(<ComponentsView {...props} />))
    },
    unmount() {
      act(() => root.unmount())
      host.remove()
    },
  }
  drawn.draw(raw)
  return drawn
}

/** Type into a field as a person does: React hears the native value setter and an input event. */
export function typeInto(element: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  act(() => {
    setter.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export function click(element: Element, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

export function key(element: Element, name: string, init: KeyboardEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
  })
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
