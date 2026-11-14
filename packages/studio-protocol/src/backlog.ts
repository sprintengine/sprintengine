import {
  studioNoParams,
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import type {
  BacklogCreateEpicResult,
  BacklogCriticalityPayload,
  BacklogDifficultyPayload,
  BacklogEnsureIdsItemInput,
  BacklogEnsureIdsResult,
  BacklogHighlightColorPayload,
  BacklogItemLinkPayload,
  BacklogItemRecordInput,
  BacklogItemStatusPayload,
  BacklogLocationResult,
  BacklogMutationResult,
  BacklogReadResult,
  BacklogRiskPayload,
} from './backlog-types.js'
import { STUDIO_BACKLOG_CAPABILITY, STUDIO_SHARES_CAPABILITY } from './handshake.js'
import { isStudioPath } from './key.js'

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

export type StudioBacklogMethod = keyof StudioBacklogMethodMap | keyof StudioBacklogFolderMethodMap

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

// ── A project's backlog by its folder ───────────────────────────────────────
//
// The desktop's own Backlog panel, its item sheet, the agent hand-off and the
// extensions' backlog calls: a project named by its folder on the Studio's
// machine (`workspaceRoot`), where its backlog lives (its location, which the
// panel may point elsewhere), the object store beside the item files, and
// each change to one item. Owner-only: they name a folder on that machine and
// write its files. A paired device reads and triages backlogs by token,
// above. An `ssh://` folder is refused in words.

/** Why only an owner reads or writes a backlog by its folder. */
export const STUDIO_BACKLOG_FOLDER_OWNER =
  'It names a project by its folder on this machine and writes the backlog files there; another device reads and triages backlogs by token (backlog.list, backlog.update).'

/** One change to one item, by what it changes. */
export type StudioBacklogEdit =
  | { kind: 'status'; status: BacklogItemStatusPayload }
  | {
      kind: 'triage'
      difficulty?: BacklogDifficultyPayload | null
      criticality?: BacklogCriticalityPayload | null
      risk?: BacklogRiskPayload | null
    }
  | { kind: 'highlight'; starred: boolean; color: BacklogHighlightColorPayload | null }
  | { kind: 'addLink'; link: BacklogItemLinkPayload; status?: BacklogItemStatusPayload }
  | { kind: 'removeLink'; linkId: string }
  | { kind: 'moduleMetadata'; moduleId: string; value: unknown }
  | { kind: 'moveSource'; nextRelativePath: string }
  | { kind: 'removeRecord' }
  | { kind: 'epic'; epic: string | null }
  | { kind: 'epicColor'; color: BacklogHighlightColorPayload | null }
  | { kind: 'dependencies'; dependsOn: string[] | null }
  | { kind: 'mockups'; mockups: string[] | null }

type Folder = { workspaceRoot: string }
type Commanded<T> = T & { commandId: string }

export type StudioBacklogFolderMethodMap = {
  /** Where the project's backlog items live, and whether that folder is there. */
  'backlog.location': { params: Folder; result: BacklogLocationResult }
  /** Point the project's backlog at another folder, or (`root: null`) back at `<project>/backlog`. */
  'backlog.setRoot': { params: Commanded<Folder & { root: string | null }>; result: BacklogLocationResult }
  /** Give every scanned item its record in the object store, kept as it is where it has one. */
  'backlog.ensureRecords': {
    params: Commanded<Folder & { items: BacklogItemRecordInput[] }>
    result: BacklogReadResult
  }
  /** Write the next ids into the items that have none. */
  'backlog.ensureIds': {
    params: Commanded<Folder & { items: BacklogEnsureIdsItemInput[] }>
    result: BacklogEnsureIdsResult
  }
  /** Change one item, named by its path inside the backlog folder. */
  'backlog.edit': {
    params: Commanded<Folder & { relativePath: string; edit: StudioBacklogEdit }>
    result: BacklogMutationResult
  }
  /** Make an epic of this title. */
  'backlog.createEpic': { params: Commanded<Folder & { title: string }>; result: BacklogCreateEpicResult }
}

const MAX_ITEMS = 20_000
const MAX_SLUGS = 1_000
const STATUSES: readonly BacklogItemStatusPayload[] = STUDIO_BACKLOG_ITEM_STATUSES
const RISKS: readonly BacklogRiskPayload[] = ['low', 'normal', 'high']
const COLORS: readonly BacklogHighlightColorPayload[] = ['red', 'orange', 'amber', 'green', 'blue', 'purple', 'pink']
const LINK_TYPES: readonly BacklogItemLinkPayload['type'][] = [
  'execution',
  'issue',
  'review',
  'artifact',
  'external',
  'agent',
]
const LINK_STATUSES: readonly NonNullable<BacklogItemLinkPayload['status']>[] = [
  'pending',
  'active',
  'completed',
  'canceled',
  'failed',
  'unknown',
]

type Fields = Record<string, unknown>
const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

/** A member that may be one of `known`, null, or absent: what it is, or `false` for none of those. */
function nullableOneOf<T extends string>(known: readonly T[], value: unknown): T | null | undefined | false {
  if (value === undefined || value === null) return value
  return oneOf(known, value) ?? false
}

function slugs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_SLUGS && value.every((slug) => id(slug, 1000))
}

