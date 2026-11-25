// @vitest-environment jsdom
// A Table: rows in the panel's order, only those in view drawn, sorting,
// selection, row actions and paging reported as plain data.

import { act } from 'react'
import { afterEach, expect, test } from 'vitest'

import { cb, click, draw, key, n, type Drawn } from './componentsTestKit'
import { visibleColumns } from './componentsTable'

let drawn: Drawn | null = null
afterEach(() => {
  drawn?.unmount()
  drawn = null
})

const columns = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'size', label: 'Size', align: 'end', hideBelow: 'md' },
  { key: 'done', label: 'Done' },
]
const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    key: `r${index}`,
    cells: { name: `file ${index}`, size: index * 10, done: index % 2 === 0 },
  }))

const table = (extra: Record<string, unknown> = {}) =>
  n('Table', {
    label: 'Files',
    columns,
    rows: rows(3),
    selectionMode: 'multiple',
    onSelectionChange: cb('sel'),
    onRowAction: cb('act'),
    onSortChange: cb('sort'),
    ...extra,
  })

const bodyRows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('tbody tr[data-row-key]')]

test('rows are drawn in the order given, booleans as a check mark', () => {
  drawn = draw(table())
  expect(bodyRows(drawn.host).map((row) => row.dataset.rowKey)).toEqual(['r0', 'r1', 'r2'])
  expect(bodyRows(drawn.host)[0]!.querySelector('[role="img"][aria-label="Yes"]')).not.toBeNull()
})

test('a header click asks for a sort; the panel sorts', () => {
  drawn = draw(table({ sort: { column: 'name', direction: 'asc' } }))
  const header = [...drawn.host.querySelectorAll('thead button')].find((each) => each.textContent?.startsWith('Name'))!
  click(header)
  expect(drawn.sent).toEqual([{ callback: 'sort', args: [{ column: 'name', direction: 'desc' }] }])
})

test('click, Cmd-click and Shift-click select; Enter and double click act', () => {
  drawn = draw(table())
  const [a, b, c] = bodyRows(drawn.host)
  click(a!)
  click(c!, { metaKey: true })
  click(b!, { shiftKey: true })
  expect(drawn.sent.map((each) => each.args[0])).toEqual([
    { keys: ['r0'] },
    { keys: ['r0', 'r2'] },
    { keys: ['r1', 'r2'] },
  ])
  const region = drawn.host.querySelector('[data-component-table]')!
  key(region, 'Enter')
  doubleClick(b!)
  expect(drawn.sent.filter((each) => each.callback === 'act').map((each) => each.args[0])).toEqual([
    { key: 'r1' },
    { key: 'r1' },
  ])
})

function doubleClick(row: HTMLElement) {
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}

test('only the rows in view are drawn, and the end asks for more once per list', () => {
  drawn = draw(table({ rows: rows(2000), hasMore: true, onLoadMore: cb('more'), maxHeight: 'sm' }))
  expect(bodyRows(drawn.host).length).toBeLessThan(40)
  const asked = () => drawn!.sent.filter((each) => each.callback === 'more').length
  expect(asked()).toBe(0)
  drawn.draw(table({ rows: rows(5), hasMore: true, onLoadMore: cb('more') }))
  drawn.draw(table({ rows: rows(5), hasMore: true, onLoadMore: cb('more') }))
  expect(asked()).toBe(1)
  // The same length, sorted the other way, is another list.
  drawn.draw(table({ rows: rows(5).reverse(), hasMore: true, onLoadMore: cb('more') }))
  expect(asked()).toBe(2)
})

test('paging waits while a page loads, shows it loading, and asks again for a page that failed', () => {
  const page = (extra: Record<string, unknown>) =>
    table({ rows: rows(5), hasMore: true, onLoadMore: cb('more'), ...extra })
  const asked = () => drawn!.sent.filter((each) => each.callback === 'more').length
  drawn = draw(page({ loading: true }))
  expect(asked()).toBe(0)
  expect(drawn.host.querySelector('[data-table-loading]')!.textContent).toContain('Loading more…')
  drawn.draw(page({}))
  expect(asked()).toBe(1)
  drawn.draw(page({ loading: true }))
  // The page ended with the list unchanged: it failed, and nothing is asked until the person scrolls.
  drawn.draw(page({}))
  expect(drawn.host.querySelector('[data-table-loading]')).toBeNull()
  expect(asked()).toBe(1)
  const region = drawn.host.querySelector('[data-component-table]')!
  act(() => {
    region.dispatchEvent(new Event('scroll'))
  })
  expect(asked()).toBe(2)
})

test("a key on a control inside the table is that control's: Enter on a sortable header sorts, not acts", () => {
  drawn = draw(table())
  const header = [...drawn.host.querySelectorAll('thead button')].find((each) => each.textContent?.startsWith('Name'))!
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  act(() => {
    header.dispatchEvent(enter)
  })
  expect(enter.defaultPrevented).toBe(false)
  key(header, 'ArrowDown')
  expect(drawn.sent.filter((each) => each.callback === 'act')).toEqual([])
  const region = drawn.host.querySelector('[data-component-table]')!
  expect(region.getAttribute('aria-activedescendant')).toMatch(/row-0$/u)
})

test('a narrow table drops the columns that hide below its width, keeping at least one', () => {
  const shown = visibleColumns(columns as Array<{ key: string; hideBelow?: 'sm' | 'md' }>, 400)
  expect(shown.map((each) => each.key)).toEqual(['name', 'done'])
  expect(visibleColumns([{ key: 'only', hideBelow: 'md' }], 100).map((each) => each.key)).toEqual(['only'])
})

test('an empty table says so', () => {
  drawn = draw(table({ rows: [], emptyText: 'No files yet' }))
  expect(drawn.host.textContent).toContain('No files yet')
})
