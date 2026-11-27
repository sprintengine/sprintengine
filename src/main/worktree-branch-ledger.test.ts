import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

import { testDatabaseAt } from '../../tests/studio-database'
import {
  createWorktreeBranchLedger,
  installWorktreeBranchLedger,
  readWorktreeBranchesFile,
  worktreeBranchLedger,
} from './worktree-branch-ledger'

const execFileAsync = promisify(execFile)
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })
  return stdout.trim()
}

let scratch = ''
let repo = ''
let other = ''
let caseNumber = 0

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-branch-ledger-')))
  for (const name of ['app', 'other']) {
    const dir = join(scratch, name)
    await mkdir(dir, { recursive: true })
    await git(dir, 'init', '-q', '-b', 'main')
    await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  repo = join(scratch, 'app')
  other = join(scratch, 'other')
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

/** A profile data directory of its own per case. */
async function dataDir(): Promise<string> {
  caseNumber += 1
  const dir = join(scratch, `profile-${caseNumber}`)
  await mkdir(dir, { recursive: true })
  return dir
}

const ledgerIn = (dir: string) => createWorktreeBranchLedger({ database: testDatabaseAt(dir), log: () => {} })

test('a branch recorded is read back for its repository, and for no other', async () => {
  const ledger = ledgerIn(await dataDir())
  await ledger.record(repo, 'feat/chat-1')
  await ledger.record(repo, 'chat-ab12')
  assert.deepEqual([...(await ledger.branches(repo))].sort(), ['chat-ab12', 'feat/chat-1'])
  assert.deepEqual([...(await ledger.branches(other))], [])
})

test('the record survives a restart', async () => {
  const dir = await dataDir()
  await ledgerIn(dir).record(repo, 'feat/chat-1')
  assert.deepEqual([...(await ledgerIn(dir).branches(repo))], ['feat/chat-1'])
})

test('every worktree of a repository, and any folder in it, names the same record', async () => {
  const ledger = ledgerIn(await dataDir())
  const worktree = join(scratch, `wt-${caseNumber}`)
  await git(repo, 'worktree', 'add', '-q', '-b', `wt-${caseNumber}`, worktree)
  await mkdir(join(repo, 'src'), { recursive: true })
  await ledger.record(worktree, 'feat/from-worktree')
  assert.ok((await ledger.branches(repo)).has('feat/from-worktree'))
  assert.ok((await ledger.branches(join(repo, 'src'))).has('feat/from-worktree'))
})

test('a missing record reads as empty', async () => {
  assert.equal((await ledgerIn(await dataDir()).branches(repo)).size, 0)
})

test('a ledger file this build cannot read is not imported', () => {
  for (const content of ['{ not json', '[]', '{"version":99,"repos":{}}'])
    assert.equal(readWorktreeBranchesFile(content), null, content)
  assert.deepEqual(readWorktreeBranchesFile('{"version":1,"repos":{"x":{"branches":"no"}}}'), [])
})

test('the ledger file is read oldest repository first, each with its branches in order', () => {
  assert.deepEqual(
    readWorktreeBranchesFile(
      JSON.stringify({
        version: 1,
        repos: {
          '/new/.git': { updatedAt: 20, branches: ['b', 'a', 'b'] },
          '/old/.git': { updatedAt: 10, branches: ['c', ''] },
        },
      }),
    ),
    [
      { repo: '/old/.git', branches: ['c'] },
      { repo: '/new/.git', branches: ['b', 'a'] },
    ],
  )
})

test('a forgotten branch is struck off, and a repository with none left is dropped', async () => {
  const dir = await dataDir()
  const ledger = ledgerIn(dir)
  await ledger.record(repo, 'feat/a')
  await ledger.record(repo, 'feat/b')
  await ledger.forget(repo, ['feat/a'])
  assert.deepEqual([...(await ledger.branches(repo))], ['feat/b'])
  await ledger.forget(repo, ['feat/b'])
  assert.deepEqual(await testDatabaseAt(dir).all('SELECT * FROM worktree_branches'), [])
})

test('changes made together all land, in order', async () => {
  const ledger = ledgerIn(await dataDir())
  await Promise.all(['a', 'b', 'c', 'd'].map((name) => ledger.record(repo, `feat/${name}`)))
  await ledger.forget(repo, ['feat/b'])
  assert.deepEqual([...(await ledger.branches(repo))], ['feat/a', 'feat/c', 'feat/d'])
})

test('a write from another ledger in between is kept', async () => {
  const dir = await dataDir()
  await ledgerIn(dir).record(repo, 'feat/a')
  // Another ledger over the same database.
  await ledgerIn(dir).record(repo, 'feat/b')
  assert.deepEqual([...(await ledgerIn(dir).branches(repo))], ['feat/a', 'feat/b'])
})

test('with no server in the process, nothing is kept and nothing is known', async () => {
  installWorktreeBranchLedger(null)
  await worktreeBranchLedger().record(repo, 'feat/a')
  assert.equal((await worktreeBranchLedger().branches(repo)).size, 0)

  // The one a server installs is the one every caller reaches.
  const installed = ledgerIn(await dataDir())
  installWorktreeBranchLedger(installed)
  try {
    await worktreeBranchLedger().record(repo, 'feat/b')
    assert.deepEqual([...(await installed.branches(repo))], ['feat/b'])
  } finally {
    installWorktreeBranchLedger(null)
  }
})

test('a branch recorded again is the newest, and each repository keeps its newest names', async () => {
  const ledger = ledgerIn(await dataDir())
  await ledger.record(repo, 'feat/a')
  await ledger.record(repo, 'feat/b')
  await ledger.record(repo, 'feat/a')
  assert.deepEqual([...(await ledger.branches(repo))], ['feat/b', 'feat/a'])
})

test('a folder that is not a repository records nothing', async () => {
  const dir = await dataDir()
  const plain = join(scratch, 'plain')
  await mkdir(plain, { recursive: true })
  await ledgerIn(dir).record(plain, 'feat/a')
  assert.equal((await ledgerIn(dir).branches(plain)).size, 0)
})

test('a read waits for what this process is still writing', async () => {
  const ledger = ledgerIn(await dataDir())
  void ledger.record(repo, 'feat/just-made')
  assert.ok((await ledger.branches(repo)).has('feat/just-made'))
})
