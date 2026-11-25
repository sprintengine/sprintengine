// `@sprintengine/extension-sdk/components`: what a components panel imports.
//
// A components panel describes its UI as data. Its module runs hidden and
// sandboxed, and Studio draws the tree it renders with Studio's own controls,
// so the panel matches the app in light and dark and follows its keyboard and
// focus rules, with no HTML or CSS of its own.
//
//   import { atom, read, update, Stack, Text, Button } from '@sprintengine/extension-sdk/components'
//
//   const count = atom('count', 0, { persist: 'plugin' })
//
//   export default function Panel() {
//     return (
//       <Stack gap="sm">
//         <Text>Clicked {read(count)} times</Text>
//         <Button onPress={() => update(count, (n) => n + 1)}>Click</Button>
//       </Stack>
//     )
//   }
//
// Studio provides this module when it loads the panel: a panel never bundles
// it. The same module is the JSX runtime (`.../components/jsx-runtime`), and
// Studio compiles a panel's `.tsx` for it with no build step.

import { read, resetAtoms } from './runtime/atoms.js'
import type { ComponentFunction } from './runtime/evaluate.js'
import {
  createComponentsRuntime,
  type ComponentsBridge,
  type ComponentsRuntime,
  type PanelModule,
  type Schedule,
} from './runtime/renderer.js'
import { createComponentsSdk } from './runtime/sdk.js'
import type * as T from './types.js'

export { atom, derived, read, set, update } from './runtime/atoms.js'
export type { Atom, AtomOptions, PersistScope } from './runtime/atoms.js'
export { Fragment, h, jsx, jsx as jsxs, jsx as jsxDEV } from './runtime/evaluate.js'
export type { ComponentsBridge, Disposable, PanelContext, Theme, ColorScheme } from './runtime/renderer.js'
export type * from './types.js'

let runtime: ComponentsRuntime | null = null
// What `mount()` was given last. Kept: a module runs once per process, and
// every runtime started after it (a test's second mount) draws it too.
let mounted: ComponentFunction | null = null

/**
 * Start the runtime on a bridge (the frame's bootstrap, or a test's
 * stand-in). Not for panels: Studio does this before it loads one.
 */
export function installComponentsRuntime(options: {
  bridge: ComponentsBridge
  schedule?: Schedule
  now?: () => number
  awaitHydration?: boolean
}): ComponentsRuntime {
  runtime?.dispose()
  resetAtoms()
  const installed = createComponentsRuntime(options)
  runtime = installed
  // Drawn when the runtime boots, where a default export is: after setup.
  if (mounted) installed.mount(mounted)
  return installed
}

/** The runtime now running, if any (tests and the frame's bootstrap). */
export function currentComponentsRuntime(): ComponentsRuntime | null {
  return runtime
}

/**
 * Studio's frame bootstrap: start the runtime and boot the panel's module.
 * Resolves once the first render is sent; rejects when the module throws
 * before it. Not for panels.
 */
export async function bootComponentsPanel(bridge: ComponentsBridge, module: PanelModule): Promise<ComponentsRuntime> {
  const installed = installComponentsRuntime({ bridge, awaitHydration: true })
  if (typeof addEventListener === 'function') addEventListener('pagehide', () => installed.dispose(), { once: true })
  await installed.boot(module)
  return installed
}

/**
 * Draw `component` as the panel, as a module's default export is drawn: once
 * the stored atoms are loaded and `setup` ran. A default export comes first.
 */
export function mount(component: (props: Record<string, never>) => unknown): void {
  if (typeof component !== 'function') throw new TypeError('mount() takes a component function.')
  mounted = component as ComponentFunction
  runtime?.mount(mounted)
}

const sdk = createComponentsSdk({
  bridge: () => runtime?.bridge ?? null,
  theme: () => (runtime ? read(runtime.themeAtom) : { colorScheme: 'dark' }),
})

export const { api, host, env, shell, on, ui, storage, settings, secrets, worker } = sdk

// The catalogue's tags. JSX `<Stack>` compiles to a reference to `Stack`, so
// a panel imports them by name; at run time each is its own name.
const tag = <P>(name: string): T.Component<P> => name as unknown as T.Component<P>

export const Stack = tag<T.StackProps>('Stack')
export const Row = tag<T.RowProps>('Row')
export const Text = tag<T.TextProps>('Text')
export const Heading = tag<T.HeadingProps>('Heading')
export const Button = tag<T.ButtonProps>('Button')
export const IconButton = tag<T.IconButtonProps>('IconButton')
export const Badge = tag<T.BadgeProps>('Badge')
export const Card = tag<T.CardProps>('Card')
export const List = tag<T.ListProps>('List')
export const ListItem = tag<T.ListItemProps>('ListItem')
export const Input = tag<T.InputProps>('Input')
export const Switch = tag<T.SwitchProps>('Switch')
export const Select = tag<T.SelectProps>('Select')
export const Separator = tag<T.SeparatorProps>('Separator')
export const Progress = tag<T.ProgressProps>('Progress')
export const Spinner = tag<T.SpinnerProps>('Spinner')
export const EmptyState = tag<T.EmptyStateProps>('EmptyState')
export const Link = tag<T.LinkProps>('Link')
export const Code = tag<T.CodeProps>('Code')
// Catalogue 2.
export const Textarea = tag<T.TextareaProps>('Textarea')
export const Checkbox = tag<T.CheckboxProps>('Checkbox')
export const RadioGroup = tag<T.RadioGroupProps>('RadioGroup')
export const Slider = tag<T.SliderProps>('Slider')
export const Field = tag<T.FieldProps>('Field')
export const Tabs = tag<T.TabsProps>('Tabs')
export const Tab = tag<T.TabProps>('Tab')
export const Collapsible = tag<T.CollapsibleProps>('Collapsible')
export const Toolbar = tag<T.ToolbarProps>('Toolbar')
export const Grid = tag<T.GridProps>('Grid')
export const Table = tag<T.TableProps>('Table')
export const Tree = tag<T.TreeProps>('Tree')
export const Markdown = tag<T.MarkdownProps>('Markdown')
export const CodeView = tag<T.CodeViewProps>('CodeView')
export const Image = tag<T.ImageProps>('Image')
export const KeyValue = tag<T.KeyValueProps>('KeyValue')
export const Callout = tag<T.CalloutProps>('Callout')
export const Skeleton = tag<T.SkeletonProps>('Skeleton')
// Catalogue 3.
export const RelativeTime = tag<T.RelativeTimeProps>('RelativeTime')
// Catalogue 4.
export const Box = tag<T.BoxProps>('Box')

/** The JSX namespace TypeScript checks a panel's JSX with (`jsxImportSource`). */
export declare namespace JSX {
  type Element = T.ComponentElement
  // No lowercase tags: a components panel never draws HTML.
  type IntrinsicElements = Record<never, never>
  type ElementChildrenAttribute = { children: unknown }
  type IntrinsicAttributes = { key?: string | number | null }
}
