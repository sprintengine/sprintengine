// What every drawn component of a components panel reaches: where its presses
// and edits go, the stationary rule, and how to draw its children. One
// context, so a family's file needs no props beyond its node.

import { createContext, useContext, type ReactNode } from 'react'

import { COMPONENT_EDIT_PROP } from '../../../../../../packages/extension-sdk/src/components/catalog'
import type { ComponentChild, ComponentNode } from '../../../../../../packages/extension-sdk/src/components/tree'
import { TONE_COLOR_VAR, TONE_SOFT_VAR, type Tone } from '../../ui/tokens'
import {
  ComponentGesturesContext,
  componentGestureId,
  isComponentControlSettled,
  type ComponentGestures,
} from './componentGestures'

export type ComponentsContextValue = {
  /** Send a handler call; nothing while the view is inert. */
  send(callback: string, args: unknown[], edit?: number): void
  grantGesture(): void
  openLink(href: string): void
  readImage(src: string): Promise<string | null>
  inert: boolean
  locale: string
  /** The run that drew the tree: the edit protocol's count starts over with a new one. */
  run: string
  gestures: ComponentGestures
  /** Draw one node's children. */
  renderChildren(children: ComponentChild[], path: string): ReactNode
}

export const ComponentsContext = createContext<ComponentsContextValue | null>(null)

export function useComponents(): ComponentsContextValue {
  const value = useContext(ComponentsContext)
  if (!value) throw new Error('A component of a components panel is drawn outside its view.')
  return value
}

/** How a column lays out what it holds: a field fills the width, a button keeps its own. */
export const ColumnContext = createContext(false)

/** The id of a callback prop, or undefined. */
export function callbackOf(value: unknown): string | undefined {
  const id = (value as { $callback?: unknown } | undefined)?.$callback
  return typeof id === 'string' ? id : undefined
}

/** A value control's `$edit`: the newest edit the panel had handled when it rendered. */
export function editAckOf(node: ComponentNode): number | undefined {
  const acked = node.props[COMPONENT_EDIT_PROP]
  return typeof acked === 'number' ? acked : undefined
}

/** The catalogue's tones in the app's own vocabulary. */
const TONES: Record<string, Tone> = {
  neutral: 'neutral',
  accent: 'accent',
  success: 'good',
  warning: 'warn',
  danger: 'error',
}

export function appTone(tone: unknown): Tone {
  return (typeof tone === 'string' && TONES[tone]) || 'neutral'
}

export function toneInk(tone: unknown): string | undefined {
  if (tone === undefined || tone === 'neutral') return undefined
  return TONE_COLOR_VAR[appTone(tone)]
}

export function toneSoft(tone: unknown): string {
  return TONE_SOFT_VAR[appTone(tone)]
}

/** The gap scale, as the app's spacing steps. */
export const GAP: Record<string, string> = { none: 'gap-0', xs: 'gap-1', sm: 'gap-2', md: 'gap-3', lg: 'gap-4' }
export const PADDING: Record<string, string> = { none: 'p-0', xs: 'p-1', sm: 'p-2', md: 'p-3', lg: 'p-4' }
export const PADDING_X: Record<string, string> = { none: 'px-0', xs: 'px-1', sm: 'px-2', md: 'px-3', lg: 'px-4' }
export const PADDING_Y: Record<string, string> = { none: 'py-0', xs: 'py-1', sm: 'py-2', md: 'py-3', lg: 'py-4' }
export const MARGIN: Record<string, string> = { none: 'm-0', xs: 'm-1', sm: 'm-2', md: 'm-3', lg: 'm-4' }
export const ALIGN: Record<string, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
}
export const JUSTIFY: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
}
/** A Table's, CodeView's or Tree's own scroll area. */
export const MAX_HEIGHT_PX: Record<string, number | undefined> = { sm: 256, md: 384, lg: 512, none: undefined }

/** The words of a node's text children, for a button's or a link's name. */
export function textOf(children: ComponentChild[]): string {
  return children
    .map((child) => (typeof child === 'string' ? child : textOf(child.type === 'Unsupported' ? [] : child.children)))
    .join('')
}

/**
 * A press on a Button, IconButton or ListItem: grants a gesture when the
 * control has stood still, then runs its handler. Nothing while inert.
 */
export function usePress(node: ComponentNode): (() => void) | undefined {
  const view = useComponents()
  const callback = callbackOf(node.props.onPress)
  if (!callback) return undefined
  return () => {
    if (view.inert) return
    if (isComponentControlSettled(view.gestures, componentGestureId.callback(callback))) view.grantGesture()
    view.send(callback, [])
  }
}

export function GesturesProvider({ gestures, children }: { gestures: ComponentGestures; children: ReactNode }) {
  return <ComponentGesturesContext.Provider value={gestures}>{children}</ComponentGesturesContext.Provider>
}

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /mac/iu.test(navigator.platform || navigator.userAgent || '')
