import { StudioError, type StudioClient, type StudioClientState } from '../../../../packages/client-runtime/src/public'
import {
  STUDIO_CONVERSATIONS_CAPABILITY,
  type StudioWelcomeFrame,
} from '../../../../packages/studio-protocol/src/public'
import { formatChatAddress, isEnvironmentId } from '../../../../packages/studio-protocol/src/environment'
import type { ConversationEvent, ConversationSessionSummary } from '../../../shared/conversation-runtime'
import type { MeshConversation, MeshConversationAccess } from '../../../shared/tailnet-mesh'
import { createStudioChatServices } from '../components/panels/agentChat/studioChat'
import { windowActivity, type WindowActivity } from '../utils/windowActivity'
import { listEnvironmentChatsThrough } from './environmentChatRecords'
import {
  ANSWER_GRACE_MS,
  listFailureOf,
  readDue,
  type EnvironmentListFailure,
  type ReadHistory,
} from './environmentChatsFreshness'
import { cachedRowsOf, windowEnvironmentChatsCache, type EnvironmentChatsCache } from './environmentChatsCache'
import { browseEnvironmentThrough, type EnvironmentBrowse } from './environmentDiscovery'
import {
  environmentRefusal,
  holdEnvironmentStudio,
  type EnvironmentAsk,
  type EnvironmentHold,
  type EnvironmentRefusal,
  type EnvironmentTarget,
} from './environmentStudio'

// The chats one environment holds, as this window follows them: one source per
// route the window shows chats of, fed by that environment's own Studio over
// the window's client of it (`environmentStudio.ts`). Two lists:
//
// - its sessions (`session.list`), read again whenever its
//   `conversation.events` push says a session moved, and once more after every
//   reconnect, keyed by chat address (`<environmentId>:<workspaceId>`), the
//   environment's own id as its welcome says it, so a chat is never taken for
//   another machine's chat of the same id;
// - its rows (`rows`): what it holds (`workspaces.list`) and its chats
//   (`conversation.list`), read again for what its `conversations.changed`
//   push names, whole once more whenever the window reaches it again, and on
//   the slow clock and focus of `environmentChatsFreshness.ts`.
//
// Nothing here knows what kind of machine the route reaches: an SSH machine's
// server, a paired desktop, a WSL distribution are each a route and a client.
// While the client is away (reconnecting, parked, the machine asleep) the
// source keeps the last lists it read and says they are stale, so the rows
// they feed stay where they are, dimmed, rather than vanish; nothing is asked
// of it on the clock until it is reached again, and that reconnect is what
// reads it. A read that fails keeps the rows it had and says why
// (`listFailure`). The rows it reads are kept by the environment's id
// (`environmentChatsCache.ts`), so a window that starts while the environment
// is away draws its last-known rows until it answers. A window nobody can see reads no rows on a push: it
// remembers what moved and reads it once it is seen again.

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
  /** What it holds and its chats, as the newest reads left them. */
  rows: EnvironmentRows
}

/** What an environment holds and its chats, as the window last read them of its Studio. */
export type EnvironmentRows = {
  /** What it holds, as the newest read that reached it said; kept across a read that did not. */
  browse: EnvironmentBrowse | null
  /** A read of what it holds is out. */
  loading: boolean
  /** Why the newest read of what it holds did not reach it; null when it did. */
  error: string | null
  /** Epoch ms of the newest read that settled; null before the first. */
  at: number | null
  /**
   * Its chats as the newest read that could list them listed them; absent
   * before one has. A device that may not read them, or a Studio that does not
   * serve them, simply has none.
   */
  conversations?: MeshConversation[]
  /** What this device may do with its chats, as its newest list said. Absent before a list. */
  access?: MeshConversationAccess
  /** What of its chats' records its Studio keeps for this one, as the newest browse that reached it said. */
  chatRecord?: { lifecycle: boolean; unwatchPullRequest: boolean }
  /** Epoch ms of the newest read that listed its chats (or got a refusal that is the answer); absent before one. */
  listedAt?: number
  /** Why the newest read of its chats did not replace them, or null when it did: they are then a last-known list. */
  listFailure?: EnvironmentListFailure | null
}

