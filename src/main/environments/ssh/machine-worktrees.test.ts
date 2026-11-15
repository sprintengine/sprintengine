// A chat's worktree on an SSH machine, cut, listed, given back and swept by
// that machine's own Studio from its own pool: a real SshEnvironment (a plain
// `sh` standing in for ssh, the real server tree and relay), a git repository
// with an origin in the machine's home, and the window's own New chat
// worktree code and worktrees module, asked with paths spelled
// `ssh://<id>/…`. They reach the machine's Studio as a window does: a ticket
// its window listener minted, over main's owner connection, spent on a socket
// main's loopback route carries through the front door (`ws`).

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import {
  connect,
  webSocketTransport,
  type StudioClient,
  type StudioWebSocketConstructor,
} from '../../../../packages/client-runtime/src/public'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../../shared/ssh-environments'
import { machinePath, parseMachinePath } from '../../../shared/machine-paths'
import { WSL_NODE_VERSION } from '../../hosts/wsl-node-runtime'
import { createLoopbackRoute } from '../environment-route'
import { SshEnvironment } from './ssh-environment'
import { serverTreeDigest } from './ssh-install'
import type { SessionProcess } from './ssh-session'

// The real window modules New chat's worktree goes through: every other suite
// gets their stand-ins.
vi.mock('../../../renderer/src/studio/git', () => vi.importActual('../../../renderer/src/studio/git'))
vi.mock('../../../renderer/src/studio/worktrees', () => vi.importActual('../../../renderer/src/studio/worktrees'))
vi.mock('../../../renderer/src/store/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ appSettings: { worktreeBranchPrefix: 'agent' } }) },
}))
const diagnostics: string[] = []
vi.mock('../../../renderer/src/utils/diagnostics', () => ({
  publishDiagnosticSync: (input: { message: string }) => {
    diagnostics.push(input.message)
  },
}))

const { worktreesApi } = await import('../../../renderer/src/studio/worktrees')
const { createNewChatWorktree, obtainNewChatWorktree, releaseNewChatWorktreeReservation, reserveNewChatWorktree } =
  await import('../../../renderer/src/utils/newChatWorktree')
const { configureEnvironmentStudio, closeEnvironmentStudios } = await vi.importActual<
  typeof import('../../../renderer/src/studio/environmentStudio')
>('../../../renderer/src/studio/environmentStudio')

function socketFrom(origin: string): StudioWebSocketConstructor {
  const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, init: unknown) => unknown }).WebSocket
  return class {
    constructor(url: string) {
      return new NodeWebSocket(url, { headers: { origin } }) as never
    }
  } as unknown as StudioWebSocketConstructor
}

const ROOT = join(__dirname, '..', '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
let scratch = ''
let tree = ''
let digest = ''
const pids: number[] = []

beforeAll(() => {
  // Real path: git answers with one (macOS's temp directory is a symlink).
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'se-ssh-worktrees-')))
  tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  digest = serverTreeDigest(tree)
})
afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone.
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

