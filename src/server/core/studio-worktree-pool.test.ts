import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

import { defaultAgent } from '../../shared/agent-state'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { SOLO_CHAT_TEMPLATE_AGENT_ID, SOLO_CHAT_TEMPLATE_ID } from '../../shared/layouts/templates'
import { agentWorktreePaths } from '../../shared/worktree-paths'
import { createGitWorktree } from '../../main/git'
import { activeWorktreePool, installWorktreePool } from '../../main/worktree-pool/active-pool'
import { poolIdFor, type PoolRecord } from '../../main/worktree-pool/pool-store'
import { bindGatewayConversation } from '../tools/client-tool-gateway'
import { createNodeStudioPlatform, resetStudioPlatform } from '../platform/platform'
import { createStudioCore } from './studio-core'
import { createStudioGateway } from './studio-gateway'
import { studioPullRequestWakes } from './studio-pull-request-wakes'

// The worktree pool is the Studio core's, in every mode (studio-worktree-pool.ts):
// a core composed under plain Node, as a server out of process or on another
// machine composes it, keeps the pool, serves `worktree.*`, and brings a chat's
// returned slot back before its agent runs, whichever door the turn came in
// by: a paired phone's send, a scheduled message, a pull request's wake. Real
// git, the real pool and runtime; the mock provider is the only stand-in.

const execFileAsync = promisify(execFile)
const identity = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}
const saved: Record<string, string | undefined> = {}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return stdout.trim()
}

/** The branch checked out at `path` now, read at once: '' when detached. */
function branchNow(path: string): string {
  return execFileSync('git', ['-C', path, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
}

let scratch = ''

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'se-studio-worktree-pool-')))
  for (const [key, value] of Object.entries({ ...identity, HOME: join(scratch, 'home') })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  await mkdir(join(scratch, 'home'), { recursive: true })
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  installWorktreePool(null)
  resetStudioPlatform()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

/** A project cloned from an origin of its own, in a folder of the case's. */
async function project(name: string): Promise<string> {
  const dir = join(scratch, name)
  const seed = join(dir, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, 'init', '-q', '-b', 'main')
  await writeFile(join(seed, 'README.md'), '# app\n')
  await writeFile(join(seed, '.gitignore'), '.installed\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  const origin = join(dir, 'origin.git')
  await git(dir, 'clone', '-q', '--bare', seed, origin)
  const repo = join(dir, 'app')
  await git(dir, 'clone', '-q', origin, repo)
  return repo
}

function serverCore(dataDir: string) {
  return createStudioCore(createNodeStudioPlatform({ dataDir, packaged: false, version: '0.0.0-test' }), {
    role: 'server',
  })
}

/** An agent's connection as the gateway leaves it once its launch token checked out. */
function provenAgent(workspaceId: string, agentId: string): McpConnectionContext {
  const context: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId, agentId } }
  bindGatewayConversation(context, { workspaceId, agentId })
  return context
}