export type EnvironmentChatSource = {
  readonly route: string
  snapshot(): EnvironmentChatsSnapshot
  /** Hear the snapshot change. Returns the unsubscriber. */
  subscribe(listener: () => void): () => void
  /** Hear each of the environment's lifecycle events, and each reconnect. Returns the unsubscriber. */
  onLifecycleEvent(listener: (event: ConversationEvent) => void, onReconnected?: () => void): () => void
  /** Read both lists again now, whatever the clock says. */
  refresh(): void
  /**
   * The slow clock's tick, or a person coming back to the window: read its
   * rows if they are due. The clock asks only an environment the window is
   * connected to; coming back also asks one whose connection was let go or
   * refused, which may take this device again by now.
   */
  reread(trigger: 'clock' | 'focus'): void
  /** This window's client of the environment, held open while the source lives. */
  client(): Promise<StudioClient>
  /** The environment's latest welcome, once its client has opened. */
  welcome(): StudioWelcomeFrame | null
  /** Hear each time the client opens, a reconnect included. Returns the unsubscriber. */
  watchOpen(listener: () => void): () => void
  /**
   * Draw the environment's last-known rows from the window's cache, by its
   * id, until a read of its own answers. Once per source; an id already said
   * by its welcome wins.
   */
  loadCached(environmentId: string): void
  /** Stop following the environment and let its connection go. */
  close(): void
}

/** How long a burst of lifecycle events is folded into one read. */
const REFRESH_SETTLE_MS = 300
/** A change push arrives already folded; this folds the workspace and conversation pushes of one change into one read. */
const CHANGE_SETTLE_MS = 250
/** How often the slow clock looks for an environment due a read; it asks only those whose delay has passed. */
const REREAD_TICK_MS = 60_000
/** How long a read of the rows waits for an answer before it is one that did not come. */
const ROWS_ASK_TIMEOUT_MS = 15_000
/** How long the rows wait after a read before they are kept, so a burst of reads is one write. */
const CACHE_SAVE_MS = 1_000

/** The two reads behind an environment's rows: what it holds (a browse), and its chats (a conversation list). */
type RowsPart = 'browse' | 'conversations'
const EVERY_PART: ReadonlySet<RowsPart> = new Set(['browse', 'conversations'])

