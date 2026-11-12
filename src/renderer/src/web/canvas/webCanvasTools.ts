import { createHash } from 'node:crypto'

import type { StudioClient, ToolCall, ToolDefinition } from '../../../../../packages/client-runtime/src/public'
import { CANVAS_MUTATION_TOOL_NAMES, createCanvasTools } from '../../../../main/automation/canvas-tools'
import { createCanvasService } from '../../../../main/canvas/canvas-service'
import type { CanvasServiceInternal, CanvasStoreCatalogue } from '../../../../main/canvas/canvas-service'
import { createCanvasWorkerHost, type CanvasWorkerTransport } from '../../../../main/canvas/canvas-worker-host'
import { createProtocolCanvasFs } from '../../../../main/canvas/protocol-canvas-fs'
import type { McpConnectionContext, McpConnectionMetadata } from '../../../../shared/modules/mcp-tools'

// The `canvas` toolset a web tab offers (phase 9 spec, 3.8; decision R79):
// the same tools the desktop's shell offers (main/automation/canvas-tools.ts),
// over the same portable canvas service, running in the page. Its boards stay
// on the server's disk, read, written and watched through `files.*`
// (protocol-canvas-fs.ts), so an edit made here shows in a desktop on the same
// board and the reverse. The drawing that needs a document runs in the
// canvas worker, in a hidden frame of the tab's own origin.

/**
 * How long Studio waits for each canvas tool. These are the desktop's own
 * (`BUILT_IN_TOOL_TIMEOUTS_MS` in main/automation/offer-gateway-tools.ts, held
 * equal by this module's test); that module is not imported here because it
 * reaches the whole gateway, which a browser does not load.
 */
export const WEB_CANVAS_TOOL_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  'canvas.import': 90_000,
  'canvas.edit': 45_000,
  'canvas.layout': 45_000,
  'canvas.screenshot': 45_000,
}
export const WEB_CANVAS_DEFAULT_TIMEOUT_MS = 15_000

/** The connection a canvas tool reads, rebuilt from what the call says about its caller, as the desktop does. */
export function webConnectionContextOf(call: Pick<ToolCall, 'context'>): McpConnectionContext {
  const connection = call.context.connection
  const metadata: McpConnectionMetadata = { kind: connection.kind }
  for (const key of ['workspaceId', 'agentId', 'agentName', 'cliId', 'deviceId', 'deviceName'] as const)
    if (connection[key]) metadata[key] = connection[key]
  return { metadata }
}

export type WebCanvasClient = Pick<StudioClient, 'request' | 'subscribe' | 'welcome'>

/** A board on a server is reached through a workspace's root, so a store is only a name for that workspace here. */
const SERVER_STORE_NOTE =
  'A browser tab lists the boards of the projects this server still has. Boards left by a removed project are listed in the desktop app.'

export type WebCanvasTools = {
  definitions: ToolDefinition[]
  service: CanvasServiceInternal
  dispose(): Promise<void>
}

/** A store's key for a workspace on a server. A key by the workspace's id, in the shape every key takes. */
function storeKeyOfWorkspace(workspaceId: string): string {
  return `ws_${createHash('sha256').update(workspaceId).digest('hex').slice(0, 24)}`
}

export function createWebCanvasTools(
  client: WebCanvasClient,
  options: {
    worker: CanvasWorkerTransport
    onReconnect?: (listener: () => void) => () => void
    /** Where the service's pushes go: the tab's Canvas pane (webCanvasPane.ts). Absent, nowhere. */
    pane?: {
      broadcast(channel: string, payload: unknown): void
      sendTo(subscriberId: number, channel: string, payload: unknown): void
    }
  },
): WebCanvasTools {
  const files = createProtocolCanvasFs(client, options.onReconnect ? { onReconnect: options.onReconnect } : {})
  // The workspaces the server holds, read again before every call: a tool
  // names its workspace, and one created since the last call must be found.
  let workspaces = new Set<string>()
  let stores = new Map<string, { workspaceId: string; project: string }>()
  const refreshWorkspaces = async () => {
    const listed = await client.request('workspaces.list', {})
    workspaces = new Set(listed.workspaces.map((workspace) => workspace.id))
    stores = new Map(
      listed.workspaces.map((workspace) => [
        storeKeyOfWorkspace(workspace.id),
        { workspaceId: workspace.id, project: workspace.name },
      ]),
    )
  }
  // The server's `files.*` roots each name a workspace, so a tab reaches the
  // boards of every workspace the server has and no store beyond those: an
  // orphaned store on a server would take an owner method of its own. The key
  // is derived from the workspace, because a tab cannot read a store's folder.
  const storeCatalogue: CanvasStoreCatalogue = {
    listNote: SERVER_STORE_NOTE,
    list: async () => {
      await refreshWorkspaces()
      return [...stores].map(([store, { workspaceId, project }]) => ({
        store,
        directory: files.resolveBoardStore(workspaceId),
        projectFolder: files.resolveWorkspaceRoot(workspaceId),
        project,
        workspaceId,
      }))
    },
    storeKeyOf: (folder) => {
      const workspaceId = folder.slice(folder.lastIndexOf('/') + 1)
      return storeKeyOfWorkspace(workspaceId)
    },
    storeDirectory: (store) => {
      const workspaceId = stores.get(store)?.workspaceId
      return workspaceId ? files.resolveBoardStore(workspaceId) : null
    },
    projectFolder: (store) => {
      const workspaceId = stores.get(store)?.workspaceId
      return workspaceId ? files.resolveWorkspaceRoot(workspaceId) : null
    },
    noteBoardWritten: () => undefined,
  }
  const worker = createCanvasWorkerHost({ transport: options.worker })
  const service = createCanvasService({
    fs: files.fs,
    path: files.path,
    platform: files.platform(),
    now: () => Date.now(),
    resolveWorkspaceRoot: (workspaceId) =>
      workspaces.has(workspaceId) ? files.resolveWorkspaceRoot(workspaceId) : null,
    resolveBoardStore: (workspaceId) => files.resolveBoardStore(workspaceId),
    storeCatalogue,
    // The tab's Canvas pane is the service's one subscriber: its scenes,
    // presence and an agent's `canvas.open` go to the pane in the page.
    broadcast: options.pane?.broadcast ?? (() => undefined),
    sendTo: options.pane?.sendTo ?? (() => undefined),
    watch: files.watch,
    worker,
  })
  const registrations = createCanvasTools({
    service,
    hasWorkspace: (workspaceId) => workspaces.has(workspaceId),
    isCanvasEnabled: () => true,
  })
  const definitions = registrations.map((registration): ToolDefinition => {
    if (!registration.name.startsWith('canvas.'))
      throw new Error(`"${registration.name}" is not a canvas tool and cannot be offered in the canvas toolset.`)
    return {
      name: registration.name.slice('canvas.'.length),
      description: registration.description,
      inputSchema: registration.inputSchema,
      mutates: registration.mutates ?? CANVAS_MUTATION_TOOL_NAMES.includes(registration.name),
      timeoutMs: WEB_CANVAS_TOOL_TIMEOUTS_MS[registration.name] ?? WEB_CANVAS_DEFAULT_TIMEOUT_MS,
      handler: async (input, call) => {
        await refreshWorkspaces()
        return registration.handler(input, webConnectionContextOf(call))
      },
    }
  })
  return { definitions, service, dispose: () => worker.dispose() }
}
