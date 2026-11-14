import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { connect, webSocketTransport, type StudioClient } from '../../../../packages/client-runtime/src/public'
import { createWorkspaceRegistryService } from '../../../main/workspace-registry-service'
import { createWorkspaceRegistryStore, type WorkspaceRegistryStore } from '../../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../../main/workspace-sync-service'
import { createTicketAuthenticator, framePortStream, mintStudioTicket } from '../../../server/rpc/studio-frame-port'
import { createStudioRpcServer, type StudioRpcServer } from '../../../server/rpc/studio-rpc-server'
import { createFakeAuthenticator, createFakeBackend } from '../../../server/rpc/studio-rpc.test-helper'
import type { StudioChatBackend } from '../../../server/rpc/studio-rpc-types'
import { createStudioWorkspaceSync } from '../../../server/workspaces/studio-workspace-sync'
import type { WorkspaceSyncCommand, WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'
import { createMemoryChannel, type MemoryChannelEnd } from '../../../../tests/memory-channel'
import { memoryWebSocketClass } from '../../../../tests/memory-websocket'
import type { Workspace } from '../types/workspace'
import { createWorkspaceSyncClient, type WorkspaceSyncClientApi } from './workspaceSyncClient'

// A window's new chat across a kill -9 of its Studio, on the real registry,
// its file on disk, the real protocol server and the window's real client. A
// kill leaves the registry as its file has it: nothing flushed, no answer
// still to come. The registry's write delay is long here, so only a write
// something waited for is on disk.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean) => {
  for (let tries = 0; !check() && tries < 400; tries++) await sleep(5)
  assert.ok(check())
}

/** A Studio on `dataDir` that can be killed and started again on the same folder. */
function studio(dataDir: string, options: { writesHang?: boolean } = {}) {
  const chat = { onCommandsChanged: () => () => undefined, releaseFileSearches: () => undefined }
  let port = 0
  let server: StudioRpcServer
  let registry: ReturnType<typeof createWorkspaceRegistryService>
  let open: MemoryChannelEnd | null = null
  const boot = (hang: boolean) => {
    const real = createWorkspaceRegistryStore({ resolveUserDataDir: () => dataDir, persistDebounceMs: 60_000 })
    // A write that never lands: the kill comes in the middle of it.
    const never = () => new Promise<void>(() => undefined)
    const store: WorkspaceRegistryStore = hang ? { ...real, flush: never, whenWritten: never } : real
    registry = createWorkspaceRegistryService({ store })
    const workspaceSyncService = createWorkspaceSyncService({ registry })
    port += 1
    server = createStudioRpcServer({
      dataDir,
      version: '0.0.0-test',
      environmentId: 'env-test',
      backend: createFakeBackend(),
      chat: () => chat as unknown as StudioChatBackend,
      authenticator: createFakeAuthenticator(),
      workspaceSync: createStudioWorkspaceSync({
        workspaceSyncService,
        workspaceRegistry: registry,
        platform: { paths: { dataDir: () => dataDir } },
      } as never),
    })
    const made = server
    cleanups.push(() => made.stop(1))
  }
  boot(options.writesHang === true)
  const transport = webSocketTransport({
    ticket: async () => {
      const ticket = mintStudioTicket()
      return { url: `ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`, token: ticket }
    },
    WebSocket: memoryWebSocketClass((url) => {
      const address = new URL(url)
      const ticket = address.searchParams.get('ticket')
      if (!ticket || Number(address.port) !== port) return null
      const [serverEnd, clientEnd] = createMemoryChannel()
      server.attach(framePortStream(serverEnd), { authenticator: createTicketAuthenticator(ticket), ownWindow: true })
      open = clientEnd
      return clientEnd
    }),
  })
  return {
    transport,
    registry: () => registry,
    /** kill -9 and start again: the new run reads the registry's file, and its writes land. */
    async kill() {
      const stopping = server
      boot(false)
      open?.close()
      await stopping.stop(1)
    },
  }
}

