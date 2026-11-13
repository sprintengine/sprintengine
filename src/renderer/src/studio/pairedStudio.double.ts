import { StudioError, type StudioClient } from '../../../../packages/client-runtime/src/public'
import {
  STUDIO_APPROVAL_RULES_CAPABILITY,
  STUDIO_CANVAS_BOARDS_CAPABILITY,
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_SCHEDULES_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  type StudioScope,
} from '../../../../packages/studio-protocol/src/public'
import { closePairedStudios, configurePairedStudio } from './pairedStudio'

// A stand-in for each paired machine's Studio as this window's own client
// reaches it (`pairedStudio.ts`), for tests of what asks it. A test gives its
// `window.api` one:
//
//   const studio = fakePairedStudios(window.api, {
//     'workspaces.list': () => ({ workspaces: [...] }),
//     'conversation.settle': (params) => ({ settledAt: 1 }),
//   })
//
// and reads `studio.calls`, or `studio.writes()` for the changes alone. A method it names no answer for is refused
// `unknown_method`, as a Studio without it would. Each machine serves the
// capabilities and holds the scopes given, or all of them.

/** What one method answers, given what it was asked and which machine was asked. */
type Answer = (params: Record<string, unknown>, connectionId: string) => unknown

export type PairedStudiosDouble = {
  /** Every ask, in order. */
  calls: Array<{ connectionId: string; method: string; params: Record<string, unknown> }>
  /** The answers, changeable as the test goes. */
  answers: Record<string, Answer>
  /** The capabilities each machine serves; change to make one older. */
  capabilities: Set<string>
  /** What the pairing may do there. */
  scopes: StudioScope[]
  /** Refuse a machine's connection, as a ticket refused or a machine away does; null connects. */
  refuse: (connectionId: string) => StudioError | null
  /** The changes asked, reads left out, each without its command id. */
  writes(): Array<{ connectionId: string; method: string; params: Record<string, unknown> }>
}

/** The methods that only read, which `writes` leaves out. */
const READS = new Set([
  'workspaces.list',
  'workspaces.checkout',
  'workspaces.extensions',
  'cliRuntimes.list',
  'schedules.list',
  'conversation.deletePlan',
  'conversation.searchChats',
  'conversation.approvalRules',
  'canvas.list',
  'canvas.picture',
  'canvas.read',
  'canvas.files',
])

const ALL_CAPABILITIES = [
  STUDIO_WORKSPACES_CAPABILITY,
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_APPROVAL_RULES_CAPABILITY,
  STUDIO_SCHEDULES_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_CANVAS_BOARDS_CAPABILITY,
]

const ALL_SCOPES: StudioScope[] = [
  'workspaces:read',
  'workspaces:operate',
  'conversation:read',
  'conversation:operate',
  'conversation:create',
]

export function fakePairedStudios(
  api: object,
  answers: Record<string, Answer> = {},
  options: { capabilities?: readonly string[]; scopes?: StudioScope[] } = {},
): PairedStudiosDouble {
  const double: PairedStudiosDouble = {
    calls: [],
    answers: { ...answers },
    capabilities: new Set(options.capabilities ?? ALL_CAPABILITIES),
    scopes: options.scopes ?? ALL_SCOPES,
    refuse: () => null,
    writes: () =>
      double.calls
        .filter((call) => !READS.has(call.method))
        .map(({ connectionId, method, params: { commandId: _commandId, ...params } }) => ({
          connectionId,
          method,
          params,
        })),
  }
  closePairedStudios(api as never)
  configurePairedStudio(api, {
    connect: async (connectionId) => {
      const refused = double.refuse(connectionId)
      if (refused) throw refused
      const ask = async (method: string, params: Record<string, unknown> = {}) => {
        double.calls.push({ connectionId, method, params })
        const answer = double.answers[method]
        if (!answer) throw new StudioError('unknown_method', `This Studio does not serve ${method}.`)
        return answer(params, connectionId)
      }
      const client = {
        state: 'open',
        get grant() {
          return { clientId: 'tailnet:double', name: 'dev-macbook-air', owner: false, scopes: double.scopes }
        },
        supports: (capability: string) => double.capabilities.has(capability),
        request: ask,
        rpc: new Proxy(
          {},
          { get: (_target, method: string) => (params: Record<string, unknown>) => ask(method, params) },
        ),
        close: () => undefined,
        closed: new Promise<void>(() => undefined),
        wake: () => undefined,
      }
      return client as unknown as StudioClient
    },
  })
  return double
}
