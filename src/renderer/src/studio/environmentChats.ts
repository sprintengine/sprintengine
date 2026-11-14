import type { StudioClient, StudioClientState } from '../../../../packages/client-runtime/src/public'
import type { StudioWelcomeFrame } from '../../../../packages/studio-protocol/src/public'
import { formatChatAddress, isEnvironmentId } from '../../../../packages/studio-protocol/src/environment'
import type { ConversationEvent, ConversationSessionSummary } from '../../../shared/conversation-runtime'
import { createStudioChatServices } from '../components/panels/agentChat/studioChat'
import {
  environmentRefusal,
  holdEnvironmentStudio,
  type EnvironmentHold,
  type EnvironmentRefusal,
  type EnvironmentTarget,
} from './environmentStudio'

// The chats one environment holds, as this window follows them: one source per
// route the window shows chats of, fed by that environment's own Studio over
// the window's client of it (`environmentStudio.ts`): its `session.list`, read
// again whenever its `conversation.events` push says a session moved, and once
// more after every reconnect. Keyed by chat address
// (`<environmentId>:<workspaceId>`), the environment's own id as its welcome
// says it, so a chat is never taken for another machine's chat of the same id.
//
// Nothing here knows what kind of machine the route reaches: an SSH machine's
// server, a paired desktop, a WSL distribution are each a route and a client.
// While the client is away (reconnecting, parked, the machine asleep) the
// source keeps the last list it read and says it is stale, so the rows it
// feeds stay where they are, dimmed, rather than vanish.

/** One environment's sessions as last read: who they belong to, and whether they are still current. */
export type EnvironmentChatsSnapshot = {
  route: string
  /** The environment's id, once its Studio has said it. */
  environmentId: string | null
  /** Its sessions as last listed, in the order it listed them. */
  sessions: readonly ConversationSessionSummary[]
  /** Each listed chat's sessions by its address; empty until the environment has said its id. */
  byAddress: ReadonlyMap<string, readonly ConversationSessionSummary[]>
  /** True until the first list lands, and while the client is away: the list is the last one read. */
  stale: boolean
  /**
   * Why the window's last connection to it was refused, until one opens: a
   * Studio from before the protocol (a paired desktop not yet updated) is
   * `outdated`, and says to update it there.
   */
  refusal?: EnvironmentRefusal
}

export type EnvironmentChatSource = {
  readonly route: string
  snapshot(): EnvironmentChatsSnapshot
  /** Hear the snapshot change. Returns the unsubscriber. */
  subscribe(listener: () => void): () => void
  /** Hear each of the environment's lifecycle events, and each reconnect. Returns the unsubscriber. */
  onLifecycleEvent(listener: (event: ConversationEvent) => void, onReconnected?: () => void): () => void
  /** Read the list again now. */
  refresh(): void
  /** This window's client of the environment, held open while the source lives. */
  client(): Promise<StudioClient>
  /** The environment's latest welcome, once its client has opened. */
  welcome(): StudioWelcomeFrame | null
  /** Hear each time the client opens, a reconnect included. Returns the unsubscriber. */
  watchOpen(listener: () => void): () => void
  /** Stop following the environment and let its connection go. */
  close(): void
}

/** How long a burst of lifecycle events is folded into one read. */
const REFRESH_SETTLE_MS = 300

const EMPTY_SESSIONS: readonly ConversationSessionSummary[] = Object.freeze([])

/** Sessions grouped by their chat's address in one environment. */
function byAddressOf(
  environmentId: string | null,
  sessions: readonly ConversationSessionSummary[],
): ReadonlyMap<string, readonly ConversationSessionSummary[]> {
  const grouped = new Map<string, ConversationSessionSummary[]>()
  if (!environmentId || !isEnvironmentId(environmentId)) return grouped
  for (const session of sessions) {
    let address: string
    try {
      address = formatChatAddress({ environmentId, chatId: session.workspaceId })
    } catch {
      continue
    }
    const list = grouped.get(address)
    if (list) list.push(session)
    else grouped.set(address, [session])
  }
  return grouped
}

