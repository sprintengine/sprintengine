// The words for a relative time in a components panel (`RelativeTime`, and a
// Table's relative cells), and when they next change, so Studio keeps them
// current and the panel never polls.

import type { RelativeTimeFormat } from '../../../../../../packages/extension-sdk/src/components/catalog'

type Unit = 'second' | 'minute' | 'hour' | 'day'
const UNIT_MS: Array<[Unit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
]

/** The largest whole unit for `diffMs` (negative is the past). */
export function relativeTimeParts(diffMs: number): { value: number; unit: Unit } {
  const size = Math.abs(diffMs)
  const [unit, ms] = UNIT_MS.find(([, each]) => size >= each) ?? ['second', 1000]
  return { value: Math.trunc(diffMs / ms), unit }
}

/** How soon the words change: each second under a minute, then every 15 s, then every 5 minutes. */
export function relativeTimeTickMs(diffMs: number): number {
  const size = Math.abs(diffMs)
  return size < 60_000 ? 1000 : size < 3_600_000 ? 15_000 : 300_000
}

/** `long` "5 minutes ago", `short` "5m ago", `duration` "5m". */
export function formatRelativeTime(at: number, now: number, format: RelativeTimeFormat, locale: string): string {
  const { value, unit } = relativeTimeParts(at - now)
  try {
    if (format === 'duration')
      return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(Math.abs(value))
    return new Intl.RelativeTimeFormat(locale, {
      numeric: format === 'long' ? 'auto' : 'always',
      style: format === 'long' ? 'long' : 'narrow',
    }).format(value, unit)
  } catch {
    return new Date(at).toLocaleString()
  }
}
