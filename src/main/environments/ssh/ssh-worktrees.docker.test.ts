// A chat's worktree on an SSH machine for real: the system ssh, a container's
// sshd, the pinned Linux Node downloaded and streamed with the server tree, a
// managed server started there, and the window's own New chat worktree code
// and worktrees module asking that server, with paths spelled
// `ssh://<id>/…`, over a window's ticket on main's loopback route. The
// machine's own Studio cuts the worktree from its own pool, lists it, takes a
// lease back and sweeps, with git on the machine.
//
// Runs with STUDIO_TEST_DOCKER=1 and a Docker that answers; git is installed
// in this suite's own container first, so the machine needs network access
// (as the Node download does). The Node archive is cached in
// STUDIO_TEST_CACHE (or the system temp directory).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { createLoopbackRoute } from '../environment-route'
import { createAskpassBroker } from './askpass'
import {
  DOCKER_TESTS,
  prepareSshdImage,
  SSHD_IMAGE_BUILD_MS,
  startSshd,
  type SshdFixture,
} from './__fixtures__/docker-sshd'
import { parseDestination, spawnSshSession } from './ssh-command'
import { SshEnvironment } from './ssh-environment'
import { ensureNodeBinary, serverTreeDigest } from './ssh-install'
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

/** Node's WebSocket, saying the origin a window's would. */
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
const CACHE = process.env.STUDIO_TEST_CACHE || join(tmpdir(), 'se-ssh-node-cache')
/** Installing git in the container: apt-get, which a slow mirror stretches. */
const GIT_INSTALL_MS = 5 * 60_000

let scratch = ''
let tree = ''
let digest = ''
let sshd: SshdFixture | null = null

beforeAll(async () => {
  if (!DOCKER_TESTS) return
  await prepareSshdImage()
  scratch = mkdtempSync(join(tmpdir(), 'se-sshd-worktrees-'))
  tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  digest = serverTreeDigest(tree)
  sshd = startSshd()
  execFileSync(
    'docker',
    [
      'exec',
      sshd.id,
      'sh',
      '-c',
      'apt-get -o Acquire::Retries=3 update -qq && apt-get -o Acquire::Retries=3 install -y -qq --no-install-recommends git >/dev/null',
    ],
    { timeout: GIT_INSTALL_MS, stdio: 'pipe' },
  )
  // A project with an origin: every chat's worktree starts on origin's default branch.
  sshd.exec(
    [
      'git init -q --bare -b main /home/dev/origin.git',
      'git init -q -b main /home/dev/app',
      'cd /home/dev/app',
      'git config user.name Dev && git config user.email dev@example.com',
      'echo "A project on build-box." > README.md && git add . && git commit -qm first',
      'git remote add origin /home/dev/origin.git && git push -q -u origin main',
    ].join(' && '),
    'dev',
  )
}, SSHD_IMAGE_BUILD_MS + GIT_INSTALL_MS)
afterAll(() => {
  sshd?.stop()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

test.skipIf(!DOCKER_TESTS)(
  'build-box for real: a chat’s worktree is cut, listed, given back and swept by the machine’s own Studio',
  async () => {
    const fixture = sshd!
    const broker = await createAskpassBroker({
      runAsNode: false,
      ask: async (request) => (request.kind === 'host-key' ? 'yes' : null),
    })
    const destination = parseDestination('build-box')
    assert.ok(destination.ok)
    const env = new SshEnvironment({
      id: 'docker',
      label: () => 'build-box',
      settings: () => ({ ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }),
      spawn: ({ interactive }) =>
        spawnSshSession({
          ssh: 'ssh',
          destination: destination.destination,
          label: 'build-box',
          interactive,
          askpass: broker,
          configFile: fixture.configFile,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        }) as unknown as SessionProcess,
      app: { version: VERSION, channel: 'latest' },
      dataName: 'data',
      startedBy: 'Studio on dev-macbook-air',
      serverTree: () => ({ dir: tree, digest }),
      nodeBinary: (target) => ensureNodeBinary(target, { cacheDir: CACHE, subject: 'build-box' }),
      onChange: () => undefined,
      timing: { backoff: { baseMs: 200, maxMs: 1_000 } },
    })
    const api = {}
    const host = globalThis as { window?: { api?: object } }
    let route: ReturnType<typeof createLoopbackRoute> | null = null
    try {
      const connection = await env.connect({ interactive: true })
      route = createLoopbackRoute({ open: () => connection.open('ws') })
      const routePort = await route.port()
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
        assert.equal(parsed?.id, 'docker', `${path} is spelled as the machine's`)
        return parsed!.path
      }
      const root = machinePath('docker', '/home/dev/app')

      // New chat with a name typed: cut on Enter, from the machine's own pool.
      const named = await createNewChatWorktree(root, 'fix-login', null)
      assert.ok(named.ok, JSON.stringify({ named, diagnostics }))
      const namedPath = onMachine(named.folderPath)
      assert.equal(fixture.exec(`git -C '${namedPath}' branch --show-current`, 'dev').trim(), 'agent/fix-login')
      assert.equal(fixture.exec(`cat '${namedPath}/README.md'`, 'dev').trim(), 'A project on build-box.')
      assert.match(namedPath, /^\/home\/dev\/\.sprintengine-worktrees\/app\//u, 'beside the project, on the machine')
      assert.ok(named.made?.leaseId, 'a slot of the machine’s own pool')

      const snapshot = await worktreesApi.getWorktreePoolSnapshot(root)
      assert.equal(snapshot?.slots.find((slot) => slot.path === named.folderPath)?.state, 'leased')

      // Worktree on with no name: reserved while the person types, taken on Enter.
      reserveNewChatWorktree('door', root, null)
      const reserved = await obtainNewChatWorktree(root, '', null)
      assert.ok(reserved.ok, JSON.stringify({ reserved, diagnostics }))
      assert.notEqual(reserved.folderPath, named.folderPath)
      const given = await worktreesApi.worktreePoolAction(
        { kind: 'release', leaseId: reserved.made!.leaseId!, unused: true },
        reserved.folderPath,
      )
      assert.ok(given.ok, JSON.stringify(given))
      const after = await worktreesApi.getWorktreePoolSnapshot(root)
      assert.equal(after?.slots.find((slot) => slot.path === reserved.folderPath)?.state, 'idle')

      // The sweep there keeps what a chat's record holds.
      const swept = await worktreesApi.cleanupAgentWorktrees({
        repoRoot: root,
        protectedPaths: [named.folderPath],
        dryRun: true,
      })
      assert.equal(swept.repoRoot, root)
      assert.ok(!swept.entries.some((entry) => entry.path === named.folderPath && entry.verdict === 'removed'))

      // Settings ▸ Worktrees' install choice is the machine's pool's own.
      const saved = await worktreesApi.setWorktreePoolSettings(
        { dependencyInstall: { [root]: { enabled: true, command: 'true' } } },
        root,
      )
      assert.deepEqual(saved.dependencyInstall[root], { enabled: true, command: 'true' })
      assert.deepEqual((await worktreesApi.getWorktreePoolSettings(root)).dependencyInstall[root], {
        enabled: true,
        command: 'true',
      })
    } finally {
      releaseNewChatWorktreeReservation('door')
      closeEnvironmentStudios(api as never)
      delete host.window
      await route?.close()
      env.disconnect()
      broker.close()
    }
  },
)
