// What Studio checks of a components panel's tree before it draws it: the
// whole-render limits refuse it (the last good tree stays), a component over
// its own cap is a placeholder, unknown props and components degrade with a
// warning, and structure is held to the catalogue.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { COMPONENT_CATALOG, COMPONENT_LIMITS as L, componentPropNames } from '../src/components/catalog.js'
import { parseComponentTree, type ComponentNode } from '../src/components/tree.js'
import * as module from '../src/components/index.js'

const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = [], key?: string) => ({
  type,
  props,
  children,
  ...(key === undefined ? {} : { key }),
})

function refused(tree: unknown, pattern: RegExp) {
  const result = parseComponentTree(tree)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, pattern)
}

function drawn(tree: unknown) {
  const result = parseComponentTree(tree)
  assert.ok(result.ok, result.ok ? '' : result.error)
  return result as Extract<typeof result, { ok: true }>
}

test('every catalogue component is exported by the module, named as itself', () => {
  for (const name of Object.keys(COMPONENT_CATALOG)) {
    assert.equal((module as Record<string, unknown>)[name], name, name)
  }
  assert.equal(module.ui.catalog, 4)
  assert.ok(module.ui.has('Table', 'onLoadMore'))
  assert.ok(!module.ui.has('Table', '$edit'))
  assert.ok(!module.ui.has('Carousel'))
  assert.deepEqual(componentPropNames('Badge'), ['tone'])
})

test('the node, depth, size, text, label, props and Select caps refuse the render', () => {
  const many = Array.from({ length: L.maxNodes + 1 }, (_, index) => node('Text', {}, ['x'], `k${index}`))
  refused(node('Stack', {}, many), /more than 5000/)
  let deep: unknown = node('Text', {}, ['x'])
  for (let level = 0; level < L.maxDepth; level++) deep = node('Stack', {}, [deep])
  refused(deep, /deeper than 64/)
  refused(node('Text', {}, ['x'.repeat(L.maxTextLength + 1)]), /longer than/)
  refused(node('Card', { title: 'x'.repeat(L.maxLabelLength + 1) }), /title is longer than 1024/)
  const props = Object.fromEntries(Array.from({ length: L.maxPropsPerNode + 1 }, (_, index) => [`p${index}`, 1]))
  refused(node('Stack', props), /at most 32 fields/)
  const options = Array.from({ length: L.maxSelectOptions + 1 }, (_, index) => ({
    value: `${index}`,
    label: `${index}`,
  }))
  refused(node('Select', { label: 'Pick', options }), /more than 500 options/)
  const big = Array.from({ length: 40 }, (_, index) => node('Text', {}, ['y'.repeat(15_000)], `t${index}`))
  refused(node('Stack', {}, big), /larger than 512 KiB/)
})

test('a component over its own cap is drawn as a placeholder, with a warning', () => {
  const option = (index: number) => ({ value: `${index}`, label: `${index}` })
  const cases: Array<[string, Record<string, unknown>]> = [
    ['RadioGroup', { label: 'Pick', options: Array.from({ length: 51 }, (_, index) => option(index)) }],
    [
      'Table',
      {
        label: 'Rows',
        columns: Array.from({ length: 33 }, (_, index) => ({ key: `c${index}`, label: `C${index}` })),
        rows: [],
      },
    ],
    [
      'Table',
      {
        label: 'Rows',
        columns: [{ key: 'a', label: 'A' }],
        rows: Array.from({ length: 5001 }, (_, index) => ({ key: `r${index}`, cells: {} })),
      },
    ],
    ['Tree', { label: 'Files', items: Array.from({ length: 2001 }, (_, index) => ({ key: `i${index}`, label: 'x' })) }],
    ['KeyValue', { items: Array.from({ length: 201 }, (_, index) => ({ label: `k${index}`, value: index })) }],
    ['Markdown', { content: 'x'.repeat(L.maxDocumentLength + 1) }],
    ['CodeView', { code: 'x'.repeat(L.maxDocumentLength + 1) }],
  ]
  for (const [type, props] of cases) {
    const result = drawn(node('Stack', {}, [node(type, props)]))
    const child = (result.tree as ComponentNode).children[0] as ComponentNode
    assert.equal(child.type, 'Unsupported', type)
    assert.ok(
      result.warnings.some((warning) => warning.startsWith(type)),
      type,
    )
  }
  // Tree items nest at most 16 deep.
  let items: unknown[] = [{ key: 'leaf', label: 'leaf' }]
  for (let level = 0; level < 16; level++) items = [{ key: `l${level}`, label: 'x', children: items }]
  const deep = drawn(node('Tree', { label: 'Deep', items }))
  assert.equal(deep.tree?.type, 'Unsupported')
})

