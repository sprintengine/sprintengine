import type * as Schedules from './schedules'

// A stand-in for the window's scheduled agents (`schedules.ts`), for tests of
// what calls it. Every suite gets it (`tests/setup.ts` mocks the module with
// this one); the module's own suite asks for the real one.
//
// A call goes, as it is made, to the member of the same name a suite set on
// `window.api` (the names the window's IPC once had, which suites have always
// stubbed), else to `schedulesDouble`'s, which a suite may set too. Unset, a
// follow hears nothing and anything else rejects, as an unstubbed IPC member did.

type Api = Schedules.SchedulesApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`schedules.${name} is not stubbed in this test`))
}

function blank(): Api {
  return {
    listScheduledAgents: () => notStubbed('listScheduledAgents'),
    createScheduledAgent: () => notStubbed('createScheduledAgent'),
    updateScheduledAgent: () => notStubbed('updateScheduledAgent'),
    removeScheduledAgent: () => notStubbed('removeScheduledAgent'),
    runScheduledAgentNow: () => notStubbed('runScheduledAgentNow'),
    markScheduledAgentFailureSeen: () => notStubbed('markScheduledAgentFailureSeen'),
    onScheduledAgentsChanged: () => () => undefined,
    pauseScheduledAgent: () => notStubbed('pauseScheduledAgent'),
    resumeScheduledAgent: () => notStubbed('resumeScheduledAgent'),
    getScheduledAgentsPause: () => notStubbed('getScheduledAgentsPause'),
    pauseAllScheduledAgents: () => notStubbed('pauseAllScheduledAgents'),
    resumeAllScheduledAgents: () => notStubbed('resumeAllScheduledAgents'),
    onScheduledAgentsPauseChanged: () => () => undefined,
    getScheduledAgentsHeld: async () => null,
    onScheduledAgentsHeldChanged: () => () => undefined,
  }
}

/** What each call answers when no suite stubbed `window.api` for it: set a member to change it. */
export const schedulesDouble: Api = blank()

/** Put every member back as it was. */
export function resetSchedulesDouble(): void {
  Object.assign(schedulesDouble, blank())
}

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const schedulesApi: Api = Object.fromEntries(
  (Object.keys(blank()) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (schedulesDouble[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
