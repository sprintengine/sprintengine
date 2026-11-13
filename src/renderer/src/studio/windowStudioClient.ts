import {
  connect,
  webSocketTransport,
  type StudioClient,
  type StudioTransportFactory,
  type StudioWebSocketConstructor,
} from '../../../../packages/client-runtime/src/public'
import type { StudioWelcomeFrame } from '../../../../packages/studio-protocol/src/public'
import type { ElectronApi } from '../../../shared/electron-api'

// This window's client of the Studio RPC: the same `@sprintengine/agent-sdk`
// client a script or a web page uses, over a WebSocket to the window listener
// of the Studio server that holds this machine's chats. Before each
// connection, reconnects included, it asks for a ticket: main mints a desktop
// window's (good once, for thirty seconds, from this window's origin); a web
// tab's is its session cookie, which its socket's upgrade carries. The client
// resumes its streams from their cursors and resends what was unanswered.

type TicketApi = Pick<ElectronApi, 'studioWindowTicket'>

/** How one page's connections are made, beyond the ticket: set once, by the page that knows. */
export type WindowStudioSetup = {
  /**
   * The Studio is on another machine (a web tab's socket to the server that
   * served it): the device being offline does say it cannot be reached, and
   * the client parks until the network is back.
   */
  anotherMachine?: boolean
  /** Hears each socket's close code (a revoked web session's, say). */
  onSocketClose?: (code: number) => void
  /** A WebSocket other than the global one (tests). */
  WebSocket?: StudioWebSocketConstructor
}

const setups = new WeakMap<object, WindowStudioSetup>()

/** Whether this page reaches a Studio at all: a desktop window or a web tab does. */
export function windowHasStudio(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.studioWindowTicket === 'function'
}

/** Whether this page's Studio is on another machine: a web tab's, rather than a desktop window's own. */
export function windowStudioIsAnotherMachine(api: object = window.api): boolean {
  return setups.get(api)?.anotherMachine === true
}

/** Say how this page's connections are made, over what was said before; read when a client is made. */
export function configureWindowStudio(api: object, setup: WindowStudioSetup): void {
  setups.set(api, { ...setups.get(api), ...setup })
}

/** A transport over a fresh WebSocket per connection, each with a fresh ticket. */
export function windowSocketTransport(api: TicketApi, setup: WindowStudioSetup = {}): StudioTransportFactory {
  return webSocketTransport({
    ticket: () => api.studioWindowTicket(),
    ...(setup.WebSocket ? { WebSocket: setup.WebSocket } : {}),
    ...(setup.onSocketClose ? { onSocketClose: setup.onSocketClose } : {}),
  })
}

/**
 * Where a window's connection to its Studio stands: what a chat on the
 * protocol says while it is not `open`.
 */
export type WindowStudioState = 'connecting' | 'open' | 'reconnecting' | 'parked' | 'unavailable'

const states = new WeakMap<object, WindowStudioState>()
const watchers = new WeakMap<object, Set<() => void>>()

function setWindowState(api: object, state: WindowStudioState): void {
  if (states.get(api) === state) return
  states.set(api, state)
  for (const watcher of watchers.get(api) ?? []) watcher()
}

/** The window's connection as it stands; `connecting` before its first client has said anything. */
export function windowStudioState(api: object = window.api): WindowStudioState {
  return states.get(api) ?? 'connecting'
}

/** Hear the window's connection change. Returns the unsubscriber. */
export function watchWindowStudio(api: object, listener: () => void): () => void {
  let set = watchers.get(api)
  if (!set) watchers.set(api, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}

const welcomes = new WeakMap<object, StudioWelcomeFrame>()
const welcomeWatchers = new WeakMap<object, Set<() => void>>()

/**
 * The latest welcome this window's Studio gave it: what it serves and what
 * this window may do there. Null before the first. A reconnect's welcome
 * replaces it (a grant may have changed meanwhile).
 */
export function windowStudioWelcome(api: object = window.api): StudioWelcomeFrame | null {
  return welcomes.get(api) ?? null
}

/** Hear the window's welcome change. Returns the unsubscriber. */
export function watchWindowStudioWelcome(api: object, listener: () => void): () => void {
  let set = welcomeWatchers.get(api)
  if (!set) welcomeWatchers.set(api, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}

function noteWelcome(api: object, client: StudioClient | undefined): void {
  const welcome = client?.welcome
  if (!welcome || welcomes.get(api) === welcome) return
  welcomes.set(api, welcome)
  for (const watcher of welcomeWatchers.get(api) ?? []) watcher()
}

const clients = new WeakMap<object, Promise<StudioClient>>()
// The client each window's promise settled to, so one that has closed is
// known at once rather than a turn later.
const settled = new WeakMap<object, StudioClient>()
// The Studio each window belongs to, by its environment id: a window's later
// clients refuse any other, so nothing the window holds (a stream's cursor, a
// command's id) is ever offered to a different Studio.
const environments = new WeakMap<object, string>()

/**
 * The window's client, connected on first use and kept. A first connection
 * that fails is forgotten, so the next use tries again; once connected, the
 * client reconnects by itself. Asking for it again is a retry: a client parked
 * by a refused ticket or by being offline tries to connect now, and one that
 * closed for good (a version outside the window, another Studio) is replaced.
 */
export function windowStudioClient(api: TicketApi = window.api): Promise<StudioClient> {
  const known = clients.get(api)
  const client = settled.get(api)
  if (known && client?.state !== 'closed') {
    if (client?.state === 'parked') client.wake()
    return known
  }
  settled.delete(api)
  const bound = environments.get(api)
  if (states.get(api) !== 'reconnecting') setWindowState(api, 'connecting')
  const setup = setups.get(api) ?? {}
  const connecting = connect({
    // Read through the api at each connection, so a page that swaps its
    // ticket call (a test) is heard on the next one.
    transport: windowSocketTransport(api, setup),
    client: { name: 'Studio window' },
    // A window and the Studio it belongs to come and go together; a short
    // ceiling brings a window back quickly after a restart of the server.
    reconnect: { initialDelayMs: 100, maxDelayMs: 5_000 },
    // A desktop window's Studio is on this machine: an offline laptop still
    // reaches it. A web tab's is not, and waits for the network.
    parkWhenOffline: setup.anotherMachine === true,
    ...(bound === undefined ? {} : { environmentId: bound }),
    onStateChange: (state) => {
      if (clients.get(api) !== connecting) return
      setWindowState(api, state === 'closed' ? 'unavailable' : state)
      // A reconnect is welcomed again before it opens.
      if (state === 'open') noteWelcome(api, settled.get(api))
    },
  })
  clients.set(api, connecting)
  const forget = () => {
    if (clients.get(api) !== connecting) return
    clients.delete(api)
    setWindowState(api, 'unavailable')
  }
  void connecting.then((connected) => {
    if (clients.get(api) === connecting) {
      settled.set(api, connected)
      noteWelcome(api, connected)
    }
    if (!environments.has(api)) environments.set(api, connected.welcome.environment.id)
    connected.closed.then(forget, forget)
  }, forget)
  return connecting
}
