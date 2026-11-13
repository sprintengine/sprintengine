import {
  StudioError,
  connect,
  webSocketTransport,
  type StudioClient,
  type StudioClientState,
  type StudioWebSocketConstructor,
} from '../../../../packages/client-runtime/src/public'
import type { StudioCapability } from '../../../../packages/studio-protocol/src/public'
import { formatEnvironmentRoute } from '../../../../packages/studio-protocol/src/environment'
import type { ElectronApi } from '../../../shared/electron-api'
import type { EnvironmentEntry } from '../../../shared/environments'

// This window's own client of each paired desktop's Studio
// (design-lane-on-protocol D1): the protocol every client speaks, on that
// machine's tailnet listener, through the shared client runtime. One
// connection per paired machine, opened on the first ask and closed once it
// has sat idle, since that machine allows a device a handful of sockets.
//
// The credential is never the window's. Before each connection, reconnects
// included, it asks main for a ticket (`environmentsTicket`): main buys one
// with the device token it keeps, good once, for thirty seconds, from this
// window's origin only. The ticket goes straight into the one connection that
// spends it and is held nowhere else.
//
// A pairing that machine revoked closes this client: its server closes the
// socket, and the next ticket is refused `unauthorized`, which parks the
// client; a parked credential is closed here, not kept. A pairing forgotten
// here closes it too, the moment the machine list no longer has it.

type PairedApi = Pick<ElectronApi, 'environmentsTicket'> &
  Partial<Pick<ElectronApi, 'environmentsList' | 'onEnvironmentsChanged'>>

/** A paired machine as the window knows it: its pairing here, and what it is called. */
export type PairedMachine = { id: string; machineName: string }

/**
 * Whether this page reaches paired machines' Studios itself: a desktop window
 * does; a web tab, or a test harness without the bridge, does not, and asks
 * nothing.
 */
export function pairedStudioAvailable(): boolean {
  if (typeof window === 'undefined' || !window.api) return false
  return typeof window.api.environmentsTicket === 'function' || setups.get(window.api)?.connect !== undefined
}

/** How long a paired machine's connection is kept with nothing asked of it. */
const IDLE_CLOSE_MS = 5 * 60_000
/** How long one ask waits for an answer, unless it says otherwise. */
const ASK_TIMEOUT_MS = 15_000

type Held = {
  opening: Promise<StudioClient>
  idle: ReturnType<typeof setTimeout> | null
  asking: number
  /** Holds on the connection (an open board): it is not closed for idling while any lasts. */
  holds: number
  /** Who hears the connection's state as it moves. */
  states: Set<(state: StudioClientState) => void>
}

type Registry = {
  held: Map<string, Held>
  /** Stops hearing the machine list; set once the first client is made. */
  unwatch: (() => void) | null
  /** Who hears a pairing forgotten here (the machine list no longer has it). */
  forgotten: Set<(connectionId: string) => void>
}

const registries = new WeakMap<object, Registry>()

/** How the clients one api makes are made, beyond the ticket (tests). */
type PairedStudioSetup = {
  /** A WebSocket other than the global one. */
  WebSocket?: StudioWebSocketConstructor
  /** A client of its own for each machine, in place of a connection (a test's double). */
  connect?: (connectionId: string) => Promise<StudioClient>
}

const setups = new WeakMap<object, PairedStudioSetup>()

/** Say how the clients this api makes are made (tests). */
export function configurePairedStudio(api: object, setup: PairedStudioSetup): void {
  setups.set(api, setup)
}

function registryOf(api: PairedApi): Registry {
  let registry = registries.get(api)
  if (!registry) registries.set(api, (registry = { held: new Map(), unwatch: null, forgotten: new Set() }))
  return registry
}

/** The route a paired machine is reached by, as the environments bridge names it. */
export function pairedRoute(connectionId: string): string {
  return formatEnvironmentRoute({ kind: 'tailnet', connection: connectionId })
}

function close(api: PairedApi, connectionId: string): void {
  const registry = registries.get(api)
  const entry = registry?.held.get(connectionId)
  if (!registry || !entry) return
  registry.held.delete(connectionId)
  if (entry.idle) clearTimeout(entry.idle)
  entry.opening.then(
    (client) => client.close(),
    () => undefined,
  )
}

