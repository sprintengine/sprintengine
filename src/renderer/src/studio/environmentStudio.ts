import {
  StudioError,
  connect,
  isStudioVersionFailure,
  presentStudioFailure,
  webSocketTransport,
  type StudioClient,
  type StudioClientState,
  type StudioWebSocketConstructor,
} from '../../../../packages/client-runtime/src/public'
import type { StudioCapability } from '../../../../packages/studio-protocol/src/public'
import {
  formatEnvironmentRoute,
  isEnvironmentRoute,
  parseEnvironmentRoute,
} from '../../../../packages/studio-protocol/src/environment'
import type { ElectronApi } from '../../../shared/electron-api'
import type { EnvironmentEntry } from '../../../shared/environments'

// This window's own client of each other environment's Studio
// (design-lane-on-protocol D1, design-wsl-ssh-direct PR 1d): the protocol every
// client speaks, through the shared client runtime, one connection per route
// (`tailnet:<pairing>` for a paired desktop, `ssh:<machine>` for an SSH
// machine's server). Opened on the first ask and closed once it has sat idle,
// since a machine allows a window a handful of sockets. Nothing here tells the
// routes apart: main answers each route's ticket, and the rest is the same.
//
// The credential is never the window's. Before each connection, reconnects
// included, it asks main for a ticket (`environmentsTicket`): main buys one
// (with the device token it keeps for a paired desktop, over its owner
// connection for an SSH machine), good once, for thirty seconds, from this
// window's origin only. The ticket goes straight into the one connection that
// spends it and is held nowhere else.
//
// A route that machine no longer admits closes this client: its server closes
// the socket, and the next ticket is refused `unauthorized`, which parks the
// client; a parked credential is closed here, not kept. A route the
// environment list no longer holds (a pairing forgotten, an SSH machine
// removed) closes it too, the moment the list says so.

type EnvironmentApi = Pick<ElectronApi, 'environmentsTicket'> &
  Partial<Pick<ElectronApi, 'environmentsList' | 'onEnvironmentsChanged'>>

/** An environment as the window asks it: the route it is reached by, and what it is called in words. */
export type EnvironmentTarget = { route: string; name: string }

/** A paired machine as the window knows it: its pairing here, and what it is called. */
export type PairedMachine = { id: string; machineName: string }

/** The route a paired machine is reached by, as the environments bridge names it. */
export function pairedRoute(connectionId: string): string {
  return formatEnvironmentRoute({ kind: 'tailnet', connection: connectionId })
}

/** The pairing a route reaches a paired desktop by; null for any other route, or none. */
export function pairedConnectionOf(route: string | null): string | null {
  const parsed = route ? parseEnvironmentRoute(route) : null
  return parsed?.kind === 'tailnet' ? parsed.connection : null
}

/** A paired machine, as the environment this window asks. */
export function pairedTarget(machine: PairedMachine): EnvironmentTarget {
  return { route: pairedRoute(machine.id), name: machine.machineName }
}

/**
 * Whether this page reaches other environments' Studios itself: a desktop
 * window does; a web tab, or a test harness without the bridge, does not, and
 * asks nothing.
 */
export function environmentStudioAvailable(): boolean {
  if (typeof window === 'undefined' || !window.api) return false
  return typeof window.api.environmentsTicket === 'function' || setups.get(window.api)?.connect !== undefined
}

/** How long a route's connection is kept with nothing asked of it. */
const IDLE_CLOSE_MS = 5 * 60_000
/** How long one ask waits for an answer, unless it says otherwise. */
const ASK_TIMEOUT_MS = 15_000

type Held = {
  opening: Promise<StudioClient>
  idle: ReturnType<typeof setTimeout> | null
  asking: number
  /** Holds on the connection (an open board, a chat on screen): it is not closed for idling while any lasts. */
  holds: number
  /** Who hears the connection's state as it moves. */
  states: Set<(state: StudioClientState) => void>
}

type Registry = {
  held: Map<string, Held>
  /** Stops hearing the environment list; set once the first client is made. */
  unwatch: (() => void) | null
  /** Who hears a route the environment list no longer holds. */
  forgotten: Set<(route: string) => void>
}

