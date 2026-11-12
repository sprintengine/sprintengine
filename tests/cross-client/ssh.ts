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
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../src/shared/ssh-environments'
import { ClientCannot, MOCK_PROVIDER } from './client'
import { approvalAfter, Feed, isReplyTo, isUserMessage, resolvedAfter, type GateEvent } from './feed'
import type { Matrix } from './matrix'

// An SSH machine, for real: the dockerized sshd the SSH machine suites use,
// the desktop's SSH environment (ssh-environment.ts) installing the server tree
// and the pinned Node there and starting it, and a chat on the fake provider
// driven over the backend wire. That wire is today's path to an SSH machine's
// chats; once SSH machines are environments a client connects to directly, this leg's
// client with it.

export const SSH_TRANSPORT = 'backend wire (SSH environment)'

type TranscriptSync =
  | { kind: 'events'; events: GateEvent[]; generation: string }
  | { kind: 'snapshot'; page: { events: GateEvent[] }; generation: string }

type Backend = {
  readConversationSync(key: unknown, input: { afterSeq?: number; generation?: string }): Promise<unknown>
  messageSubagent(input: unknown): Promise<unknown>
  startSession(input: unknown): Promise<unknown>
  sendTurn(input: unknown): Promise<unknown>
  respondToRequest(input: unknown): Promise<unknown>
  readTranscript(input: unknown): Promise<unknown>
  onEvent(listener: (event: GateEvent & { workspaceId: string; agentId: string }) => void): () => void
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

const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

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
    sshd.exec('mkdir -p /home/dev/repo', 'dev')
    let connection = await env.connect({ interactive: true })
    let backend = connection.backend as unknown as Backend
    // The SSH chat, as the desktop follows it: live events while connected,
    // and after a reconnect the catch-up from its cursor (the router's resume).
    const feed = new Feed('ssh')
    let stopEvents: () => void = () => undefined
    const follow = (next: Backend) => {
      stopEvents()
      stopEvents = next.onEvent((event) => {
        if (event.workspaceId === key.workspaceId && event.agentId === key.agentId) feed.event(event)
      })
    }
    const catchUp = async (from: Backend) => {
      const read = ok<TranscriptSync>(
        await from.readConversationSync(key, {
          ...(feed.cursor === undefined ? {} : { afterSeq: feed.cursor }),
          ...(feed.generation === undefined ? {} : { generation: feed.generation }),
        }),
        'catch up',
      )
      if (read.kind === 'events') for (const event of read.events) feed.event(event)
      // Anything but the events after the cursor replaces what the feed held.
      else feed.snapshot(read.page.events, { reset: true })
      feed.side({ live: true })
      feed.generation = read.generation
    }
    /** Nothing after `cursor` that the machine's transcript has is missing, none twice, and no reset. */
    const resumedFrom = async (cursor: number, before: { duplicates: number; resets: number }) => {
      const transcript = ok<{ events: GateEvent[] }>(await backend.readTranscript(key), 'transcript')
      const held = new Set(feed.seqs)
      const lost = transcript.events.filter(
        (event) => typeof event.seq === 'number' && event.seq > cursor && !held.has(event.seq),
      )
      if (lost.length) throw new Error(`ssh: ${lost.length} event(s) never arrived`)
      if (feed.duplicates !== before.duplicates) throw new Error('ssh: events were handed over twice')
      if (feed.resets !== before.resets) throw new Error('ssh: it came back with a snapshot, not by its cursor')
    }
    let sessionId = ''
    const send = (message: string, extra: Record<string, unknown> = {}) =>
      // Answered when the turn ends, which may be after this connection goes:
      // a call in flight then fails with the wire, as it does in the app.
      void backend.sendTurn({ sessionId, message, commandId: `ssh-${Date.now()}`, ...extra }).catch(() => undefined)
    const answer = async (text: string) => {
      await feed.until((each) => approvalAfter(each, text) !== undefined, `the approval after "${text}"`, 30_000)
      const requestId = String(approvalAfter(feed, text)!.payload?.requestId)
      ok(await backend.respondToRequest({ sessionId, requestId, approved: true }), 'answer')
      await feed.until((each) => resolvedAfter(each, requestId), `"${text}" ending`, 30_000)
    }

    await matrix.run('ssh', 'create', async () => {
      sessionId = ok<{ session: { sessionId: string } }>(
        await backend.startSession({ ...key, ...MOCK_PROVIDER }),
        'start',
      ).session.sessionId
      await catchUp(backend)
      follow(backend)
    })

    const first = 'turn on build-box'
    await matrix.run('ssh', 'stream', async () => {
      send(first)
      await feed.until(
        (each) => each.find(isReplyTo(first)) !== undefined && approvalAfter(each, first) !== undefined,
        `"${first}" streamed`,
        30_000,
      )
    })

    // The session drops while the turn waits. The person's answer goes on the
    // next session before anything follows the chat again, so the turn's end
    // is missed and has to come back by the cursor.
    await matrix.run('ssh', 'resume', async () => {
      const requestId = String(approvalAfter(feed, first)?.payload?.requestId ?? '')
      if (!requestId) throw new Error('ssh: no turn waiting to resume')
      const cursor = feed.cursor ?? 0
      const before = { duplicates: feed.duplicates, resets: feed.resets }
      stopEvents()
      sessions.at(-1)!.kill()
      if (!(await until(() => env.summary().state !== 'connected', 10_000)))
        throw new Error('ssh: the dropped session was not noticed')
      connection = await env.connect({ interactive: true })
      backend = connection.backend as unknown as Backend
      ok(await backend.respondToRequest({ sessionId, requestId, approved: true }), 'answer')
      await until(() => false, 500)
      if (resolvedAfter(feed, requestId)) throw new Error('ssh: the feed heard the answer while it followed nothing')
      await catchUp(backend)
      follow(backend)
      if (!resolvedAfter(feed, requestId)) throw new Error('ssh: the catch-up did not carry the turn’s end')
      await resumedFrom(cursor, before)
    })
    // The approval a turn raised on one session, answered on the next.
    await matrix.run('ssh', 'approval', async () => {
      const requestId = String(approvalAfter(feed, first)?.payload?.requestId ?? '')
      if (!requestId || !resolvedAfter(feed, requestId)) throw new Error('ssh: the approval was not answered')
    })

    await matrix.run('ssh', 'upload', async () => {
      const text = 'picture on build-box'
      sshd.exec(`echo ${PICTURE.toString('base64')} | base64 -d > /home/dev/repo/picture.png`, 'dev')
      send(text, { files: [{ path: '/home/dev/repo/picture.png' }] })
      await feed.until(
        (each) => {
          const message = each.find(isUserMessage(text))
          return Array.isArray(message?.payload?.files) && (message.payload.files as unknown[]).length === 1
        },
        `"${text}" with its file`,
        30_000,
      )
      await answer(text)
    })

    await matrix.run('ssh', 'subagent', async () => {
      send('/subagent')
      await feed.until(
        (each) =>
          each.find((event) => event.type === 'subagent_status' && event.payload?.status === 'running') !== undefined,
        'a sub-agent running',
        30_000,
      )
      const toolUseId = String(feed.find((event) => event.type === 'subagent_status')!.payload?.toolUseId)
      const text = 'note on build-box'
      ok(await backend.messageSubagent({ sessionId, toolUseId, message: text }), 'message the sub-agent')
      await feed.until(
        (each) =>
          each.find((event) => (event.payload?.subagentMessage as { text?: string } | undefined)?.text === text) !==
          undefined,
        `"${text}" passed to the sub-agent`,
        30_000,
      )
      const relayed = feed.find(
        (event) => (event.payload?.subagentMessage as { text?: string } | undefined)?.text === text,
      )
      await answer(String(relayed?.payload?.text))
    })

    await matrix.run('ssh', 'schedule', async () => {
      throw new ClientCannot(
        'the SSH leg',
        'schedule a send: the desktop’s scheduler keeps them, and this leg runs none',
      )
    })

    // The machine's server dies. The environment should notice, reconnect by
    // itself (BatchMode: the key needs no passphrase) and start the server
    // again, and the chat come back by its cursor and go on. Today it does not
    // notice while the SSH session stays up (a known gap): then the person's
    // Reconnect is checked to bring it all back, and the row says which.
    await matrix.run('ssh', 'restart', async () => {
      const pid = serverPid()
      const cursor = feed.cursor ?? 0
      const before = { duplicates: feed.duplicates, resets: feed.resets }
      const dropped = connection
      sshd.exec(`kill -9 ${pid}`)
      const byItself = await until(
        () => env.current() !== null && env.current() !== dropped && env.summary().state === 'connected',
        30_000,
      )
      const stateAfter = `${env.summary().state}: ${env.summary().stateText}`
      if (!byItself) {
        env.disconnect()
        await env.connect({ interactive: true })
      }
      connection = env.current()!
      backend = connection.backend as unknown as Backend
      const after = serverPid()
      if (!(after > 0 && after !== pid)) throw new Error('ssh: the server was not started again')
      await catchUp(backend)
      follow(backend)
      await resumedFrom(cursor, before)
      sessionId = ok<{ session: { sessionId: string } }>(
        await backend.startSession({ ...key, ...MOCK_PROVIDER }),
        'start again',
      ).session.sessionId
      const text = 'after the restart'
      send(text)
      await answer(text)
      if (!feed.find(isUserMessage(first))) throw new Error('ssh: the chat lost its history')
      if (!byItself)
        throw new Error(
          `ssh: the environment did not notice its server die (still "${stateAfter}" 30 s later); a Reconnect brought it back, by its cursor`,
        )
    })
  } finally {
    env.disconnect()
    broker.close()
    sshd.stop()
  }
}
