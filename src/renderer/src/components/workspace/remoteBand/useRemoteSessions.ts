import { useCallback, useEffect, useRef, useState } from 'react'

import { STUDIO_CONVERSATIONS_CAPABILITY } from '../../../../../../packages/studio-protocol/src/public'
import { useWindowPageVisible, windowActivity } from '../../../utils/windowActivity'
import { useTailnetPresence, type TailnetPresence } from '../topbar/useTailnetPresence'
import { publishRemoteConversationList } from './remoteConversationFacts'
import { browseEnvironment, tailnetScopesOfGrant } from '../../../studio/environmentDiscovery'
import type { MeshBrowse } from '../../../../../shared/tailnet-mesh'
import { listEnvironmentChats } from '../../../studio/environmentChatRecords'
import { environmentStudioAvailable, pairedTarget } from '../../../studio/environmentStudio'
import { environmentChatSourceFor, onFollowedEnvironmentChats } from '../../../studio/environmentChats'
import { environmentConversationTransport } from '../../panels/agentChat/environmentChat'
import {
  chatManageOf,
  remoteLinkStateOf,
  shouldBrowse,
  type RemoteBrowseEntry,
  type RemoteLinkState,
} from './remoteSessionsModel'
import {
  listFailureOf,
  remoteReadDue,
  REMOTE_ANSWER_GRACE_MS,
  type RemoteListFailure,
  type RemoteReadHistory,
} from './remoteListFreshness'

// The reads behind the sidebar's Remote band (remote-sessions-in-the-sidebar,
// epic decision 2): an expanded band IS the ask, and the asking is bounded —
// only machines main's last check says are awake, on the transitions that
// change what they hold, and when a machine SAYS it changed. A machine that
// is asleep is never dialled: its last rows stay on screen dimmed, and the
// next reachability event that says it answered is what reads it again.
//
// Every read is this window's own, over its one client of that machine's
// Studio (`environmentStudio.ts`), which the window follows each paired
// desktop's chats on (`environmentChats.ts`): `workspaces.list` for what it
// holds, `conversation.list` for its chats. That machine says when either
// list moved (`conversations.changed`), and the band re-reads on that, and
// once more whenever the window reaches it again: the server owns the
// state, the client subscribes.
//
// A push re-reads only what it names: a conversation push re-lists the
// machine's chats, a workspace push re-browses it. A window
// nobody can see does not re-read at all; it remembers what changed and
// reads once when it is shown again.
//
// Pushes alone left a list silently old: a notice can be lost, and a machine
// that stops taking this pairing sends nothing at all. So a window someone
// can see also re-reads each machine on a slow clock, further apart while it
// keeps failing, and when the window comes back to the front
// (`remoteListFreshness.ts` has the intervals). A machine that refused this
// pairing is asked again then too, rather than never: a pairing made again
// over there is otherwise only noticed by main's next check. A read that
// fails, or goes unanswered, keeps the rows it had and says why
// (`listFailure`), which the rows draw as a last-known list.

/** A machine's change pushes arrive already folded; a short settle folds the workspace and conversation pushes of one event into one read. */
const REMOTE_CHANGE_SETTLE_MS = 250
/** How often the slow clock looks for a machine due a read; it asks only those whose delay has passed. */
const REMOTE_REREAD_TICK_MS = 60_000

export type RemoteSessions = {
  presence: TailnetPresence
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  /**
   * Whether this device is on the tailnet at all — up, down, or not yet known.
   * What the rows that are WINDOWS here are gated on: a chat on another machine
   * is not openable, typable, or readable from a device with no tailnet, so its
   * row goes with the link and comes back with it (owner, 2026-09-13).
   */
  link: RemoteLinkState
  /** Read one machine now, or every machine that may be asked. */
  refresh: (connectionId?: string) => void
}

const EMPTY_ENTRY: RemoteBrowseEntry = { browse: null, loading: false, error: null, at: null }

/** The two reads behind a machine's rows: what it holds (a browse), and its chats (a conversation list). */
type ReadPart = 'browse' | 'conversations'
const EVERY_PART: ReadonlySet<ReadPart> = new Set(['browse', 'conversations'])

function withEntry(
  current: ReadonlyMap<string, RemoteBrowseEntry>,
  connectionId: string,
  update: (entry: RemoteBrowseEntry) => RemoteBrowseEntry,
): ReadonlyMap<string, RemoteBrowseEntry> {
  const next = new Map(current)
  next.set(connectionId, update(current.get(connectionId) ?? EMPTY_ENTRY))
  return next
}

