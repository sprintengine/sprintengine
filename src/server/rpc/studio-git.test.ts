import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { STUDIO_GIT_METHODS, type StudioScope } from '../../../packages/studio-protocol/src/public'
import { createStudioFileSystem } from '../files/studio-file-system'
import { createStudioGit } from '../git/studio-git'
import type { StudioMachineCall } from './studio-file-system'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// Git on this machine over the owner socket, on real repositories: what an
// owner runs, what a paired app may name (never a repository whose real place
// is outside the folders Studio knows, by `..` or by a link), what only an
// owner may run, a ref that git would read as an option, an owner's
// repository on an SSH machine, and the streams.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', ...args], { cwd, encoding: 'utf8' })

function repo(at: string): string {
  mkdirSync(at, { recursive: true })
  git(at, 'init', '-q', '-b', 'main')
  git(at, 'config', 'user.email', 'dev@example.com')
  git(at, 'config', 'user.name', 'Dev')
  writeFileSync(join(at, 'a.txt'), 'alpha\n')
  git(at, 'add', 'a.txt')
  git(at, 'commit', '-q', '-m', 'first')
  return at
}

function disk() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-git-')))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const workspace = repo(join(base, 'workspace'))
  const outside = repo(join(base, 'outside'))
  const data = join(base, 'data')
  mkdirSync(data)
  symlinkSync(outside, join(base, 'workspace-link-out'))
  mkdirSync(join(workspace, 'nested'))
  symlinkSync(outside, join(workspace, 'nested', 'out'))
  return { base, workspace, outside, data }
}

async function serve(options: { machine?: StudioMachineCall; withGit?: boolean } = {}) {
  const at = disk()
  const started = await startTestServer({
    fileSystem: createStudioFileSystem({ readableRoots: () => [at.workspace], writableRoots: () => [at.workspace] }),
    ...(options.withGit === false ? {} : { git: createStudioGit({ dataDir: () => at.data }) }),
    ...(options.machine ? { machine: options.machine } : {}),
  })
  cleanups.push(() => started.dispose())
  return { started, ...at }
}

async function client(path: string, token: string) {
  const line = await connectLineClient(path)
  cleanups.push(() => line.close())
  line.send(hello({ token }))
  const welcome = await line.next((frame) => frame.t === 'welcome')
  let seq = 0
  return {
    line,
    welcome,
    async request(method: string, params: unknown) {
      const id = `r${++seq}`
      line.send({ t: 'req', id, method, params })
      return line.next((frame) => frame.t === 'res' && frame.id === id)
    },
    async subscribe(topic: string, params: unknown) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params })
      return id
    },
  }
}

type Frame = { t: string; ok?: boolean; error?: { code: string }; result?: unknown }
const codeOf = (frame: Frame) => (frame.t === 'res' && !frame.ok ? (frame.error?.code ?? null) : null)
const resultOf = <T>(frame: Frame) => {
  assert.equal(codeOf(frame), null, JSON.stringify(frame))
  return frame.result as T
}
let commands = 0
const cid = () => `c${++commands}`

test('a Studio advertises git only where its core gives it', async () => {
  const without = await serve({ withGit: false })
  const owner = await client(without.started.path, OWNER_TOKEN)
  assert.equal((owner.welcome as unknown as { capabilities: string[] }).capabilities.includes('git'), false)
  assert.equal(codeOf(await owner.request('git.status', { repoRoot: without.workspace })), 'unavailable')
  const served = await serve()
  const window = await client(served.started.path, OWNER_TOKEN)
  assert.equal((window.welcome as unknown as { capabilities: string[] }).capabilities.includes('git'), true)
})

