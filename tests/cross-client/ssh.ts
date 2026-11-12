import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAskpassBroker } from '../../src/main/environments/ssh/askpass'
import { DOCKER_TESTS, prepareSshdImage, startSshd } from '../../src/main/environments/ssh/__fixtures__/docker-sshd'
import { parseDestination, spawnSshSession } from '../../src/main/environments/ssh/ssh-command'
import { SshEnvironment } from '../../src/main/environments/ssh/ssh-environment'
import { ensureNodeBinary, serverTreeDigest } from '../../src/main/environments/ssh/ssh-install'
import type { SessionProcess } from '../../src/main/environments/ssh/ssh-session'
import { ConversationSessionApi } from '../../src/main/conversation-session-api'
import type { ConversationBackend } from '../../src/server/core/conversation-backend'
import { createRoutedConversationBackend } from '../../src/server/core/routed-conversation-backend'
import { BACKEND_WIRE_VERSION } from '../../src/server/wsl/backend-wire'
import type { ConversationSessionFrame } from '../../src/shared/conversation-runtime'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../src/shared/ssh-environments'
import { ClientCannot, MOCK_PROVIDER } from './client'
import { approvalAfter, Feed, isReplyTo, isUserMessage, resolvedAfter, type GateEvent } from './feed'
import type { Matrix } from './matrix'

// An SSH machine, for real: the dockerized sshd the SSH machine suites use,
// the desktop's SSH environment (ssh-environment.ts) installing the server tree
// and the pinned Node there and starting it, and a chat on the fake provider.
// The chat is driven the way the desktop drives one: through its router
// (routed-conversation-backend.ts), which reaches the machine over the backend
// wire, and followed through its session API (conversation-session-api.ts),
// whose catch-up after a reconnect is what the resume rows hold to. Once SSH
// machines are environments a client connects to directly, this leg's client
// changes with them.

export const SSH_TRANSPORT = 'backend wire (desktop router, SSH environment)'

