import { STUDIO_CHAT_ROWS_CAPABILITY } from '../../../../packages/studio-protocol/src/public'
import type { Workspace } from '../../../shared/workspace'
import {
  followedEnvironmentChats,
  followedEnvironmentTargets,
  followEnvironmentChats,
  WINDOW_STUDIO_TARGET,
} from './environmentChats'
import {
  fakePairedStudios,
  pairedStudiosOf,
  PAIRED_STUDIO_CAPABILITIES,
  type PairedStudiosDouble,
} from './environmentStudio.double'
import { WINDOW_STUDIO_ROUTE } from './environmentStudio'

// A stand-in for the window's own Studio as its chat source reads it
// (`environmentChats.ts`, the `local` route), for tests of what draws this
// computer's chats (the sidebar). It lists the records it is given as its
// chats, with their row facts, and takes their changes (Settle, Snooze, Star,
// rename, Auto-settle) as the Studio would: the next list says them.
//
//   const windowStudio = serveWindowChats(window.api, props.workspaces)
//   root.render(React.createElement(WorkspaceSidebar, props))
//
// Serving again (new records, as a test moves on) reads them again. It joins
// a paired double installed on the same bridge (`fakePairedStudios`), or
// installs one with no paired machine, and follows the window's own Studio
// beside whatever the window follows already.

type Facts = Partial<Pick<Workspace, 'name' | 'highlight' | 'snoozedUntil' | 'settledAt' | 'autoSettleEnabled'>>

export type WindowChatsDouble = {
  /** List these records as the window's own Studio's chats from now, and read them again. */
  serve(records: readonly Workspace[]): void
  /** Every change asked of it, without its command id. */
  writes(): Array<{ method: string; params: Record<string, unknown> }>
  /** The paired double it is served by. */
  studio: PairedStudiosDouble
}

const doubles = new WeakMap<object, WindowChatsDouble>()

/** List `records` as the window's own Studio's chats (installing the stand-in on `api` the first time). */
export function serveWindowChats(api: object, records: readonly Workspace[]): WindowChatsDouble {
  let double = doubles.get(api)
  if (!double || pairedStudiosOf(api) !== double.studio) {
    double = install(api)
    doubles.set(api, double)
  }
  double.serve(records)
  return double
}

function install(api: object): WindowChatsDouble {
  const studio = pairedStudiosOf(api) ?? fakePairedStudios(api)
  let served: readonly Workspace[] = []
  const written = new Map<string, Facts>()
  const write = (params: Record<string, unknown>, facts: Facts) => {
    const id = String(params.workspaceId)
    written.set(id, { ...written.get(id), ...facts })
  }
  const wire = (record: Workspace) => {
    const chat = { ...record, ...written.get(record.id) }
    return {
      id: chat.id,
      name: chat.name,
      mode: chat.mode ?? 'standard',
      folderPath: chat.folderPath ?? null,
      repository: null,
      settledAt: typeof chat.settledAt === 'number' ? chat.settledAt : null,
      ...(chat.highlight ? { highlight: chat.highlight } : {}),
      ...(chat.autoSettleEnabled === true ? { autoSettle: true } : {}),
      ...(typeof chat.snoozedUntil === 'number' ? { snoozedUntil: chat.snoozedUntil } : {}),
      ...(typeof chat.lastUserMessageAt === 'number' ? { lastUserMessageAt: chat.lastUserMessageAt } : {}),
      ...(typeof chat.lastTurnEndedAt === 'number' ? { lastTurnEndedAt: chat.lastTurnEndedAt } : {}),
      ...(typeof chat.lastVisitedAt === 'number' ? { lastVisitedAt: chat.lastVisitedAt } : {}),
      ...(chat.scheduledAgentId ? { scheduledAgentId: chat.scheduledAgentId } : {}),
    }
  }
  studio.served.set(WINDOW_STUDIO_ROUTE, {
    capabilities: new Set([...PAIRED_STUDIO_CAPABILITIES, STUDIO_CHAT_ROWS_CAPABILITY]),
    answers: {
      'workspaces.list': () => ({ workspaces: served.map(wire) }),
      'conversation.list': () => ({ conversations: [] }),
      'session.list': () => ({ ok: true, sessions: [] }),
      'conversation.settle': (params) => {
        const settledAt = params.settled === false ? null : Date.now()
        write(params, { settledAt })
        return { settledAt }
      },
      'conversation.snooze': (params) => {
        write(params, { snoozedUntil: typeof params.until === 'number' ? params.until : null })
        return {}
      },
      'conversation.highlight': (params) => {
        const starred = params.starred === true
        const color = (params.color ?? null) as NonNullable<Workspace['highlight']>['color']
        write(params, { highlight: starred || color ? { starred, color } : undefined })
        return {}
      },
      'conversation.rename': (params) => {
        write(params, { name: String(params.name) })
        return {}
      },
      'conversation.setAutoSettle': (params) => {
        write(params, { autoSettleEnabled: params.enabled === true ? true : null })
        return {}
      },
      'conversation.markUnread': () => ({}),
      'conversation.visit': () => ({ lastVisitedAt: Date.now() }),
    },
  })
  return {
    studio,
    serve(records) {
      served = records
      written.clear()
      if (!followedEnvironmentTargets().some((target) => target.route === WINDOW_STUDIO_ROUTE))
        followEnvironmentChats([WINDOW_STUDIO_TARGET, ...followedEnvironmentTargets()])
      else
        followedEnvironmentChats()
          .find((source) => source.route === WINDOW_STUDIO_ROUTE)
          ?.refresh()
    },
    writes: () =>
      studio
        .writes()
        .flatMap(({ connectionId, method, params }) =>
          connectionId === WINDOW_STUDIO_ROUTE ? [{ method, params }] : [],
        ),
  }
}