function link(value: unknown): BacklogItemLinkPayload | null {
  if (!isRecord(value) || !isRecord(value.target)) return null
  const { target } = value
  const type = oneOf(LINK_TYPES, value.type)
  const status = value.status === undefined ? undefined : oneOf(LINK_STATUSES, value.status)
  if (
    !id(value.id) ||
    !id(value.moduleId) ||
    !type ||
    !text(value.label, 2000) ||
    (status === undefined && value.status !== undefined)
  )
    return null
  if (!id(target.kind) || !id(target.id, 4000)) return null
  if (target.path !== undefined && !text(target.path, 4096)) return null
  if (target.url !== undefined && !text(target.url, 8192)) return null
  if (value.updatedAt !== undefined && !text(value.updatedAt, 100)) return null
  return {
    id: value.id,
    moduleId: value.moduleId,
    type,
    label: value.label,
    target: {
      kind: target.kind,
      id: target.id,
      ...(typeof target.path === 'string' ? { path: target.path } : {}),
      ...(typeof target.url === 'string' ? { url: target.url } : {}),
    },
    ...(status ? { status } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

const EDIT_WORDS =
  '"edit" is one change: its "kind" is status, triage, highlight, addLink, removeLink, moduleMetadata, moveSource, removeRecord, epic, epicColor, dependencies or mockups, with that change\'s members.'

/** One item's change, or why not. */
export function parseStudioBacklogEdit(value: unknown): StudioParsed<StudioBacklogEdit> {
  if (!isRecord(value)) return refuse(EDIT_WORDS)
  switch (value.kind) {
    case 'status': {
      const status = oneOf(STATUSES, value.status)
      return status ? studioParams({ kind: 'status', status }) : refuse(`"status" is one of ${STATUSES.join(', ')}.`)
    }
    case 'triage': {
      const difficulty = nullableOneOf(STUDIO_BACKLOG_ITEM_DIFFICULTIES, value.difficulty)
      const criticality = nullableOneOf(STUDIO_BACKLOG_ITEM_CRITICALITIES, value.criticality)
      const risk = nullableOneOf(RISKS, value.risk)
      if (difficulty === false || criticality === false || risk === false)
        return refuse('"difficulty", "criticality" and "risk" are each one of their values, or null to clear it.')
      return studioParams({
        kind: 'triage',
        ...(difficulty !== undefined ? { difficulty } : {}),
        ...(criticality !== undefined ? { criticality } : {}),
        ...(risk !== undefined ? { risk } : {}),
      })
    }
    case 'highlight': {
      const color = nullableOneOf(COLORS, value.color)
      if (typeof value.starred !== 'boolean' || color === false || color === undefined)
        return refuse(`A highlight is "starred" (true or false) and "color" (${COLORS.join(', ')}, or null).`)
      return studioParams({ kind: 'highlight', starred: value.starred, color })
    }
    case 'addLink': {
      const read = link(value.link)
      const status = value.status === undefined ? undefined : oneOf(STATUSES, value.status)
      if (!read) return refuse('"link" is a backlog link: id, moduleId, type, label and target { kind, id }.')
      if (value.status !== undefined && !status) return refuse(`"status" is one of ${STATUSES.join(', ')}.`)
      return studioParams({ kind: 'addLink', link: read, ...(status ? { status } : {}) })
    }
    case 'removeLink':
      return id(value.linkId)
        ? studioParams({ kind: 'removeLink', linkId: value.linkId })
        : refuse('"linkId" names the link.')
    case 'moduleMetadata':
      return id(value.moduleId)
        ? studioParams({ kind: 'moduleMetadata', moduleId: value.moduleId, value: value.value })
        : refuse('"moduleId" names the extension whose metadata this is.')
    case 'moveSource':
      return id(value.nextRelativePath, 1000)
        ? studioParams({ kind: 'moveSource', nextRelativePath: value.nextRelativePath })
        : refuse('"nextRelativePath" is where the item goes, inside the backlog folder.')
    case 'removeRecord':
      return studioParams({ kind: 'removeRecord' })
    case 'epic':
      return value.epic === null || id(value.epic, 1000)
        ? studioParams({ kind: 'epic', epic: value.epic })
        : refuse('"epic" is the epic\'s slug, or null to take the item out of its epic.')
    case 'epicColor': {
      const color = nullableOneOf(COLORS, value.color)
      return color === false || color === undefined
        ? refuse(`"color" is one of ${COLORS.join(', ')}, or null.`)
        : studioParams({ kind: 'epicColor', color })
    }
    case 'dependencies':
      return value.dependsOn === null || slugs(value.dependsOn)
        ? studioParams({ kind: 'dependencies', dependsOn: value.dependsOn === null ? null : [...value.dependsOn] })
        : refuse('"dependsOn" is a list of item slugs, or null.')
    case 'mockups':
      return value.mockups === null || slugs(value.mockups)
        ? studioParams({ kind: 'mockups', mockups: value.mockups === null ? null : [...value.mockups] })
        : refuse('"mockups" is a list of mockup paths in the project, or null.')
    default:
      return refuse(EDIT_WORDS)
  }
}

const FOLDER_WORDS = '"workspaceRoot" is the project\'s folder.'
const COMMAND_WORDS = '"commandId" names this command: a string of 1 to 200 characters.'

function folderParams<P>(
  read: (value: Fields, workspaceRoot: string) => StudioParsed<P>,
): (value: Fields) => StudioParsed<P & Folder> {
  return (value) => {
    if (!isStudioPath(value.workspaceRoot)) return refuse(FOLDER_WORDS)
    const parsed = read(value, value.workspaceRoot)
    return parsed.ok ? studioParams({ ...parsed.params, workspaceRoot: value.workspaceRoot }) : parsed
  }
}

function commandedFolder<P>(
  read: (value: Fields) => StudioParsed<P>,
): (value: Fields) => StudioParsed<Commanded<P & Folder>> {
  return folderParams((value) => {
    if (!id(value.commandId)) return refuse(COMMAND_WORDS)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  })
}

function recordItems(value: unknown): BacklogItemRecordInput[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const items: BacklogItemRecordInput[] = []
  for (const entry of value) {
    if (!isRecord(entry) || !id(entry.relativePath, 1000)) return null
    const status = entry.status === undefined ? undefined : oneOf(STATUSES, entry.status)
    const type = entry.type === undefined ? undefined : oneOf(STUDIO_BACKLOG_ITEM_TYPES, entry.type)
    const difficulty =
      entry.difficulty === undefined ? undefined : oneOf(STUDIO_BACKLOG_ITEM_DIFFICULTIES, entry.difficulty)
    const criticality =
      entry.criticality === undefined ? undefined : oneOf(STUDIO_BACKLOG_ITEM_CRITICALITIES, entry.criticality)
    if (
      (entry.status !== undefined && !status) ||
      (entry.type !== undefined && !type) ||
      (entry.difficulty !== undefined && !difficulty) ||
      (entry.criticality !== undefined && !criticality)
    )
      return null
    items.push({
      relativePath: entry.relativePath,
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      ...(difficulty ? { difficulty } : {}),
      ...(criticality ? { criticality } : {}),
    })
  }
  return items
}

function idItems(value: unknown): BacklogEnsureIdsItemInput[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const items: BacklogEnsureIdsItemInput[] = []
  for (const entry of value) {
    if (!isRecord(entry) || !id(entry.relativePath, 1000)) return null
    const numericId = entry.numericId
    if (
      numericId !== undefined &&
      numericId !== null &&
      !(Number.isSafeInteger(numericId) && (numericId as number) >= 0)
    )
      return null
    items.push({
      relativePath: entry.relativePath,
      ...(numericId !== undefined ? { numericId: numericId as number | null } : {}),
    })
  }
  return items
}

const folderRead = {
  scope: 'backlog:read',
  mutation: false,
  capability: STUDIO_BACKLOG_CAPABILITY,
  owner: STUDIO_BACKLOG_FOLDER_OWNER,
} as const
const folderWrite = {
  scope: 'backlog:operate',
  mutation: true,
  capability: STUDIO_BACKLOG_CAPABILITY,
  owner: STUDIO_BACKLOG_FOLDER_OWNER,
} as const

export const STUDIO_BACKLOG_FOLDER_METHODS: StudioMethodTable<StudioBacklogFolderMethodMap> = {
  'backlog.location': { ...folderRead, params: folderParams(() => studioParams({})) },
  'backlog.setRoot': {
    ...folderWrite,
    params: commandedFolder((value) =>
      value.root === null || isStudioPath(value.root)
        ? studioParams({ root: value.root })
        : refuse('"root" is the folder the backlog lives in, or null for the project\'s own backlog folder.'),
    ),
  },
  'backlog.ensureRecords': {
    ...folderWrite,
    params: commandedFolder((value) => {
      const items = recordItems(value.items)
      return items
        ? studioParams({ items })
        : refuse(`"items" is the scanned items (at most ${MAX_ITEMS}), each with its "relativePath".`)
    }),
  },
  'backlog.ensureIds': {
    ...folderWrite,
    params: commandedFolder((value) => {
      const items = idItems(value.items)
      return items
        ? studioParams({ items })
        : refuse(
            `"items" is the scanned items (at most ${MAX_ITEMS}), each with its "relativePath" and its id or null.`,
          )
    }),
  },
  'backlog.edit': {
    ...folderWrite,
    params: commandedFolder((value) => {
      if (!id(value.relativePath, 1000)) return refuse('"relativePath" names the item, inside the backlog folder.')
      const edit = parseStudioBacklogEdit(value.edit)
      return edit.ok ? studioParams({ relativePath: value.relativePath, edit: edit.params }) : edit
    }),
  },
  'backlog.createEpic': {
    ...folderWrite,
    params: commandedFolder((value) =>
      typeof value.title === 'string' && value.title.trim() && value.title.length <= 500
        ? studioParams({ title: value.title })
        : refuse('"title" is the epic\'s title, 1 to 500 characters.'),
    ),
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
