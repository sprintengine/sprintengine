import type { StudioClient } from '../../packages/client-runtime/src/public'
import { machinePathsIn, machinePathsOut } from './machine-path-edge'
import { machineSpellingOf, type MachineSpelling } from './machine-spelling'

// A client of another machine's Studio (an SSH machine's, a WSL
// distribution's) as this computer's callers read it (the window, the core's
// hand-over and gateway, main): the same client, with the machine's paths
// respelled at its edge (`machine-path-edge.ts`). A chat there keeps its
// folder as this computer spells it (`ssh://<id>/…`, `\\wsl.localhost\…`) in
// this computer's records and keys; the machine is handed the plain path, and
// the folders and files it names come back spelled for this computer again.
// This is the one place either respells them.

/** The members of one answer that name a file there beside the folders every answer's do. */
const ANSWER_PATHS: Partial<Record<string, ReadonlySet<string>>> = {
  'conversation.planDocument': new Set(['path']),
}

const made = new WeakMap<StudioClient, Map<string, StudioClient>>()

/** The machine's client, its paths spelled as this computer spells them. One per client and machine. */
export function machineStudioClient(client: StudioClient, spelling: MachineSpelling): StudioClient {
  let byRoute = made.get(client)
  if (!byRoute) made.set(client, (byRoute = new Map()))
  const known = byRoute.get(spelling.route)
  if (known) return known
  const request = (async (method: string, params?: unknown) =>
    machinePathsOut(
      spelling,
      await (client.request as (method: string, params?: unknown) => Promise<unknown>)(
        method,
        machinePathsIn(spelling, params ?? {}),
      ),
      ANSWER_PATHS[method],
    )) as StudioClient['request']
  const rpc = new Proxy(
    {},
    {
      get: (_target, method) =>
        typeof method === 'string'
          ? (params: unknown) => (request as (m: string, p: unknown) => unknown)(method, params)
          : undefined,
    },
  ) as StudioClient['rpc']
  // Each conversation call names its chat by a ref whose folder is this
  // computer's spelling: handed over plain. What it answers is the
  // transcript's, left as it was written.
  // (A stand-in client without them is left as it is.)
  const conversations = !client.conversations
    ? client.conversations
    : new Proxy(client.conversations, {
        get(target, member, receiver) {
          const value = Reflect.get(target, member, receiver) as unknown
          if (typeof value !== 'function') return value
          return (...args: unknown[]) =>
            (value as (...given: unknown[]) => unknown).apply(target, machinePathsIn(spelling, args))
        },
      })
  const wrapped = new Proxy(client, {
    get(target, member, receiver) {
      if (member === 'request') return request
      if (member === 'rpc') return rpc
      if (member === 'conversations') return conversations
      const value = Reflect.get(target, member, receiver) as unknown
      return typeof value === 'function' ? (value as (...given: unknown[]) => unknown).bind(target) : value
    },
  })
  byRoute.set(spelling.route, wrapped)
  return wrapped
}

/**
 * A client of the Studio a route reaches, as this computer's callers read it:
 * respelled for an SSH machine or a WSL distribution (a distribution's drive
 * mount root read from its own welcome), and as it is for any other route.
 */
export function routeStudioClient(client: StudioClient, route: string): StudioClient {
  const spelling = machineSpellingOf(route, () => {
    try {
      return client.welcome.environment.driveMountRoot
    } catch {
      // Not connected yet: the default root until it says.
      return undefined
    }
  })
  return spelling ? machineStudioClient(client, spelling) : client
}