test('an owner reads, stages, commits and keeps changelists; a retried commit is answered once', async () => {
  const { started, workspace } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  writeFileSync(join(workspace, 'b.txt'), 'beta\n')
  const status = resultOf<{ files: Record<string, unknown> }>(
    await owner.request('git.status', { repoRoot: workspace }),
  )
  assert.ok(JSON.stringify(status).includes('b.txt'))
  assert.equal(
    codeOf(
      await owner.request('git.stage', { commandId: cid(), repoRoot: workspace, paths: [join(workspace, 'b.txt')] }),
    ),
    null,
  )
  const commit = { commandId: 'commit-once', repoRoot: workspace, message: 'second' }
  const first = resultOf(await owner.request('git.commit', commit))
  assert.deepEqual(resultOf(await owner.request('git.commit', commit)), first)
  assert.equal(git(workspace, 'rev-list', '--count', 'HEAD').trim(), '2')
  const branches = resultOf(await owner.request('git.branches', { repoRoot: workspace }))
  assert.ok(JSON.stringify(branches).includes('main'))
  // A changelist write tells every follower.
  const lists = await owner.subscribe('git.changelistsChanged', {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  const made = resultOf<{ changelists: unknown[] }>(
    await owner.request('git.createChangelist', { commandId: cid(), repoRoot: workspace, name: 'Later' }),
  )
  assert.ok(made.changelists.length >= 1)
  const pushed = await owner.line.next((frame) => frame.t === 'push' && frame.sub === lists)
  assert.deepEqual(pushed.t === 'push' && pushed.payload, { repoRoot: workspace })
})

test('a ref, branch or commit that git would read as an option is refused before git runs', async () => {
  const { started, workspace } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  for (const [method, params] of [
    ['git.fileAtRev', { repoRoot: workspace, rev: '--output=/tmp/x', path: 'a.txt' }],
    ['git.switchBranch', { commandId: cid(), repoRoot: workspace, branch: '-f' }],
    ['git.checkoutCommit', { commandId: cid(), repoRoot: workspace, commit: '--orphan' }],
    ['git.mergeRef', { commandId: cid(), repoRoot: workspace, ref: '-Xours' }],
  ] as const)
    assert.deepEqual([method, codeOf(await owner.request(method, params))], [method, 'invalid_params'])
})

test('a paired app names only repositories really inside the folders Studio knows, and nothing that moves work', async () => {
  const { started, workspace, outside, base } = await serve()
  const scopes: StudioScope[] = ['files:read', 'files:write', 'providers:read', 'settings:write', 'workspaces:read']
  const app = await client(started.path, pairFakeClient(started.auth, 'app', scopes))
  assert.equal(codeOf(await app.request('git.status', { repoRoot: workspace })), null)
  for (const repoRoot of [
    outside,
    `${workspace}/../outside`,
    join(base, 'workspace-link-out'),
    join(workspace, 'nested', 'out'),
    'ssh://build-box/home/dev/app',
  ]) {
    assert.deepEqual([repoRoot, codeOf(await app.request('git.status', { repoRoot }))], [repoRoot, 'not_found'])
    const staged = await app.request('git.stage', { commandId: cid(), repoRoot, paths: ['a.txt'] })
    assert.deepEqual([repoRoot, codeOf(staged)], [repoRoot, 'not_found'])
    const summary = await app.request('git.changeSummary', { checkoutPath: repoRoot })
    assert.deepEqual([repoRoot, codeOf(summary)], [repoRoot, 'not_found'])
  }
  // A resolved conflict is written where the file really is: never through a link out of the repository.
  const through = { commandId: cid(), repoRoot: workspace, path: 'nested/out/a.txt', content: 'planted' }
  assert.equal(codeOf(await app.request('git.resolveConflict', through)), 'not_found')
  // Nor is a file read through one: the conflict view reads the working file itself.
  const peek = await app.request('git.conflictFile', { repoRoot: workspace, path: 'nested/out/a.txt' })
  assert.equal(codeOf(peek), 'not_found', JSON.stringify(peek))
  const own = resultOf<{ file: { result: string } | null }>(
    await app.request('git.conflictFile', { repoRoot: workspace, path: 'a.txt' }),
  )
  assert.equal(own.file?.result, 'alpha\n')
  const hunk = { repoRoot: outside, filePath: 'a.txt', scope: 'unstaged', index: 0, fingerprint: 'x' }
  assert.equal(codeOf(await app.request('git.stageHunk', { commandId: cid(), ref: hunk })), 'not_found')
  // What moves a branch, rewrites history, discards work, reaches a remote or holds the GitHub account is an owner's.
  for (const [method, spec] of Object.entries(STUDIO_GIT_METHODS))
    if (spec.owner) {
      const answer = await app.request(method, { commandId: cid(), repoRoot: workspace })
      assert.deepEqual([method, codeOf(answer)], [method, 'owner_required'])
    }
  // The checkout it may not name is not followed.
  const followed = await app.subscribe('git.checkoutChanged', { checkoutPath: outside })
  const failed = await app.line.next((frame) => frame.t === 'subFailed' && frame.sub === followed)
  assert.equal(failed.t === 'subFailed' && failed.code, 'not_found')
  assert.equal(git(outside, 'status', '--porcelain'), '')
  assert.equal(git(outside, 'show', 'HEAD:a.txt'), 'alpha\n')
})

test('a grant that may only read files stages nothing, and one that may only read chats reaches no git', async () => {
  const { started, workspace } = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['files:read']))
  const chats = await client(started.path, pairFakeClient(started.auth, 'chats', ['conversation:read']))
  assert.equal(codeOf(await reader.request('git.status', { repoRoot: workspace })), null)
  const stage = { commandId: cid(), repoRoot: workspace, paths: ['a.txt'] }
  assert.equal(codeOf(await reader.request('git.stage', stage)), 'scope_required')
  assert.equal(codeOf(await chats.request('git.status', { repoRoot: workspace })), 'scope_required')
  assert.equal(codeOf(await chats.request('versionControl.probeProviders', {})), 'scope_required')
})

