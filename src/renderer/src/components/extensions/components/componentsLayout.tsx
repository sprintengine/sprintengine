// Layout and structure components of a components panel. Every prop is a
// step of the app's own scales (gaps, padding, radii, the theme's surfaces and
// tones); Box's lengths, already held to pixels or whole percents, are the one
// value that reaches a style as given.

import { useId, type CSSProperties, type JSX } from 'react'

import type { ComponentChild, ComponentNode } from '../../../../../../packages/extension-sdk/src/components/tree'
import { Field } from '../../ui/Field'
import { GroupHeader } from '../../ui/GroupHeader'
import { TabPanel, Tabs } from '../../ui/Tabs'
import { Toolbar } from '../../ui/Toolbar'
import { ComponentIcon } from './componentIcons'
import { useHostValue } from './componentValue'
import {
  ALIGN,
  callbackOf,
  ColumnContext,
  editAckOf,
  GAP,
  JUSTIFY,
  MARGIN,
  PADDING,
  PADDING_X,
  PADDING_Y,
  toneInk,
  toneSoft,
  useComponents,
} from './componentsContext'

type Props = { node: ComponentNode; path: string }

export function StackView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const align = typeof node.props.align === 'string' ? node.props.align : undefined
  return (
    <div
      className={[
        'flex min-w-0 flex-col',
        GAP[String(node.props.gap ?? 'sm')],
        align ? ALIGN[align] : 'items-stretch',
      ].join(' ')}
    >
      <ColumnContext.Provider value={align === undefined}>
        {view.renderChildren(node.children, path)}
      </ColumnContext.Provider>
    </div>
  )
}

export function RowView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  return (
    <div
      className={[
        'flex min-w-0 flex-row',
        GAP[String(node.props.gap ?? 'sm')],
        ALIGN[String(node.props.align ?? 'center')] ?? 'items-center',
        JUSTIFY[String(node.props.justify ?? 'start')] ?? '',
        node.props.wrap ? 'flex-wrap' : '',
      ].join(' ')}
    >
      <ColumnContext.Provider value={false}>{view.renderChildren(node.children, path)}</ColumnContext.Provider>
    </div>
  )
}

const RADIUS: Record<string, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
}

const length = (value: unknown): string | number | undefined =>
  typeof value === 'number' ? value : typeof value === 'string' ? value : undefined

export function BoxView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const p = node.props
  const row = p.direction === 'row'
  const columns = typeof p.columns === 'number' ? p.columns : undefined
  const style: CSSProperties = {}
  for (const name of ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'] as const) {
    const value = length(p[name])
    if (value !== undefined) style[name] = value
  }
  if (columns) style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
  if (typeof p.border === 'string') style.borderColor = toneInk(p.border) ?? 'var(--border-default)'
  if (typeof p.background === 'string' && !['none', 'muted', 'card'].includes(p.background))
    style.backgroundColor = toneSoft(p.background)
  const align = typeof p.align === 'string' ? ALIGN[p.align] : row ? 'items-center' : 'items-stretch'
  return (
    <div
      data-component-box=""
      className={[
        'min-w-0',
        columns ? 'grid' : row ? 'flex flex-row' : 'flex flex-col',
        GAP[String(p.gap ?? 'none')],
        typeof p.padding === 'string' ? PADDING[p.padding] : '',
        typeof p.paddingX === 'string' ? PADDING_X[p.paddingX] : '',
        typeof p.paddingY === 'string' ? PADDING_Y[p.paddingY] : '',
        typeof p.margin === 'string' ? MARGIN[p.margin] : '',
        align,
        typeof p.justify === 'string' ? JUSTIFY[p.justify] : '',
        p.wrap ? 'flex-wrap' : '',
        p.grow ? 'grow' : '',
        p.shrink === false ? 'shrink-0' : p.shrink ? 'shrink' : '',
        p.scroll === 'x'
          ? 'overflow-x-auto'
          : p.scroll === 'y'
            ? 'overflow-y-auto'
            : p.scroll === 'both'
              ? 'overflow-auto'
              : '',
        p.border === true
          ? 'border border-[color:var(--border-default)]'
          : typeof p.border === 'string'
            ? 'border'
            : '',
        typeof p.radius === 'string' ? RADIUS[p.radius] : '',
        p.background === 'muted'
          ? 'bg-[color:var(--bg-hover)]'
          : p.background === 'card'
            ? 'bg-[color:var(--bg-surface-raised)]'
            : '',
      ].join(' ')}
      style={style}
    >
      <ColumnContext.Provider value={!row && !columns && p.align === undefined}>
        {view.renderChildren(node.children, path)}
      </ColumnContext.Provider>
    </div>
  )
}

const MIN_ITEM_WIDTH: Record<string, string> = { xs: '6rem', sm: '9rem', md: '12rem', lg: '16rem' }

export function GridView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const min = typeof node.props.minItemWidth === 'string' ? MIN_ITEM_WIDTH[node.props.minItemWidth] : undefined
  const columns = typeof node.props.columns === 'number' ? node.props.columns : 2
  return (
    <div
      className={['grid min-w-0', GAP[String(node.props.gap ?? 'sm')]].join(' ')}
      style={{
        gridTemplateColumns: min
          ? `repeat(auto-fill, minmax(min(${min}, 100%), 1fr))`
          : `repeat(${columns}, minmax(0, 1fr))`,
      }}
    >
      <ColumnContext.Provider value={false}>{view.renderChildren(node.children, path)}</ColumnContext.Provider>
    </div>
  )
}

