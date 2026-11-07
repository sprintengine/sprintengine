import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  changedPathsOf,
  createConversationCheckoutChanges,
  type ConversationChangesSaid,
} from './conversation-checkout-changes'

// A paired device reading a chat's changes in a real checkout: what the Diff
// tab here reads, and nothing the change does not list.

const chat = { workspaceId: 'ws', agentId: 'chat' }
const made: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    },
  }).trim()
}

/** A repository on `main` with one commit, and a feature branch one commit ahead of it. */
function repository(): { root: string; secret: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), 'checkout-changes-'))
  const outside = mkdtempSync(join(tmpdir(), 'checkout-changes-outside-'))
  made.push(root, outside)
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'calendar.ts'), 'export const days = 7\n')
  writeFileSync(join(root, 'notes.md'), 'first\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'Start')
  git(root, 'checkout', '-q', '-b', 'feature/calendar')
  writeFileSync(join(root, 'calendar.ts'), 'export const days = 7\nexport const weeks = 52\n')
  git(root, 'commit', '-q', '-am', 'Count the weeks')
  const commit = git(root, 'rev-parse', 'HEAD')
  const secret = join(outside, 'secret.txt')
  writeFileSync(secret, 'not for a paired device\n')
  return { root, secret, commit }
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('a step lists its files, and a file reads as its two sides', async () => {
  const { root, commit } = repository()
  writeFileSync(join(root, 'notes.md'), 'first\nsecond\n')
  writeFileSync(join(root, 'fresh.ts'), 'new file\n')
  const changes = createConversationCheckoutChanges({ checkoutOf: () => root })

  const span = await changes.diff(chat, { kind: 'span' })
  assert.ok(span.ok)
  assert.deepEqual(span.files.map((file) => file.path).sort(), ['calendar.ts', 'notes.md'])
  const uncommitted = await changes.diff(chat, { kind: 'uncommitted' })
  assert.ok(uncommitted.ok)
  assert.deepEqual(uncommitted.files.map((file) => `${file.status}:${file.path}`).sort(), [
    'modified:notes.md',
    'new:fresh.ts',
  ])

  // The whole branch: from where it left main to the working tree.
  assert.deepEqual(await changes.file(chat, { kind: 'span' }, 'calendar.ts'), {
    ok: true,
    original: { kind: 'content', content: 'export const days = 7\n' },
    modified: { kind: 'content', content: 'export const days = 7\nexport const weeks = 52\n' },
  })
  // A new file has no original side.
  assert.deepEqual(await changes.file(chat, { kind: 'uncommitted' }, 'fresh.ts'), {
    ok: true,
    original: { kind: 'absent' },
    modified: { kind: 'content', content: 'new file\n' },
  })
  // One commit, between it and its parent.
  const step = await changes.file(chat, { kind: 'commit', hash: commit }, 'calendar.ts')
  assert.ok(step.ok)
  assert.equal(
    step.modified.kind === 'content' && step.modified.content,
    'export const days = 7\nexport const weeks = 52\n',
  )
})

test('nothing the change does not list is readable', async () => {
  const { root, secret } = repository()
  const changes = createConversationCheckoutChanges({ checkoutOf: () => root })

  // A tracked file nothing uncommitted touched.
  const unchanged = await changes.file(chat, { kind: 'uncommitted' }, 'notes.md')
  assert.equal(unchanged.ok, false)
  assert.equal(!unchanged.ok && unchanged.code, 'not_found')

  // A commit that is not one of the branch's own.
  const main = git(root, 'rev-parse', 'main')
  const other = await changes.diff(chat, { kind: 'commit', hash: main })
  assert.equal(other.ok, false)

  // A link the agent made to a file outside the checkout reads as the link, never as the file.
  symlinkSync(secret, join(root, 'peek.txt'))
  const linked = await changes.file(chat, { kind: 'uncommitted' }, 'peek.txt')
  assert.ok(linked.ok)
  assert.deepEqual(linked.modified, { kind: 'content', content: secret })

  // A folder that is a link out of the checkout reads as nothing.
  symlinkSync(join(secret, '..'), join(root, 'elsewhere'))
  const through = await changes.file(chat, { kind: 'uncommitted' }, 'elsewhere/secret.txt')
  assert.equal(through.ok, false)
})

test('a chat with no checkout here, or one that is not a repository, says so', async () => {
  const none = createConversationCheckoutChanges({ checkoutOf: () => null })
  const refused = await none.diff(chat, { kind: 'span' })
  assert.equal(refused.ok, false)
  const plain = mkdtempSync(join(tmpdir(), 'checkout-changes-plain-'))
  made.push(plain)
  const folder = createConversationCheckoutChanges({ checkoutOf: () => plain })
  const said = await new Promise<ConversationChangesSaid>((resolve) => {
    const stop = folder.watch(chat, (reading) => {
      stop()
      resolve(reading)
    })
  })
  assert.equal(said.changes, null)
})

test('a watch is told when the checkout moves, an edit to a file already changed included, and only then', async () => {
  const { root } = repository()
  writeFileSync(join(root, 'notes.md'), 'first\nsecond\n')
  type Tick = () => void
  const pending: Tick[] = []
  const changes = createConversationCheckoutChanges({
    checkoutOf: () => root,
    timers: { setTimeout: (run) => pending.push(run), clearTimeout: () => undefined },
  })
  const said: ConversationChangesSaid[] = []
  const stop = changes.watch(chat, (reading) => said.push(reading))
  const settle = async (count: number) => {
    for (let attempt = 0; attempt < 200 && said.length < count; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const tick = async () => {
    const run = pending.shift()
    assert.ok(run, 'a reading is scheduled')
    run()
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  await settle(1)
  assert.equal(said.length, 1)
  assert.equal(said[0]!.changes?.branch, 'feature/calendar')
  assert.equal(said[0]!.changes?.steps.length, 1)
  assert.equal(said[0]!.changes?.hasUncommitted, true)

  await tick()
  assert.equal(said.length, 1, 'nothing moved, nothing said')

  // Still "modified", so `git status` reads the same: the file's own stat moves it.
  writeFileSync(join(root, 'notes.md'), 'first\nsecond\nthird, and longer\n')
  await tick()
  await settle(2)
  assert.equal(said.length, 2)
  assert.notEqual(said[1]!.revision, said[0]!.revision)

  // A second watcher of the same checkout is told the last reading at once.
  const second: ConversationChangesSaid[] = []
  const stopSecond = changes.watch(chat, (reading) => second.push(reading))
  for (let attempt = 0; attempt < 50 && second.length === 0; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(second[0]?.revision, said[1]!.revision)
  stopSecond()
  stop()
})

test('a status line names each changed path once, a rename by its new name', () => {
  const stdout = [
    '# branch.oid abc',
    '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts',
    'src/old.ts',
    '? fresh.ts',
    '',
  ].join('\0')
  assert.deepEqual(changedPathsOf(stdout), ['src/a file.ts', 'src/new.ts', 'fresh.ts'])
})