/** Close a paired machine's connection from this window, if one is open. */
export function closePairedStudio(connectionId: string, api: PairedApi = window.api): void {
  close(api, connectionId)
}

/** Close every paired machine's connection from this window. */
export function closePairedStudios(api: PairedApi = window.api): void {
  const registry = registries.get(api)
  if (!registry) return
  for (const connectionId of [...registry.held.keys()]) close(api, connectionId)
}

/** Whether a machine list still holds a pairing. */
function listsPairing(entries: readonly EnvironmentEntry[], connectionId: string): boolean {
  return entries.some((entry) =>
    entry.routes.some((route) => route.kind === 'tailnet' && route.connection === connectionId),
  )
}

/** Close the connections of pairings the machine list no longer holds. */
function watchPairings(api: PairedApi, registry: Registry): void {
  if (registry.unwatch || !api.onEnvironmentsChanged || !api.environmentsList) return
  const list = api.environmentsList.bind(api)
  registry.unwatch = api.onEnvironmentsChanged(() => {
    if (registry.held.size === 0) return
    void list().then(
      (entries) => {
        for (const connectionId of [...registry.held.keys()]) {
          if (listsPairing(entries, connectionId)) continue
          close(api, connectionId)
          for (const listener of [...registry.forgotten]) listener(connectionId)
        }
      },
      () => undefined,
    )
  })
}

/** Hear a pairing forgotten here, once its connection has been closed. Returns the unsubscriber. */
export function onPairedStudioForgotten(
  listener: (connectionId: string) => void,
  api: PairedApi = window.api,
): () => void {
  const registry = registryOf(api)
  registry.forgotten.add(listener)
  return () => registry.forgotten.delete(listener)
}

function open(api: PairedApi, connectionId: string): Held {
  const registry = registryOf(api)
  const known = registry.held.get(connectionId)
  if (known) return known
  watchPairings(api, registry)
  const route = pairedRoute(connectionId)
  const setup = setups.get(api) ?? {}
  const states = new Set<(state: StudioClientState) => void>()
  const WebSocket = setup.WebSocket
  const opening = setup.connect
    ? setup.connect(connectionId)
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
          for (const listener of [...states]) listener(state)
          // Parked on its credential: the pairing is gone there. Nothing to wait for.
          if (state === 'parked' && error && error.code !== 'offline' && registry.held.get(connectionId) === entry)
            close(api, connectionId)
        },
      })
  const entry: Held = { opening, idle: null, asking: 0, holds: 0, states }
  registry.held.set(connectionId, entry)
  const forget = () => {
    if (registry.held.get(connectionId) === entry) close(api, connectionId)
  }
  opening.then((client) => client.closed.then(forget, forget), forget)
  return entry
}

/**
 * Ask a paired machine's Studio something on this window's connection to it,
 * opened now if there is none. Rejects with a `StudioError`: `outdated` for a
 * machine from before the protocol, `unauthorized` for a pairing it no longer
 * knows, `unavailable` for one that did not answer in time, or the refusal it
 * gave.
 */
export async function withPairedStudio<T>(
  machine: PairedMachine,
  work: (client: StudioClient) => Promise<T>,
  options: { timeoutMs?: number; api?: PairedApi } = {},
): Promise<T> {
  const api = options.api ?? window.api
  const entry = use(api, machine.id)
  entry.asking += 1
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      entry.opening.then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new StudioError('unavailable', `${machine.machineName} did not answer in time.`)),
          options.timeoutMs ?? ASK_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    entry.asking -= 1
    settle(api, machine.id, entry)
  }
}

/** The connection, opened now if there is none, kept from closing for idling while it is used. */
function use(api: PairedApi, connectionId: string): Held {
  const entry = open(api, connectionId)
  if (entry.idle) clearTimeout(entry.idle)
  entry.idle = null
  return entry
}

/** Close it after the idle wait, once nothing asks of it or holds it. */
function settle(api: PairedApi, connectionId: string, entry: Held): void {
  const registry = registries.get(api)
  if (entry.asking > 0 || entry.holds > 0 || registry?.held.get(connectionId) !== entry) return
  if (entry.idle) clearTimeout(entry.idle)
  entry.idle = setTimeout(() => {
    if (registry.held.get(connectionId) === entry && entry.asking === 0 && entry.holds === 0) close(api, connectionId)
  }, IDLE_CLOSE_MS)
}

