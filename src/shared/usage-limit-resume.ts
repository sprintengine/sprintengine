// A chat whose turn a usage limit stopped, and the turn Studio can send it once
// the limit lifts. Main keeps them (src/main/usage-limits/resume.ts), with the
// setting that schedules one for every such chat; the chat's composer tray
// draws its own (agentChat/usageLimitResume.tsx).

export type {
  UsageLimitKind,
  UsageLimitResumeAction,
  UsageLimitResumeChat,
  UsageLimitResumeNotice,
  UsageLimitResumeState,
  UsageLimitResumeUpdate,
} from '../../packages/studio-protocol/src/public'
import type { UsageLimitKind } from '../../packages/studio-protocol/src/public'

const HOUR_MS = 60 * 60 * 1000

/** A window's kind by its length, else by the id Claude gives it. */
export function usageLimitKindOf(windowId: string | null, durationMs?: number): UsageLimitKind {
  if (durationMs === 5 * HOUR_MS) return 'session'
  if (durationMs === 7 * 24 * HOUR_MS) return 'weekly'
  if (windowId === 'five_hour') return 'session'
  if (windowId?.startsWith('seven_day')) return 'weekly'
  return null
}