test('a followed checkout is heard while its stream is open, and given back when the connection closes', async () => {
  const { started, workspace } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const id = await owner.subscribe('git.checkoutChanged', { checkoutPath: workspace })
  await new Promise((resolve) => setTimeout(resolve, 300))
  git(workspace, 'checkout', '-q', '-b', 'topic')
  const pushed = await owner.line.next((frame) => frame.t === 'push' && frame.sub === id, 10_000)
  assert.equal(pushed.t, 'push')
  owner.line.close()
})

test('an owner’s repository on an SSH machine is asked there, plain, and answered spelled; the rest is refused in words', async () => {
  const asked: Array<[string, string, unknown[]]> = []
  const machine: StudioMachineCall = async (id, channel, args) => {
    asked.push([id, channel, args])
    if (channel === 'git:check-ignored') return ['dist']
    return { branch: 'main', files: {} }
  }
  const { started } = await serve({ machine })
  const owner = await client(started.path, OWNER_TOKEN)
  const app = 'ssh://build-box/home/dev/app'
  assert.equal(codeOf(await owner.request('git.status', { repoRoot: app })), null)
  assert.deepEqual(resultOf(await owner.request('git.checkIgnored', { repoRoot: app, paths: ['dist'] })), {
    paths: ['dist'],
  })
  assert.equal(codeOf(await owner.request('git.commit', { commandId: cid(), repoRoot: app, message: 'm' })), null)
  assert.deepEqual(
    asked.map(([id, channel, args]) => [id, channel, args[0]]),
    [
      ['build-box', 'git:get-status', '/home/dev/app'],
      ['build-box', 'git:check-ignored', '/home/dev/app'],
      ['build-box', 'git:commit', '/home/dev/app'],
    ],
  )
  for (const [method, params] of [
    ['git.push', { commandId: cid(), repoRoot: app }],
    ['git.stashList', { repoRoot: app }],
  ] as const)
    assert.deepEqual([method, codeOf(await owner.request(method, params))], [method, 'unavailable'])
})
