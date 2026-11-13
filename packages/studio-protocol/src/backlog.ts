import {
  studioNoParams,
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_BACKLOG_CAPABILITY, STUDIO_SHARES_CAPABILITY } from './handshake.js'

// The backlogs of the projects a Studio holds, as a client away from the
// desktop reads and triages them: the phone's Backlog. Each project's items
// with their status and triage, and its epics with their rollups, read from
// the backlog store in the project's folder.
//
// No local path leaves the Studio. A project is named by an opaque token
// (`workspaceId`, `backlog:<token>`), which an update names back; an item by
// its path inside the backlog folder.
//
// Reads on `backlog:read`, changes on `backlog:operate`, behind the `backlog`
// capability. `backlog.changed` says which projects' backlogs moved; a client
// asks `backlog.list` again for what it shows.

export type StudioBacklogItemStatus = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
export type StudioBacklogItemType = 'epic' | 'feature' | 'bug' | 'mockup' | 'spike'
export type StudioBacklogItemDifficulty = 'xs' | 's' | 'm' | 'l' | 'xl'
export type StudioBacklogItemCriticality = 'low' | 'normal' | 'high' | 'critical'

export const STUDIO_BACKLOG_ITEM_STATUSES: readonly StudioBacklogItemStatus[] = [
  'idea',
  'ready',
  'in_progress',
  'needs_input',
  'completed',
  'archived',
]
export const STUDIO_BACKLOG_ITEM_TYPES: readonly StudioBacklogItemType[] = ['epic', 'feature', 'bug', 'mockup', 'spike']
export const STUDIO_BACKLOG_ITEM_DIFFICULTIES: readonly StudioBacklogItemDifficulty[] = ['xs', 's', 'm', 'l', 'xl']
export const STUDIO_BACKLOG_ITEM_CRITICALITIES: readonly StudioBacklogItemCriticality[] = [
  'low',
  'normal',
  'high',
  'critical',
]

export interface StudioBacklogItem {
  itemId: string
  relativePath: string
  title: string
  excerpt?: string
  status: StudioBacklogItemStatus
  type?: StudioBacklogItemType
  difficulty?: StudioBacklogItemDifficulty
  criticality?: StudioBacklogItemCriticality
  /**
   * The up-pointing epic slug (frontmatter `epic:`) when this item belongs to
   * an epic; absent otherwise. The epic's children are a derived query.
   */
  epic?: string
  updatedAt?: string
}

/** One project's epic: what its chips and colour bands need, and its rollup. */
export interface StudioBacklogEpic {
  /** The epic slug (matches an item's `epic` up-slug). */
  slug: string
  /** The epic's display id, when the epic file carries an `id`. */
  displayId?: string
  title?: string
  /** One of the desktop seven-colour highlight set, when the epic sets `color`. */
  color?: string
  doneCount: number
  totalCount: number
}

/** One project's backlog. */
export interface StudioBacklogWorkspace {
  /** The project's token, `backlog:<token>`: what an update names it by. */
  workspaceId: string
  /** The same token without its prefix. */
  workspacePath: string
  /** The repository this backlog belongs to, as a token: one key for one repository. */
  projectKey?: string
  workspaceName: string
  updatedAt: string
  items: StudioBacklogItem[]
  epics?: StudioBacklogEpic[]
}

/** A change to one item's status or triage; at least one of them. */
export type StudioBacklogUpdate = {
  workspaceId: string
  relativePath: string
  status?: StudioBacklogItemStatus
  type?: StudioBacklogItemType
  difficulty?: StudioBacklogItemDifficulty
  criticality?: StudioBacklogItemCriticality
}

export type StudioBacklogMethodMap = {
  /** Every project's backlog this Studio holds, by name. */
  'backlog.list': { params: Record<string, never>; result: { workspaces: StudioBacklogWorkspace[] } }
  /**
   * Change one item, once per command id. Refused `not_found` for a project
   * or an item this Studio does not hold.
   */
  'backlog.update': {
    params: StudioBacklogUpdate & { commandId: string }
    result: { item: StudioBacklogItem | null }
    errors: 'not_found'
  }
}

export type StudioBacklogMethod = keyof StudioBacklogMethodMap

