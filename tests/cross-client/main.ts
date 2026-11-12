import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { StudioClient } from '../../packages/agent-sdk/src/index'
import { ClientCannot, type ChatRef, type GateClient } from './client'
import { desktopClient } from './clients/desktop'
import { answerOf, embedClient, parseEmbedLink } from './clients/embed'
import { peerClient } from './clients/peer'
import { phoneClient, type PhoneProtocol } from './clients/phone'
import { startCutter, type Cutter } from './cutter'
import { approvalAfter, isReplyTo, isUserMessage, resolvedAfter, type Feed, type GateEvent } from './feed'
import type { HostConfig, HostReady } from './host'
import { Matrix } from './matrix'
import { runSshLeg } from './ssh'

// The cross-client gate (scripts/cross-client-gate.mjs bundles and runs this).
// One real Studio server build, started by a host process, and several clients
// on it at once, each the code that surface really runs: the desktop window
// over the Studio protocol, a paired desktop and the phone over the tailnet
// lane, a read-only embed, and an SSH machine. They share one chat, and every
// scenario is checked from every client's side: what one does, all see.

type Options = { root: string; serverBundle: string; hostBundle: string; phoneBundle: string; requireSsh: boolean }

const options = JSON.parse(process.argv[2] ?? '{}') as Options
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The server host process: started, asked, killed and started again. */
class Host {
  private child: ChildProcess | null = null
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private next = 0
  ready: HostReady | null = null
  stderr = ''

  constructor(
    private readonly config: Omit<HostConfig, 'firstBoot'>,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async start(firstBoot: boolean): Promise<HostReady> {
    const config: HostConfig = { ...this.config, firstBoot }
    const child = spawn(process.execPath, [options.hostBundle, JSON.stringify(config)], {
      env: this.env,
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-20_000)
    })
    return new Promise<HostReady>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`The server host was not ready in 90 s:\n${this.stderr}`)),
        90_000,
      )
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`The server host exited (${code}) before it was ready:\n${this.stderr}`))
      })
      createInterface({ input: child.stdout! }).on('line', (line) => {
        let message: { ready?: HostReady; fatal?: string; id?: number; result?: unknown; error?: string }
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        if (message.ready) {
          clearTimeout(timer)
          this.ready = message.ready
          resolve(message.ready)
        } else if (message.fatal) reject(new Error(`The server host failed: ${message.fatal}\n${this.stderr}`))
        else if (typeof message.id === 'number') {
          const waiting = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.error) waiting?.reject(new Error(message.error))
          else waiting?.resolve(message.result)
        }
      })
    })
  }

  request<T>(body: Record<string, unknown>): Promise<T> {
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.child?.stdin?.write(`${JSON.stringify({ id, ...body })}\n`)
    })
  }

  /** Killed, as a crash kills it: nothing drains. */
  async kill(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(15_000).then(() => child.kill('SIGKILL'))])
  }
}

function makeRepository(path: string): void {
  mkdirSync(path, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'Developer')
  git('config', 'user.email', 'dev@example.com')
  writeFileSync(join(path, 'README.md'), 'The cross-client gate’s project.\n')
  writeFileSync(join(path, '.gitignore'), '.sprintengine/\n')
  git('add', '.')
  git('commit', '-qm', 'Initial files')
}

