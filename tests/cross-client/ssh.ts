import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAskpassBroker } from '../../src/main/environments/ssh/askpass'
import { DOCKER_TESTS, prepareSshdImage, startSshd } from '../../src/main/environments/ssh/__fixtures__/docker-sshd'
import { parseDestination, spawnSshSession } from '../../src/main/environments/ssh/ssh-command'
import { SshEnvironment } from '../../src/main/environments/ssh/ssh-environment'
import { ensureNodeBinary, serverTreeDigest } from '../../src/main/environments/ssh/ssh-install'
import type { SessionProcess } from '../../src/main/environments/ssh/ssh-session'
import { BACKEND_WIRE_VERSION } from '../../src/server/wsl/backend-wire'
import type { ConversationEvent } from '../../src/shared/conversation-runtime'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../src/shared/ssh-environments'
import { MOCK_PROVIDER } from './client'
import type { Matrix } from './matrix'

// An SSH machine, for real: the dockerized sshd the SSH machine suites use,
// the desktop's SSH environment (ssh-environment.ts) installing the server tree
// and the pinned Node there and starting it, and a chat on the fake provider
// driven over the backend wire. That wire is today's path to an SSH machine's
// chats; plan step 9 replaces it with a direct environment, and this leg's
// client with it.

export const SSH_TRANSPORT = 'backend wire (SSH environment)'

type Backend = {
  startSession(input: unknown): Promise<unknown>
  sendTurn(input: unknown): Promise<unknown>
  respondToRequest(input: unknown): Promise<unknown>
  readTranscript(input: unknown): Promise<unknown>
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

function nextEvent(backend: Backend, test: (event: ConversationEvent) => boolean, what: string, ms = 30_000) {
  return new Promise<ConversationEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`ssh: no ${what} in ${ms / 1000} s`))
    }, ms)
    const stop = backend.onEvent((event) => {
      if (!test(event)) return
      clearTimeout(timer)
      stop()
      resolve(event)
    })
  })
}

function ok<T>(result: unknown, what: string): T {
  const outcome = result as { ok?: boolean; message?: string }
  if (!outcome || outcome.ok === false) throw new Error(`ssh: ${what}: ${outcome?.message ?? 'no answer'}`)
  return result as T
}

const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 200))
  return check()
}

