// A components panel's Table: rows in the order the panel gives, drawn only
// while in view so thousands stay cheap; sorting, selection, row actions and
// paging reported to the panel as plain data.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'

import {
  TABLE_BREAKPOINTS,
  type RelativeTimeFormat,
} from '../../../../../../packages/extension-sdk/src/components/catalog'
import type { ComponentNode } from '../../../../../../packages/extension-sdk/src/components/tree'
import { CheckIcon } from '../../AppIcons'
import { GhostButton } from '../../ui/Buttons'
import { Spinner } from '../../ui/Spinner'
import { Table } from '../../ui/Table'
import { useHostValue } from './componentValue'
import { RelativeTimeText } from './componentsContent'
import { callbackOf, editAckOf, MAX_HEIGHT_PX, useComponents } from './componentsContext'

type Column = {
  key: string
  label: string
  align?: 'start' | 'center' | 'end'
  width?: 'auto' | 'xs' | 'sm' | 'md' | 'lg'
  minWidth?: 'auto' | 'xs' | 'sm' | 'md'
  hideBelow?: 'sm' | 'md'
  sortable?: boolean
}
type Cell = string | number | boolean | null | { type: 'relative'; at: number; format?: RelativeTimeFormat }
type Row = { key: string; cells: Record<string, Cell>; disabled?: boolean }
type Sort = { column: string; direction: 'asc' | 'desc' }

/** A drawn row's height: what the window of rows in view is counted in. */
export const TABLE_ROW_HEIGHT = 28
const OVERSCAN = 8
/** Scrolling within this many rows of the end asks for more. */
const LOAD_MORE_WITHIN = 10

const WIDTH: Record<string, string | undefined> = { auto: undefined, xs: '4rem', sm: '6rem', md: '9rem', lg: '14rem' }
const MIN_WIDTH: Record<string, string> = { auto: '0px', xs: '4rem', sm: '6rem', md: '9rem' }
const ALIGN_CLASS: Record<string, string> = { start: 'text-left', center: 'text-center', end: 'text-right' }

/** The columns a table this wide shows; at least one always stays. */
export function visibleColumns<C extends { hideBelow?: 'sm' | 'md' }>(columns: readonly C[], width: number): C[] {
  const shown = columns.filter((column) => !column.hideBelow || width >= TABLE_BREAKPOINTS[column.hideBelow])
  return shown.length > 0 ? shown : columns.slice(0, 1)
}

function CellContent({ cell, locale }: { cell: Cell | undefined; locale: string }): JSX.Element | null {
  if (cell === undefined || cell === null) return null
  if (typeof cell === 'boolean')
    return cell ? (
      <span role="img" aria-label="Yes" className="inline-flex">
        <CheckIcon className="icon-xs" />
      </span>
    ) : (
      <span className="sr-only">No</span>
    )
  if (typeof cell === 'object') return <RelativeTimeText at={cell.at} format={cell.format ?? 'short'} locale={locale} />
  return <>{String(cell)}</>
}

function cellTitle(cell: Cell | undefined): string | undefined {
  return typeof cell === 'string' || typeof cell === 'number' ? String(cell) : undefined
}

