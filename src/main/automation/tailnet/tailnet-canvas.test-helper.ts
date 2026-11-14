import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStudioCanvasDomain } from '../../../server/canvas/canvas-domain'
import type { CanvasElement, CanvasScenePush } from '../../../shared/canvas/types'
import type { McpToolRegistration } from '../../../shared/modules/mcp-tools'
import { canvasBoardStoreDir } from '../../canvas/canvas-board-store'
import { createCanvasRemoteSubscribers, isRemoteCanvasSubscriber } from '../../canvas/canvas-remote-subscribers'
import { createCanvasService, type CanvasServiceInternal } from '../../canvas/canvas-service'
import type { CanvasService } from '../../canvas/canvas-service-types'
import { createCanvasStoreCatalogue } from '../../canvas/canvas-store-catalogue'
import { createNodeCanvasFs, watchCanvasDirectory } from '../../canvas/canvas-node-fs'
import type { CanvasWorkerHost } from '../../canvas/canvas-worker-host'
import { createCanvasTools } from '../canvas-tools'
import { deviceRig, type DeviceRig } from './tailnet-studio.test-helper'

// The machine that holds the boards, for the canvas tests over the Studio
// protocol: a real canvas service over a real folder, served by a real Studio
// server through the real tailnet listener on loopback, as the desktop with
// its server in process serves another device's boards.

export const FAR_CHAT = 'far-chat'
export const MACHINE = 'mac-mini'

let nonce = 1
export function element(id: string, extra: Partial<CanvasElement> = {}): CanvasElement {
  return {
    id,
    type: 'rectangle',
    version: 1,
    versionNonce: nonce++,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    isDeleted: false,
    updated: Date.now(),
    ...extra,
  }
}

/**
 * A worker that answers an agent's edit with the boxes it was asked for, what
 * an agent drawing looks like to the service, and draws every picture as one
 * fixed PNG, as a hidden window would draw it.
 */
function agentWorker(): CanvasWorkerHost {
  return {
    call: (async (request: Record<string, unknown>) => {
      if (request.kind === 'export-image')
        return {
          ok: true,
          value: {
            kind: 'export-image',
            requestId: 'r',
            ok: true,
            image: { data: PICTURE_PNG_BASE64, mimeType: 'image/png', width: 1, height: 1 },
          },
        }
      if (request.kind !== 'apply-edit') return { ok: false, error: { code: 'worker_unavailable', message: 'no' } }
      const edit = request.edit as { create?: Array<{ tempId?: string }> }
      const created = (edit.create ?? []).map((_, index) => element(`agent-box-${nonce}-${index}`))
      return {
        ok: true,
        value: {
          kind: 'apply-edit',
          requestId: 'r',
          ok: true,
          elements: [...(request.elements as CanvasElement[]), ...created],
          files: {},
          changed: [],
          result: { created: created.map((box) => box.id), updated: [], deleted: [], tempIds: {}, warnings: [] },
        },
      }
    }) as unknown as CanvasWorkerHost['call'],
    report: () => null,
    dispose: async () => undefined,
  }
}

/** A port nothing listens on now, so a listener can be stopped and started again on it. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** The picture the far machine draws, without a hidden window: a fixed PNG. */
export const PICTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export type FarMachine = Awaited<ReturnType<typeof farMachine>>

