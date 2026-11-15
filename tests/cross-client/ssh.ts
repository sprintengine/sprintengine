import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAskpassBroker } from '../../src/main/environments/ssh/askpass'
import { DOCKER_TESTS, prepareSshdImage, startSshd } from '../../src/main/environments/ssh/__fixtures__/docker-sshd'
import { parseDestination, spawnSshSession } from '../../src/main/environments/ssh/ssh-command'
import { SshEnvironment } from '../../src/main/environments/ssh/ssh-environment'
import { ensureNodeBinary, serverTreeDigest } from '../../src/main/environments/ssh/ssh-install'
import type { SessionProcess } from '../../src/main/environments/ssh/ssh-session'
import { createLoopbackRoute } from '../../src/main/environments/environment-route'
import { adoptedRecordDigest } from '../../src/server/environment/environment-adoption'
import { connect, webSocketTransport, type StudioClient } from '../../packages/client-runtime/src/public'
import { createStudioConversationParts } from '../../src/renderer/src/components/panels/agentChat/studioChat'
import { machineStudioClient } from '../../src/shared/machine-studio-client'
import { machineSpellingOf } from '../../src/shared/machine-spelling'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../src/shared/ssh-environments'
import { GATE_WINDOW_ORIGIN, MOCK_PROVIDER } from './client'
import { approvalAfter, Feed, isReplyTo, isUserMessage, resolvedAfter, type GateEvent } from './feed'
import { followChat, newChatThere, okOf, until, windowWebSocket } from './machine-chat'
import type { Matrix } from './matrix'

// An SSH machine, for real: the dockerized sshd the SSH machine suites use,
// the desktop's SSH environment (ssh-environment.ts) installing the server tree
// and the pinned Node there and starting it, and a chat on the fake provider.
// The chat is driven the way a desktop window drives one now
// (design-wsl-ssh-direct PR 1d): the window's own Studio client of the
// machine, over main's loopback route through the front door (`ws`), with a
// ticket the machine's window listener minted for the window's origin, and the
// chat view's calls over it (`createStudioConversationParts`). Its paths are
// spelled as this computer spells them (`ssh://gate/…`) and respelled at the
// client's edge, as the window's are. A chat is made where the machine keeps
// it: New chat's record in the machine's own registry.

export const SSH_TRANSPORT = 'Studio protocol (window client over the loopback route, SSH environment)'

const ok = okOf('ssh')

const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