test('unknown props, values and components degrade; structure refuses', () => {
  const result = drawn(
    node('Stack', { gap: 'huge', className: 'x' }, [node('Carousel', { label: 'x' }), node('Button', {}, ['Go'])]),
  )
  assert.deepEqual((result.tree as ComponentNode).props, {})
  assert.equal(((result.tree as ComponentNode).children[0] as ComponentNode).type, 'Unsupported')
  assert.ok(result.warnings.some((warning) => /unknown prop "className"/.test(warning)))
  assert.ok(result.warnings.some((warning) => /invalid gap/.test(warning)))
  // A missing required prop is a placeholder.
  assert.equal(drawn(node('Input', {})).tree?.type, 'Unsupported')
  refused(node('Stack', {}, [node('ListItem', { title: 'x' })]), /direct child of List/)
  refused(node('List', {}, [node('Text', {}, ['x'])]), /holds only ListItem/)
  refused(node('Text', {}, [node('Stack')]), /takes only text, Text/)
  refused(node('Button', {}, [node('Text')]), /takes only text/)
  refused(
    node('List', {}, [node('ListItem', { onPress: { $callback: 'c1' } }, [node('Button', {}, ['x'])])]),
    /cannot hold a Button/,
  )
  refused(node('Stack', {}, [node('Text', {}, ['a'], 'k'), node('Text', {}, ['b'], 'k')]), /duplicate key/)
  refused(node('div'), /invalid component name/)
  refused({ type: 'Stack', props: {}, children: [], style: 'x' }, /unknown node field/)
  refused('bare text', /the root does not take text/)
  // Row and item keys must be unique: that component is a placeholder.
  const rows = [
    { key: 'a', cells: {} },
    { key: 'a', cells: {} },
  ]
  assert.equal(
    drawn(node('Table', { label: 'T', columns: [{ key: 'a', label: 'A' }], rows })).tree?.type,
    'Unsupported',
  )
})

test('Box takes only px and whole percents, tones and the gap scale', () => {
  const result = drawn(
    node('Box', {
      width: '50%',
      height: 120,
      maxWidth: '50px',
      minHeight: '120%',
      background: '#ff0000',
      border: 'danger',
      padding: 'sm',
    }),
  )
  assert.deepEqual((result.tree as ComponentNode).props, { width: '50%', height: 120, border: 'danger', padding: 'sm' })
  assert.equal(result.warnings.length, 3)
})

test('a Link only takes web and mail addresses; an Image only the extension’s own image files', () => {
  assert.deepEqual((drawn(node('Link', { href: 'javascript:alert(1)' }, ['x'])).tree as ComponentNode).props, {})
  assert.deepEqual((drawn(node('Link', { href: 'https://example.com' }, ['x'])).tree as ComponentNode).props, {
    href: 'https://example.com',
  })
  for (const src of ['https://example.com/a.png', '../a.png', '/a.png', 'a.gif', 'assets/../a.png'])
    assert.equal(drawn(node('Image', { src, alt: '' })).tree?.type, 'Unsupported', src)
  assert.equal(drawn(node('Image', { src: 'assets/logo.png', alt: '' })).tree?.type, 'Image')
})
