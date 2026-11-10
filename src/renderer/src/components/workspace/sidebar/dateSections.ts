// The By date list (owner request 2026-11-10): the flat stream cut into
// sections by when the person last sent each chat a message, so what they
// are working on today stands apart from what is left over from yesterday
// and from what has gone quiet. The stream's own order is kept, newest
// message first, so a section is a run of it under a heading and no row
// changes seat when the list is grouped this way.
//
// Days are the person's own calendar days, in local time: a chat written to
// at 23:50 is yesterday's at 00:10. The week and month sections are the
// seven and thirty days before today, not calendar weeks and months, so a
// chat from last Sunday reads the same on a Monday as on a Saturday.

export type ChatDateSection = 'today' | 'yesterday' | 'week' | 'month' | 'older'

export const CHAT_DATE_SECTION_LABEL: Record<ChatDateSection, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  month: 'Previous 30 days',
  older: 'Older',
}

/** The start of the local day `daysBack` days before the one `now` falls in. */
function dayStart(now: number, daysBack: number): number {
  const day = new Date(now)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - daysBack).getTime()
}

/**
 * Which section a chat last written to at `at` sits in. A stamp after `now`
 * (a paired machine's clock a little ahead) is today's; a chat never written
 * to (no stamp) is the oldest there is.
 */
export function chatDateSectionOf(at: number, now: number): ChatDateSection {
  if (!(at > 0)) return 'older'
  if (at >= dayStart(now, 0)) return 'today'
  if (at >= dayStart(now, 1)) return 'yesterday'
  if (at >= dayStart(now, 7)) return 'week'
  if (at >= dayStart(now, 30)) return 'month'
  return 'older'
}

/**
 * `entries` in the order given, cut into their date sections, newest section
 * first. A section with no chat in it is left out.
 */
export function sectionChatsByDate<T extends { recencyAt: number }>(
  entries: readonly T[],
  now: number,
): Array<{ section: ChatDateSection; entries: T[] }> {
  const bySection = new Map<ChatDateSection, T[]>()
  for (const entry of entries) {
    const section = chatDateSectionOf(entry.recencyAt, now)
    const rows = bySection.get(section)
    if (rows) rows.push(entry)
    else bySection.set(section, [entry])
  }
  return (Object.keys(CHAT_DATE_SECTION_LABEL) as ChatDateSection[]).flatMap((section) => {
    const rows = bySection.get(section)
    return rows ? [{ section, entries: rows }] : []
  })
}
