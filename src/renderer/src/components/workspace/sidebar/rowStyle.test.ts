import { expect, test } from 'vitest'

import { ROW_SEAT_CLASS } from './rowStyle'

// A row at rest gives its width to the title: the seat reserves room for the
// row's actions only while they show.
test('the seat reserves no width at rest', () => {
  const atRest = ROW_SEAT_CLASS.split(/\s+/).filter((name) => !name.startsWith('group-'))
  expect(atRest.some((name) => name.startsWith('min-w-') || name.startsWith('pl-'))).toBe(false)
  expect(ROW_SEAT_CLASS).toContain('group-hover:min-w-[44px]')
  expect(ROW_SEAT_CLASS).toContain('group-focus-within:min-w-[44px]')
})
