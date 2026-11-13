// A workspace on an SSH machine, its files and git read and changed on that
// machine by its own Studio (design-wsl-ssh-direct PR 2): a real
// SshEnvironment (a plain `sh` standing in for ssh, the real server tree and
// relay), a git repository in the machine's home, and the window's own files
// and git modules, asked with paths spelled `ssh://<id>/…`. They reach the
// machine's Studio as a window does: a ticket its window listener minted, over
// main's owner connection, spent on a socket main's loopback route carries
// through the front door (`ws`).

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
import { machinePath } from '../../../shared/machine-paths'
import { BACKEND_WIRE_VERSION } from '../../../server/wsl/backend-wire'
import { WSL_NODE_VERSION } from '../../hosts/wsl-node-runtime'
import { createLoopbackRoute } from '../environment-route'
import { SshEnvironment } from './ssh-environment'
import { serverTreeDigest } from './ssh-install'
import type { SessionProcess } from './ssh-session'

// The real modules: every other suite gets their stand-ins.
const { filesApi } = await vi.importActual<typeof import('../../../renderer/src/studio/files')>(
  '../../../renderer/src/studio/files',
)
const { gitApi } = await vi.importActual<typeof import('../../../renderer/src/studio/git')>(
  '../../../renderer/src/studio/git',
)
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
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'se-ssh-files-')))
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

test('a workspace on an SSH machine: the explorer, search, git status, diffs, staging and a commit, all on the machine', async () => {
  const home = join(scratch, 'home')
  const repo = join(home, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const answer = 41\n')
  writeFileSync(join(repo, '.gitignore'), 'dist\n')
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], {
      encoding: 'utf8',
    })
  git('init', '-q', '-b', 'main')
  // The machine's own identity for commits, as a person's ~/.gitconfig there would give.
  git('config', 'user.name', 'Dev')
  git('config', 'user.email', 'dev@example.com')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const answer = 42\n')
  writeFileSync(join(repo, 'src', 'new.ts'), 'export {}\n')

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
    app: { version: VERSION, channel: 'latest', backendWire: BACKEND_WIRE_VERSION },
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
      ) as {
        pid: number
      }
    ).pid,
  )

  // The machine's home is a scratch folder on this computer, so its plain
  // paths are real here too. This window has no Studio of its own (no bridge
  // to one), so every answer below is the machine's.
  const route = createLoopbackRoute({ open: () => connection.open('ws') })
  const routePort = await route.port()
  const routes: string[] = []
  const api = {}
  const host = globalThis as { window?: { api?: object } }
  host.window = { api }
  configureEnvironmentStudio(api, {
    connect: async (asked) => {
      routes.push(asked)
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
  try {
    const root = machinePath('e1', repo)

    const listing = await filesApi.readdir(`${root}/src`)
    assert.deepEqual(listing.map((entry) => entry.name).sort(), ['app.ts', 'new.ts'])
    assert.equal(await filesApi.readfile(`${root}/src/app.ts`), 'export const answer = 42\n')
    assert.equal(await filesApi.pathExists(`${root}/src/new.ts`), true)
    const found = await filesApi.searchFiles(root, 'new', { purpose: 'mention', limit: 10 })
    assert.ok(found.ok)
    assert.ok(
      found.results.some((entry) => entry.path === `${root}/src/new.ts` && entry.parentPath === `${root}/src`),
      JSON.stringify(found),
    )

    // A save there: what is written is the person's text, even where it reads as a path here.
    await filesApi.writefile(`${root}/notes.md`, root, { roots: [root] })
    assert.equal(readFileSync(join(repo, 'notes.md'), 'utf8'), root)
    assert.equal(await filesApi.createFile(root, 'more.md'), `${root}/more.md`)

    assert.equal(await gitApi.getGitRepoRoot(`${root}/src`), root)
    const status = await gitApi.getGitStatus(root)
    assert.equal(status.repoRoot, root)
    assert.deepEqual(Object.keys(status.files).sort(), [
      `${root}/more.md`,
      `${root}/notes.md`,
      `${root}/src/app.ts`,
      `${root}/src/new.ts`,
    ])
    assert.deepEqual(await gitApi.getGitFileBase(root, `${root}/src/app.ts`), {
      ok: true,
      content: 'export const answer = 41\n',
    })

    await gitApi.stageGitPaths(root, [`${root}/src/app.ts`, `${root}/src/new.ts`])
    const committed = await gitApi.commitGitChanges(root, 'Answer correctly')
    assert.ok(committed.ok, JSON.stringify(committed))
    assert.match(git('log', '--oneline', '-1'), /Answer correctly/u)

    // One client of the machine, by its route, for all of it.
    assert.deepEqual([...new Set(routes)], ['ssh:e1'])
    // A machine's checkout is not followed: its views refresh by asking again.
    gitApi.watchGitCheckout(root, () => undefined)()
    // Two machines, or a machine and this computer, in one ask are refused in words.
    await assert.rejects(filesApi.copyPath(`${root}/notes.md`, '/Users/dev/elsewhere'), /two machines/u)
  } finally {
    closeEnvironmentStudios(api as never)
    delete host.window
    await route.close()
    machine.disconnect()
  }
})