export function CardView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const titleId = useId()
  const title = typeof node.props.title === 'string' ? node.props.title : undefined
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className="flex min-w-0 flex-col gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-3"
    >
      {title ? (
        <div className="flex flex-col gap-0.5">
          <h4 id={titleId} className="m-0 text-body font-semibold text-[color:var(--text-strong)]">
            {title}
          </h4>
          {typeof node.props.description === 'string' ? (
            <p className="m-0 text-meta text-[color:var(--text-muted)]">{node.props.description}</p>
          ) : null}
        </div>
      ) : null}
      <ColumnContext.Provider value={true}>{view.renderChildren(node.children, path)}</ColumnContext.Provider>
    </section>
  )
}

export function SeparatorView({ node }: Props): JSX.Element {
  const vertical = node.props.orientation === 'vertical'
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={
        vertical
          ? 'w-px self-stretch bg-[color:var(--border-subtle)]'
          : 'h-px w-full shrink-0 bg-[color:var(--border-subtle)]'
      }
    />
  )
}

export function ToolbarView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  return (
    <Toolbar ariaLabel={String(node.props.label ?? '')} className={GAP[String(node.props.gap ?? 'xs')]}>
      <ColumnContext.Provider value={false}>{view.renderChildren(node.children, path)}</ColumnContext.Provider>
    </Toolbar>
  )
}

type TabNode = ComponentNode & { type: 'Tab' }

function tabsOf(children: ComponentChild[]): TabNode[] {
  return children.filter((child): child is TabNode => typeof child !== 'string' && child.type === 'Tab')
}

/** Tabs: only the selected tab's children are drawn. */
export function TabsView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const prefix = useId().replace(/[^A-Za-z0-9_-]/gu, '')
  const tabs = tabsOf(node.children)
  const firstEnabled = tabs.find((tab) => !tab.props.disabled)
  const callback = callbackOf(node.props.onChange)
  const state = useHostValue<string>({
    value: typeof node.props.value === 'string' ? node.props.value : undefined,
    defaultValue:
      typeof node.props.defaultValue === 'string' ? node.props.defaultValue : String(firstEnabled?.props.value ?? ''),
    fallback: '',
    acked: editAckOf(node),
    callback,
    send: (id, value, edit) => view.send(id, [value], edit),
  })
  const selected = tabs.find((tab) => tab.props.value === state.value) ?? firstEnabled
  // The tab's own segment of its content's path, and the key its content is drawn
  // under: a switch draws the other tab's controls afresh, so what was typed in
  // one tab's field never shows in a field of the same key in the next.
  const selectedId = selected ? (selected.key ?? String(selected.props.value)) : ''
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Tabs
        ariaLabel={String(node.props.label ?? '')}
        idPrefix={prefix}
        items={tabs.map((tab) => ({
          id: String(tab.props.value),
          label: String(tab.props.label),
          ...(typeof tab.props.icon === 'string' ? { icon: <ComponentIcon name={tab.props.icon} /> } : {}),
          ...(tab.props.disabled ? { disabled: true } : {}),
        }))}
        value={String(selected?.props.value ?? '')}
        onChange={(next) => {
          if (view.inert || state.readOnly) return
          state.change(next)
        }}
      />
      {selected ? (
        <TabPanel idPrefix={prefix} tabId={String(selected.props.value)} active>
          <div key={`${selectedId}\u0000${String(selected.props.value)}`} className="flex min-w-0 flex-col gap-2">
            <ColumnContext.Provider value={true}>
              {view.renderChildren(selected.children, `${path}/${selectedId}`)}
            </ColumnContext.Provider>
          </div>
        </TabPanel>
      ) : null}
    </div>
  )
}

export function CollapsibleView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  const region = useId()
  const callback = callbackOf(node.props.onChange)
  const state = useHostValue<boolean>({
    value: typeof node.props.open === 'boolean' ? node.props.open : undefined,
    defaultValue: typeof node.props.defaultOpen === 'boolean' ? node.props.defaultOpen : undefined,
    fallback: false,
    acked: editAckOf(node),
    callback,
    send: (id, value, edit) => view.send(id, [value], edit),
  })
  return (
    <div className="flex min-w-0 flex-col">
      <GroupHeader
        title={String(node.props.title ?? '')}
        {...(typeof node.props.description === 'string' ? { count: node.props.description } : {})}
        expanded={state.value}
        controls={region}
        onExpandedChange={(next) => {
          if (view.inert || state.readOnly || node.props.disabled === true) return
          state.change(next)
        }}
      />
      {/* Kept in the DOM, hidden, so the header's aria-controls resolves; its content is drawn only when open. */}
      <div id={region} hidden={!state.value} className="flex min-w-0 flex-col gap-2 pt-2 pl-3">
        {state.value ? (
          <ColumnContext.Provider value={true}>{view.renderChildren(node.children, path)}</ColumnContext.Provider>
        ) : null}
      </div>
    </div>
  )
}

export function FieldView({ node, path }: Props): JSX.Element {
  const view = useComponents()
  return (
    <Field
      label={String(node.props.label ?? '')}
      {...(typeof node.props.description === 'string' ? { help: node.props.description } : {})}
      {...(typeof node.props.error === 'string' && node.props.error ? { error: node.props.error } : {})}
      required={node.props.required === true}
    >
      <div
        role="group"
        aria-label={String(node.props.label ?? '')}
        aria-invalid={typeof node.props.error === 'string' && node.props.error ? true : undefined}
        className="flex min-w-0 flex-col gap-2"
      >
        <ColumnContext.Provider value={true}>{view.renderChildren(node.children, path)}</ColumnContext.Provider>
      </div>
    </Field>
  )
}