export function TableView({ node }: { node: ComponentNode; path: string }): JSX.Element {
  const view = useComponents()
  const id = useId()
  const columns = (node.props.columns ?? []) as Column[]
  const rows = (node.props.rows ?? []) as Row[]
  const sort = node.props.sort as Sort | undefined
  const mode = (node.props.selectionMode as 'none' | 'single' | 'multiple' | undefined) ?? 'none'
  const max = MAX_HEIGHT_PX[String(node.props.maxHeight ?? 'md')]
  const selection = useHostValue<string[]>({
    value: Array.isArray(node.props.selected) ? (node.props.selected as string[]) : undefined,
    defaultValue: Array.isArray(node.props.defaultSelected) ? (node.props.defaultSelected as string[]) : undefined,
    fallback: [],
    acked: editAckOf(node),
    callback: callbackOf(node.props.onSelectionChange),
    send: (callback, keys, edit) => view.send(callback, [{ keys }], edit),
  })
  const selected = new Set(selection.value)
  const scroller = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  const [scrollTop, setScrollTop] = useState(0)
  const [cursor, setCursor] = useState(0)
  const anchor = useRef<number | null>(null)
  const askedAt = useRef<number | null>(null)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth || Number.POSITIVE_INFINITY))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const shown = visibleColumns(columns, width)
  const virtual = max !== undefined
  const first = virtual ? Math.max(0, Math.floor(scrollTop / TABLE_ROW_HEIGHT) - OVERSCAN) : 0
  const count = virtual ? Math.ceil(max / TABLE_ROW_HEIGHT) + OVERSCAN * 2 : rows.length
  const last = Math.min(rows.length, first + count)

  // Paging: ask once per length of `rows`, when the end comes into reach.
  const loadMore = callbackOf(node.props.onLoadMore)
  const lastInView = virtual ? Math.min(rows.length, Math.ceil((scrollTop + max) / TABLE_ROW_HEIGHT)) : rows.length
  useEffect(() => {
    if (!loadMore || node.props.hasMore !== true || view.inert) return
    if (lastInView < rows.length - LOAD_MORE_WITHIN) return
    if (askedAt.current === rows.length) return
    askedAt.current = rows.length
    view.send(loadMore, [])
  }, [loadMore, node.props.hasMore, lastInView, rows.length, view])

  const choose = (keys: string[]) => {
    if (view.inert || selection.readOnly || mode === 'none') return
    selection.change(keys)
  }
  const enabledKey = (index: number) => {
    const row = rows[index]
    return row && !row.disabled ? row.key : null
  }
  const selectAt = (index: number, how: { toggle?: boolean; range?: boolean }) => {
    const key = enabledKey(index)
    if (key === null) return
    if (mode === 'single' || (!how.toggle && !how.range)) {
      anchor.current = index
      choose([key])
      return
    }
    if (how.range && anchor.current !== null) {
      const [from, to] = anchor.current < index ? [anchor.current, index] : [index, anchor.current]
      const keys = rows
        .slice(from, to + 1)
        .filter((row) => !row.disabled)
        .map((row) => row.key)
      choose(how.toggle ? [...new Set([...selection.value, ...keys])] : keys)
      return
    }
    anchor.current = index
    choose(selected.has(key) ? selection.value.filter((each) => each !== key) : [...selection.value, key])
  }
  const act = (index: number) => {
    const key = enabledKey(index)
    const action = callbackOf(node.props.onRowAction)
    if (key === null || !action || view.inert) return
    view.send(action, [{ key }])
  }
  const reveal = (index: number) => {
    const element = scroller.current
    if (!element || !virtual) return
    const top = index * TABLE_ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + TABLE_ROW_HEIGHT > element.scrollTop + max) element.scrollTop = top + TABLE_ROW_HEIGHT - max
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return
    const move = (next: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, next))
      event.preventDefault()
      setCursor(clamped)
      reveal(clamped)
      if (event.shiftKey && mode === 'multiple') selectAt(clamped, { range: true })
    }
    if (event.key === 'ArrowDown') move(cursor + 1)
    else if (event.key === 'ArrowUp') move(cursor - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(rows.length - 1)
    else if (event.key === ' ') {
      event.preventDefault()
      selectAt(cursor, { toggle: mode === 'multiple', range: event.shiftKey })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      act(cursor)
    }
  }
  const onRowClick = (event: MouseEvent, index: number) => {
    setCursor(index)
    selectAt(index, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey })
  }
  const sortBy = (column: Column) => {
    const callback = callbackOf(node.props.onSortChange)
    if (!callback || view.inert) return
    const direction = sort?.column === column.key && sort.direction === 'asc' ? 'desc' : 'asc'
    view.send(callback, [{ column: column.key, direction }])
  }
  const label = String(node.props.label ?? '')
  const activeRow = rows[cursor]

  return (
    <div
      ref={scroller}
      role="region"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      aria-activedescendant={activeRow ? `${id}-row-${cursor}` : undefined}
      className="relative min-w-0 overflow-auto rounded-sm border border-[color:var(--border-subtle)] focus-visible:focus-ring"
      style={max ? { maxHeight: max } : undefined}
      data-component-table=""
    >
      <Table
        ariaLabel={label}
        fixed
        className="w-full"
        colgroup={
          <colgroup>
            {shown.map((column) => (
              <col
                key={column.key}
                style={{
                  ...(WIDTH[column.width ?? 'auto'] ? { width: WIDTH[column.width ?? 'auto'] } : {}),
                  minWidth: MIN_WIDTH[column.minWidth ?? 'auto'],
                }}
              />
            ))}
          </colgroup>
        }
      >
        <thead>
          <tr>
            {shown.map((column) => {
              const sorted = sort?.column === column.key ? sort.direction : undefined
              return (
                <Table.Head
                  key={column.key}
                  numeric={column.align === 'end'}
                  className={ALIGN_CLASS[column.align ?? 'start']}
                >
                  <span
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className="block truncate"
                  >
                    {column.sortable ? (
                      <GhostButton size="inline" onClick={() => sortBy(column)}>
                        {column.label}
                        {sorted ? <span aria-hidden="true">{sorted === 'asc' ? ' ↑' : ' ↓'}</span> : null}
                      </GhostButton>
                    ) : (
                      column.label
                    )}
                  </span>
                </Table.Head>
              )
            })}
          </tr>
        </thead>
        <tbody aria-multiselectable={mode === 'multiple' || undefined}>
          {first > 0 ? (
            <tr aria-hidden="true" style={{ height: first * TABLE_ROW_HEIGHT }}>
              <td colSpan={shown.length} />
            </tr>
          ) : null}
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset
            const isSelected = selected.has(row.key)
            return (
              <Table.Row
                key={row.key}
                id={`${id}-row-${index}`}
                data-row-key={row.key}
                aria-selected={mode === 'none' ? undefined : isSelected}
                aria-disabled={row.disabled || undefined}
                onClick={(event) => onRowClick(event, index)}
                onDoubleClick={() => act(index)}
                style={{ height: TABLE_ROW_HEIGHT }}
                className={[
                  row.disabled ? 'opacity-45' : 'cursor-default hover:bg-[color:var(--bg-hover)]',
                  isSelected ? 'bg-[color:var(--bg-selected)]' : '',
                  index === cursor ? 'outline-1 -outline-offset-1 outline-[color:var(--border-default)]' : '',
                ].join(' ')}
              >
                {shown.map((column) => (
                  <Table.Cell
                    key={column.key}
                    numeric={column.align === 'end'}
                    {...(cellTitle(row.cells[column.key]) ? { title: cellTitle(row.cells[column.key]) } : {})}
                    className={['truncate', ALIGN_CLASS[column.align ?? 'start']].join(' ')}
                  >
                    <CellContent cell={row.cells[column.key]} locale={view.locale} />
                  </Table.Cell>
                ))}
              </Table.Row>
            )
          })}
          {last < rows.length ? (
            <tr aria-hidden="true" style={{ height: (rows.length - last) * TABLE_ROW_HEIGHT }}>
              <td colSpan={shown.length} />
            </tr>
          ) : null}
        </tbody>
      </Table>
      {rows.length === 0 && node.props.loading !== true ? (
        <p className="m-0 px-2 py-3 text-meta text-[color:var(--text-muted)]">
          {typeof node.props.emptyText === 'string' ? node.props.emptyText : 'Nothing to show.'}
        </p>
      ) : null}
      {node.props.loading === true ? (
        <div className="flex items-center gap-2 px-2 py-2 text-meta text-[color:var(--text-muted)]">
          <Spinner label="Loading" />
        </div>
      ) : null}
    </div>
  )
}
