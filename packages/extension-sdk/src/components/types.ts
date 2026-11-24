// The typings of the components a components panel draws: what TypeScript
// checks a panel's JSX against. The catalogue (catalog.ts) is what Studio
// checks at run time; a test holds the two to the same prop names.

import type { ComponentIconName, ComponentTone, RelativeTimeFormat } from './catalog.js'

/** What JSX makes: plain data until Studio draws it. */
export type ComponentElement = {
  readonly $$typeof: symbol
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly key: string | undefined
}

/** What a component may hold. */
export type Child = ComponentElement | string | number | boolean | null | undefined | readonly Child[]
type Children = { children?: Child }
type Keyed = { key?: string | number | null }

export type Gap = 'none' | 'xs' | 'sm' | 'md' | 'lg'
export type Align = 'start' | 'center' | 'end' | 'stretch'
export type Justify = 'start' | 'center' | 'end' | 'between'
export type Size = 'xs' | 'sm' | 'md'
export type Variant = 'solid' | 'outline' | 'ghost'
export type MaxHeight = 'sm' | 'md' | 'lg' | 'none'
/** Any short name; one Studio does not know draws a neutral glyph. */
export type IconName = ComponentIconName | (string & {})
export type Tone = ComponentTone

export type StackProps = Children & { gap?: Gap; align?: Align }
export type RowProps = Children & { gap?: Gap; align?: Align; justify?: Justify; wrap?: boolean }
export type TextProps = Children & {
  tone?: Tone
  muted?: boolean
  size?: Size
  weight?: 'regular' | 'medium' | 'semibold'
  truncate?: boolean
}
export type HeadingProps = Children & { level?: 1 | 2 | 3 }
export type ButtonProps = Children & {
  variant?: Variant
  tone?: Tone
  size?: Size
  icon?: IconName
  tooltip?: string
  disabled?: boolean
  onPress?: () => void | Promise<void>
}
export type IconButtonProps = {
  icon: IconName
  label: string
  tooltip?: string
  variant?: Variant
  tone?: Tone
  size?: Size
  disabled?: boolean
  onPress?: () => void | Promise<void>
}
export type BadgeProps = Children & { tone?: Tone }
export type CardProps = Children & { title?: string; description?: string }
export type ListProps = Children & { label?: string }
export type ListItemProps = Children & {
  title?: string
  description?: string
  icon?: IconName
  current?: boolean
  disabled?: boolean
  onPress?: () => void | Promise<void>
}
type FieldBase = { label: string; labelHidden?: boolean; disabled?: boolean }
export type InputProps = FieldBase & {
  value?: string
  defaultValue?: string
  placeholder?: string
  type?: 'text' | 'search' | 'password'
  maxLength?: number
  invalid?: boolean
  onChange?: (value: string) => void
  onSubmit?: (value: string) => void
}
export type SwitchProps = {
  label: string
  checked?: boolean
  defaultChecked?: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
}
export type SelectOption = { value: string; label: string; disabled?: boolean }
export type SelectProps = FieldBase & {
  value?: string
  defaultValue?: string
  placeholder?: string
  options: SelectOption[]
  onChange?: (value: string) => void
}
export type SeparatorProps = { orientation?: 'horizontal' | 'vertical' }
export type ProgressProps = { label: string; labelHidden?: boolean; value?: number }
export type SpinnerProps = { label: string; labelHidden?: boolean }
export type EmptyStateProps = Children & { title: string; description?: string; icon?: IconName }
export type LinkProps = Children & { href?: string; onPress?: () => void | Promise<void> }
export type CodeProps = Children & { block?: boolean }
export type TextareaProps = FieldBase & {
  value?: string
  defaultValue?: string
  placeholder?: string
  rows?: number
  maxLength?: number
  invalid?: boolean
  onChange?: (value: string) => void
  /** Cmd+Enter (Ctrl+Enter off macOS). */
  onSubmit?: (value: string) => void
}
export type CheckboxProps = {
  label: string
  description?: string
  checked?: boolean
  defaultChecked?: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
}
export type RadioOption = { value: string; label: string; description?: string; disabled?: boolean }
export type RadioGroupProps = FieldBase & {
  value?: string
  defaultValue?: string
  options: RadioOption[]
  orientation?: 'vertical' | 'horizontal'
  onChange?: (value: string) => void
}
export type SliderProps = FieldBase & {
  value?: number
  defaultValue?: number
  min?: number
  max?: number
  step?: number
  showValue?: boolean
  onChange?: (value: number) => void
}
export type FieldProps = Children & { label: string; description?: string; error?: string; required?: boolean }
export type TabsProps = Children & {
  label: string
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
}
export type TabProps = Children & { value: string; label: string; icon?: IconName; disabled?: boolean }
export type CollapsibleProps = Children & {
  title: string
  description?: string
  open?: boolean
  defaultOpen?: boolean
  disabled?: boolean
  onChange?: (open: boolean) => void
}
export type ToolbarProps = Children & { label: string; gap?: Gap }
export type GridProps = Children & { columns?: number; minItemWidth?: 'xs' | 'sm' | 'md' | 'lg'; gap?: Gap }
export type RelativeCell = { type: 'relative'; at: number; format?: RelativeTimeFormat }
export type TableCell = string | number | boolean | null | RelativeCell
export type TableColumn = {
  key: string
  label: string
  align?: 'start' | 'center' | 'end'
  width?: 'auto' | 'xs' | 'sm' | 'md' | 'lg'
  minWidth?: 'auto' | 'xs' | 'sm' | 'md'
  hideBelow?: 'sm' | 'md'
  sortable?: boolean
}
export type TableRow = { key: string; cells: Record<string, TableCell>; disabled?: boolean }
export type TableSort = { column: string; direction: 'asc' | 'desc' }
export type TableProps = {
  label: string
  columns: TableColumn[]
  rows: TableRow[]
  sort?: TableSort
  selectionMode?: 'none' | 'single' | 'multiple'
  selected?: string[]
  defaultSelected?: string[]
  hasMore?: boolean
  loading?: boolean
  emptyText?: string
  maxHeight?: MaxHeight
  onSortChange?: (sort: TableSort) => void
  onSelectionChange?: (selection: { keys: string[] }) => void
  onRowAction?: (row: { key: string }) => void
  onLoadMore?: () => void
}
export type TreeItem = {
  key: string
  label: string
  description?: string
  icon?: IconName
  disabled?: boolean
  hasChildren?: boolean
  children?: TreeItem[]
}
export type TreeProps = {
  label: string
  items: TreeItem[]
  selected?: string
  defaultSelected?: string
  expanded?: string[]
  defaultExpanded?: string[]
  maxHeight?: MaxHeight
  onSelect?: (item: { key: string }) => void
  onToggle?: (item: { key: string; expanded: boolean }) => void
  onAction?: (item: { key: string }) => void
}
export type MarkdownProps = { content: string }
export type CodeViewProps = {
  code: string
  language?: string
  label?: string
  lineNumbers?: boolean
  wrap?: boolean
  maxHeight?: MaxHeight
}
export type ImageProps = {
  /** An image file in the extension (PNG, JPEG or WebP). */
  src: string
  alt: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'full'
  fit?: 'contain' | 'cover'
  rounded?: boolean
}
export type KeyValueItem = { label: string; value: string | number | boolean | null; tone?: Tone; code?: boolean }
export type KeyValueProps = { label?: string; items: KeyValueItem[] }
export type CalloutProps = Children & { tone?: Tone; title?: string; icon?: IconName }
export type SkeletonProps = { shape?: 'text' | 'block' | 'circle'; lines?: number; label?: string }
export type RelativeTimeProps = { at: number; format?: RelativeTimeFormat; tone?: Tone; muted?: boolean }
/** Pixels 0–4096, or a whole percent such as `'50%'`. */
export type BoxLength = number | `${number}%`
export type BoxProps = Children & {
  direction?: 'row' | 'column'
  gap?: Gap
  padding?: Gap
  paddingX?: Gap
  paddingY?: Gap
  margin?: Gap
  align?: Align
  justify?: Justify
  wrap?: boolean
  grow?: boolean
  shrink?: boolean
  width?: BoxLength
  height?: BoxLength
  minWidth?: BoxLength
  minHeight?: BoxLength
  maxWidth?: BoxLength
  maxHeight?: BoxLength
  columns?: number
  scroll?: 'x' | 'y' | 'both'
  border?: boolean | Tone
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'full'
  background?: 'none' | 'muted' | 'card' | Tone
}

/** A catalogue component as TypeScript sees it: a function of its props. At run time it is its name. */
export type Component<P> = (props: P & Keyed) => ComponentElement
