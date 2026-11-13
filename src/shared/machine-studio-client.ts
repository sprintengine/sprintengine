import type { StudioClient } from '../../packages/client-runtime/src/public'
import { machinePathsIn, machinePathsOut } from './machine-path-edge'

// A client of one SSH machine's Studio as this computer's callers read it
// (the window, and main for the gateway's tools and modules): the same client,
// with the machine's paths respelled at its edge (`machine-path-edge.ts`). A
// chat there keeps its folder as this computer spells it, `ssh://<id>/…`, in
// this computer's records and keys; the machine is handed the plain path, and
// the folders and files it names come back spelled for this computer again.
// This is the one place either respells them.

/** The members of one answer that name a file there beside the folders every answer's do. */
const ANSWER_PATHS: Partial<Record<string, ReadonlySet<string>>> = {
  'conversation.planDocument': new Set(['path']),
}

const made = new WeakMap<StudioClient, Map<string, StudioClient>>()

/** The machine `id`'s client, its paths spelled as this computer spells them. One per client and machine. */
export function machineStudioClient(client: StudioClient, id: string): StudioClient {
  let byId = made.get(client)
  if (!byId) made.set(client, (byId = new Map()))
  const known = byId.get(id)
  if (known) return known
  const request = (async (method: string, params?: unknown) =>
    machinePathsOut(
      id,
      await (client.request as (method: string, params?: unknown) => Promise<unknown>)(
        method,
        machinePathsIn(id, params ?? {}),
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
  const conversations = new Proxy(client.conversations, {
    get(target, member, receiver) {
      const value = Reflect.get(target, member, receiver) as unknown
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => (value as (...given: unknown[]) => unknown).apply(target, machinePathsIn(id, args))
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
  byId.set(id, wrapped)
  return wrapped
}
