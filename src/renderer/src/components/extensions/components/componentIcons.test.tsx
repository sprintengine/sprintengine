// The icon names a components panel may use: each in the catalogue's list has
// a glyph of its own, and only a name outside it draws the neutral mark.

import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { COMPONENT_ICONS } from '../../../../../../packages/extension-sdk/src/components/catalog'
import { ComponentIcon } from './componentIcons'

const drawing = (name: string) =>
  renderToStaticMarkup(<ComponentIcon name={name} />).replace(/ data-component-icon="[^"]*"/u, '')

test('every listed name has its own glyph; the neutral mark is only for names outside the list', () => {
  const neutral = drawing('not-a-listed-name')
  const unmarked = COMPONENT_ICONS.filter((name) => name !== 'extension' && drawing(name) === neutral)
  expect(unmarked).toEqual([])
  const drawings = new Map<string, string[]>()
  for (const name of COMPONENT_ICONS) drawings.set(drawing(name), [...(drawings.get(drawing(name)) ?? []), name])
  expect([...drawings.values()].filter((names) => names.length > 1)).toEqual([])
})

test('an error is not drawn as a warning', () => {
  expect(drawing('error')).not.toBe(drawing('warning'))
})
