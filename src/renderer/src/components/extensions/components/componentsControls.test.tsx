// @vitest-environment jsdom
// Buttons, lists and form controls of a components panel, and the edit
// protocol: Studio owns typed text, so a render never drops characters.

import { afterEach, expect, test, vi } from 'vitest'

import { cb, click, draw, key, n, settle, typeInto, type Drawn } from './componentsTestKit'

let drawn: Drawn | null = null
afterEach(() => {
  drawn?.unmount()
  drawn = null
  vi.restoreAllMocks()
})

const input = (extra: Record<string, unknown> = {}) =>
  n('Input', { label: 'Task', onChange: cb('change'), onSubmit: cb('submit'), ...extra }, [], 'task')

test('a button runs its handler; one with no handler is disabled', () => {
  drawn = draw(n('Stack', {}, [n('Button', { onPress: cb('go') }, ['Go'], 'a'), n('Button', {}, ['Idle'], 'b')]))
  const [go, idle] = [...drawn.host.querySelectorAll('button')]
  click(go!)
  expect(drawn.sent).toEqual([{ callback: 'go', args: [] }])
  expect(idle!.disabled).toBe(true)
})

test('an icon button is named by its label', () => {
  drawn = draw(n('IconButton', { icon: 'refresh', label: 'Refresh', onPress: cb('r') }))
  const button = drawn.host.querySelector('button[aria-label="Refresh"]')!
  click(button)
  expect(drawn.sent[0]!.callback).toBe('r')
})

test('a button with no variant is the outline; solid is the neutral fill, the primary only with the accent tone', () => {
  const button = (props: Record<string, unknown>, key: string) =>
    n('Button', { onPress: cb(key), ...props }, [key], key)
  drawn = draw(
    n('Stack', {}, [
      button({}, 'plain'),
      button({ variant: 'solid' }, 'solid'),
      button({ variant: 'solid', tone: 'accent' }, 'primary'),
      button({ variant: 'solid', tone: 'danger' }, 'danger'),
      button({ variant: 'ghost' }, 'ghost'),
    ]),
  )
  const classOf = (label: string) =>
    [...drawn!.host.querySelectorAll('button')].find((each) => each.textContent === label)!.className
  expect(classOf('plain')).toContain('border-[color:var(--border-strong)]')
  expect(classOf('plain')).toContain('bg-transparent')
  expect(classOf('solid')).not.toContain('accent-primary')
  expect(classOf('solid')).not.toContain('bg-transparent')
  expect(classOf('primary')).toContain('bg-[color:var(--accent-primary)]')
  expect(classOf('danger')).toContain('bg-[color:var(--tone-error)]')
  expect(classOf('ghost')).not.toContain('border-[color:var(--border-strong)]')
})

test('an icon button honours its variant, and stays borderless without one', () => {
  drawn = draw(
    n('Row', {}, [
      n('IconButton', { icon: 'add', label: 'Plain', onPress: cb('a') }, [], 'a'),
      n('IconButton', { icon: 'add', label: 'Outlined', variant: 'outline', onPress: cb('b') }, [], 'b'),
      n('IconButton', { icon: 'add', label: 'Primary', variant: 'solid', tone: 'accent', onPress: cb('c') }, [], 'c'),
    ]),
  )
  const classOf = (label: string) => drawn!.host.querySelector(`button[aria-label="${label}"]`)!.className
  expect(classOf('Plain')).not.toContain('border-[color:var(--border-strong)]')
  expect(classOf('Outlined')).toContain('border-[color:var(--border-strong)]')
  expect(classOf('Outlined')).toContain('aspect-square')
  expect(classOf('Primary')).toContain('bg-[color:var(--accent-primary)]')
  click(drawn.host.querySelector('button[aria-label="Outlined"]')!)
  expect(drawn.sent).toEqual([{ callback: 'b', args: [] }])
})

test('a press grants a gesture only on a control that stood still for 500 ms', () => {
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  drawn = draw(n('Button', { onPress: cb('open') }, ['Open'], 'open'))
  const button = drawn.host.querySelector('button')!
  click(button)
  expect(drawn.grants).toBe(0)
  expect(drawn.sent).toHaveLength(1)
  now += 600
  click(button)
  expect(drawn.grants).toBe(1)
  // Its label changed: the wait starts again.
  drawn.draw(n('Button', { onPress: cb('open') }, ['Open now'], 'open'))
  click(drawn.host.querySelector('button')!)
  expect(drawn.grants).toBe(1)
})

test('a list holds rows; a pressable row runs its handler and marks the current one', () => {
  drawn = draw(
    n('List', { label: 'Files' }, [
      n('ListItem', { title: 'a.ts', description: 'src', onPress: cb('a'), current: true }, [], 'a'),
      n('ListItem', { title: 'b.ts' }, [], 'b'),
    ]),
  )
  expect(drawn.host.querySelector('ul[aria-label="Files"]')).not.toBeNull()
  const row = drawn.host.querySelector('button')!
  expect(row.getAttribute('aria-current')).toBe('true')
  click(row)
  expect(drawn.sent).toEqual([{ callback: 'a', args: [] }])
  expect(drawn.host.textContent).toContain('b.ts')
})