/** A paired machine's connection kept open while something here needs it (a board on screen). */
export type PairedHold = {
  /** The connection, once open. Rejects as an ask does. */
  client: Promise<StudioClient>
  /** The connection's state as it moves: `reconnecting` after a drop, `open` once it is back. */
  onState(listener: (state: StudioClientState) => void): () => void
  /** Done with it: it closes once nothing else holds or asks of it, after the idle wait. */
  release(): void
}

/** Keep a paired machine's connection open, opening it now if there is none, until released. */
export function holdPairedStudio(machine: PairedMachine, options: { api?: PairedApi } = {}): PairedHold {
  const api = options.api ?? window.api
  const entry = use(api, machine.id)
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
      settle(api, machine.id, entry)
    },
  }
}

/** What a coordinator over paired machines asks of them: one ask, or a hold. */
export type PairedStudios = {
  ask<T>(machine: PairedMachine, work: (client: StudioClient) => Promise<T>, timeoutMs?: number): Promise<T>
  hold(machine: PairedMachine): PairedHold
}

/** This window's paired machines (or another api's), for a coordinator that asks and holds them. */
export function pairedStudios(given?: PairedApi): PairedStudios {
  // The window's bridge as it stands at each ask: a page may be given it late.
  const api = () => given ?? window.api
  return {
    ask: (machine, work, timeoutMs) =>
      withPairedStudio(machine, work, { api: api(), ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
    hold: (machine) => holdPairedStudio(machine, { api: api() }),
  }
}

/** Words for a machine whose Studio is from before the protocol. */
export function pairedStudioOutdated(machineName: string): string {
  return `Update SprintEngine Studio on ${machineName} to use this from here.`
}

/** Why a paired machine did not answer, in the kinds a caller tells apart. */
export type PairedRefusal = {
  kind: 'outdated' | 'unauthorized' | 'unavailable' | 'refused'
  /** The refusal's own code, for a caller that names it. */
  code: string
  message: string
}

/** A failed ask, read: an older Studio, a pairing it refuses, a machine away, or a refusal of what was asked. */
export function pairedRefusal(machine: { machineName: string }, error: unknown): PairedRefusal {
  const code = error instanceof StudioError ? error.code : 'unavailable'
  const message = error instanceof Error && error.message ? error.message : `${machine.machineName} could not answer.`
  switch (code) {
    case 'outdated':
    case 'unknown_method':
    case 'unsupported_protocol_version':
      return { kind: 'outdated', code, message: pairedStudioOutdated(machine.machineName) }
    case 'unauthorized':
    case 'revoked':
    case 'peer_mismatch':
    case 'scope_required':
    case 'owner_required':
      return { kind: 'unauthorized', code, message }
    case 'unavailable':
    case 'closed':
    case 'timeout':
    case 'disconnected':
      return { kind: 'unavailable', code, message }
    default:
      return { kind: 'refused', code, message }
  }
}

/** An ask's answer, or its refusal in words: what the window's callers read. */
export type PairedAnswer<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

/**
 * One ask of a paired machine's Studio, held to a capability its welcome must
 * name: a machine whose Studio does not serve it, or that has no Studio yet,
 * is told to update, in words about what was asked. Any other refusal comes
 * back with that machine's code and words. Never throws.
 */
export async function askPaired<T>(
  machine: PairedMachine,
  capability: StudioCapability | null,
  unsupported: (machineName: string) => { code: string; message: string },
  work: (client: StudioClient) => Promise<T>,
  options: { timeoutMs?: number; api?: PairedApi } = {},
): Promise<PairedAnswer<T>> {
  try {
    const value = await withPairedStudio(
      machine,
      async (client) => {
        if (capability && !client.supports(capability)) throw new StudioError('outdated', '')
        return work(client)
      },
      options,
    )
    return { ok: true, value }
  } catch (error) {
    const refused = pairedRefusal(machine, error)
    return refused.kind === 'outdated'
      ? { ok: false, ...unsupported(machine.machineName) }
      : { ok: false, code: refused.code, message: refused.message }
  }
}

/** A command id for one change asked of a paired machine: a retry of the ask is the same change there. */
export function pairedCommandId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
