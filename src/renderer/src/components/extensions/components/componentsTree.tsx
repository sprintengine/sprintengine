// A components panel's Tree: items as data, walked with the keyboard as a tree
// is everywhere (Up and Down move, Right opens or goes to the first child,
// Left closes or goes to the parent, Home and End jump, Space selects, Enter
// acts). Studio keeps which items are open, seeded by `defaultExpanded`,
// unless the panel holds them itself (`expanded`); each change is reported.

import { useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'

import type { TreeItemData } from '../../../../../../packages/extension-sdk/src/components/catalog'
import type { ComponentNode } from '../../../../../../packages/extension-sdk/src/components/tree'
import { FileTreeChevron } from '../../ui/FileTree'
import { Spinner } from '../../ui/Spinner'
import { ComponentIcon } from './componentIcons'
import { useHostValue } from './componentValue'
import { callbackOf, editAckOf, MAX_HEIGHT_PX, useComponents } from './componentsContext'

type Visible = { item: TreeItemData; depth: number; parent: string | null; loading?: true }

/** The rows a tree shows: each open item's children under it, a loading row for one whose children are not here yet. */
export function visibleTreeRows(items: readonly TreeItemData[], open: ReadonlySet<string>): Visible[] {
  const out: Visible[] = []
  const walk = (level: readonly TreeItemData[], depth: number, parent: string | null) => {
    for (const item of level) {
      out.push({ item, depth, parent })
      if (!open.has(item.key)) continue
      if (item.children) walk(item.children, depth + 1, item.key)
      else if (item.hasChildren)
        out.push({
          item: { key: `${item.key}\u0000loading`, label: 'Loading' },
          depth: depth + 1,
          parent: item.key,
          loading: true,
        })
    }
  }
  walk(items, 0, null)
  return out
}

const opens = (item: TreeItemData) => item.hasChildren === true || (item.children?.length ?? 0) > 0

export function TreeView({ node }: { node: ComponentNode; path: string }): JSX.Element {
  const view = useComponents()
  const id = useId()
  const items = (node.props.items ?? []) as TreeItemData[]
  const controlled = Array.isArray(node.props.expanded) ? (node.props.expanded as string[]) : undefined
  const [ownOpen, setOwnOpen] = useState<string[]>(() =>
    Array.isArray(node.props.defaultExpanded) ? (node.props.defaultExpanded as string[]) : [],
  )
  const open = useMemo(() => new Set(controlled ?? ownOpen), [controlled, ownOpen])
  const selection = useHostValue<string>({
    value: typeof node.props.selected === 'string' ? node.props.selected : undefined,
    defaultValue: typeof node.props.defaultSelected === 'string' ? node.props.defaultSelected : undefined,
    fallback: '',
    acked: editAckOf(node),
    callback: callbackOf(node.props.onSelect),
    send: (callback, key, edit) => view.send(callback, [{ key }], edit),
  })
  const rows = visibleTreeRows(items, open)
  const [cursorKey, setCursorKey] = useState<string | null>(null)
  const cursor = Math.max(
    0,
    rows.findIndex((row) => row.item.key === (cursorKey ?? selection.value)),
  )
  const container = useRef<HTMLDivElement | null>(null)

  const toggle = (item: TreeItemData, expanded: boolean) => {
    if (view.inert || !opens(item) || open.has(item.key) === expanded) return
    if (!controlled) setOwnOpen((now) => (expanded ? [...now, item.key] : now.filter((key) => key !== item.key)))
    const callback = callbackOf(node.props.onToggle)
    if (callback) view.send(callback, [{ key: item.key, expanded }])
  }
  const select = (item: TreeItemData) => {
    if (view.inert || item.disabled || selection.readOnly) return
    selection.change(item.key)
  }
  const act = (item: TreeItemData) => {
    const callback = callbackOf(node.props.onAction)
    if (view.inert || item.disabled || !callback) return
    view.send(callback, [{ key: item.key }])
  }
  const moveTo = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))]
    if (!row) return
    setCursorKey(row.item.key)
    const element = [...(container.current?.querySelectorAll<HTMLElement>('[data-tree-key]') ?? [])].find(
      (each) => each.dataset.treeKey === row.item.key,
    )
    element?.scrollIntoView?.({ block: 'nearest' })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[cursor]
    if (!row) return
    const { item } = row
    let handled = true
    if (event.key === 'ArrowDown') moveTo(cursor + 1)
    else if (event.key === 'ArrowUp') moveTo(cursor - 1)
    else if (event.key === 'Home') moveTo(0)
    else if (event.key === 'End') moveTo(rows.length - 1)
    else if (event.key === 'ArrowRight') {
      if (opens(item) && !open.has(item.key)) toggle(item, true)
      else if (open.has(item.key)) moveTo(cursor + 1)
    } else if (event.key === 'ArrowLeft') {
      if (open.has(item.key)) toggle(item, false)
      else if (row.parent !== null) moveTo(rows.findIndex((each) => each.item.key === row.parent))
    } else if (event.key === ' ') {
      if (!row.loading) select(item)
    } else if (event.key === 'Enter') {
      if (!row.loading) act(item)
    } else handled = false
    if (handled) event.preventDefault()
  }
  const max = MAX_HEIGHT_PX[String(node.props.maxHeight ?? 'none')]
  const active = rows[cursor]

  return (
    <div
      ref={container}
      role="tree"
      aria-label={String(node.props.label ?? '')}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-activedescendant={active ? `${id}-${cursor}` : undefined}
      className="min-w-0 overflow-auto rounded-sm focus-visible:focus-ring"
      style={max ? { maxHeight: max } : undefined}
      data-component-tree=""
    >
      {rows.map((row, index) => {
        const { item } = row
        if (row.loading)
          return (
            <div
              key={item.key}
              id={`${id}-${index}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-busy="true"
              aria-selected={false}
              className="flex h-6 items-center gap-2 text-meta text-[color:var(--text-muted)]"
              style={{ paddingInlineStart: `${row.depth * 12 + 20}px` }}
            >
              <Spinner size={12} />
              Loading
            </div>
          )
        const isOpen = open.has(item.key)
        const isSelected = selection.value === item.key
        return (
          <div
            key={item.key}
            id={`${id}-${index}`}
            data-tree-key={item.key}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={opens(item) ? isOpen : undefined}
            aria-selected={isSelected}
            aria-disabled={item.disabled || undefined}
            onClick={() => {
              setCursorKey(item.key)
              select(item)
            }}
            onDoubleClick={() => act(item)}
            className={[
              'flex min-h-6 items-center gap-1.5 rounded-xs pr-2 text-body',
              item.disabled ? 'opacity-45' : 'cursor-default hover:bg-[color:var(--bg-hover)]',
              isSelected
                ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-default)]',
              index === cursor ? 'outline-1 -outline-offset-1 outline-[color:var(--border-default)]' : '',
            ].join(' ')}
            style={{ paddingInlineStart: `${row.depth * 12 + 4}px` }}
          >
            {opens(item) ? (
              <FileTreeChevron
                expanded={isOpen}
                onClick={(event) => {
                  event.stopPropagation()
                  setCursorKey(item.key)
                  toggle(item, !isOpen)
                }}
              />
            ) : (
              <span aria-hidden="true" className="w-3 shrink-0" />
            )}
            {item.icon ? <ComponentIcon name={item.icon} /> : null}
            <span className="min-w-0 truncate">{item.label}</span>
            {item.description ? (
              <span className="min-w-0 truncate text-meta text-[color:var(--text-muted)]">{item.description}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