/** The router answers for no chat on this machine: the leg's only project is on build-box. */
function noLocalChats(): ConversationBackend {
  return new Proxy({} as ConversationBackend, {
    get(_target, member: string) {
      if (member === 'then') return undefined
      if (member === 'onEvent') return () => () => undefined
      if (member === 'listSessions') return () => ({ ok: true, sessions: [] })
      if (member === 'listLiveConversationRoots') return () => []
      return () => {
        throw new Error(`ssh: the leg asked this machine for ${member}`)
      }
    },
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
  const key = { workspaceRoot: '/home/dev/repo', workspaceId: 'w-ssh', agentId: 'ssh-chat' }
  let env: SshEnvironment | null = null
  const machine = () => {
    if (!env) throw new Error('ssh: no environment yet')
    return env
  }
  // The desktop's router, with the project recorded on the machine, and its
  // session API over it: what a window's chat on build-box follows.
  const router = createRoutedConversationBackend({
    local: noLocalChats(),
    workspace: (workspaceId) =>
      workspaceId === key.workspaceId
        ? { folderPath: key.workspaceRoot, environment: { kind: 'ssh', id: 'gate' } }
        : null,
    chatServerOn: () => false,
    servers: null,
    ssh: {
      connect: async () => machine().connect({ interactive: false }),
      current: () => machine().current(),
      touch: () => undefined,
    },
  })
  let resumes = 0
  router.onRouteResumed(() => (resumes += 1))
  const conversations = new ConversationSessionApi(router)
  env = new SshEnvironment({
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
    // As the desktop wires it: a session that is up again is the router's to follow.
    onConnected: (connection) => router.attach(connection),
    timing: { backoff: { baseMs: 200, maxMs: 1_000 } },
  })
  const serverPid = () =>
    Number(
      sshd.exec(
        'sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' /home/dev/.local/share/sprintengine-studio/data/run/server.json',
      ),
    )
  let stopFollowing: () => void = () => undefined
  try {
    sshd.exec('mkdir -p /home/dev/repo', 'dev')
    // The first connect asks the person about the host key, as Settings does.
    await env.connect({ interactive: true })
    const feed = new Feed('ssh')
    /** Nothing after `cursor` that the machine's transcript has is missing, none twice, and no snapshot. */
    const resumedFrom = async (cursor: number, before: { duplicates: number; resets: number; resumes: number }) => {
      if (resumes <= before.resumes) throw new Error('ssh: the router never caught its chats up')
      const transcript = ok<{ events: GateEvent[] }>(await router.readTranscript(key), 'transcript')
      await feed.until(
        (each) => {
          const held = new Set(each.seqs)
          return transcript.events.every(
            (event) => typeof event.seq !== 'number' || event.seq <= cursor || held.has(event.seq),
          )
        },
        'every event after its cursor',
        30_000,
      )
      if (feed.duplicates !== before.duplicates) throw new Error('ssh: events were handed over twice')
      if (feed.resets !== before.resets) throw new Error('ssh: it came back with a snapshot, not by its cursor')
    }
    const mark = () => ({ cursor: feed.cursor ?? 0, duplicates: feed.duplicates, resets: feed.resets, resumes })
    let sessionId = ''
    const send = (message: string, extra: Record<string, unknown> = {}) =>
      // Answered when the turn ends, which may be after this connection goes:
      // a call in flight then fails with the wire, as it does in the app.
      void router
        .sendTurn({ sessionId, message, commandId: `ssh-${Date.now()}`, ...extra } as never)
        .catch(() => undefined)
    const answer = async (text: string) => {
      await feed.until((each) => approvalAfter(each, text) !== undefined, `the approval after "${text}"`, 30_000)
      const requestId = String(approvalAfter(feed, text)!.payload?.requestId)
      ok(await router.respondToRequest({ sessionId, requestId, approved: true } as never), 'answer')
      await feed.until((each) => resolvedAfter(each, requestId), `"${text}" ending`, 30_000)
    }

    await matrix.run('ssh', 'create', async () => {
      sessionId = ok<{ session: { sessionId: string } }>(
        await router.startSession({ ...key, ...MOCK_PROVIDER } as never),
        'start',
      ).session.sessionId
      const following = conversations.subscribe({ key, turnLimit: 50 }, (frame: ConversationSessionFrame) => {
        if (frame.type === 'snapshot')
          feed.snapshot(frame.page.events, {
            ...(frame.reset ? { reset: true } : {}),
            ...(frame.generation ? { generation: frame.generation } : {}),
          })
        else if (frame.type === 'event') feed.event(frame.event)
        else if (frame.type === 'error') feed.side({ lastError: frame.message })
      })
      stopFollowing = following.dispose
      await following.ready
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

    // The SSH session drops while the turn waits. The environment comes back
    // by itself (BatchMode: the key needs no passphrase), the router catches
    // its chats up, and the answer sent meanwhile ends the turn: all of it
    // reaches the follower by its cursor.
    await matrix.run('ssh', 'resume', async () => {
      const requestId = String(approvalAfter(feed, first)?.payload?.requestId ?? '')
      if (!requestId) throw new Error('ssh: no turn waiting to resume')
      const before = mark()
      const dropped = machine().current()
      sessions.at(-1)!.kill()
      if (!(await until(() => machine().current() !== dropped && machine().summary().state === 'connected', 60_000)))
        throw new Error(`ssh: the environment did not come back by itself (${machine().summary().stateText})`)
      ok(await router.respondToRequest({ sessionId, requestId, approved: true } as never), 'answer')
      await resumedFrom(before.cursor, before)
      if (!resolvedAfter(feed, requestId)) throw new Error('ssh: the turn’s end never reached the follower')
    })
    // The approval a turn raised on one session, answered on the next.
    await matrix.run('ssh', 'approval', async () => {
      const requestId = String(approvalAfter(feed, first)?.payload?.requestId ?? '')
      if (!requestId || !resolvedAfter(feed, requestId)) throw new Error('ssh: the approval was not answered')
    })

    await matrix.run('ssh', 'upload', async () => {
      const text = 'picture on build-box'
      sshd.exec(`echo ${PICTURE.toString('base64')} | base64 -d > /home/dev/repo/notes.png`, 'dev')
      send(text, {
        attachments: [
          { id: 'picture-1', name: 'picture.png', mediaType: 'image/png', dataBase64: PICTURE.toString('base64') },
        ],
        files: [{ path: '/home/dev/repo/notes.png' }],
      })
      await feed.until(
        (each) => {
          const message = each.find(isUserMessage(text))
          return (
            Array.isArray(message?.payload?.attachments) &&
            (message.payload.attachments as unknown[]).length === 1 &&
            Array.isArray(message.payload.files) &&
            (message.payload.files as unknown[]).length === 1
          )
        },
        `"${text}" with its picture and its file`,
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
      ok(await router.messageSubagent({ sessionId, toolUseId, message: text } as never), 'message the sub-agent')
      const said = (event: GateEvent) =>
        (event.payload?.subagentMessage as { text?: string } | undefined)?.text === text
      await feed.until((each) => each.find(said) !== undefined, `"${text}" passed to the sub-agent`, 30_000)
      await answer(String(feed.find(said)?.payload?.text))
    })

    await matrix.run('ssh', 'schedule', async () => {
      throw new ClientCannot(
        'the SSH leg',
        'schedule a send: the desktop’s scheduler keeps them, and this leg runs none',
      )
    })

    // The machine's server dies. The environment should notice, reconnect by
    // itself and start the server again, and the chat come back by its cursor
    // and go on. Today it does not notice while the SSH session stays up (a
    // known gap): then the person's Reconnect is checked to bring it all back,
    // and the row says which.
    await matrix.run('ssh', 'restart', async () => {
      const pid = serverPid()
      const before = mark()
      const dropped = machine().current()
      sshd.exec(`kill -9 ${pid}`)
      const byItself = await until(
        () =>
          machine().current() !== null && machine().current() !== dropped && machine().summary().state === 'connected',
        30_000,
      )
      const stateAfter = `${machine().summary().state}: ${machine().summary().stateText}`
      if (!byItself) {
        machine().disconnect()
        await machine().connect({ interactive: true })
      }
      const after = serverPid()
      if (!(after > 0 && after !== pid)) throw new Error('ssh: the server was not started again')
      await resumedFrom(before.cursor, before)
      sessionId = ok<{ session: { sessionId: string } }>(
        await router.startSession({ ...key, ...MOCK_PROVIDER } as never),
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
    stopFollowing()
    env.disconnect()
    broker.close()
    sshd.stop()
  }
}