const registries = new WeakMap<object, Registry>()

/** How the clients one api makes are made, beyond the ticket (tests). */
type EnvironmentStudioSetup = {
  /** A WebSocket other than the global one. */
  WebSocket?: StudioWebSocketConstructor
  /**
   * A client of its own for each route, in place of a connection (a test's
   * double), told how to say its state moved as a connection's would.
   */
  connect?: (route: string, onState: (state: StudioClientState) => void) => Promise<StudioClient>
}

const setups = new WeakMap<object, EnvironmentStudioSetup>()

/** Say how the clients this api makes are made (tests). */
export function configureEnvironmentStudio(api: object, setup: EnvironmentStudioSetup): void {
  setups.set(api, setup)
}

function registryOf(api: EnvironmentApi): Registry {
  let registry = registries.get(api)
  if (!registry) registries.set(api, (registry = { held: new Map(), unwatch: null, forgotten: new Set() }))
  return registry
}

function close(api: EnvironmentApi, route: string): void {
  const registry = registries.get(api)
  const entry = registry?.held.get(route)
  if (!registry || !entry) return
  registry.held.delete(route)
  if (entry.idle) clearTimeout(entry.idle)
  entry.opening.then(
    (client) => client.close(),
    () => undefined,
  )
}

/** Close a route's connection from this window, if one is open. */
export function closeEnvironmentStudio(route: string, api: EnvironmentApi = window.api): void {
  close(api, route)
}

/** Close every route's connection from this window. */
export function closeEnvironmentStudios(api: EnvironmentApi = window.api): void {
  const registry = registries.get(api)
  if (!registry) return
  for (const route of [...registry.held.keys()]) close(api, route)
}

/** Whether an environment list still holds a route. */
function listsRoute(entries: readonly EnvironmentEntry[], route: string): boolean {
  return entries.some((entry) =>
    entry.routes.some((known) => isEnvironmentRoute(known) && formatEnvironmentRoute(known) === route),
  )
}

/** Close the connections of routes the environment list no longer holds. */
function watchRoutes(api: EnvironmentApi, registry: Registry): void {
  if (registry.unwatch || !api.onEnvironmentsChanged || !api.environmentsList) return
  const list = api.environmentsList.bind(api)
  registry.unwatch = api.onEnvironmentsChanged(() => {
    if (registry.held.size === 0) return
    void list().then(
      (entries) => {
        for (const route of [...registry.held.keys()]) {
          if (listsRoute(entries, route)) continue
          close(api, route)
          for (const listener of [...registry.forgotten]) listener(route)
        }
      },
      () => undefined,
    )
  })
}

/** Hear a route the environment list dropped, once its connection has been closed. Returns the unsubscriber. */
export function onEnvironmentStudioForgotten(
  listener: (route: string) => void,
  api: EnvironmentApi = window.api,
): () => void {
  const registry = registryOf(api)
  registry.forgotten.add(listener)
  return () => registry.forgotten.delete(listener)
}

function open(api: EnvironmentApi, route: string): Held {
  const registry = registryOf(api)
  const known = registry.held.get(route)
  if (known) return known
  watchRoutes(api, registry)
  const setup = setups.get(api) ?? {}
  const states = new Set<(state: StudioClientState) => void>()
  const WebSocket = setup.WebSocket
  const tell = (state: StudioClientState): void => {
    for (const listener of [...states]) listener(state)
  }
  const opening = setup.connect
    ? setup.connect(route, tell)
    : connect({
        client: { name: 'Studio window' },
        transport: webSocketTransport({
          // Asked afresh for every connection and handed straight to it.
          ticket: async () => {
            const ticket = await api.environmentsTicket(route)
            if (!ticket.ok) throw new StudioError(ticket.code, ticket.message)
            return { url: ticket.url, token: ticket.token }
          },
          ...(WebSocket ? { WebSocket } : {}),
        }),
        reconnect: { initialDelayMs: 500, maxDelayMs: 30_000 },
        // Another machine: this one being offline does say it cannot be reached.
        parkWhenOffline: true,
        onStateChange: (state, error) => {
          tell(state)
          // Parked on its credential: the route is gone there. Nothing to wait for.
          if (state === 'parked' && error && error.code !== 'offline' && registry.held.get(route) === entry)
            close(api, route)
        },
      })
  const entry: Held = { opening, idle: null, asking: 0, holds: 0, states }
  registry.held.set(route, entry)
  const forget = () => {
    if (registry.held.get(route) === entry) close(api, route)
  }
  opening.then((client) => client.closed.then(forget, forget), forget)
  return entry
}