test('a chat’s worktree on an SSH machine is cut, listed, given back and swept by that machine’s own Studio', async () => {
  const home = join(scratch, 'home')
  const repo = join(home, 'repo')
  const origin = join(home, 'origin.git')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const answer = 42\n')
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], {
      encoding: 'utf8',
    })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Dev')
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  // Every chat's worktree starts on origin's default branch.
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'main')

  const fakeNode = Buffer.from(
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${WSL_NODE_VERSION}; exit 0; fi\nexec '${process.execPath}' "$@"\n`,
  )
  const machine = new SshEnvironment({
    id: 'e1',
    label: () => 'build-box',
    settings: () => ({ ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }),
    spawn: () =>
      spawn('sh', ['-s'], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as SessionProcess,
    app: { version: VERSION, channel: 'latest' },
    dataName: 'data',
    startedBy: 'Studio on dev-macbook-air',
    serverTree: () => ({ dir: tree, digest }),
    nodeBinary: async () => ({ binary: fakeNode }),
    onChange: () => undefined,
  })
  const connection = await machine.connect({ interactive: false })
  pids.push(
    (
      JSON.parse(
        readFileSync(join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run', 'server.json'), 'utf8'),
      ) as { pid: number }
    ).pid,
  )

  // The machine's home is a scratch folder on this computer, so its plain
  // paths are real here too. This window has no Studio of its own (no bridge
  // to one), so every answer below is the machine's.
  const route = createLoopbackRoute({ open: () => connection.open('ws') })
  const routePort = await route.port()
  const api = {}
  const host = globalThis as { window?: { api?: object } }
  host.window = { api }
  configureEnvironmentStudio(api, {
    connect: async () => {
      const minted = await connection.owner.request('environment.windowTicket', {
        windowKey: 'window-1-1',
        origin: 'file://',
      })
      const ticket = { url: `ws://127.0.0.1:${routePort}${minted.path}`, token: minted.token }
      return connect({
        transport: webSocketTransport({ ticket: async () => ticket, WebSocket: socketFrom('file://') }),
        client: { name: 'Studio window' },
        reconnect: false,
      }) as Promise<StudioClient>
    },
  })
  const onMachine = (path: string) => {
    const parsed = parseMachinePath(path)
    assert.equal(parsed?.id, 'e1', `${path} is spelled as the machine's`)
    return parsed!.path
  }
  try {
    const root = machinePath('e1', repo)

    // New chat with a name typed: cut on Enter, from the machine's pool.
    const named = await createNewChatWorktree(root, 'fix-login', null)
    assert.ok(named.ok, JSON.stringify({ named, diagnostics }))
    const namedPath = onMachine(named.folderPath)
    assert.ok(existsSync(join(namedPath, 'src', 'app.ts')), 'checked out on the machine')
    assert.equal(git(namedPath, 'branch', '--show-current').trim(), 'agent/fix-login')
    assert.equal(named.worktree.repoRoot, root, 'filed under the project on that machine')
    assert.ok(named.made?.leaseId, 'a slot of the machine’s own pool')

    // Listed by that machine: its pool holds the slot, leased.
    const snapshot = await worktreesApi.getWorktreePoolSnapshot(root)
    assert.ok(snapshot, 'the machine keeps a pool for the project')
    assert.equal(snapshot.repoRoot, root)
    assert.equal(snapshot.containerPath, machinePath('e1', join(home, '.sprintengine-worktrees', 'repo')))
    const slot = snapshot.slots.find((entry) => entry.path === named.folderPath)
    assert.ok(slot, JSON.stringify(snapshot.slots.map((entry) => entry.path)))
    assert.equal(slot.state, 'leased')

    // New chat with Worktree on and no name: reserved while the person types,
    // and taken by the chat Enter starts.
    reserveNewChatWorktree('door', root, null)
    const reserved = await obtainNewChatWorktree(root, '', null)
    assert.ok(reserved.ok, JSON.stringify({ reserved, diagnostics }))
    assert.notEqual(reserved.folderPath, named.folderPath)
    assert.ok(existsSync(onMachine(reserved.folderPath)))

    // A chat that went before its worktree landed gives it back to the pool
    // that leased it, by its lease.
    const given = await worktreesApi.worktreePoolAction(
      { kind: 'release', leaseId: reserved.made!.leaseId!, unused: true },
      reserved.folderPath,
    )
    assert.ok(given.ok, JSON.stringify(given))
    const after = await worktreesApi.getWorktreePoolSnapshot(root)
    assert.equal(after?.slots.find((entry) => entry.path === reserved.folderPath)?.state, 'idle')

    // The sweep, asked of the machine: the folder a chat's record holds is
    // kept there, whatever this computer's records name elsewhere.
    const swept = await worktreesApi.cleanupAgentWorktrees({
      repoRoot: root,
      protectedPaths: [named.folderPath, '/Users/dev/elsewhere'],
      dryRun: true,
    })
    assert.equal(swept.repoRoot, root)
    assert.ok(!swept.entries.some((entry) => entry.path === named.folderPath && entry.verdict === 'removed'))
  } finally {
    releaseNewChatWorktreeReservation('door')
    closeEnvironmentStudios(api as never)
    delete host.window
    await route.close()
    machine.disconnect()
  }
})
