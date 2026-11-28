import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
// records, and answers the rest of what a client reads before it starts a
// chat there (its CLIs, a project's checkout, what a chat there can use): it
// advertises `workspaces` and `chat-rows`, so it answers them.

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

test('a Studio without the desktop shell answers what a client reads before it starts a chat there', async () => {
  const core = createStudioCore(
    createNodeStudioPlatform({ dataDir: join(scratch, 'data-discovery'), packaged: false, version: '0.0.0-test' }),
    { role: 'server' },
  )
  const gateway = createStudioGateway(core)
  const rpc = createStudioRpc(core, gateway)
  const project = join(scratch, 'home', 'checkout')
  await mkdir(project, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '--allow-empty', '-m', 'first')
  git('branch', 'feat/x')
  const windowId = core.workspaceSyncService.getSnapshot().state.primaryWorkspaceWindowId
  for (const workspace of [
    chat('ws-repo', project),
    chat('ws-copy', project, { environment: { kind: 'ssh', id: 'build-box' } }),
  ]) {
    const created = core.workspaceSyncService.dispatch({
      sourceWindowId: windowId,
      command: {
        type: 'workspace.created',
        payload: { workspace, windowId, insert: { kind: 'folder_head', folderPath: project }, activate: false },
      },
    } as never)
    assert.equal(created.ok, true, JSON.stringify(created))
  }
  const client = await connect({
    transport: rpc.shellTransport(),
    client: { name: 'Studio desktop', kind: 'desktop' },
    heartbeat: false,
  })
  const refusal = (asked: Promise<unknown>) =>
    asked.then(
      () => 'answered',
      (error: { code?: string }) => error.code,
    )
  try {
    // The CLIs it can run: the plugins it holds, with what each offers.
    const { clis } = await client.request('cliRuntimes.list', {})
    assert.ok(
      clis.some((row) => row.id === 'claude-code'),
      JSON.stringify(clis.map((row) => row.id)),
    )
    const [one] = (await client.request('cliRuntimes.list', { cli: 'claude-code' })).clis
    assert.equal(one?.agentSelectable, true)
    assert.ok(one?.catalog, 'each row carries what the model picker there offers')
    assert.equal(await refusal(client.request('cliRuntimes.list', { cli: 'no-such-cli' })), 'not_found')

    // A project's checkout, read with git where the folder is.
    const checkout = await client.request('workspaces.checkout', { workspaceId: 'ws-repo' })
    assert.equal(checkout.workspaceId, 'ws-repo')
    assert.equal(checkout.git, true)
    assert.equal(checkout.branch, 'main')
    assert.deepEqual(checkout.branches?.map((branch) => branch.name).sort(), ['feat/x', 'main'])
    assert.equal(checkout.worktrees?.[0]?.isMain, true)
    assert.equal(await refusal(client.request('workspaces.checkout', { workspaceId: 'ws-ghost' })), 'not_found')
    // Another machine's chat is read on that machine, not through here.
    assert.equal(await refusal(client.request('workspaces.checkout', { workspaceId: 'ws-copy' })), 'not_found')

    // What a chat in the project can use.
    const extensions = await client.request('workspaces.extensions', { workspaceId: 'ws-repo', cli: 'claude-code' })
    assert.equal(extensions.workspaceId, 'ws-repo')
    assert.ok(Array.isArray(extensions.skills))
    assert.ok(Array.isArray(extensions.servers))
    assert.equal(await refusal(client.request('workspaces.extensions', { workspaceId: 'ws-ghost' })), 'not_found')
  } finally {
    client.close()
    await rpc.stop().catch(() => undefined)
    await core.shutdown?.()
  }
})