test('a core keeps the pool: a returned slot is brought back on its branch before a phone send, a scheduled message or a pull request wake starts the agent', async () => {
  const repo = await project('restore')
  const core = serverCore(join(scratch, 'restore', 'data'))
  try {
    // The pool is this core's, installed for the process's agent worktrees.
    assert.equal(activeWorktreePool(), core.worktrees.pool)
    const gateway = createStudioGateway(core)
    const listed = gateway.ownTools().map((tool) => tool.name)
    assert.ok(listed.includes('worktree.lease') && listed.includes('worktree.release'), 'the gateway serves worktree.*')
    await gateway.shutdown()

    // A chat's worktree, cut as New chat, `conversation.create` and a
    // scheduled run cut theirs: from this core's pool.
    const paths = agentWorktreePaths(repo, 'chat', 'agent')
    assert.ok(paths)
    const created = await createGitWorktree({
      repoRoot: repo,
      containerPath: paths.containerPath,
      destinationPath: paths.destinationPath,
      branchName: paths.branchName,
      baseRef: 'HEAD',
      fromPool: true,
      copyIncludedFiles: true,
      agentLockOwner: paths.branchName,
    })
    assert.ok(created.ok, created.ok ? '' : created.message)
    assert.ok(created.data.leaseId, 'leased from the pool, not a fresh worktree')
    const slot = created.data.path
    const branch = created.data.branch!

    // The chat's record, as a launch writes it: a conversation agent on the
    // mock provider, in a workspace marked as a worktree of the project.
    const agentId = 'agent-chat'
    const made = core.workspaceSyncService.createWorkspace(
      {
        name: 'chat',
        folderPath: slot,
        templateId: SOLO_CHAT_TEMPLATE_ID,
        worktree: { branch, repoRoot: repo },
        templateAgentIds: { [SOLO_CHAT_TEMPLATE_AGENT_ID]: agentId },
        agents: {
          [agentId]: {
            ...defaultAgent(agentId, 'chat'),
            runtimeKind: 'conversation',
            conversation: { providerId: 'mock-provider', modelId: 'mock-model' },
          },
        },
      },
      'system',
    )
    assert.ok(made.ok, made.ok ? '' : made.message)
    const workspaceId = made.result.workspace.id
    const key = { workspaceId, agentId, workspaceRoot: slot }

    // What the branch was each time a turn of this chat started.
    const atTurnStart: string[] = []
    const turnEnded: Array<() => void> = []
    core.conversations.onEvent((event: ConversationEvent) => {
      if (event.workspaceId !== workspaceId) return
      if (event.type === 'turn_started') atTurnStart.push(branchNow(slot))
      if (event.type === 'turn_completed') for (const done of turnEnded.splice(0)) done()
    })
    const nextTurnEnd = () => new Promise<void>((resolve) => turnEnded.push(resolve))

    // The chat's first turn, so it has a thread to resume from.
    const started = await core.conversations.startSession({
      ...key,
      providerId: 'mock-provider',
      modelId: 'mock-model',
    })
    assert.ok(started.ok, started.ok ? '' : started.message)
    let ended = nextTurnEnd()
    assert.equal(
      (await core.conversations.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })).ok,
      true,
    )
    await ended

    /** The chat goes idle and its slot goes back to the pool, detached, as an idle return leaves it. */
    const giveBack = async () => {
      const listedSessions = core.conversations.listSessions({ workspaceId })
      for (const session of listedSessions.ok ? listedSessions.sessions : []) {
        await core.conversations.stopSession({ sessionId: session.sessionId })
      }
      const snapshot = await core.worktrees.pool.snapshot(repo)
      const lease = snapshot?.slots.find((candidate) => candidate.path === slot)?.lease
      assert.ok(lease, 'the slot is leased to the chat')
      assert.equal(await core.worktrees.pool.release(lease.leaseId), 'returned')
      assert.equal(branchNow(slot), '', 'given back detached')
      assert.equal(core.worktrees.pool.awaitsChat(slot, branch), true)
    }

    // A paired phone's send: the conversation host every remote door wraps.
    await giveBack()
    ended = nextTurnEnd()
    const phone = core.createConversationHost()
    const phoneKey = phone.resolveKey(workspaceId, agentId)
    assert.ok(phoneKey)
    const sent = await phone.command(phoneKey, 'android-phone', 'phone-send-1', { kind: 'send', message: '/tools' })
    assert.equal(sent.ok, true, sent.ok ? '' : (sent.message ?? 'refused'))
    await ended
    assert.equal(atTurnStart.at(-1), branch, 'the phone’s turn started on the chat’s branch')

    // A scheduled message, due now, sent by the core's own timer once its
    // start-up grace is over (a quarter of a minute).
    await giveBack()
    ended = nextTurnEnd()
    const scheduled = core.scheduledMessages.scheduleFrom({ workspaceId, agentId }, '/tools', Date.now() + 50, 'test')
    assert.equal(scheduled.ok, true, scheduled.ok ? '' : scheduled.reason)
    await ended
    assert.equal(atTurnStart.at(-1), branch, 'the scheduled turn started on the chat’s branch')

    // A watched pull request waking the chat, through the wakes the core builds.
    await giveBack()
    ended = nextTurnEnd()
    const wakes = studioPullRequestWakes({
      conversations: core.conversations,
      workspaceRecord: (id) => core.workspaceRegistry.getRecord(id) ?? null,
      createHost: (options) => core.createConversationHost(options),
    })
    const woke = await wakes.send({ workspaceId, agentId }, '/tools', 'pr-wake-1')
    assert.equal(woke.ok, true, woke.ok ? '' : (woke.message ?? 'refused'))
    await ended
    assert.equal(atTurnStart.at(-1), branch, 'the wake’s turn started on the chat’s branch')

    assert.equal(atTurnStart.length, 4)
    assert.ok(
      atTurnStart.every((each) => each === branch),
      `every turn started on ${branch}: ${atTurnStart.join(', ')}`,
    )
  } finally {
    await core.shutdown()
  }
})

