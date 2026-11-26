import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_WEB_TAB_CAPABILITY } from './handshake.js'

// What a web tab asks of the Studio whose web listener served it, beside what
// every client asks: the folder browser that stands in for the native folder
// picker (`webFolders.browse`), and previews of an agent's dev server, each on
// an origin of its own (`webPreviews.*` and the `webPreviews.changed` stream).
// Offered as `web-tab` by a Studio that runs the web listener (a standalone
// server started with it); a desktop's runs none.
//
// Grants. Every one is an owner's (`STUDIO_WEB_TAB_OWNER`), an owner's web tab
// included; no paired device, app or embed reaches any of it. Both expose this
// machine (its folders, its loopback ports) to the browser, so each is
// answered only to a browser paired on this machine's loopback: one paired
// over the tailnet is told so in words and shown no folder and no port.

/** A port an agent of the server listens on, offered for a preview. */
export type PreviewPort = { port: number; pid: number; command: string }

/** An open preview, as the tab that opened it sees it. */
export type PreviewSummary = { previewId: string; port: number; origin: string; openedAt: number; lastUsedAt: number }

export type PreviewOpenAnswer =
  { ok: true; previewId: string; origin: string; enterUrl: string } | { ok: false; message: string }

export type FolderBrowserEntry = { name: string; path: string; project: boolean; hint: 'not-a-project' | null }

export type FolderBrowserListing =
  | {
      ok: true
      path: string
      parent: string | null
      home: string
      entries: FolderBrowserEntry[]
      truncated: boolean
    }
  | { ok: false; message: string }

/** The loopback name a tab was opened on: its previews open on the same one. */
export type WebTabLoopbackName = '127.0.0.1' | 'localhost'

/** Why everything a web tab asks here is an owner's. */
export const STUDIO_WEB_TAB_OWNER =
  'It shows the browser this machine’s folders and the ports its agents listen on, which only its owner may see.'

type Commanded<P> = P & { commandId: string }

export type StudioWebTabMethodMap = {
  /** One folder's listing: a project is marked; hidden entries only when asked. Absent `path` is the home. */
  'webFolders.browse': { params: { path?: string; showHidden?: boolean }; result: FolderBrowserListing }
  /** The ports this machine's agents listen on, offered for a preview. */
  'webPreviews.list': { params: Record<string, never>; result: { ports: PreviewPort[] } }
  /**
   * Open a preview of one port, on an origin of its own under the loopback
   * name the tab was opened on. `typed` says the person typed the port in
   * rather than picked an agent's.
   */
  'webPreviews.open': {
    params: Commanded<{ port: number; typed?: boolean; host: WebTabLoopbackName }>
    result: PreviewOpenAnswer
  }
  /** Close one of this browser's previews. */
  'webPreviews.close': { params: Commanded<{ previewId: string }>; result: { closed: boolean } }
}

export type StudioWebTabTopicMap = {
  /** This browser's open previews, whole, at subscribing and on every change. */
  'webPreviews.changed': { params: Record<string, never>; payload: PreviewSummary[]; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0')
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

const browse = (value: Record<string, unknown>): StudioParsed<{ path?: string; showHidden?: boolean }> => {
  if (
    value.path !== undefined &&
    (typeof value.path !== 'string' || value.path.length > 4096 || value.path.includes('\0'))
  )
    return refuse('"path" is the folder to list.')
  if (value.showHidden !== undefined && typeof value.showHidden !== 'boolean')
    return refuse('"showHidden" says whether hidden entries are listed.')
  return studioParams({
    ...(value.path === undefined ? {} : { path: value.path as string }),
    ...(value.showHidden === undefined ? {} : { showHidden: value.showHidden as boolean }),
  })
}

const open = (
  value: Record<string, unknown>,
): StudioParsed<{ port: number; typed?: boolean; host: WebTabLoopbackName }> => {
  if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535)
    return refuse('"port" is the port to preview, 1 to 65535.')
  if (value.typed !== undefined && typeof value.typed !== 'boolean')
    return refuse('"typed" says the port was typed in.')
  if (value.host !== '127.0.0.1' && value.host !== 'localhost')
    return refuse('"host" is the loopback name the tab was opened on: "127.0.0.1" or "localhost".')
  return studioParams({
    port: value.port as number,
    host: value.host,
    ...(value.typed === undefined ? {} : { typed: value.typed as boolean }),
  })
}

// ── The table ───────────────────────────────────────────────────────────────

const owner = (scope: 'files:read' | 'workspaces:read' | 'workspaces:operate', mutation: boolean) =>
  ({ scope, mutation, capability: STUDIO_WEB_TAB_CAPABILITY, owner: STUDIO_WEB_TAB_OWNER }) as const

export const STUDIO_WEB_TAB_METHODS: StudioMethodTable<StudioWebTabMethodMap> = {
  'webFolders.browse': { ...owner('files:read', false), params: browse },
  'webPreviews.list': { ...owner('workspaces:read', false), params: studioNoParams },
  'webPreviews.open': { ...owner('workspaces:operate', true), params: commanded(open) },
  'webPreviews.close': {
    ...owner('workspaces:operate', true),
    params: commanded((value) =>
      id(value.previewId) ? studioParams({ previewId: value.previewId }) : refuse('"previewId" names the preview.'),
    ),
  },
}

export const STUDIO_WEB_TAB_TOPICS: StudioTopicTable<StudioWebTabTopicMap> = {
  'webPreviews.changed': {
    scope: 'workspaces:read',
    capability: STUDIO_WEB_TAB_CAPABILITY,
    push: true,
    owner: STUDIO_WEB_TAB_OWNER,
    params: studioNoParams,
  },
}
