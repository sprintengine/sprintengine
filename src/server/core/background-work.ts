import { scheduledAgentTitle } from '../../shared/scheduled-agents'
import type { StudioCore } from './studio-core'

// The work a Studio server does on its own, with no client and no chat
// working: schedules with a run to come, pull request watches, messages kept
// to send later, resumes after a usage limit. A server that stops ends it.
//
// What a detached server's idle rule counts as work (bootstrap/headless.ts),
// so an SSH machine's server is not stopped under its schedules; and what the
// desktop's quit question names (app-lifecycle.ts), so stopping them is never
// silent.

/**
 * The backend wire's machine channel a WSL server answers with what it does
 * on its own (`BackgroundWork`): the Windows side asks before it stops the
 * server for being idle, and for the quit question (wsl-environment-manager.ts).
 * A server of an older build refuses the channel, which is read as none.
 */
export const BACKGROUND_WORK_MACHINE_CHANNEL = 'studio:background-work'

export type BackgroundWork = {
  schedules: Array<{ id: string; title: string; nextRunAt: number }>
  watches: Array<{ url: string; title: string }>
  /** Messages kept to send into a chat later (scheduled, or held for a turn's end). */
  messages: number
  /** Chats a usage limit stopped, with a resume set for when it resets. */
  resumes: number
}

type BackgroundWorkCore = Pick<
  StudioCore,
  'scheduledAgents' | 'pullRequests' | 'scheduledMessages' | 'usageLimitResumes'
>

export function backgroundWorkOf(core: BackgroundWorkCore): BackgroundWork {
  const schedules = core.scheduledAgents.upcoming().map((agent) => ({
    id: agent.id,
    title: scheduledAgentTitle(agent.prompt, agent.name),
    nextRunAt: agent.nextRunAt as number,
  }))
  const watches = core.pullRequests.record.watches().map((watched) => {
    const entry = core.pullRequests.record
      .forConversation(watched.conversation)
      .find((candidate) => candidate.url === watched.url)
    return { url: watched.url, title: entry ? entry.title || `#${entry.number}` : watched.url }
  })
  const messages = core.scheduledMessages.state().messages.filter((message) => !message.failure).length
  const resumes = core.usageLimitResumes.state().notices.filter((notice) => notice.resumeAt !== null).length
  return { schedules, watches, messages, resumes }
}

export function hasBackgroundWork(work: BackgroundWork): boolean {
  return work.schedules.length > 0 || work.watches.length > 0 || work.messages > 0 || work.resumes > 0
}

/** A background work summary as another process sends it; null when it is not one (an older build's refusal). */
export function parseBackgroundWork(value: unknown): BackgroundWork | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const list = <T>(items: unknown, read: (item: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(items)
      ? items
          .flatMap((item) => (item && typeof item === 'object' ? [read(item as Record<string, unknown>)] : []))
          .filter((item): item is T => item !== null)
      : []
  const count = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0)
  return {
    schedules: list(raw.schedules, (item) =>
      typeof item.id === 'string' && typeof item.title === 'string' && typeof item.nextRunAt === 'number'
        ? { id: item.id, title: item.title, nextRunAt: item.nextRunAt }
        : null,
    ),
    watches: list(raw.watches, (item) =>
      typeof item.url === 'string' && typeof item.title === 'string' ? { url: item.url, title: item.title } : null,
    ),
    messages: count(raw.messages),
    resumes: count(raw.resumes),
  }
}

/** What a quit stops of the work done on its own, by name: this machine's, and each WSL server's it runs. */
export type QuitStops = { schedules: string[]; watches: string[] }

export function quitStopsOf(
  local: BackgroundWork | null,
  wsl: ReadonlyArray<{ distro: string; work: BackgroundWork }>,
): QuitStops {
  const where = (distro: string) => ` (WSL: ${distro})`
  return {
    schedules: [
      ...(local?.schedules ?? []).map((schedule) => schedule.title),
      ...wsl.flatMap(({ distro, work }) => work.schedules.map((schedule) => `${schedule.title}${where(distro)}`)),
    ],
    watches: [
      ...(local?.watches ?? []).map((watch) => watch.title),
      ...wsl.flatMap(({ distro, work }) => work.watches.map((watch) => `${watch.title}${where(distro)}`)),
    ],
  }
}