export async function runSshLeg(input: { root: string; scratch: string; matrix: Matrix; cacheDir: string }) {
  const { matrix } = input
  matrix.client('ssh', SSH_TRANSPORT, [
    'the remote machine: a container with a real sshd and the system ssh; the server tree and Node are really installed there',
  ])
  if (!DOCKER_TESTS) {
    matrix.notRun('ssh', 'no Docker here (CI runs it; locally set STUDIO_TEST_DOCKER=1 with Docker running)')
    return
  }
  await prepareSshdImage()
  const tree = join(input.scratch, 'ssh-tree')
  execFileSync(process.execPath, [join(input.root, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: input.root,
    stdio: 'pipe',
  })
  const digest = serverTreeDigest(tree)
  const version = (JSON.parse(readFileSync(join(input.root, 'package.json'), 'utf8')) as { version: string }).version
  const sshd = startSshd({ sshdOptions: ['AllowTcpForwarding no', 'AllowStreamLocalForwarding no'] })
  const broker = await createAskpassBroker({
    runAsNode: false,
    ask: async (request) => (request.kind === 'host-key' ? 'yes' : null),
  })
  const destination = parseDestination('build-box')
  if (!destination.ok) throw new Error('ssh: build-box is not a destination')
  const sessions: SessionProcess[] = []
  const env: SshEnvironment = new SshEnvironment({
    id: 'gate',
    label: () => 'build-box',
    settings: () => ({ ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }),
    spawn: ({ interactive }) => {
      const child = spawnSshSession({
        ssh: 'ssh',
        destination: destination.destination,
        label: 'build-box',
        interactive,
        askpass: broker,
        configFile: sshd.configFile,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }) as unknown as SessionProcess
      sessions.push(child)
      return child
    },
    app: { version, channel: 'latest', backendWire: BACKEND_WIRE_VERSION },
    dataName: 'data',
    startedBy: 'Studio on dev-macbook-air',
    serverTree: () => ({ dir: tree, digest }),
    nodeBinary: (target) => ensureNodeBinary(target, { cacheDir: input.cacheDir, subject: 'build-box' }),
    onChange: () => undefined,
    timing: { backoff: { baseMs: 200, maxMs: 1_000 } },
  })
  const key = { workspaceRoot: '/home/dev/repo', workspaceId: 'w-ssh', agentId: 'ssh-chat' }
  const serverPid = () =>
    Number(
      sshd.exec(
        'sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' /home/dev/.local/share/sprintengine-studio/data/run/server.json',
      ),
    )
  try {
    let backend = (await env.connect({ interactive: true })).backend as unknown as Backend
    sshd.exec('mkdir -p /home/dev/repo', 'dev')
    let sessionId = ''
    await matrix.run('ssh', 'create', async () => {
      sessionId = ok<{ session: { sessionId: string } }>(
        await backend.startSession({ ...key, ...MOCK_PROVIDER }),
        'start',
      ).session.sessionId
    })

    let approval: ConversationEvent | null = null
    await matrix.run('ssh', 'stream', async () => {
      const reply = nextEvent(backend, (event) => event.type === 'content_delta', 'reply')
      const asking = nextEvent(backend, (event) => event.type === 'approval_requested', 'approval')
      // Answered when the turn ends; the session is dropped before that, and
      // the call in flight fails with the wire, as it does in the app.
      backend.sendTurn({ sessionId, message: 'turn on build-box', commandId: 'ssh-1' }).catch(() => undefined)
      if (String((await reply).payload?.text) !== 'Mock response for: turn on build-box')
        throw new Error('ssh: the reply is not the turn’s')
      approval = await asking
    })

    // The session drops while the turn waits; the server keeps it; a new
    // session finds the same turn still waiting, and its answer ends it.
    await matrix.run('ssh', 'resume', async () => {
      if (!approval) throw new Error('ssh: no turn to resume')
      sessions.at(-1)!.kill()
      if (!(await until(() => env.summary().state !== 'connected', 10_000)))
        throw new Error('ssh: the dropped session was not noticed')
      backend = (await env.connect({ interactive: true })).backend as unknown as Backend
      const done = nextEvent(backend, (event) => event.type === 'turn_completed', 'end of the turn')
      ok(
        await backend.respondToRequest({
          sessionId,
          requestId: String(approval.payload?.requestId),
          approved: true,
        }),
        'answer',
      )
      await done
    })
    await matrix.run('ssh', 'approval', async () => {
      const transcript = JSON.stringify(await backend.readTranscript(key))
      if (!transcript.includes('approval_resolved')) throw new Error('ssh: the approval is not in the transcript')
    })

    // The machine's server dies; the environment starts it again and the
    // chat goes on from its transcript.
    await matrix.run('ssh', 'restart', async () => {
      const before = serverPid()
      sshd.exec(`kill -9 ${before}`)
      env.disconnect()
      backend = (await env.connect({ interactive: true })).backend as unknown as Backend
      const after = serverPid()
      if (!(after > 0 && after !== before)) throw new Error('ssh: the server was not started again')
      sessionId = ok<{ session: { sessionId: string } }>(
        await backend.startSession({ ...key, ...MOCK_PROVIDER }),
        'start again',
      ).session.sessionId
      const asking = nextEvent(backend, (event) => event.type === 'approval_requested', 'approval after the restart')
      backend.sendTurn({ sessionId, message: 'after the restart', commandId: 'ssh-2' }).catch(() => undefined)
      await asking
      const transcript = JSON.stringify(await backend.readTranscript(key))
      if (!transcript.includes('turn on build-box')) throw new Error('ssh: the chat lost its history')
    })
    for (const scenario of ['upload', 'subagent', 'schedule'] as const)
      await matrix.run('ssh', scenario, async () => {
        throw new Error(`the SSH leg has no call to ${scenario} over the backend wire`)
      })
  } finally {
    env.disconnect()
    broker.close()
    sshd.stop()
  }
}