/**
 * Ask an environment's Studio something on this window's connection to it,
 * opened now if there is none. Rejects with a `StudioError`: `outdated` for a
 * machine from before the protocol, `unauthorized` for a route it no longer
 * admits, `unavailable` for one that did not answer in time, or the refusal
 * it gave.
 */
export async function withEnvironmentStudio<T>(
  target: EnvironmentTarget,
  work: (client: StudioClient) => Promise<T>,
  options: {
    timeoutMs?: number
    api?: EnvironmentApi
    /**
     * Refused at once, nothing asked, unless the connection is open now: a
     * change the person waits on, which the client would otherwise hold
     * and carry out on the next connect, after the ask has said it failed.
     */
    onlyWhenConnected?: boolean
  } = {},
): Promise<T> {
  const api = options.api ?? window.api
  const entry = use(api, target.route)
  entry.asking += 1
  let timer: ReturnType<typeof setTimeout> | undefined
  // An ask answered "did not answer in time" is over: its work never starts
  // afterwards, when a connection that took that long opens at last.
  let over = false
  let started = false
  const away = () => new StudioError('unavailable', `${target.name} is not connected.`)
  try {
    return await Promise.race([
      entry.opening.then((client) => {
        if (over) throw new StudioError('unavailable', `${target.name} did not answer in time.`)
        if (options.onlyWhenConnected && client.state !== 'open') throw away()
        started = true
        return work(client)
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          over = true
          // Never connected in that time, a connected-only ask asked nothing.
          reject(
            options.onlyWhenConnected && !started
              ? away()
              : new StudioError('unavailable', `${target.name} did not answer in time.`),
          )
        }, options.timeoutMs ?? ASK_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
    entry.asking -= 1
    settle(api, target.route, entry)
  }
}

/** The connection, opened now if there is none, kept from closing for idling while it is used. */
function use(api: EnvironmentApi, route: string): Held {
  const entry = open(api, route)
  if (entry.idle) clearTimeout(entry.idle)
  entry.idle = null
  return entry
}

/** Close it after the idle wait, once nothing asks of it or holds it. */
function settle(api: EnvironmentApi, route: string, entry: Held): void {
  const registry = registries.get(api)
  if (entry.asking > 0 || entry.holds > 0 || registry?.held.get(route) !== entry) return
  if (entry.idle) clearTimeout(entry.idle)
  entry.idle = setTimeout(() => {
    if (registry.held.get(route) === entry && entry.asking === 0 && entry.holds === 0) close(api, route)
  }, IDLE_CLOSE_MS)
}

/** A route's connection kept open while something here needs it (a board or a chat on screen). */
export type EnvironmentHold = {
  /** The connection, once open. Rejects as an ask does. */
  client: Promise<StudioClient>
  /** The connection's state as it moves: `reconnecting` after a drop, `open` once it is back. */
  onState(listener: (state: StudioClientState) => void): () => void
  /** Done with it: it closes once nothing else holds or asks of it, after the idle wait. */
  release(): void
}

/** Keep a route's connection open, opening it now if there is none, until released. */
export function holdEnvironmentStudio(
  target: EnvironmentTarget,
  options: { api?: EnvironmentApi } = {},
): EnvironmentHold {
  const api = options.api ?? window.api
  const entry = use(api, target.route)
  entry.holds += 1
  const listeners = new Set<(state: StudioClientState) => void>()
  let released = false
  return {
    client: entry.opening,
    onState(listener) {
      listeners.add(listener)
      entry.states.add(listener)
      return () => {
        listeners.delete(listener)
        entry.states.delete(listener)
      }
    },
    release() {
      if (released) return
      released = true
      for (const listener of listeners) entry.states.delete(listener)
      entry.holds -= 1
      settle(api, target.route, entry)
    },
  }
}

/** What a coordinator over environments asks of them: one ask, or a hold. */
export type EnvironmentStudios = {
  ask<T>(target: EnvironmentTarget, work: (client: StudioClient) => Promise<T>, timeoutMs?: number): Promise<T>
  hold(target: EnvironmentTarget): EnvironmentHold
}

/** This window's environments (or another api's), for a coordinator that asks and holds them. */
export function environmentStudios(given?: EnvironmentApi): EnvironmentStudios {
  // The window's bridge as it stands at each ask: a page may be given it late.
  const api = () => given ?? window.api
  return {
    ask: (target, work, timeoutMs) =>
      withEnvironmentStudio(target, work, { api: api(), ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
    hold: (target) => holdEnvironmentStudio(target, { api: api() }),
  }
}

/** Words for a machine whose Studio is from before the protocol. */
export function environmentStudioOutdated(name: string): string {
  return `Update SprintEngine Studio on ${name} to use this from here.`
}

/**
 * Why an environment did not answer, in the kinds a caller tells apart.
 * `outdated` is that machine's Studio behind this window; `incompatible` a
 * protocol mismatch where it is not, or not known to be (this app behind it),
 * whose words say which side to update.
 */
export type EnvironmentRefusal = {
  kind: 'outdated' | 'incompatible' | 'unauthorized' | 'unavailable' | 'refused'
  /** The refusal's own code, for a caller that names it. */
  code: string
  message: string
}

/**
 * A failed ask, read (`presentStudioFailure`): an older Studio, an older app,
 * a route it refuses, a machine away, or a refusal of what was asked.
 */
export function environmentRefusal(target: { name: string }, error: unknown): EnvironmentRefusal {
  const code = error instanceof StudioError ? error.code : 'unavailable'
  const failure = presentStudioFailure(error)
  const message =
    isStudioVersionFailure(failure.kind) || (error instanceof Error && error.message)
      ? failure.message
      : `${target.name} could not answer.`
  switch (failure.kind) {
    case 'server-outdated':
      // A version refusal says so in the Studio's words; an older Studio
      // without the method or capability asked, in words about that machine.
      return {
        kind: 'outdated',
        code,
        message: code === 'unsupported_protocol_version' ? message : environmentStudioOutdated(target.name),
      }
    case 'client-outdated':
    case 'incompatible':
      return { kind: 'incompatible', code, message }
    case 'unauthorized':
    case 'forbidden':
      return { kind: 'unauthorized', code, message }
    default:
      // A machine away is said `unavailable` here too, by the ticket that could not be bought.
      return {
        kind: failure.kind === 'connection' || code === 'unavailable' ? 'unavailable' : 'refused',
        code,
        message,
      }
  }
}

/** An ask's answer, or its refusal in words: what the window's callers read. */
export type EnvironmentAnswer<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

/**
 * One ask of an environment's Studio, held to a capability its welcome must
 * name: a machine whose Studio does not serve it, or that has no Studio yet,
 * is told to update, in words about what was asked. Any other refusal comes
 * back with that machine's code and words. Never throws.
 */
export async function askEnvironment<T>(
  target: EnvironmentTarget,
  capability: StudioCapability | null,
  unsupported: (name: string) => { code: string; message: string },
  work: (client: StudioClient) => Promise<T>,
  options: { timeoutMs?: number; api?: EnvironmentApi; onlyWhenConnected?: boolean } = {},
): Promise<EnvironmentAnswer<T>> {
  try {
    const value = await withEnvironmentStudio(
      target,
      async (client) => {
        if (capability && !client.supports(capability)) throw new StudioError('outdated', '')
        return work(client)
      },
      options,
    )
    return { ok: true, value }
  } catch (error) {
    const refused = environmentRefusal(target, error)
    return refused.kind === 'outdated'
      ? { ok: false, ...unsupported(target.name) }
      : { ok: false, code: refused.code, message: refused.message }
  }
}

/** A command id for one change asked of another environment: a retry of the ask is the same change there. */
export function environmentCommandId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