export async function runSshLeg(input: {
  root: string
  /** The server tree as `npm run build:server:wsl` builds it, built on the first ask. */
  serverTree: () => string
  matrix: Matrix
  cacheDir: string
}) {
  const { matrix } = input
  matrix.client('ssh', SSH_TRANSPORT, [
    'the remote machine: a container with a real sshd and the system ssh; the server tree and Node are really installed there',
  ])
  if (!DOCKER_TESTS) {
    matrix.notRun('ssh', 'no Docker here (CI runs it; locally set STUDIO_TEST_DOCKER=1 with Docker running)')
    return
  }
  await prepareSshdImage()
  const tree = input.serverTree()
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
  // The chat as the window names it: its folder spelled for this computer.
  const key = { workspaceRoot: 'ssh://gate/home/dev/repo', workspaceId: 'w-ssh', agentId: 'ssh-chat' }
  let env: SshEnvironment | null = null
  const machine = () => {
    if (!env) throw new Error('ssh: no environment yet')
    return env
  }
  // The desktop cut off from the machine: its environment's next sessions
  // fail at once, as ssh does with the network down, until it is let back.
  let cutOff = false
  const machineFor = (id: string, wiring: { cut: boolean }) =>
    new SshEnvironment({
      id,
      label: () => 'build-box',
      settings: () => ({ ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }),
      spawn: ({ interactive }) => {
        if (wiring.cut && cutOff)
          return spawn(process.execPath, ['-e', 'process.exit(255)']) as unknown as SessionProcess
        const child = spawnSshSession({
          ssh: 'ssh',
          destination: destination.destination,
          label: 'build-box',
          interactive,
          askpass: broker,
          configFile: sshd.configFile,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        }) as unknown as SessionProcess
        if (wiring.cut) sessions.push(child)
        return child
      },
      app: { version, channel: 'latest' },
      dataName: 'data',
      startedBy: 'Studio on dev-macbook-air',
      serverTree: () => ({ dir: tree, digest }),
      nodeBinary: (target) => ensureNodeBinary(target, { cacheDir: input.cacheDir, subject: 'build-box' }),
      onChange: () => undefined,
      timing: { backoff: { baseMs: 200, maxMs: 1_000 } },
    })
  env = machineFor('gate', { cut: true })
  // A second desktop on the same machine's server, which the window does not
  // reach: what it does while the first is cut off is what the first's
  // catch-up has to bring.
  const other = machineFor('gate-other', { cut: false })
  // Its chat calls go to the machine's Studio on its own owner connection,
  // the chat's paths respelled at that edge, as main's are.
  const otherParts = createStudioConversationParts(async () =>
    machineStudioClient((await other.connect({ interactive: true })).owner, machineSpellingOf('ssh:gate')!),
  )
  const serverPid = () =>
    Number(
      sshd.exec(
        'sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' /home/dev/.local/share/sprintengine-studio/data/run/server.json',
      ),
    )
  // Main's loopback route to the machine's front door, and the window's client
  // over it: each connection on a ticket the machine's window listener mints
  // for the window's origin, asked over main's owner connection, as main asks.
  const loopback = createLoopbackRoute({
    open: async () => {
      const connection = machine().current()
      if (!connection) throw new Error('build-box is not connected.')
      return connection.open('ws')
    },
  })
  let windowClient: Promise<StudioClient> | null = null
  const windowStudio = async (): Promise<StudioClient> => {
    windowClient ??= loopback.port().then((port) =>
      connect({
        transport: webSocketTransport({
          ticket: async () => {
            const connection = machine().current()
            if (!connection) throw new Error('build-box is not connected.')
            const minted = await connection.owner.request('environment.windowTicket', {
              windowKey: 'window-gate-1',
              origin: GATE_WINDOW_ORIGIN,
            })
            return { url: `ws://127.0.0.1:${port}${minted.path}`, token: minted.token }
          },
          WebSocket: windowWebSocket(),
        }),
        client: { name: 'Studio window' },
        // As the window's environment client (environmentStudio.ts) connects.
        reconnect: { initialDelayMs: 500, maxDelayMs: 30_000 },
        parkWhenOffline: false,
      }),
    )
    return machineStudioClient(await windowClient, machineSpellingOf('ssh:gate')!)
  }
  const parts = createStudioConversationParts(windowStudio)
  let stopFollowing: () => void = () => undefined
  try {
    sshd.exec('mkdir -p /home/dev/repo', 'dev')
    // The first connect asks the person about the host key, as Settings does.
    await env.connect({ interactive: true })
    const feed = new Feed('ssh')
    /** Nothing after `cursor` that the machine's transcript has is missing, none twice, and no snapshot. */
    /**
     * The session API caught the chat up after the wire came back (a join ran
     * to its `synchronized`), and nothing after `cursor` that the machine's
     * transcript has is missing, none twice, and no snapshot replaced it.
     */
    const resumedFrom = async (
      before: ReturnType<typeof mark>,
      arrived: (each: Feed) => boolean = () => false,
      ms = 60_000,
    ) => {
      await feed
        .until((each) => each.syncs > before.syncs || arrived(each), 'the catch-up after the machine came back', ms)
        .catch(async (error: unknown) => {
          const client = await (windowClient as Promise<StudioClient> | null)?.catch(() => null)
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} (window client ${client?.state ?? 'none'}; last stream error: ${feed.lastError ?? 'none'})`,
          )
        })
      const read = await (await windowStudio()).conversations.loadEarlier(key, Number.MAX_SAFE_INTEGER, 100)
      const transcript = ok<{ page: { events: GateEvent[] } }>(read, 'transcript').page
      const held = new Set(feed.seqs)
      const lost = transcript.events.filter(
        (event) => typeof event.seq === 'number' && event.seq > before.cursor && !held.has(event.seq),
      )
      if (lost.length) throw new Error(`ssh: ${lost.length} event(s) never arrived`)
      if (feed.duplicates !== before.duplicates) throw new Error('ssh: events were handed over twice')
      if (feed.resets !== before.resets) throw new Error('ssh: it came back with a snapshot, not by its cursor')
    }
    function mark() {
      return { cursor: feed.cursor ?? 0, duplicates: feed.duplicates, resets: feed.resets, syncs: feed.syncs }
    }
    let sessionId = ''
    const send = (message: string, extra: Record<string, unknown> = {}) =>
      // Answered when the turn ends, which may be after this connection goes:
      // a call in flight then fails with the wire, as it does in the app.
      void parts.send({ sessionId, message, commandId: `ssh-${Date.now()}`, ...extra } as never).catch(() => undefined)
    const answer = async (text: string) => {
      await feed.until((each) => approvalAfter(each, text) !== undefined, `the approval after "${text}"`, 30_000)
      const requestId = String(approvalAfter(feed, text)!.payload?.requestId)
      ok(await parts.respond({ sessionId, requestId, approved: true }), 'answer')
      await feed.until((each) => resolvedAfter(each, requestId), `"${text}" ending`, 30_000)
    }

    // The window's New chat on build-box, and the chat view's follow of it.
    const follow = () => {
      stopFollowing = followChat(parts, key, feed)
    }
    await matrix.run('ssh', 'create', async () => {
      sessionId = await newChatThere({ leg: 'ssh', label: 'build-box', client: await windowStudio(), parts, key })
      follow()
      await feed.until((each) => each.syncs > 0, 'the chat followed', 30_000)
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

    // The desktop is cut off from the machine while the turn waits, and a
    // second desktop answers it meanwhile. The first comes back by itself
    // (BatchMode: the key needs no passphrase), the window's client connects
    // again on a fresh ticket, and its follow catches up by its cursor: the
    // turn's end was published while nothing of this desktop's was there.
    await matrix.run('ssh', 'resume', async () => {
      const requestId = String(approvalAfter(feed, first)?.payload?.requestId ?? '')
      if (!requestId) throw new Error('ssh: no turn waiting to resume')
      const before = mark()
      const dropped = machine().current()
      cutOff = true
      sessions.at(-1)!.kill()
      if (!(await until(() => machine().current() !== dropped, 10_000)))
        throw new Error('ssh: the dropped session was not noticed')
      ok(await otherParts.respond({ sessionId, requestId, approved: true } as never), 'answer')
      await until(() => false, 1_000)
      if (resolvedAfter(feed, requestId))
        throw new Error('ssh: the cut-off desktop heard the answer: the cut did not cut')
      cutOff = false
      if (!(await until(() => machine().current() !== null && machine().summary().state === 'connected', 60_000)))
        throw new Error(`ssh: the environment did not come back by itself (${machine().summary().stateText})`)
      await resumedFrom(before)
      if (!resolvedAfter(feed, requestId)) throw new Error('ssh: the catch-up did not carry the turn’s end')
    })
    // The approval a turn raised on one session, answered on the next.
    await matrix.run('ssh', 'approval', async () => {
      const requestId = String(approvalAfter(feed, first)?.payload?.requestId ?? '')
      if (!requestId || !resolvedAfter(feed, requestId)) throw new Error('ssh: the approval was not answered')
    })

    // The machine keeps its chats' background work: a message scheduled from
    // the window, and a pull request handed over watched, go on there with
    // this desktop gone (its window closed, its SSH session ended), and are
    // there when it comes back.
    await matrix.run('ssh', 'schedule', async () => {
      const text = 'scheduled on build-box'
      // The chat at rest first, so the message goes at its time rather than
      // after a turn still running.
      await parts.interrupt({ sessionId } as never).catch(() => undefined)
      await until(() => false, 1_500)
      ok(await parts.scheduleSend({ key, message: text, sendAt: Date.now() + 4_000 }), 'schedule a message')
      const url = 'https://github.com/example/repo/pull/7'
      const body = { workspaceId: key.workspaceId, agentId: key.agentId, url, watched: true }
      const handed = await machine()
        .current()!
        .owner.request('environment.adopt', {
          commandId: 'gate-adopt',
          migrationId: 'gate-migration',
          records: [{ kind: 'pull-request', id: url, digest: adoptedRecordDigest(body), body }],
        })
      if (handed.conflicts.length) throw new Error(`ssh: the watch was not kept: ${handed.conflicts[0]!.reason}`)
      // The desktop goes: its window and its session to the machine.
      stopFollowing()
      ;(await (windowClient as Promise<StudioClient> | null))?.close()
      windowClient = null
      cutOff = true
      env!.disconnect()
      await until(() => false, 8_000)
      cutOff = false
      // Connected again by the person, as Settings › Machines does after a Disconnect.
      await machine().connect({ interactive: true })
      const client = await windowStudio()
      // Sent by the machine at its time, or as soon as the chat's turn let it.
      let went = false
      for (let tries = 0; tries < 30 && !went; tries++) {
        const read = ok<{ page: { events: GateEvent[] } }>(
          await client.conversations.loadEarlier(key, Number.MAX_SAFE_INTEGER, 100),
          'transcript',
        )
        went = read.page.events.some(isUserMessage(text))
        if (!went) await until(() => false, 1_000)
      }
      if (!went) {
        let held: unknown = null
        const stop = client.subscribe('conversation.scheduled', { key }, { onPayload: (frame) => (held = frame) })
        await until(() => held !== null, 3_000)
        stop()
        throw new Error(
          `ssh: the scheduled message did not go while the desktop was away (still kept: ${JSON.stringify(held)})`,
        )
      }
      const listed = await client.request('pullRequests.list', {
        conversations: [{ workspaceId: key.workspaceId, agentId: key.agentId }],
      })
      const kept = listed.conversations.flatMap((entry) => entry.pullRequests).find((entry) => entry.url === url)
      if (!kept?.watch) throw new Error('ssh: the watched pull request was not kept watched on build-box')
      follow()
      await feed.until((each) => each.find(isUserMessage(text)) !== undefined, `"${text}" followed again`, 30_000)
      await answer(text)
    })

    await matrix.run('ssh', 'upload', async () => {
      const text = 'picture on build-box'
      sshd.exec(`echo ${PICTURE.toString('base64')} | base64 -d > /home/dev/repo/notes.png`, 'dev')
      send(text, {
        attachments: [
          { id: 'picture-1', name: 'picture.png', mediaType: 'image/png', dataBase64: PICTURE.toString('base64') },
        ],
        files: [{ path: 'ssh://gate/home/dev/repo/notes.png' }],
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
      ok(await parts.messageSubagent!({ sessionId, toolUseId, message: text }), 'message the sub-agent')
      const said = (event: GateEvent) =>
        (event.payload?.subagentMessage as { text?: string } | undefined)?.text === text
      await feed.until((each) => each.find(said) !== undefined, `"${text}" passed to the sub-agent`, 30_000)
      await answer(String(feed.find(said)?.payload?.text))
    })

    // The machine's server dies under a live SSH session, and the desktop is
    // kept off the machine while a second desktop starts it again and runs a
    // turn. The first notices the death by itself (its own connection to the
    // server ends, whatever the session says), then catches up by its cursor
    // and goes on. A desktop that did not notice is failed, after a Reconnect
    // shows whether the rest would have held.
    await matrix.run('ssh', 'restart', async () => {
      const pid = serverPid()
      const before = mark()
      const dropped = machine().current()
      cutOff = true
      sshd.exec(`kill -9 ${pid}`)
      const noticed = await until(
        () => machine().current() !== dropped || machine().summary().state !== 'connected',
        30_000,
      )
      const stateAfter = `${machine().summary().state}: ${machine().summary().stateText}`
      if (!noticed) machine().disconnect()
      const away = 'while the desktop was away from build-box'
      // The second desktop noticed too, and may be reconnecting by itself; it
      // is made to connect now, which starts the server or attaches to the one
      // its own reconnect started.
      other.disconnect()
      await other.connect({ interactive: true })
      const after = serverPid()
      if (!(after > 0 && after !== pid)) throw new Error('ssh: the server was not started again')
      sessionId = ok<{ session: { sessionId: string } }>(
        await otherParts.startSession!({ ...key, ...MOCK_PROVIDER }),
        'start again',
      ).session.sessionId
      void otherParts.send({ sessionId, message: away, commandId: 'ssh-away' } as never).catch(() => undefined)
      await until(() => false, 2_000)
      if (feed.find(isUserMessage(away)))
        throw new Error('ssh: the cut-off desktop heard the turn: the cut did not cut')
      cutOff = false
      if (noticed) {
        if (!(await until(() => machine().current() !== null && machine().summary().state === 'connected', 60_000)))
          throw new Error(`ssh: the environment did not come back by itself (${machine().summary().stateText})`)
      } else await machine().connect({ interactive: true })
      // A server started again holds the chat anew: the client's own resume
      // brings what it missed by its cursor, with or without a fresh fence.
      // The window notices a server gone by its heartbeat (30 s quiet, 10 s
      // to answer) when no socket closes, then reconnects on its backoff.
      await resumedFrom(before, (each) => approvalAfter(each, away) !== undefined, 120_000)
      if (!approvalAfter(feed, away)) throw new Error('ssh: the catch-up did not carry the turn run while it was away')
      await answer(away)
      if (!feed.find(isUserMessage(first))) throw new Error('ssh: the chat lost its history')
      if (!noticed)
        throw new Error(
          `ssh: the environment did not notice its server die (still "${stateAfter}" 30 s later); a Reconnect brought it back, by its cursor`,
        )
    })
  } finally {
    stopFollowing()
    const lastWindow = windowClient as Promise<StudioClient> | null
    ;(await lastWindow?.catch(() => null))?.close()
    loopback.close()
    other.disconnect()
    env.disconnect()
    broker.close()
    sshd.stop()
  }
}