const NO_ROWS: EnvironmentRows = Object.freeze({ browse: null, loading: false, error: null, at: null })

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
    /** Whether anyone can see the window and is at it; the window's own unless a test says otherwise. */
    activity?: WindowActivity
    /** Where its last-known rows are kept; the window's own unless a test says otherwise. */
    cache?: EnvironmentChatsCache | null
  } = {},
): EnvironmentChatSource {
  const holdOf = options.hold ?? ((given: EnvironmentTarget) => holdEnvironmentStudio(given))
  const settleMs = options.settleMs ?? REFRESH_SETTLE_MS
  const activity = options.activity ?? windowActivity()
  const cache = options.cache === undefined ? windowEnvironmentChatsCache() : options.cache
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
    rows: NO_ROWS,
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
          ...snapshot,
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

  // ── Its rows ────────────────────────────────────────────────────────────

  const publishRows = (update: (rows: EnvironmentRows) => EnvironmentRows): void => {
    if (closed) return
    publish({ ...snapshot, rows: update(snapshot.rows) })
  }
  // Asked on the client the source holds, given up on after a while: a read
  // that never comes back must not hold every later read behind it.
  const ask: EnvironmentAsk = async (work) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        client().then(work),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new StudioError('unavailable', `${target.name} did not answer in time.`)),
            ROWS_ASK_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  let rowsOut = false
  let rowsWaiting = new Set<RowsPart>()
  let history: ReadHistory | undefined
  const readRows = (parts: ReadonlySet<RowsPart> = EVERY_PART): void => {
    if (closed) return
    if (rowsOut) {
      // A read is out, and may have left before whatever prompted this one:
      // what is asked now runs when it lands, once.
      for (const part of parts) rowsWaiting.add(part)
      return
    }
    const wantBrowse = parts.has('browse')
    const wantList = parts.has('conversations')
    if (!wantBrowse && !wantList) return
    rowsOut = true
    if (wantBrowse) publishRows((rows) => ({ ...rows, loading: true }))
    // The clock and its backoff are about the chats: a browse on its own (a
    // workspace push) leaves them alone.
    if (wantList) history = { askedAt: Date.now(), failures: history?.failures ?? 0 }
    // A read that hangs is an environment not answering, said once the grace
    // has passed; the read landing later replaces it either way.
    let landed = false
    const grace = wantList
      ? setTimeout(() => {
          if (landed) return
          publishRows((rows) =>
            rows.listFailure ? rows : { ...rows, listFailure: { kind: 'unavailable', message: 'Not answering.' } },
          )
        }, ANSWER_GRACE_MS)
      : undefined
    let failed = false
    void (async () => {
      const result = wantBrowse ? await browseEnvironmentThrough(target, ask) : null
      // Its chats too, once it has answered. A device that may not read them,
      // or a Studio that does not serve them, lists none.
      const listed =
        wantList && (result === null || result.reachable) ? await listEnvironmentChatsThrough(target, ask) : null
      // What this read says of the chats: listed (or a refusal that is the
      // answer, which lists none), or why the rows it had are kept.
      const failure: EnvironmentListFailure | null | undefined =
        result && !result.reachable
          ? {
              kind: result.unauthorized ? 'unauthorized' : 'unavailable',
              message: result.unreachableReason ?? 'Not answering.',
            }
          : !wantList
            ? undefined
            : listed === null
              ? { kind: 'unavailable', message: 'Not answering.' }
              : listed.ok
                ? null
                : listFailureOf(listed.code, listed.message)
      failed = failure !== null && failure !== undefined
      const answered = wantList && failure === null
      publishRows((rows) => {
        const next: EnvironmentRows = { ...rows, at: Date.now() }
        if (result) {
          // One that did not answer keeps its last rows; only an answer replaces them.
          if (result.reachable) next.browse = result
          next.loading = false
          next.error = result.reachable ? null : (result.unreachableReason ?? 'Not answering.')
          if (result.chatRecord) next.chatRecord = result.chatRecord
        }
        if (answered) {
          next.conversations = listed?.ok ? listed.conversations : []
          next.listedAt = Date.now()
        }
        if (listed?.ok) next.access = listed.access
        if (failure !== undefined) next.listFailure = failure
        return next
      })
      if (result?.reachable || answered) {
        readLive = true
        keep()
      }
    })()
      .catch((error: unknown) => {
        failed = true
        const message = error instanceof Error ? error.message : String(error)
        publishRows((rows) => ({
          ...rows,
          loading: false,
          error: message,
          at: Date.now(),
          listFailure: { kind: 'unavailable', message },
        }))
      })
      .finally(() => {
        landed = true
        if (grace !== undefined) clearTimeout(grace)
        if (history && wantList) history = { ...history, failures: failed ? history.failures + 1 : 0 }
        rowsOut = false
        const waiting = rowsWaiting
        rowsWaiting = new Set()
        // Its chats did not answer, and it has just answered a browse: they
        // are read now, rather than left saying it is not answering until the
        // clock comes round.
        if (!wantList && !failed && snapshot.rows.listFailure?.kind === 'unavailable') waiting.add('conversations')
        if (waiting.size > 0) readRows(waiting)
      })
  }

  // ── Its last-known rows ─────────────────────────────────────────────────

  // Whether a read of its own has answered: from then on the cache is only
  // written, never drawn from.
  let readLive = false
  let cachedId: string | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let saved: EnvironmentRows | null = null
  const save = (): void => {
    saveTimer = null
    const id = current?.welcome?.environment?.id ?? cachedId
    const rows = snapshot.rows
    if (!cache || !id || !isEnvironmentId(id) || rows === saved) return
    const kept = cachedRowsOf(rows)
    if (!kept) return
    saved = rows
    void cache.save(id, kept).catch(() => undefined)
  }
  const keep = (): void => {
    if (cache && saveTimer === null && !closed) saveTimer = setTimeout(save, CACHE_SAVE_MS)
  }
  const loadCached = (environmentId: string): void => {
    if (!cache || cachedId !== null || closed || !isEnvironmentId(environmentId)) return
    cachedId = environmentId
    void cache.load(environmentId).then(
      (kept) => {
        if (!kept || readLive || closed) return
        // Drawn where nothing has been read yet; a read that answers replaces it.
        publishRows((rows) => ({
          ...rows,
          browse: rows.browse ?? kept.browse,
          ...(rows.conversations || !kept.conversations ? {} : { conversations: kept.conversations }),
          ...(rows.access !== undefined || kept.access === undefined ? {} : { access: kept.access }),
          ...(rows.chatRecord || !kept.chatRecord ? {} : { chatRecord: kept.chatRecord }),
          ...(rows.listedAt !== undefined || kept.listedAt === undefined ? {} : { listedAt: kept.listedAt }),
        }))
      },
      () => undefined,
    )
  }

  // What its pushes and its reconnects said moved, waiting for the burst to
  // settle, or for the window to be seen again.
  const changed = new Set<RowsPart>()
  let changeTimer: ReturnType<typeof setTimeout> | null = null
  const flushChanges = (): void => {
    if (closed || changeTimer !== null || changed.size === 0 || !activity.get().visible) return
    changeTimer = setTimeout(() => {
      changeTimer = null
      if (closed || !activity.get().visible) return
      const parts = new Set(changed)
      changed.clear()
      readRows(parts)
    }, CHANGE_SETTLE_MS)
  }
  const noteChange = (...parts: RowsPart[]): void => {
    for (const part of parts) changed.add(part)
    flushChanges()
  }

  const reread = (trigger: 'clock' | 'focus'): void => {
    if (closed || rowsOut) return
    // Away is the connection's to notice: it reads again once it is back. A
    // connection let go or refused is asked again when a person comes back.
    const askable = state === 'open' || (trigger === 'focus' && hold === null)
    if (askable && readDue(history, trigger, Date.now())) readRows()
  }

  let following: (() => void) | null = null
  const follow = (): void => {
    if (following || closed) return
    const stopSessions = services.sessions.onLifecycleEvent(
      () => schedule(),
      () => read(),
    )
    const stopChanges =
      services.followPush?.({
        topic: 'conversations.changed',
        params: {},
        capability: STUDIO_CONVERSATIONS_CAPABILITY,
        onPayload: (change) => noteChange(change.what === 'workspaces' ? 'browse' : 'conversations'),
      }) ?? (() => undefined)
    // The first open is the first read's; each one after is the environment back, which may have missed a push.
    let opened = false
    const stopOpen = watchOpen(() => {
      if (opened) noteChange(...EVERY_PART)
      opened = true
    })
    const clock = setInterval(() => {
      if (activity.get().visible) reread('clock')
    }, REREAD_TICK_MS)
    let front = activity.get().visible && activity.get().focused
    const stopActivity = activity.subscribe((now) => {
      const atFront = now.visible && now.focused
      if (atFront && !front) reread('focus')
      front = atFront
      if (now.visible) flushChanges()
    })
    following = () => {
      stopSessions()
      stopChanges()
      stopOpen()
      clearInterval(clock)
      stopActivity()
    }
    read()
    readRows()
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
    refresh() {
      read()
      readRows()
    },
    reread,
    loadCached,
    client,
    welcome: () => current?.welcome ?? null,
    watchOpen,
    close() {
      if (closed) return
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (changeTimer !== null) clearTimeout(changeTimer)
      changeTimer = null
      // What was read is kept for the next start, not lost with the source.
      if (saveTimer !== null) {
        clearTimeout(saveTimer)
        save()
      }
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

/** Each route's environment id, as the window's environment list last said it. */
let directory: ReadonlyMap<string, string> = new Map()

/** A source followed from now draws its environment's last-known rows, when the list knows its id. */
function track(target: EnvironmentTarget, source: EnvironmentChatSource): void {
  const stop = source.subscribe(tellFollowed)
  followed.set(target.route, { target, source, stop })
  const id = directory.get(target.route)
  if (id) source.loadCached(id)
}

/**
 * The environments this desktop knows, as the window's list says them (every
 * route of each, by its id): each followed source draws its environment's
 * last-known rows, and the cache drops the rows of every environment no
 * longer listed. An empty list is one not read yet, and forgets nothing.
 */
export function knowEnvironments(
  entries: readonly { environmentId: string | null; routes: readonly string[] }[],
  cache: EnvironmentChatsCache | null = windowEnvironmentChatsCache(),
): void {
  if (entries.length === 0) return
  const next = new Map<string, string>()
  for (const entry of entries)
    if (entry.environmentId) for (const route of entry.routes) next.set(route, entry.environmentId)
  directory = next
  for (const [route, entry] of followed) {
    const id = next.get(route)
    if (id) entry.source.loadCached(id)
  }
  void cache?.keepOnly(new Set(next.values())).catch(() => undefined)
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
    track(target, make(target))
    changed = true
  }
  if (changed) tellFollowed()
}

/** The sources this window follows now. */
export function followedEnvironmentChats(): EnvironmentChatSource[] {
  return [...followed.values()].map((entry) => entry.source)
}

/** The environments this window follows now, each as it is asked: its route and its name. */
export function followedEnvironmentTargets(): EnvironmentTarget[] {
  return [...followed.values()].map((entry) => entry.target)
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
  track(target, source)
  tellFollowed()
  return source
}
