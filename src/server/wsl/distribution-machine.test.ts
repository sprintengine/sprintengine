// What a WSL distribution's Studio does on its machine for the desktop that
// holds it, as plain Node here: git with stdin and a deadline, and the home.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { createDistributionMachine } from './distribution-machine'

let temp = ''
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-dm-'))
})
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const hasGit = spawnSync('git', ['--version']).status === 0

test.skipIf(!hasGit)('git takes stdin: a hunk applied to the index, and paths checked against ignores', async () => {
  const machine = createDistributionMachine()
  const repo = join(temp, 'repo-stdin')
  mkdirSync(repo)
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'dev@example.com')
  git('config', 'user.name', 'Dev')
  writeFileSync(join(repo, '.gitignore'), 'out/\n*.log\n')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'init')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  const patch = git('diff', 'a.txt').stdout
  const applied = await machine.git({
    cwd: repo,
    args: ['apply', '--cached', '-'],
    timeoutMs: null,
    env: { LC_ALL: 'C' },
    stdinB64: Buffer.from(patch).toString('base64'),
  })
  assert.equal(applied.code, 0, applied.stderr)
  assert.equal(git('diff', '--cached', '--name-only').stdout.trim(), 'a.txt', 'the hunk is in the index')
  mkdirSync(join(repo, 'out'))
  const ignored = await machine.git({
    cwd: repo,
    args: ['check-ignore', '-z', '--stdin'],
    timeoutMs: 10_000,
    env: { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
    stdinB64: Buffer.from('out\0a.txt\0x.log\0').toString('base64'),
  })
  assert.deepEqual(ignored.stdout.split('\0').filter(Boolean), ['out', 'x.log'])
  const top = await machine.git({ cwd: repo, args: ['rev-parse', '--is-inside-work-tree'], timeoutMs: 10_000 })
  assert.equal(top.stdout.trim(), 'true')
  await assert.rejects(machine.git({ cwd: repo, args: ['status'], timeoutMs: 5_000, stdinB64: '***' }), /base64/u)
  await assert.rejects(machine.git({ cwd: 'relative', args: ['status'], timeoutMs: 5_000 }), /absolute/u)
})

test('the home and config-home variables are the login environment’s absolute ones', () => {
  const machine = createDistributionMachine({
    env: () => ({
      HOME: '/home/dev',
      CLAUDE_CONFIG_DIR: '/home/dev/.claude-work,/home/dev/.claude',
      CODEX_HOME: 'relative/codex',
      XDG_CONFIG_HOME: '/home/dev/.config',
    }),
  })
  assert.deepEqual(machine.home(), {
    home: '/home/dev',
    env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work', XDG_CONFIG_HOME: '/home/dev/.config' },
  })
})
