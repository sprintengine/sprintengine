import { expect, test } from 'vitest'

import { chatDateSectionOf, sectionChatsByDate } from './dateSections'

// Wednesday 10 November 2026, 09:30 local time.
const now = new Date(2026, 10, 10, 9, 30).getTime()
const at = (month: number, day: number, hour = 12, minute = 0) => new Date(2026, month, day, hour, minute).getTime()

test('a chat is filed under the local day the person last wrote to it', () => {
  expect(chatDateSectionOf(at(10, 10, 0, 0), now)).toBe('today')
  expect(chatDateSectionOf(at(10, 10, 9, 29), now)).toBe('today')
  // Just before midnight is yesterday, however few hours ago it was.
  expect(chatDateSectionOf(at(10, 9, 23, 59), now)).toBe('yesterday')
  expect(chatDateSectionOf(at(10, 9, 0, 0), now)).toBe('yesterday')
  expect(chatDateSectionOf(at(10, 8, 23, 59), now)).toBe('week')
  // The seven days before today, not the calendar week.
  expect(chatDateSectionOf(at(10, 3, 0, 0), now)).toBe('week')
  expect(chatDateSectionOf(at(10, 2, 23, 59), now)).toBe('month')
  expect(chatDateSectionOf(at(9, 11, 0, 0), now)).toBe('month')
  expect(chatDateSectionOf(at(9, 10, 23, 59), now)).toBe('older')
})

test('a stamp a little ahead of this clock is today, and no stamp is the oldest', () => {
  expect(chatDateSectionOf(now + 60_000, now)).toBe('today')
  expect(chatDateSectionOf(0, now)).toBe('older')
  expect(chatDateSectionOf(Number.NaN, now)).toBe('older')
})

test('a day that is not 24 hours long still starts at midnight', () => {
  // Whatever the zone's daylight saving does across these dates, a day
  // starts at its own midnight, never an hour either side of it.
  const afterChange = new Date(2026, 2, 30, 0, 30).getTime()
  expect(chatDateSectionOf(new Date(2026, 2, 29, 23, 30).getTime(), afterChange)).toBe('yesterday')
  expect(chatDateSectionOf(new Date(2026, 2, 30, 0, 10).getTime(), afterChange)).toBe('today')
})

test('the stream is cut into sections in its own order, newest section first, empty ones left out', () => {
  const rows = [
    { id: 'a', recencyAt: at(10, 10, 9) },
    { id: 'b', recencyAt: at(10, 10, 8) },
    { id: 'c', recencyAt: at(10, 6) },
    { id: 'd', recencyAt: at(5, 1) },
    // Out of order on purpose: a section keeps the order it is given.
    { id: 'e', recencyAt: at(10, 10, 9, 15) },
  ]
  expect(sectionChatsByDate(rows, now).map(({ section, entries }) => [section, entries.map((row) => row.id)])).toEqual([
    ['today', ['a', 'b', 'e']],
    ['week', ['c']],
    ['older', ['d']],
  ])
  expect(sectionChatsByDate([], now)).toEqual([])
})