/** Follow one environment's chats over this window's client of it. */
export function createEnvironmentChatSource(
  target: EnvironmentTarget,
  options: {
    /** How the connection is held; the window's own unless a test says otherwise. */
    hold?: (target: EnvironmentTarget) => EnvironmentHold
    settleMs?: number
  } = {},
): EnvironmentChatSource {
  const holdOf = options.hold ?? ((given: EnvironmentTarget) => holdEnvironmentStudio(given))
  const settleMs = options.settleMs ?? REFRESH_SETTLE_MS
  const listeners = new Set<() => void>()
  const openListeners = new Set<() => void>()
  let closed = false
  let state: StudioClientState | 'opening' = 'opening'
  let hold: EnvironmentHold | null = null
  let stopState: (() => void) | null = null
  let current: StudioClient | null = null

  // A hold whose client has closed for good (the route refused, the machine
  // removed) is let go and taken again on the next ask, so a later list is
  // read on whatever client the window makes next.
  const take = (): EnvironmentHold => {
    if (hold) return hold
    const taken = holdOf(target)
    hold = taken
    stopState = taken.onState((next) => {
      const wasOpen = state === 'open'
      state = next
      if (next === 'open' && !wasOpen) for (const listener of [...openListeners]) listener()
      if (next !== 'open') markStale()
    })
    taken.client.then(
      (client) => {
        if (hold !== taken) return
        current = client
        if (snapshot.refusal) {
          const { refusal: _cleared, ...rest } = snapshot
          publish(rest)
        }
        if (client.state === 'open') {
          state = 'open'
          for (const listener of [...openListeners]) listener()
        }
        const letGo = () => {
          if (hold !== taken) return
          release()
          markStale()
        }
        client.closed.then(letGo, letGo)
      },
      (error: unknown) => {
        if (hold !== taken) return
        release()
        const refusal = environmentRefusal(target, error)
        if (closed) return
        if (snapshot.refusal?.code !== refusal.code || !snapshot.stale) publish({ ...snapshot, stale: true, refusal })
      },
    )
    return taken
  }

  const release = (): void => {
    stopState?.()
    stopState = null
    hold?.release()
    hold = null
    state = 'opening'
  }

  // Asked on a later tick, so a hold that cannot be taken (no window to hold
  // it in) is a refusal its caller hears, never an exception thrown from a
  // retry's timer.
  const client = (): Promise<StudioClient> =>
    closed ? Promise.reject(new Error('Closed.')) : Promise.resolve().then(() => take().client)
  const watchOpen = (listener: () => void): (() => void) => {
    openListeners.add(listener)
    return () => openListeners.delete(listener)
  }
  const services = createStudioChatServices(client, watchOpen)

  let snapshot: EnvironmentChatsSnapshot = {
    route: target.route,
    environmentId: null,
    sessions: EMPTY_SESSIONS,
    byAddress: new Map(),
    stale: true,
  }
  const publish = (next: EnvironmentChatsSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  function markStale(): void {
    if (!snapshot.stale && !closed) publish({ ...snapshot, stale: true })
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let reading = false
  let again = false
  const read = (): void => {
    if (closed) return
    if (reading) {
      again = true
      return
    }
    reading = true
    again = false
    void (async () => {
      try {
        const connected = await client()
        const listed = await services.sessions.list()
        if (closed || !listed.ok) return
        const environmentId = connected.welcome?.environment?.id ?? null
        publish({
          route: target.route,
          environmentId,
          sessions: listed.sessions,
          byAddress: byAddressOf(environmentId, listed.sessions),
          stale: connected.state !== 'open',
        })
      } catch {
        markStale()
      } finally {
        reading = false
        if (again) schedule()
      }
    })()
  }
  function schedule(): void {
    if (closed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      read()
    }, settleMs)
  }

  let following: (() => void) | null = null
  const follow = (): void => {
    if (following || closed) return
    following = services.sessions.onLifecycleEvent(
      () => schedule(),
      () => read(),
    )
    read()
  }

  return {
    route: target.route,
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      follow()
      return () => listeners.delete(listener)
    },
    onLifecycleEvent(listener, onReconnected) {
      follow()
      return services.sessions.onLifecycleEvent(listener, onReconnected)
    },
    refresh: read,
    client,
    welcome: () => current?.welcome ?? null,
    watchOpen,
    close() {
      if (closed) return
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      following?.()
      following = null
      listeners.clear()
      openListeners.clear()
      release()
    },
  }
}

// ── The environments this window follows ─────────────────────────────────────

type Followed = { target: EnvironmentTarget; source: EnvironmentChatSource; stop: () => void }

const followed = new Map<string, Followed>()
const followedListeners = new Set<() => void>()

const tellFollowed = (): void => {
  for (const listener of [...followedListeners]) listener()
}

/**
 * Follow exactly these environments' chats from this window: a route not
 * followed yet gets its source, and a route no longer named lets its source
 * and its connection go.
 */
export function followEnvironmentChats(
  targets: readonly EnvironmentTarget[],
  make: (target: EnvironmentTarget) => EnvironmentChatSource = (target) => createEnvironmentChatSource(target),
): void {
  const wanted = new Map(targets.map((target) => [target.route, target]))
  let changed = false
  for (const [route, entry] of followed) {
    if (wanted.has(route)) continue
    entry.stop()
    entry.source.close()
    followed.delete(route)
    changed = true
  }
  for (const [route, target] of wanted) {
    if (followed.has(route)) continue
    const source = make(target)
    const stop = source.subscribe(tellFollowed)
    followed.set(route, { target, source, stop })
    changed = true
  }
  if (changed) tellFollowed()
}

/** The sources this window follows now. */
export function followedEnvironmentChats(): EnvironmentChatSource[] {
  return [...followed.values()].map((entry) => entry.source)
}

/** The source of one followed route, or null when the window does not follow it. */
export function followedEnvironmentChatsOf(route: string): EnvironmentChatSource | null {
  return followed.get(route)?.source ?? null
}

/** Hear the followed set change, or any followed source's list. Returns the unsubscriber. */
export function onFollowedEnvironmentChats(listener: () => void): () => void {
  followedListeners.add(listener)
  return () => followedListeners.delete(listener)
}

/** The followed source of a route, followed from now if it was not: what a chat view on it reads through. */
export function environmentChatSourceFor(target: EnvironmentTarget): EnvironmentChatSource {
  const known = followed.get(target.route)
  if (known) return known.source
  const source = createEnvironmentChatSource(target)
  const stop = source.subscribe(tellFollowed)
  followed.set(target.route, { target, source, stop })
  tellFollowed()
  return source
}