/** Which projects' backlogs moved: a client asks `backlog.list` again for what it shows. */
export type StudioBacklogChanged = { workspaceIds: string[] }

export type StudioBacklogTopicMap = {
  'backlog.changed': { params: Record<string, never>; payload: StudioBacklogChanged; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const refuse = (message: string): StudioParamsRefusal => studioParamsRefused(message)

function id(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function oneOf<T extends string>(known: readonly T[], value: unknown): T | undefined {
  return known.find((entry) => entry === value)
}

/** An update, or why not. */
export function parseStudioBacklogUpdate(
  value: Record<string, unknown>,
): StudioParsed<StudioBacklogUpdate & { commandId: string }> {
  if (!id(value.commandId)) return refuse('"commandId" names this command: a string of 1 to 200 characters.')
  if (!id(value.workspaceId)) return refuse('"workspaceId" names the project, from backlog.list.')
  if (!id(value.relativePath, 1000)) return refuse('"relativePath" names the item, from backlog.list.')
  const status = oneOf(STUDIO_BACKLOG_ITEM_STATUSES, value.status)
  const type = oneOf(STUDIO_BACKLOG_ITEM_TYPES, value.type)
  const difficulty = oneOf(STUDIO_BACKLOG_ITEM_DIFFICULTIES, value.difficulty)
  const criticality = oneOf(STUDIO_BACKLOG_ITEM_CRITICALITIES, value.criticality)
  if (value.status !== undefined && !status)
    return refuse(`"status" is one of ${STUDIO_BACKLOG_ITEM_STATUSES.join(', ')}.`)
  if (value.type !== undefined && !type) return refuse(`"type" is one of ${STUDIO_BACKLOG_ITEM_TYPES.join(', ')}.`)
  if (value.difficulty !== undefined && !difficulty)
    return refuse(`"difficulty" is one of ${STUDIO_BACKLOG_ITEM_DIFFICULTIES.join(', ')}.`)
  if (value.criticality !== undefined && !criticality)
    return refuse(`"criticality" is one of ${STUDIO_BACKLOG_ITEM_CRITICALITIES.join(', ')}.`)
  if (!status && !type && !difficulty && !criticality)
    return refuse('An update changes at least one of "status", "type", "difficulty" or "criticality".')
  return studioParams({
    commandId: value.commandId,
    workspaceId: value.workspaceId,
    relativePath: value.relativePath,
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(criticality ? { criticality } : {}),
  })
}

export const STUDIO_BACKLOG_METHODS: StudioMethodTable<StudioBacklogMethodMap> = {
  'backlog.list': {
    scope: 'backlog:read',
    mutation: false,
    capability: STUDIO_BACKLOG_CAPABILITY,
    params: studioNoParams,
  },
  'backlog.update': {
    scope: 'backlog:operate',
    mutation: true,
    capability: STUDIO_BACKLOG_CAPABILITY,
    params: parseStudioBacklogUpdate,
  },
}

export const STUDIO_BACKLOG_TOPICS: StudioTopicTable<StudioBacklogTopicMap> = {
  'backlog.changed': {
    scope: 'backlog:read',
    capability: STUDIO_BACKLOG_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}

// ── Shares ──────────────────────────────────────────────────────────────────
//
// The web pages on a Studio's machine that another device can open: a dev
// server published on the tailnet (`tailscale serve`), a real HTTPS origin
// any device there reaches. A browser tab's `localhost` is not one: on a
// phone, localhost is the phone. A read, on `workspaces:read`, behind the
// `shares` capability.

export interface StudioShare {
  /** Stable while the share stands: the HTTPS port publishing it. */
  id: string
  /** What a person recognises: the local port and the process serving it. */
  label: string
  /** The published HTTPS origin, opened as it is, never rewritten. */
  url: string
  /** The loopback port on the Studio's machine. */
  localPort: number
  /** The machine publishing it, by its tailnet name. */
  machine: string
}

export type StudioSharesMethodMap = {
  'shares.list': { params: Record<string, never>; result: { shares: StudioShare[] } }
}

export const STUDIO_SHARES_METHODS: StudioMethodTable<StudioSharesMethodMap> = {
  'shares.list': {
    scope: 'workspaces:read',
    mutation: false,
    capability: STUDIO_SHARES_CAPABILITY,
    params: studioNoParams,
  },
}