export async function farMachine(options: { canvas?: boolean } = {}) {
  const made: string[] = []
  const dir = (prefix: string) => {
    const path = mkdtempSync(join(tmpdir(), prefix))
    made.push(path)
    return path
  }
  const project = dir('canvas-far-project-')
  const userData = dir('canvas-far-data-')
  const workspaces = [{ id: FAR_CHAT, folderPath: project, name: 'Atlas' }]
  const remote = createCanvasRemoteSubscribers()
  const windowPushes: Array<{ subscriberId: number; channel: string; payload: CanvasScenePush }> = []
  const service: CanvasServiceInternal = createCanvasService({
    fs: createNodeCanvasFs(),
    now: () => Date.now(),
    resolveWorkspaceRoot: (id) => (id === FAR_CHAT ? project : null),
    resolveBoardStore: (_id, root) => canvasBoardStoreDir(userData, root),
    storeCatalogue: createCanvasStoreCatalogue({ userDataDir: userData, listWorkspaces: () => workspaces }),
    broadcast: (channel, payload) => remote.broadcast(channel, payload),
    sendTo: (subscriberId, channel, payload) => {
      if (isRemoteCanvasSubscriber(subscriberId)) remote.sendTo(subscriberId, channel, payload)
      else windowPushes.push({ subscriberId, channel, payload: payload as CanvasScenePush })
    },
    watch: watchCanvasDirectory,
    worker: agentWorker(),
  })
  const pictures: Array<Record<string, unknown>> = []
  // The real tools, over the service as another device reaches it; the
  // screenshot notes what it was asked, and answers a board named nowhere as a
  // machine without it does.
  const toolsOver = (held: CanvasService): McpToolRegistration[] => {
    const real = createCanvasTools({
      service: held,
      hasWorkspace: (id) => id === FAR_CHAT,
      isCanvasEnabled: () => true,
    })
    const drawn = real.find((tool) => tool.name === 'canvas.screenshot')!
    const screenshot: McpToolRegistration = {
      ...drawn,
      handler: async (args, context) => {
        pictures.push(args)
        if (args.board === 'canvas://nowhere') {
          return {
            content: [{ type: 'text', text: 'No such board.' }],
            structuredContent: { error: { code: 'not_found', message: 'There is no board "nowhere" on mac-mini.' } },
            isError: true,
          }
        }
        return drawn.handler(args, context)
      },
    }
    return [...real.filter((tool) => tool.name !== 'canvas.screenshot'), screenshot]
  }
  const port = await freePort()
  // What crossed, call by call, with its size: what the tests count to see a picture sent once.
  const calls: Array<{ method: 'commit' | 'stage' | 'files' | 'read'; bytes: number }> = []
  const domain = createStudioCanvasDomain(remote.host(service, toolsOver))
  const counted: typeof domain = {
    ...domain,
    commit: (connectionId, params) => {
      calls.push({ method: 'commit', bytes: JSON.stringify(params).length })
      return domain.commit(connectionId, params)
    },
    stage: (connectionId, params) => {
      calls.push({ method: 'stage', bytes: params.text.length })
      return domain.stage(connectionId, params)
    },
    files: async (ref, ids) => {
      const answer = await domain.files(ref, ids)
      calls.push({ method: 'files', bytes: answer.ok ? JSON.stringify(answer.value).length : 0 })
      return answer
    },
    read: async (ref) => {
      const answer = await domain.read(ref)
      calls.push({ method: 'read', bytes: answer.ok ? JSON.stringify(answer.value).length : 0 })
      return answer
    },
  }
  const rig: DeviceRig = await deviceRig(options.canvas === false ? {} : { canvas: counted }, { port })
  const storeDir = canvasBoardStoreDir(userData, project)
  return {
    rig,
    project,
    storeDir,
    service,
    windowPushes,
    pictures,
    calls,
    port,
    endpoint: { host: '127.0.0.1', port },
    stop: () => rig.gateway.stop(),
    restart: () => rig.gateway.start(),
    sceneOnDisk(name: string): CanvasElement[] {
      const text = readFileSync(join(storeDir, `${name}.excalidraw`), 'utf8')
      return (JSON.parse(text) as { elements: CanvasElement[] }).elements
    },
    filesOnDisk(name: string): Record<string, unknown> {
      const text = readFileSync(join(storeDir, `${name}.excalidraw`), 'utf8')
      return (JSON.parse(text) as { files: Record<string, unknown> }).files
    },
    async dispose() {
      await rig.dispose().catch(() => undefined)
      await service.dispose()
      for (const path of made) rmSync(path, { recursive: true, force: true })
    },
  }
}

export async function waitFor(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms
  while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
  if (!predicate()) throw new Error(`timed out waiting: ${what}`)
}
