// @vitest-environment jsdom
// Layout and structure: Stack, Row, Box, Grid, Card, Separator, Field,
// Toolbar, Tabs and Collapsible, and the placeholder for what Studio does not draw.

import { afterEach, expect, test } from 'vitest'

import { cb, click, draw, key, n, typeInto, type Drawn } from './componentsTestKit'

let drawn: Drawn | null = null
afterEach(() => {
  drawn?.unmount()
  drawn = null
})

test('a stack is a column on the gap scale; a row is a row', () => {
  drawn = draw(n('Stack', { gap: 'lg' }, [n('Row', { gap: 'xs', justify: 'between', wrap: true }, ['a', 'b'], 'r')]))
  const stack = drawn.host.querySelector('[data-components-view] > div')!
  expect(stack.className).toContain('flex-col')
  expect(stack.className).toContain('gap-4')
  const row = stack.firstElementChild!
  expect(row.className).toContain('flex-row')
  expect(row.className).toContain('justify-between')
  expect(row.className).toContain('flex-wrap')
})

test('a box takes only scale steps, tones, and the pixel or percent lengths it was checked for', () => {
  drawn = draw(
    n('Box', {
      direction: 'row',
      padding: 'sm',
      border: 'danger',
      radius: 'md',
      background: 'success',
      width: '50%',
      minHeight: 120,
      scroll: 'y',
      // Dropped by the checker: a hex colour and a CSS length are not Box's to take.
      maxWidth: '50px',
    }),
  )
  const box = drawn.host.querySelector<HTMLElement>('[data-component-box]')!
  expect(box.className).toContain('flex-row')
  expect(box.className).toContain('p-2')
  expect(box.className).toContain('rounded-md')
  expect(box.className).toContain('overflow-y-auto')
  expect(box.style.width).toBe('50%')
  expect(box.style.minHeight).toBe('120px')
  expect(box.style.maxWidth).toBe('')
  expect(box.style.borderColor).toContain('--tone-error')
  expect(box.style.backgroundColor).toContain('--tone-good-soft')
})

test('a grid lays out fixed columns, or as many as fit', () => {
  drawn = draw(n('Grid', { columns: 3 }, ['a', 'b', 'c']))
  expect(drawn.host.querySelector<HTMLElement>('.grid')!.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
  drawn.draw(n('Grid', { minItemWidth: 'sm' }, ['a']))
  expect(drawn.host.querySelector<HTMLElement>('.grid')!.style.gridTemplateColumns).toContain('auto-fill')
})

test('a card names its region; a separator is a separator', () => {
  drawn = draw(
    n('Stack', {}, [
      n('Card', { title: 'Deploys', description: 'Last week' }, ['body'], 'c'),
      n('Separator', {}, [], 's'),
    ]),
  )
  expect(drawn.host.querySelector('section h4')!.textContent).toBe('Deploys')
  expect(drawn.host.querySelector('[role="separator"]')).not.toBeNull()
})

test('a field labels its group and shows its error', () => {
  drawn = draw(
    n('Field', { label: 'Name', error: 'Required', required: true }, [
      n('Input', { label: 'Name', labelHidden: true }, [], 'i'),
    ]),
  )
  expect(drawn.host.textContent).toContain('Required')
  expect(drawn.host.querySelector('[role="group"]')!.getAttribute('aria-invalid')).toBe('true')
})

test('a toolbar moves between its controls with the arrow keys', () => {
  drawn = draw(
    n('Toolbar', { label: 'Actions' }, [
      n('IconButton', { icon: 'add', label: 'Add', onPress: cb('a') }, [], 'a'),
      n('IconButton', { icon: 'delete', label: 'Delete', onPress: cb('d') }, [], 'd'),
    ]),
  )
  const [add, remove] = [...drawn.host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')]
  add!.focus()
  key(add!, 'ArrowRight')
  expect(document.activeElement).toBe(remove)
  key(remove!, 'Home')
  expect(document.activeElement).toBe(add)
})

test('tabs draw only the selected tab, and report a switch', () => {
  const tabs = (extra: Record<string, unknown> = {}) =>
    n('Tabs', { label: 'Views', onChange: cb('tab'), ...extra }, [
      n('Tab', { value: 'one', label: 'One' }, ['first body'], 'one'),
      n('Tab', { value: 'two', label: 'Two' }, ['second body'], 'two'),
    ])
  drawn = draw(tabs())
  expect(drawn.host.textContent).toContain('first body')
  expect(drawn.host.textContent).not.toContain('second body')
  click([...drawn.host.querySelectorAll('[role="tab"]')][1]!)
  expect(drawn.sent).toEqual([{ callback: 'tab', args: ['two'], edit: 1 }])
  expect(drawn.host.textContent).toContain('second body')
})

test('a switch of tab draws the next tab afresh: a field of the same key does not carry what was typed', () => {
  const field = (defaultValue: string) =>
    n('Input', { label: 'Name', defaultValue, onChange: cb(`name-${defaultValue}`) }, [], 'name')
  drawn = draw(
    n('Tabs', { label: 'Views', onChange: cb('tab') }, [
      n('Tab', { value: 'one', label: 'One' }, [field('ONE')], 'one'),
      n('Tab', { value: 'two', label: 'Two' }, [field('TWO')], 'two'),
    ]),
  )
  const input = () => drawn!.host.querySelector<HTMLInputElement>('input')!
  expect(input().value).toBe('ONE')
  typeInto(input(), 'DRAFT')
  expect(input().value).toBe('DRAFT')
  click([...drawn.host.querySelectorAll('[role="tab"]')][1]!)
  expect(input().value).toBe('TWO')
})

test('a collapsible opens and closes, and its content is drawn only when open', () => {
  drawn = draw(n('Collapsible', { title: 'More', onChange: cb('open') }, ['hidden body']))
  expect(drawn.host.textContent).not.toContain('hidden body')
  click(drawn.host.querySelector('[aria-expanded]')!)
  expect(drawn.sent).toEqual([{ callback: 'open', args: [true], edit: 1 }])
  expect(drawn.host.textContent).toContain('hidden body')
})

test('a component Studio does not draw, or one missing what it needs, is a placeholder', () => {
  drawn = draw(n('Stack', {}, [n('Carousel', {}, [], 'c'), n('IconButton', { icon: 'add' }, [], 'i')]))
  const names = [...drawn.host.querySelectorAll('[data-component-placeholder]')].map((each) =>
    each.getAttribute('data-component-placeholder'),
  )
  expect(names).toEqual(['Carousel', 'IconButton'])
})