test('typing reports each edit with its number; a render that has not seen it keeps the text', () => {
  drawn = draw(input({ value: '' }))
  const field = drawn.host.querySelector('input')!
  typeInto(field, 'S')
  typeInto(field, 'Sh')
  expect(drawn.sent).toEqual([
    { callback: 'change', args: ['S'], edit: 1 },
    { callback: 'change', args: ['Sh'], edit: 2 },
  ])
  // The panel rendered after the first edit only: an echo, which leaves "Sh" alone.
  drawn.draw(input({ value: 'S', $edit: 1 }))
  expect(field.value).toBe('Sh')
  // Having seen both, the panel's value is the word.
  drawn.draw(input({ value: 'Sh', $edit: 2 }))
  expect(field.value).toBe('Sh')
})

test('Enter submits what is on screen, and a reset to the same empty value applies', () => {
  drawn = draw(input({ value: '' }))
  const field = drawn.host.querySelector('input')!
  typeInto(field, 'Ship it')
  key(field, 'Enter')
  expect(drawn.sent.at(-1)).toEqual({ callback: 'submit', args: ['Ship it'] })
  // The panel cleared its draft after the submit: '' again, having seen the edit.
  drawn.draw(input({ value: '', $edit: 1 }))
  expect(field.value).toBe('')
})

test('defaultValue seeds an uncontrolled field; value without onChange is read-only', () => {
  drawn = draw(
    n('Stack', {}, [
      n('Input', { label: 'Free', defaultValue: 'seed' }, [], 'a'),
      n('Input', { label: 'Fixed', value: 'locked' }, [], 'b'),
    ]),
  )
  const [free, fixed] = [...drawn.host.querySelectorAll('input')]
  expect(free!.value).toBe('seed')
  expect(fixed!.readOnly).toBe(true)
})

test('a keyed reorder keeps each field and what was typed in it', () => {
  const fields = (order: string[]) =>
    n(
      'Stack',
      {},
      order.map((name) => n('Input', { label: name, onChange: cb(`c-${name}`) }, [], name)),
    )
  drawn = draw(fields(['one', 'two']))
  const [one] = [...drawn.host.querySelectorAll('input')]
  typeInto(one!, 'half-typed')
  drawn.draw(fields(['two', 'one']))
  const after = [...drawn.host.querySelectorAll('input')]
  expect(after[1]).toBe(one)
  expect(after[1]!.value).toBe('half-typed')
})

test('textarea submits on the platform chord', () => {
  drawn = draw(n('Textarea', { label: 'Note', onChange: cb('c'), onSubmit: cb('s'), rows: 4 }))
  const area = drawn.host.querySelector('textarea')!
  typeInto(area, 'line')
  key(area, 'Enter', { metaKey: true, ctrlKey: true })
  expect(drawn.sent.at(-1)).toEqual({ callback: 's', args: ['line'] })
})

test('switch, checkbox, radio group, select and slider report plain values', async () => {
  drawn = draw(
    n('Stack', {}, [
      n('Switch', { label: 'Notify', onChange: cb('sw') }, [], 'sw'),
      n('Checkbox', { label: 'Done', description: 'Mark it', onChange: cb('cb') }, [], 'cb'),
      n(
        'RadioGroup',
        {
          label: 'Mode',
          defaultValue: 'a',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B', description: 'The other' },
          ],
          onChange: cb('rg'),
        },
        [],
        'rg',
      ),
      n(
        'Slider',
        { label: 'Level', min: 0, max: 10, step: 5, defaultValue: 5, showValue: true, onChange: cb('sl') },
        [],
        'sl',
      ),
    ]),
  )
  click(drawn.host.querySelector('[role="switch"]')!)
  click(drawn.host.querySelector('input[type="checkbox"]')!)
  const radios = [...drawn.host.querySelectorAll('[role="radio"]')]
  expect(radios[0]!.getAttribute('aria-checked')).toBe('true')
  click(radios[1]!)
  const slider = drawn.host.querySelector('[role="slider"]')!
  expect(slider.getAttribute('aria-valuetext')).toBe('5')
  key(slider, 'ArrowRight')
  await settle()
  expect(drawn.sent).toEqual([
    { callback: 'sw', args: [true], edit: 1 },
    { callback: 'cb', args: [true], edit: 1 },
    { callback: 'rg', args: ['b'], edit: 1 },
    { callback: 'sl', args: [10], edit: 1 },
  ])
})

test('a select draws its options and its chosen value', () => {
  drawn = draw(
    n('Select', {
      label: 'Size',
      value: 'm',
      options: [
        { value: 's', label: 'Small' },
        { value: 'm', label: 'Medium' },
      ],
      onChange: cb('size'),
    }),
  )
  expect(drawn.host.textContent).toContain('Medium')
})

test('an inert tree answers no press and no edit', () => {
  drawn = draw(n('Stack', {}, [n('Button', { onPress: cb('go') }, ['Go'], 'b'), input()]), { inert: true })
  click(drawn.host.querySelector('button')!)
  typeInto(drawn.host.querySelector('input')!, 'x')
  expect(drawn.sent).toEqual([])
  expect(drawn.host.querySelector('[data-components-view]')!.getAttribute('data-inert')).toBe('true')
})