export function useRemoteSessions({ enabled: wanted }: { enabled: boolean }): RemoteSessions {
  const presence = useTailnetPresence()
  // Off the tailnet nothing over there can answer, so nothing is asked
  // (owner ruling 2026-09-05): the band draws only what is open here until
  // the link is back, and the first read after that is the mount read. On
  // the tailnet is what counts, not this device's own listener: the reads
  // are outgoing, and a person may drive paired machines with Remote turned
  // off here (`RemoteLinkState`).
  const link = remoteLinkStateOf(presence.status)
  const enabled = wanted && link === 'up'
  const [browses, setBrowses] = useState<ReadonlyMap<string, RemoteBrowseEntry>>(() => new Map())
  const browsesRef = useRef(browses)
  browsesRef.current = browses
  // The paired machines as the presence lists them, for what a read asks by.
  const machinesRef = useRef(presence.mesh)
  machinesRef.current = presence.mesh
  /** Machines being read right now, and what was asked for while each read was out. */
  const inFlight = useRef(new Map<string, ReadonlySet<ReadPart>>())
  const queued = useRef(new Map<string, Set<ReadPart>>())
  /** When each machine was last asked for its chats, and how many reads of them in a row failed. */
  const history = useRef(new Map<string, RemoteReadHistory>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // A host without the mesh bridge (partial test harnesses, narrower
  // preloads) gets a band that draws what the rows already know and asks
  // nothing — never a throw inside an effect.
  const bridge = environmentStudioAvailable()
  const visible = useWindowPageVisible()

  const read = useCallback(
    (connectionId: string, parts: ReadonlySet<ReadPart> = EVERY_PART) => {
      if (!bridge) return
      if (inFlight.current.has(connectionId)) {
        // A read is out, and may have left before whatever prompted this one:
        // what is asked now runs when it lands, once.
        const waiting = queued.current.get(connectionId) ?? new Set<ReadPart>()
        for (const part of parts) waiting.add(part)
        queued.current.set(connectionId, waiting)
        return
      }
      const wantBrowse = parts.has('browse')
      const wantList = parts.has('conversations')
      if (!wantBrowse && !wantList) return
      inFlight.current.set(connectionId, parts)
      if (wantBrowse)
        setBrowses((current) => withEntry(current, connectionId, (entry) => ({ ...entry, loading: true })))
      // A read that hangs is a machine not answering, said once the grace has
      // passed; the read landing later replaces it either way.
      // The clock and its backoff are about the chats: a browse on its own
      // (a workspace push) leaves them alone.
      if (wantList) {
        const previous = history.current.get(connectionId)
        history.current.set(connectionId, { askedAt: Date.now(), failures: previous?.failures ?? 0 })
      }
      let landed = false
      const graceTimer = !wantList
        ? undefined
        : window.setTimeout(() => {
            if (landed || !mounted.current) return
            setBrowses((current) =>
              withEntry(current, connectionId, (entry) =>
                entry.listFailure
                  ? entry
                  : { ...entry, listFailure: { kind: 'unavailable', message: 'Not answering.' } },
              ),
            )
          }, REMOTE_ANSWER_GRACE_MS)
      // Whether this read left the chats current, for the clock's backoff.
      let failed = false
      void (async () => {
        // What it holds, and what of its chats' records it keeps for this
        // one, asked of its Studio by this window itself.
        const machine = machinesRef.current.find((connection) => connection.id === connectionId)
        const result = wantBrowse
          ? await browseEnvironment(pairedTarget(machine ?? { id: connectionId, machineName: 'That machine' })).then(
              (browse): MeshBrowse => ({
                ...browse,
                connectionId,
                scopes: browse.reachable ? tailnetScopesOfGrant(browse.grantScopes) : (machine?.scopes ?? []),
              }),
            )
          : null
        // Its chats too, once it has answered. A pairing that may not read
        // them, or a machine that does not serve them, lists none.
        const listed =
          wantList && (result === null || result.reachable)
            ? await listEnvironmentChats(
                pairedTarget(machine ?? { id: connectionId, machineName: 'That machine' }),
              ).catch(() => null)
            : null
        // The tab of a pane open on one of these chats draws from the same list.
        if (listed?.ok) publishRemoteConversationList(connectionId, listed.conversations)
        // What this read says of the chats: listed (or a refusal that is the
        // answer, which lists none), or why the rows it had are kept.
        const failure: RemoteListFailure | null | undefined =
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
        setBrowses((current) =>
          withEntry(current, connectionId, (entry) => {
            // A read that could not list them keeps the rows it has, said to
            // be a last-known list: the machine may simply be asleep, or no
            // longer take this pairing. A refusal that is the answer (a
            // pairing that may not read them, a machine that does not serve
            // them) lists none.
            const conversations = answered ? (listed?.ok ? listed.conversations : []) : entry.conversations
            // What this pairing may do with its chats, as its newest list said.
            const access = listed?.ok ? listed.access : entry.access
            // What of its chats' records the machine keeps for this one, as
            // its Studio's welcome said on the newest browse that reached it.
            const record = result?.chatRecord
            const lifecycle = record ? record.lifecycle : entry.lifecycle
            const manage = record ? chatManageOf(record) : entry.manage
            const listedParts = {
              ...(conversations ? { conversations } : {}),
              ...(lifecycle !== undefined ? { lifecycle } : {}),
              ...(access !== undefined ? { access } : {}),
              ...(manage !== undefined ? { manage } : {}),
              // Kept across a read that did not list them, as the rows are.
              ...(answered
                ? { listedAt: Date.now() }
                : entry.listedAt !== undefined
                  ? { listedAt: entry.listedAt }
                  : {}),
              ...(failure !== undefined
                ? { listFailure: failure }
                : entry.listFailure !== undefined
                  ? { listFailure: entry.listFailure }
                  : {}),
            }
            if (!result) return { ...entry, at: Date.now(), ...listedParts }
            return {
              // A machine that did not answer keeps its last rows; only an
              // answer replaces them.
              browse: result.reachable ? result : entry.browse,
              loading: false,
              error: result.reachable ? null : (result.unreachableReason ?? 'Not answering.'),
              at: Date.now(),
              ...listedParts,
            }
          }),
        )
      })()
        .catch((error: unknown) => {
          failed = true
          setBrowses((current) =>
            withEntry(current, connectionId, (entry) => ({
              ...entry,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
              at: Date.now(),
              listFailure: { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) },
            })),
          )
        })
        .finally(() => {
          landed = true
          if (graceTimer !== undefined) window.clearTimeout(graceTimer)
          const asked = history.current.get(connectionId)
          if (asked && wantList)
            history.current.set(connectionId, { ...asked, failures: failed ? asked.failures + 1 : 0 })
          inFlight.current.delete(connectionId)
          let waiting = queued.current.get(connectionId)
          queued.current.delete(connectionId)
          // A machine whose chats did not answer has just answered a browse:
          // its chats are read now, rather than left saying it is not
          // answering until the clock comes round.
          if (!wantList && !failed && browsesRef.current.get(connectionId)?.listFailure?.kind === 'unavailable') {
            waiting = new Set<ReadPart>(waiting ?? [])
            waiting.add('conversations')
          }
          if (waiting) read(connectionId, waiting)
        })
    },
    [bridge],
  )
  const browse = useCallback((connectionId: string) => read(connectionId), [read])

  const { mesh, meshReachability } = presence

  // The change feed: what each machine says moved (`conversations.changed`),
  // and each time the window reaches it again (`watchOpen`), on the window's
  // followed client of it. A machine that said it changed is re-read once its
  // pushes settle, for what it said changed; while the window is out of sight
  // the reads wait here and run once it is back.
  const pendingChanges = useRef(new Map<string, Set<ReadPart>>())
  const [changeTick, setChangeTick] = useState(0)
  const noteChange = useCallback((connectionId: string, part: ReadPart) => {
    const parts = pendingChanges.current.get(connectionId) ?? new Set<ReadPart>()
    parts.add(part)
    pendingChanges.current.set(connectionId, parts)
    setChangeTick((tick) => tick + 1)
  }, [])
  useEffect(() => {
    if (!enabled || !bridge) return
    const following = new Map<string, { source: object; stop: () => void }>()
    const sync = () => {
      const wanted = new Set<string>()
      for (const connection of mesh) {
        const source = environmentChatSourceFor(pairedTarget(connection))
        wanted.add(connection.id)
        if (following.get(connection.id)?.source === source) continue
        following.get(connection.id)?.stop()
        const services = environmentConversationTransport(pairedTarget(connection)).services
        const stopPush =
          services.followPush?.({
            topic: 'conversations.changed',
            params: {},
            capability: STUDIO_CONVERSATIONS_CAPABILITY,
            onPayload: (change) => noteChange(connection.id, change.what === 'workspaces' ? 'browse' : 'conversations'),
          }) ?? (() => undefined)
        let opened = false
        const stopOpen = source.watchOpen(() => {
          // The first open is the mount read's; each one after is the machine back.
          if (opened) for (const part of EVERY_PART) noteChange(connection.id, part)
          opened = true
        })
        following.set(connection.id, {
          source,
          stop: () => {
            stopPush()
            stopOpen()
          },
        })
      }
      for (const [id, entry] of following)
        if (!wanted.has(id)) {
          entry.stop()
          following.delete(id)
        }
    }
    sync()
    const stopFollowed = onFollowedEnvironmentChats(sync)
    return () => {
      stopFollowed()
      for (const entry of following.values()) entry.stop()
      following.clear()
    }
  }, [enabled, bridge, mesh, noteChange])
  useEffect(() => {
    if (!enabled || !visible || pendingChanges.current.size === 0) return
    const timer = window.setTimeout(() => {
      const due = [...pendingChanges.current]
      pendingChanges.current.clear()
      for (const [id, parts] of due)
        if (mesh.some((connection) => connection.id === id) && shouldBrowse(meshReachability.get(id))) read(id, parts)
    }, REMOTE_CHANGE_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, visible, mesh, meshReachability, read, changeTick])

  // The pairing list: a machine not yet read gets its first read; a machine
  // forgotten drops its entry so its rows go with it.
  useEffect(() => {
    const paired = new Set(mesh.map((connection) => connection.id))
    setBrowses((current) => {
      let next: Map<string, RemoteBrowseEntry> | null = null
      for (const id of current.keys()) {
        if (paired.has(id)) continue
        next ??= new Map(current)
        next.delete(id)
      }
      return next ?? current
    })
    if (!enabled) return
    for (const connection of mesh) {
      if (browsesRef.current.has(connection.id) || inFlight.current.has(connection.id)) continue
      if (!shouldBrowse(meshReachability.get(connection.id))) continue
      browse(connection.id)
    }
  }, [enabled, mesh, meshReachability, browse])

  // Reachability transitions: a machine that answers again after being quiet
  // is read again. The first read at mount is the effect above's; this one
  // only fires on a genuine off → on edge.
  const wasAwake = useRef(new Map<string, boolean>())
  useEffect(() => {
    for (const [id, reach] of meshReachability) {
      const awake = shouldBrowse(reach) && reach.checkedAt !== null
      const was = wasAwake.current.has(id)
        ? wasAwake.current.get(id)!
        : browsesRef.current.has(id) || inFlight.current.has(id)
      wasAwake.current.set(id, awake)
      if (enabled && awake && !was && mesh.some((connection) => connection.id === id)) browse(id)
    }
    for (const id of [...wasAwake.current.keys()]) {
      if (!meshReachability.has(id)) wasAwake.current.delete(id)
    }
  }, [enabled, mesh, meshReachability, browse])

  // The slow clock, and the window coming back to the front: what catches a
  // lost notice or a pairing dropped over there. Each machine is asked at
  // most once at a time (`read` folds an ask into the one in flight), on the
  // clock only once its delay has passed, which doubles with each failure in
  // a row, and on coming back only once the focus gap has.
  const meshRef = useRef(mesh)
  meshRef.current = mesh
  const reachRef = useRef(meshReachability)
  reachRef.current = meshReachability
  const rereadDue = useCallback(
    (trigger: 'clock' | 'focus') => {
      const now = Date.now()
      for (const connection of meshRef.current) {
        const reach = reachRef.current.get(connection.id)
        // Asleep is main's to notice (epic decision 2); a machine that refused
        // this pairing is asked again when a person comes back to the window.
        const askable = shouldBrowse(reach) || (trigger === 'focus' && reach?.unauthorized === true)
        if (!askable || inFlight.current.has(connection.id)) continue
        if (remoteReadDue(history.current.get(connection.id), trigger, now)) read(connection.id)
      }
    },
    [read],
  )
  useEffect(() => {
    if (!enabled || !bridge || !visible) return
    const timer = window.setInterval(() => rereadDue('clock'), REMOTE_REREAD_TICK_MS)
    return () => window.clearInterval(timer)
  }, [enabled, bridge, visible, rereadDue])
  useEffect(() => {
    if (!enabled || !bridge) return
    const activity = windowActivity()
    let front = activity.get().visible && activity.get().focused
    return activity.subscribe((state) => {
      const atFront = state.visible && state.focused
      if (atFront && !front) rereadDue('focus')
      front = atFront
    })
  }, [enabled, bridge, rereadDue])

  const refresh = useCallback(
    (connectionId?: string) => {
      for (const connection of mesh) {
        if (connectionId && connection.id !== connectionId) continue
        if (connectionId || shouldBrowse(meshReachability.get(connection.id))) browse(connection.id)
      }
    },
    [mesh, meshReachability, browse],
  )

  return { presence, browses, link, refresh }
}
