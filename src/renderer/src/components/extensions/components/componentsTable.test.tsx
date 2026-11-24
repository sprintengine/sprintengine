// @vitest-environment jsdom
// A Table: rows in the panel's order, only those in view drawn, sorting,
// selection, row actions and paging reported as plain data.

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
  act(b!)
  expect(drawn.sent.filter((each) => each.callback === 'act').map((each) => each.args[0])).toEqual([
    { key: 'r1' },
    { key: 'r1' },
  ])
})

function act(row: HTMLElement) {
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}

test('only the rows in view are drawn, and the end asks for more once per length', () => {
  drawn = draw(table({ rows: rows(2000), hasMore: true, onLoadMore: cb('more'), maxHeight: 'sm' }))
  expect(bodyRows(drawn.host).length).toBeLessThan(40)
  expect(drawn.sent.filter((each) => each.callback === 'more')).toHaveLength(0)
  drawn.draw(table({ rows: rows(5), hasMore: true, onLoadMore: cb('more') }))
  drawn.draw(table({ rows: rows(5), hasMore: true, onLoadMore: cb('more') }))
  expect(drawn.sent.filter((each) => each.callback === 'more')).toHaveLength(1)
})

test('a narrow table drops the columns that hide below its width, keeping at least one', () => {
  expect(visibleColumns(columns as never, 400).map((each: { key: string }) => each.key)).toEqual(['name', 'done'])
  expect(visibleColumns([{ key: 'only', hideBelow: 'md' }], 100).map((each) => each.key)).toEqual(['only'])
})

test('an empty table says so', () => {
  drawn = draw(table({ rows: [], emptyText: 'No files yet' }))
  expect(drawn.host.textContent).toContain('No files yet')
})