/** The window's registry calls, as `studio/workspaceSync.ts` makes them over its client. */
function windowApi(client: StudioClient, onReopen: { listener: () => void }): WorkspaceSyncClientApi {
  let ids = 0
  return {
    workspaceSyncDispatch: async (command: WorkspaceSyncCommand) =>
      (await client.request('workspaceSync.dispatch', {
        commandId: `cmd-${++ids}`,
        windowId: 'primary',
        command: command as unknown as Record<string, unknown>,
      })) as never,
    workspaceSyncGetSnapshot: async () => (await client.request('workspaceSync.snapshot', {})) as never,
    workspaceSyncGetEventsAfter: async () => [],
    onWorkspaceSyncEvent: (_cb, reopen) => {
      onReopen.listener = reopen ?? (() => undefined)
      return () => undefined
    },
  }
}

function newChat(id: string): Workspace {
  return {
    id,
    name: 'first message',
    mode: 'standard',
    folderPath: '/Users/dev/demo',
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  } as unknown as Workspace
}

async function windowOn(target: ReturnType<typeof studio>) {
  const reopen = { listener: () => undefined as void }
  let wasOpen = false
  const client = await connect({
    transport: target.transport,
    client: { name: 'Studio window' },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
    onStateChange: (state) => {
      if (state === 'open' && !wasOpen) reopen.listener()
      wasOpen = state === 'open'
    },
  })
  wasOpen = true
  cleanups.push(() => client.close())
  const adopted: string[][] = []
  const ignore = () => undefined
  const sync = createWorkspaceSyncClient({
    getApi: () => windowApi(client, reopen),
    getWindowId: () => 'primary',
    applyActiveChanged: ignore,
    applyWorkspaceMoved: ignore,
    applyWorkspaceClosed: ignore,
    applyWorkspacePlacement: ignore,
    applyWorkspaceCreated: ignore,
    applyAgentTerminalSession: ignore,
    applyAgentTerminalLaunchState: ignore,
    applyWorkspaceRenamed: ignore,
    applyWorkspaceLayoutUpdated: ignore,
    applyWorkspaceFieldsUpdated: ignore,
    applyWorkspaceAgentUpdated: ignore,
    applyWorkspaceRemoved: ignore,
    applyRegistrySnapshot: (snapshot: WorkspaceSyncSnapshot) =>
      adopted.push(snapshot.state.workspaces.map((workspace) => workspace.id)),
    logDiagnostic: ignore,
  })
  sync.start()
  await until(() => adopted.length === 1)
  return { client, sync, adopted }
}

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'window-new-chat-kill-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a new chat Studio answered for is still listed after a kill -9 right after the answer', async () => {
  const target = studio(dataDir())
  const { sync, adopted } = await windowOn(target)
  await sync.dispatchCreateWorkspace(newChat('ws-new'), 'primary', '/Users/dev/demo')
  assert.deepEqual(await sync.whenCreated('ws-new'), { ok: true })
  await target.kill()
  assert.ok(target.registry().getRecord('ws-new'), 'the Studio that comes back lists the chat')
  await until(() => adopted.length >= 2)
  assert.ok(adopted.at(-1)!.includes('ws-new'), 'and so does the window')
})

test('a new chat whose answer a kill -9 took is sent again to the Studio that comes back, and its chat waits for it', async () => {
  const target = studio(dataDir(), { writesHang: true })
  const { sync, adopted } = await windowOn(target)
  void sync.dispatchCreateWorkspace(newChat('ws-new'), 'primary', '/Users/dev/demo')
  let outcome: unknown = null
  void sync.whenCreated('ws-new').then((value) => (outcome = value))
  await sleep(20)
  assert.equal(outcome, null, 'nothing of the chat starts while Studio has not written it')
  await target.kill()
  await until(() => outcome !== null)
  assert.deepEqual(outcome, { ok: true })
  assert.ok(target.registry().getRecord('ws-new'), 'the Studio that came back has the chat')
  await until(() => adopted.length >= 2)
  assert.ok(
    adopted.slice(1).every((ids) => ids.includes('ws-new')),
    'every registry read after the kill lists it: the chat never leaves the window',
  )
})
