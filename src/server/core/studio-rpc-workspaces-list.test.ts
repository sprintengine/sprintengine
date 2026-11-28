import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { connect } from '../../../packages/client-runtime/src/public'
import { STUDIO_CHAT_ROWS_CAPABILITY } from '../../../packages/studio-protocol/src/handshake'
import { createNodeStudioPlatform, resetStudioPlatform } from '../platform/platform'
import { createStudioCore } from './studio-core'
import { createStudioGateway } from './studio-gateway'
import { createStudioRpc } from './studio-rpc'

// A Studio without the desktop shell (an SSH machine's, a WSL distribution's)
// lists the chats it holds, with what each one's row draws, from its own
// records: it advertises `workspaces` and `chat-rows`, so it answers them.

let scratch = ''
let savedHome: string | undefined
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'se-studio-workspaces-list-')))
  savedHome = process.env.HOME
  process.env.HOME = join(scratch, 'home')
  await mkdir(process.env.HOME, { recursive: true })
})
afterAll(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  resetStudioPlatform()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

function chat(id: string, folderPath: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Chat ${id}`,
    mode: 'standard',
    folderPath,
    templateId: 'standard',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    editorState: { openFiles: [], activeFilePath: null },
    ...fields,
  }
}

test('a Studio without the desktop shell lists its own chats with their rows, and no copy of another machine’s', async () => {
  const core = createStudioCore(
    createNodeStudioPlatform({ dataDir: join(scratch, 'data'), packaged: false, version: '0.0.0-test' }),
    { role: 'server' },
  )
  const gateway = createStudioGateway(core)
  const rpc = createStudioRpc(core, gateway)
  const project = join(scratch, 'home', 'repo')
  await mkdir(project, { recursive: true })
  const windowId = core.workspaceSyncService.getSnapshot().state.primaryWorkspaceWindowId
  const create = (workspace: Record<string, unknown>) => {
    const created = core.workspaceSyncService.dispatch({
      sourceWindowId: windowId,
      command: {
        type: 'workspace.created',
        payload: { workspace, windowId, insert: { kind: 'folder_head', folderPath: project }, activate: false },
      },
    } as never)
    assert.equal(created.ok, true, JSON.stringify(created))
  }
  // A chat with no agent listed (a terminal-only chat) is a chat all the same.
  create(chat('ws-terminal', project, { createdAt: 1_000, highlight: { starred: true } }))
  // This machine's copy of a chat another machine holds is that machine's to list.
  create(chat('ws-copy', project, { environment: { kind: 'ssh', id: 'build-box' } }))
  const client = await connect({
    transport: rpc.shellTransport(),
    client: { name: 'Studio desktop', kind: 'desktop' },
    heartbeat: false,
  })
  try {
    assert.ok((client.welcome.capabilities as readonly string[]).includes(STUDIO_CHAT_ROWS_CAPABILITY))
    const { workspaces } = await client.request('workspaces.list', {})
    assert.deepEqual(
      workspaces.map((workspace) => workspace.id),
      ['ws-terminal'],
    )
    const [row] = workspaces
    assert.equal(row?.folderPath, project)
    assert.equal(row?.createdAt, 1_000)
    assert.equal(row?.recencyAt, 1_000, 'a chat nobody wrote to sits where it was made')
    assert.deepEqual(row?.highlight, { starred: true })
    assert.equal(row?.settledAt, null)
  } finally {
    client.close()
    await rpc.stop().catch(() => undefined)
    await core.shutdown?.()
  }
})