async function main(): Promise<number> {
  const started = Date.now()
  const matrix = new Matrix()
  // A short directory: a socket path has to fit in sun_path.
  const scratch = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'se-gate-'))
  const home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  const repository = join(scratch, 'repo')
  makeRepository(repository)
  // Nothing of this machine's own Studio is read: a home of its own, and none of its variables.
  const hostEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: join(home, '.local', 'share'),
    }).filter(([key]) => !key.startsWith('SPRINTENGINE_')),
  )
  const clients: GateClient[] = []
  const cutters: Cutter[] = []
  const cutter = async (target: Parameters<typeof startCutter>[0], path?: string) => {
    const made = await startCutter(target, path ? { path } : undefined)
    cutters.push(made)
    return made
  }
  const webPort = await freePort()
  // The embed's page is served through its cutter, so the server is told
  // that address is its own (as `--public-origin` tells one behind a proxy).
  const embedCutter = await cutter({ port: webPort })
  if (!('port' in embedCutter.address)) throw new Error('The embed’s cutter has no port.')
  const embedOrigin = `http://127.0.0.1:${embedCutter.address.port}`
  const host = new Host(
    {
      bundle: options.serverBundle,
      dataDir: join(scratch, 'data'),
      appRoot: options.root,
      repository,
      webPort,
      publicOrigins: [embedOrigin],
      tailnetPort: await freePort(),
      shellSocket: join(scratch, 'shell.sock'),
    },
    hostEnv,
  )
  try {
    const ready = await host.start(true)
    if (!ready.tailnet.running) throw new Error(`The tailnet listener did not start: ${ready.tailnet.detail}`)
    if (!ready.web) throw new Error('The web listener did not start.')
    const project = { workspaceId: ready.workspaceId, workspaceRoot: repository }
    const tailnetPort = Number(ready.tailnet.detail.split(':').at(-1))
    const pairingToken = async () => (await host.request<{ token: string }>({ op: 'pairing' })).token

    const desktopCutter = await cutter({ path: join(scratch, 'shell.sock') }, join(scratch, 'window.sock'))
    const peerCutter = await cutter({ port: tailnetPort })
    const phoneCutter = await cutter({ port: tailnetPort })
    const desktop = desktopClient(desktopCutter, async (chat, patch) => {
      await host.request({ op: 'recordChat', workspaceId: chat.workspaceId, agentId: chat.agentId, patch })
    })
    const peer = await peerClient({
      cutter: peerCutter,
      dataDir: join(scratch, 'peer'),
      pairingToken,
    })
    const protocol = require(options.phoneBundle) as PhoneProtocol
    const phone = await phoneClient({ cutter: phoneCutter, protocol, pairingToken })
    const writers = [desktop, peer, phone]
    clients.push(desktop, peer, phone)
    for (const client of writers) matrix.client(client.id, client.transport, client.simulated)
    matrix.simulate(
      'the Electron app is not launched: the window runs its real client code in Node (the packaged app has smoke:server-mode)',
    )
    matrix.simulate('the agent: the built-in fake provider (mock-provider); no agent CLI runs')

    // create: the desktop starts the chat everyone shares; the others try
    // their own way and are held to the list of known gaps.
    let chat: ChatRef | null = null
    await matrix.run('desktop', 'create', async () => {
      chat = await desktop.createChat!(project, 'gate-chat')
    })
    if (!chat) throw new Error('The desktop could not start the chat the scenarios share; nothing else can run.')
    const shared: ChatRef = chat
    for (const client of [peer, phone])
      await matrix.run(client.id, 'create', () => client.createChat!(project, `gate-${client.id}-chat`))

    const feeds = new Map<GateClient, Feed>()
    for (const client of writers) feeds.set(client, await client.follow(shared))

    // The embed: minted for the shared chat by the server's own command, as a person does.
    const embedUrl = execFileSync(
      process.execPath,
      [
        options.serverBundle,
        'embed',
        '--data-dir',
        join(scratch, 'data'),
        '--workspace',
        shared.workspaceId,
        '--agent',
        shared.agentId,
      ],
      { env: hostEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    const link = parseEmbedLink(embedUrl.split('\n')[0])
    const embed = embedClient({ cutter: embedCutter, link: async () => link })
    clients.push(embed)
    matrix.client(embed.id, embed.transport, embed.simulated)
    feeds.set(embed, await embed.follow(shared))
    const cutterOf = new Map<GateClient, Cutter>([
      [desktop, desktopCutter],
      [peer, peerCutter],
      [phone, phoneCutter],
      [embed, embedCutter],
    ])
    const all = () => [...feeds.values()]
    const feedOf = (client: GateClient) => feeds.get(client)!

    /** Every client sees `test` hold of the shared chat. */
    const everyone = (test: (feed: Feed) => boolean, what: string, ms?: number) =>
      Promise.all(all().map((feed) => feed.until(test, what, ms)))
    for (const feed of all()) await feed.until((each) => each.seqs.length > 0, 'the chat’s first page', 30_000)

    /** The approval the turn that sent `text` waits on, as the desktop's feed has it. */
    const pendingApproval = async (text: string, feed: Feed = feedOf(desktop)) => {
      await feed.until((each) => approvalAfter(each, text) !== undefined, `the approval after "${text}"`)
      return String(approvalAfter(feed, text)!.payload?.requestId)
    }
    /** Answer whatever the turn that sent `text` waits on, so the next scenario starts clean. */
    const settle = async (text: string) => {
      const requestId = await pendingApproval(text)
      await desktop.answerApproval!(shared, requestId, true)
      await everyone((feed) => resolvedAfter(feed, requestId), `the turn after "${text}" ending`)
    }
    const streamedTo = (text: string) => (feed: Feed) =>
      feed.find(isUserMessage(text)) !== undefined &&
      feed.find(isReplyTo(text)) !== undefined &&
      approvalAfter(feed, text) !== undefined

    // stream and approval: each writer sends a turn, and the next one along answers it.
    const embedSaw: boolean[] = []
    for (const [index, sender] of writers.entries()) {
      const answerer = writers[(index + 1) % writers.length]
      const text = `turn from ${sender.id}`
      const sent = await matrix.run(sender.id, 'stream', async () => {
        if (!sender.send) throw new ClientCannot(sender.id, 'send a turn')
        await sender.send(shared, text)
        await everyone(streamedTo(text), `"${text}" streamed`)
      })
      embedSaw.push(sent && streamedTo(text)(feedOf(embed)))
      if (!sent) continue
      await matrix.run(answerer.id, 'approval', async () => {
        if (!answerer.answerApproval) throw new ClientCannot(answerer.id, 'answer an approval')
        const requestId = await pendingApproval(text, feedOf(answerer))
        await answerer.answerApproval(shared, requestId, true)
        await everyone((feed) => resolvedAfter(feed, requestId), `the approval of "${text}" answered`)
      })
      // A turn its answerer could not end is ended by the desktop, so the next starts clean.
      const waiting = approvalAfter(feedOf(desktop), text)?.payload?.requestId
      if (waiting && !resolvedAfter(feedOf(desktop), String(waiting))) await settle(text)
    }
    await matrix.run('embed', 'stream', async () => {
      if (!embedSaw.some(Boolean) || embedSaw.includes(false))
        throw new Error('the embed did not see every turn the writers streamed')
    })

    // upload: a message with a picture, from each writer.
    for (const sender of writers) {
      const text = `picture from ${sender.id}`
      const path = join(scratch, `${sender.id}.png`)
      writeFileSync(path, PICTURE)
      const sent = await matrix.run(sender.id, 'upload', async () => {
        if (!sender.sendWithAttachment) throw new ClientCannot(sender.id, 'send a picture')
        await sender.sendWithAttachment(shared, text, {
          name: `${sender.id}.png`,
          mediaType: 'image/png',
          bytes: PICTURE,
          path,
        })
        await everyone((feed) => {
          const message = feed.find(isUserMessage(text))
          return Array.isArray(message?.payload?.attachments) && (message.payload.attachments as unknown[]).length === 1
        }, `"${text}" with its picture`)
      })
      if (sent) await settle(text)
    }

    // subagent: the chat starts a background agent, and each writer messages it.
    let subagent: string | null = null
    try {
      await desktop.send!(shared, '/subagent')
      await everyone(
        (feed) =>
          feed.find((event) => event.type === 'subagent_status' && event.payload?.status === 'running') !== undefined,
        'a sub-agent running',
      )
      subagent = String(feedOf(desktop).find((event) => event.type === 'subagent_status')!.payload?.toolUseId)
    } catch (error) {
      console.log(`  (the chat could not start a sub-agent: ${error instanceof Error ? error.message : String(error)})`)
    }
    for (const sender of writers) {
      const text = `note from ${sender.id}`
      const sent = await matrix.run(sender.id, 'subagent', async () => {
        if (!subagent) throw new Error('the chat has no running sub-agent to message')
        if (!sender.messageSubagent) throw new ClientCannot(sender.id, 'message a sub-agent')
        await sender.messageSubagent(shared, subagent, text)
        await everyone(
          (feed) =>
            feed.find(
              (event) =>
                event.type === 'user_message' &&
                (event.payload?.subagentMessage as { text?: string } | undefined)?.text === text,
            ) !== undefined,
          `"${text}" passed to the sub-agent`,
        )
      })
      if (sent) {
        const relayed = feedOf(desktop).find(
          (event) => (event.payload?.subagentMessage as { text?: string } | undefined)?.text === text,
        )
        await settle(String(relayed?.payload?.text))
      }
    }

    // schedule: each writer schedules a send an hour out; the clients that
    // list scheduled sends see it. They are checked again after the restart.
    const listers = writers.filter((client) => client.scheduleSend)
    const scheduledBy = new Map<GateClient, string>()
    for (const sender of writers) {
      const text = `scheduled by ${sender.id}`
      const ok = await matrix.run(sender.id, 'schedule', async () => {
        if (!sender.scheduleSend) throw new ClientCannot(sender.id, 'schedule a send')
        await sender.scheduleSend(shared, text, Date.now() + 60 * 60_000)
        await Promise.all(
          listers.map((client) =>
            feedOf(client).until(
              (feed) => feed.scheduled?.some((message) => message.text === text) === true,
              `"${text}" in the scheduled list`,
            ),
          ),
        )
      })
      if (ok) scheduledBy.set(sender, text)
    }

    /**
     * Back by its cursor: every event the server's transcript has after the
     * cursor reached it, none twice, and no page replaced what it held.
     */
    const resumedFrom = async (client: GateClient, before: { cursor: number; duplicates: number; resets: number }) => {
      const feed = feedOf(client)
      const transcript = await host.request<GateEvent[]>({
        op: 'transcript',
        workspaceId: shared.workspaceId,
        agentId: shared.agentId,
      })
      const held = new Set(feed.seqs)
      const lost = transcript.filter(
        (event) => typeof event.seq === 'number' && event.seq > before.cursor && !held.has(event.seq),
      )
      if (lost.length)
        throw new Error(
          `${lost.length} event(s) never arrived: ${lost.map((event) => `${event.seq} ${event.type}`).join(', ')}`,
        )
      if (feed.duplicates !== before.duplicates)
        throw new Error(`${feed.duplicates - before.duplicates} event(s) were handed over twice`)
      if (feed.resets !== before.resets) throw new Error('it came back with a snapshot, not by its cursor')
    }

    // resume: each client is cut off mid-turn and misses what the others do.
    for (const client of [desktop, peer, phone, embed]) {
      const driver = client === desktop ? peer : desktop
      await matrix.run(client.id, 'resume', async () => {
        const feed = feedOf(client)
        const before = `before ${client.id} drops`
        const missed = `while ${client.id} was away`
        await driver.send!(shared, before)
        await feed.until((each) => approvalAfter(each, before) !== undefined, `"${before}" waiting`)
        const cursor = feed.cursor ?? 0
        const { duplicates, resets } = feed
        const opened = cutterOf.get(client)!.opened
        client.cut()
        await sleep(500)
        const requestId = await pendingApproval(before, feedOf(driver))
        await driver.answerApproval!(shared, requestId, true)
        await driver.send!(shared, missed)
        await feedOf(driver).until((each) => approvalAfter(each, missed) !== undefined, `"${missed}" waiting`)
        if (approvalAfter(feed, missed))
          throw new Error('it heard what happened while it was cut off: the cut did not cut')
        client.heal()
        client.resume?.()
        await feed.until((each) => approvalAfter(each, missed) !== undefined, `"${missed}" after coming back`, 30_000)
        await resumedFrom(client, { cursor, duplicates, resets })
        if (cutterOf.get(client)!.opened <= opened) throw new Error('it never opened a new connection')
      })
      // A row that failed may have left its turn waiting; the next row starts clean or says why it cannot.
      await settle(`while ${client.id} was away`).catch((error: unknown) =>
        console.log(`  (the turn sent while ${client.id} was away could not be ended: ${String(error)})`),
      )
    }

    // restart: the server is killed with a turn waiting, and started again.
    const inFlight = 'in flight at the restart'
    await desktop.send!(shared, inFlight)
    await pendingApproval(inFlight)
    const openedBefore = new Map([...cutterOf].map(([client, made]) => [client, made.opened]))
    const heldBefore = new Map(
      all().map((feed) => [feed, { cursor: feed.cursor ?? 0, duplicates: feed.duplicates, resets: feed.resets }]),
    )
    await host.kill()
    await host.start(false)
    /**
     * Came back by itself over a new connection and by its cursor: whatever the
     * server wrote of the turn the kill cut off, and everything after, every
     * client holds alike.
     */
    const cameBack = async (client: GateClient) => {
      if (cutterOf.get(client)!.opened <= openedBefore.get(client)!) throw new Error('it never opened a new connection')
      await resumedFrom(client, heldBefore.get(feedOf(client))!)
    }
    for (const sender of writers) {
      const text = `after the restart from ${sender.id}`
      const sent = await matrix.run(sender.id, 'restart', async () => {
        await feedOf(sender).until((feed) => feed.live, 'its connection back', 60_000)
        await sender.send!(shared, text)
        await everyone(streamedTo(text), `"${text}" streamed`, 60_000)
        await cameBack(sender)
        // What was scheduled before the restart is still there.
        const kept = scheduledBy.get(sender)
        if (kept && listers.includes(sender))
          await feedOf(sender).until(
            (feed) => feed.scheduled?.some((message) => message.text === kept) === true,
            `"${kept}" kept across the restart`,
          )
      })
      if (sent) await settle(text)
    }
    await matrix.run('embed', 'restart', async () => {
      await cameBack(embed)
      for (const sender of writers)
        if (!feedOf(embed).find(isUserMessage(`after the restart from ${sender.id}`)))
          throw new Error(`the embed did not see the turn ${sender.id} sent after the restart`)
    })
    // A scheduled send goes out now, from a client that did not schedule it.
    const scheduled = [...scheduledBy.entries()]
    if (scheduled.length) {
      const [owner, text] = scheduled[0]
      const sender = listers.find((client) => client !== owner) ?? owner
      const id = feedOf(sender).scheduled?.find((message) => message.text === text)?.id
      if (id && sender.sendScheduledNow) {
        await sender.sendScheduledNow(shared, id)
        await everyone((feed) => feed.find(isUserMessage(text)) !== undefined, `"${text}" sent now, after the restart`)
        await settle(text)
      } else throw new Error(`"${text}" could not be sent now after the restart`)
    }

    // isolation: the embed asks for more than its one chat, reading.
    const other = await desktop.createChat!(project, 'gate-other-chat')
    await matrix.run('embed', 'isolation', async () => {
      // A turn waits on its approval, so answering it is a real ask.
      const waiting = 'waiting while the embed asks'
      await desktop.send!(shared, waiting)
      const requestId = await pendingApproval(waiting)
      // Each ask is well formed (typed by the protocol's method map), and the
      // window's own connection is answered for every one of them below: only
      // the embed's frame gate and read-only grant stand in its way.
      const own = { workspaceId: shared.workspaceId, agentId: shared.agentId }
      const otherChat = { workspaceId: other.workspaceId, agentId: other.agentId }
      type Ask = (client: StudioClient, who: 'embed' | 'owner') => Promise<unknown>
      const asks: Array<[string, Ask]> = [
        ['list the chats', (client) => client.request('conversation.list', {})],
        [
          'read another chat',
          (client) =>
            new Promise((resolve, reject) => {
              const stop = client.conversations.follow(otherChat, {}, (frame) => {
                stop()
                if (frame.type === 'error') reject(new Error(frame.message))
                else resolve(frame)
              })
              void client.closed.then(() => reject(new Error('The connection to Studio closed.')), reject)
            }),
        ],
        [
          'answer an approval',
          (client, who) =>
            client.request('conversation.resolveApproval', {
              key: own,
              commandId: `${who}-approve`,
              requestId,
              decision: 'once',
            }),
        ],
        [
          'send into its chat',
          (client, who) =>
            client.request('conversation.send', { key: own, commandId: `${who}-send`, message: `from the ${who}` }),
        ],
      ]
      // What an embed may do, asked the same way, is answered: the probe can tell.
      if (!(await embed.probe((client) => client.request('server.ping', {}))).allowed)
        throw new Error('the probe could not ask even what an embed may: it proves nothing')
      // Refused by the frame gate (it ends the socket) or the read-only grant (forbidden), and nothing else.
      const refusedAsItShould = /connection to Studio closed|forbidden|not allowed|permission|scope/iu
      const wrong: string[] = []
      for (const [what, ask] of asks) {
        const answer = await embed.probe((client) => ask(client, 'embed'))
        if (answer.allowed) wrong.push(`${what} (allowed)`)
        else if (!refusedAsItShould.test(answer.why)) wrong.push(`${what} (refused, but as "${answer.why}")`)
      }
      if (wrong.length) throw new Error(`the embed was not held to its chat: ${wrong.join('; ')}`)
      if (resolvedAfter(feedOf(desktop), requestId)) throw new Error('the embed’s answer reached the chat')
      if (feedOf(desktop).find(isUserMessage('from the embed'))) throw new Error('the embed’s send reached the chat')
      // The same asks from the window, an owner: each is answered.
      const owner = await desktop.studio()
      for (const [what, ask] of asks) {
        const answer = await answerOf(ask(owner, 'owner'))
        if (!answer.allowed)
          throw new Error(`the window could not ${what} either (${answer.why}): the ask proves nothing`)
      }
      await everyone((feed) => resolvedAfter(feed, requestId), 'the approval the window answered')
      await settle('from the owner')
      // And the embed still follows its own chat.
      await feedOf(embed).until(
        (feed) => feed.find(isUserMessage('from the owner')) !== undefined,
        'its own chat, still, after its asks',
      )
    })

    for (const client of clients) await client.close()
    clients.length = 0
    await host.stop()

    await runSshLeg({
      root: options.root,
      scratch,
      matrix,
      cacheDir: process.env.STUDIO_TEST_CACHE || join(tmpdir(), 'se-ssh-node-cache'),
    })
  } catch (error) {
    console.log(`\nThe gate stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    if (host.stderr) console.log(`\nThe server host said:\n${host.stderr.slice(-4_000)}`)
    for (const client of clients) await client.close().catch(() => undefined)
    await host.kill()
    for (const made of cutters) await made.close()
    rmSync(scratch, { recursive: true, force: true })
    matrix.report({ requireAll: options.requireSsh, stopped: true })
    return 1
  }
  for (const made of cutters) await made.close()
  rmSync(scratch, { recursive: true, force: true })
  const code = matrix.report({ requireAll: options.requireSsh })
  console.log(`\n(${Math.round((Date.now() - started) / 1000)} s)`)
  return code
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  },
)