test('worktree.lease and worktree.release are the core gateway’s, install where the project opted in, and a restarted core recovers a lease a crash cut short', async () => {
  const repo = await project('lease')
  const dataDir = join(scratch, 'lease', 'data')
  let core = serverCore(dataDir)
  let gateway = createStudioGateway(core)
  const tool = (name: string) => {
    const found = gateway.ownTools().find((candidate) => candidate.name === name)
    assert.ok(found, name)
    return found
  }
  let shutDown = false
  try {
    const made = core.workspaceSyncService.createWorkspace(
      { name: 'app', folderPath: repo, templateId: SOLO_CHAT_TEMPLATE_ID },
      'system',
    )
    assert.ok(made.ok, made.ok ? '' : made.message)
    const workspaceId = made.result.workspace.id
    const agent = provenAgent(workspaceId, 'agent-1')
    // The project opted in, with a command of its own: the core's installer
    // runs it in the leased worktree before the lease answers.
    await core.worktrees.pool.updateSettings({
      dependencyInstall: { [repo]: { enabled: true, command: 'echo installed > .installed' } },
    })

    const leased = await tool('worktree.lease').handler({ name: 'by-tool' }, agent)
    assert.equal(leased.isError ?? false, false, JSON.stringify(leased))
    const answer = leased.structuredContent as { path: string; branch: string; dependencies: string }
    assert.equal(answer.branch, 'agent/by-tool')
    assert.match(answer.dependencies, /^Installed: `echo installed > \.installed` succeeded\./)
    assert.equal((await readFile(join(answer.path, '.installed'), 'utf8')).trim(), 'installed')
    const snapshot = await core.worktrees.pool.snapshot(repo)
    assert.equal(snapshot?.slots.find((slot) => slot.path === answer.path)?.lease?.agentId, 'agent-1')

    const released = await tool('worktree.release').handler({ path: answer.path }, agent)
    assert.equal((released.structuredContent as { released: boolean }).released, true)
    assert.equal((await core.worktrees.pool.snapshot(repo))?.slots[0]?.state, 'idle')

    // Leased again, and the process dies mid-lease: what a crash leaves is a
    // step the record says was under way.
    const again = await tool('worktree.lease').handler({ name: 'cut-short' }, agent)
    const cut = (again.structuredContent as { path: string }).path
    assert.equal(cut, answer.path, 'the idle slot is reused')
    await gateway.shutdown()
    await core.shutdown()
    shutDown = true
    const recordPath = join(dataDir, 'worktree-pool', `pool-${poolIdFor(join(repo, '.git'), 'local')}.json`)
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as PoolRecord
    for (const slot of record.slots) if (slot.path === cut) slot.op = { kind: 'lease', startedAt: 0, pid: 1 }
    await writeFile(recordPath, JSON.stringify(record))

    // The server starts again over the same data directory: the first use
    // of its pool finishes the interrupted lease as a return.
    core = serverCore(dataDir)
    gateway = createStudioGateway(core)
    shutDown = false
    assert.equal(activeWorktreePool(), core.worktrees.pool)
    const next = await tool('worktree.lease').handler({ name: 'after-crash' }, agent)
    assert.equal(next.isError ?? false, false, JSON.stringify(next))
    let state: string | undefined
    for (let tries = 0; tries < 200; tries += 1) {
      state = (await core.worktrees.pool.snapshot(repo))?.slots.find((slot) => slot.path === cut)?.state
      if (state !== 'returning' && state !== 'leasing') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const recovered = (await core.worktrees.pool.snapshot(repo))?.slots.find((slot) => slot.path === cut)
    assert.ok(
      recovered?.state === 'idle' || recovered?.lease?.branch === 'agent/after-crash',
      `the cut-short lease came back to the pool: ${JSON.stringify(recovered)}`,
    )
    assert.notEqual(recovered?.lease?.branch, 'agent/cut-short')
  } finally {
    if (!shutDown) {
      await gateway.shutdown()
      await core.shutdown()
    }
  }
})
