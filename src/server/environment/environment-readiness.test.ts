// What a machine lacks for its background work, and the one rule schedules
// and watches wait by: a fact the machine knows is missing holds the work, in
// words; a fact it cannot tell holds nothing.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ScheduledAgent } from '../../shared/scheduled-agents'
import { cliSignedInHere, createEnvironmentReadiness, type EnvironmentReadinessDeps } from './environment-readiness'

const schedule = (over: Partial<ScheduledAgent> = {}): ScheduledAgent => ({
  id: 'sa-1',
  prompt: 'Triage the issues opened since the last run.',
  schedule: { cron: '0 9 * * *', timezone: 'UTC' },
  folderPath: '/home/dev/acme',
  hostId: null,
  cli: 'codex',
  cliModel: null,
  permissionPreset: null,
  skills: [],
  mcpServers: [],
  worktree: null,
  ownerModuleId: null,
  createdAt: 1,
  updatedAt: 1,
  lastRun: null,
  lastFailureSeenAt: null,
  ...over,
})

function readiness(over: Partial<EnvironmentReadinessDeps> = {}) {
  return createEnvironmentReadiness({
    machine: () => 'build-box',
    clis: () => [
      { id: 'codex', name: 'Codex', installed: true },
      { id: 'claude-code', name: 'Claude Code', installed: null },
    ],
    cliSignedIn: (id) => (id === 'codex' ? true : null),
    mcpServers: () => ({
      linear: { id: 'linear', name: 'Linear', enabled: true } as never,
      sentry: { id: 'sentry', name: 'Sentry', enabled: false } as never,
    }),
    skillKnown: (id) => id === 'review',
    extensions: () => ['weather-deck'],
    gh: async () => ({ installed: true, signedIn: true }),
    ...over,
  })
}

test('a schedule the machine can run waits for nothing', () => {
  assert.equal(readiness().scheduleWaitingFor(schedule()), null)
  // A sign-in this machine cannot read (a keychain) holds nothing.
  assert.equal(readiness().scheduleWaitingFor(schedule({ cli: 'claude-code' })), null)
})

test('each thing a machine lacks is said in words naming the machine', () => {
  const wait = (over: Partial<EnvironmentReadinessDeps>, agent: Partial<ScheduledAgent> = {}) =>
    readiness(over).scheduleWaitingFor(schedule(agent))
  assert.equal(
    wait({ clis: () => [{ id: 'codex', name: 'Codex', installed: false }] }),
    'Codex is not installed on build-box',
  )
  assert.equal(wait({ cliSignedIn: () => false }), 'Codex is not signed in on build-box')
  // Run now goes past a sign-in read as missing, which may be a misread; not past a missing command.
  assert.equal(readiness({ cliSignedIn: () => false }).scheduleWaitingFor(schedule(), { signIn: false }), null)
  assert.equal(
    readiness({ clis: () => [{ id: 'codex', name: 'Codex', installed: false }] }).scheduleWaitingFor(schedule(), {
      signIn: false,
    }),
    'Codex is not installed on build-box',
  )
  assert.equal(
    wait({}, { mcpServers: [{ id: 'github', name: 'GitHub' }] }),
    'the MCP server GitHub is not set up on build-box',
  )
  assert.equal(
    wait({}, { mcpServers: [{ id: 'sentry', name: 'Sentry' }] }),
    'the MCP server Sentry is switched off on build-box',
  )
  assert.equal(wait({}, { mcpServers: [{ id: 'linear', name: 'Linear' }] }), null)
  assert.equal(wait({}, { skills: [{ id: 'deploy', name: 'Deploy' }] }), 'the skill Deploy is not on build-box')
  assert.equal(wait({}, { skills: [{ id: 'review', name: 'Review' }] }), null)
  assert.equal(
    wait({}, { ownerModuleId: 'standup-bot' }),
    'the extension "standup-bot" that made it is not installed on build-box',
  )
  assert.equal(wait({}, { ownerModuleId: 'weather-deck' }), null)
  assert.equal(
    wait({ extensions: () => null }, { ownerModuleId: 'weather-deck' }),
    'the extension "weather-deck" that made it does not run on build-box',
  )
})

test("a run on another machine of this computer (a WSL distribution) is not held to this one's CLIs", () => {
  assert.equal(
    readiness({ cliSignedIn: () => false }).scheduleWaitingFor(schedule({ hostId: 'wsl:Ubuntu' as never })),
    null,
  )
})

test('a watch whose read failed waits on gh only when gh is missing or signed out here', async () => {
  assert.equal(await readiness().ghLacking('gh-missing'), 'gh is not installed on build-box')
  assert.equal(await readiness().ghLacking('gh-failed'), null)
  assert.equal(
    await readiness({ gh: async () => ({ installed: true, signedIn: false }) }).ghLacking('gh-failed'),
    'gh is not signed in on build-box',
  )
  // Cannot tell, or another kind of failure: the read counts as failed, as before.
  assert.equal(await readiness({ gh: async () => ({ installed: true, signedIn: null }) }).ghLacking('gh-failed'), null)
  assert.equal(await readiness({ gh: async () => ({ installed: true, signedIn: false }) }).ghLacking('timeout'), null)
})

test('environment.readiness lists what the machine has, and what waits on it and why', async () => {
  const read = await readiness({
    cliSignedIn: () => false,
    schedules: () => [{ ...schedule(), nextRunAt: null, waiting: 'Codex is not signed in on build-box' }],
    watches: () => [
      {
        url: 'https://github.com/acme/app/pull/7',
        title: 'Fix the login',
        waiting: 'gh is not signed in on build-box',
      },
      { url: 'https://github.com/acme/app/pull/8', title: 'Ready' },
    ],
  }).read()
  assert.equal(read.machine, 'build-box')
  assert.deepEqual(read.clis[0], { id: 'codex', name: 'Codex', installed: true, signedIn: false })
  assert.deepEqual(read.mcpServers, [
    { id: 'linear', name: 'Linear', enabled: true },
    { id: 'sentry', name: 'Sentry', enabled: false },
  ])
  assert.deepEqual(read.extensions, ['weather-deck'])
  assert.deepEqual(read.waiting, [
    {
      kind: 'schedule',
      id: 'sa-1',
      title: 'Triage the issues opened since the last run.',
      reason: 'Codex is not signed in on build-box',
    },
    {
      kind: 'pull-request-watch',
      id: 'https://github.com/acme/app/pull/7',
      title: 'Fix the login',
      reason: 'gh is not signed in on build-box',
    },
  ])
})

test('a CLI is signed in where it keeps a key or a sign-in file; a keychain cannot be read', () => {
  const none = () => false
  const at = (path: string) => (candidate: string) => candidate === path
  assert.equal(cliSignedInHere('codex', {}, 'linux', '/home/dev', none), false)
  assert.equal(cliSignedInHere('codex', { OPENAI_API_KEY: 'sk' }, 'linux', '/home/dev', none), true)
  assert.equal(cliSignedInHere('codex', {}, 'linux', '/home/dev', at('/home/dev/.codex/auth.json')), true)
  assert.equal(
    cliSignedInHere('codex', { CODEX_HOME: '/srv/codex' }, 'linux', '/home/dev', at('/srv/codex/auth.json')),
    true,
  )
  assert.equal(cliSignedInHere('claude-code', {}, 'linux', '/home/dev', none), false)
  assert.equal(cliSignedInHere('claude-code', {}, 'darwin', '/Users/dev', none), null)
  assert.equal(
    cliSignedInHere('claude-code', {}, 'linux', '/home/dev', at('/home/dev/.claude/.credentials.json')),
    true,
  )
  assert.equal(cliSignedInHere('claude-code', { ANTHROPIC_API_KEY: 'k' }, 'linux', '/home/dev', none), true)
  assert.equal(cliSignedInHere('cursor', {}, 'linux', '/home/dev', none), null)
  // A key helper in Claude Code's settings, or Codex keeping its login in the keyring.
  const settings = (text: string) => (path: string) => (path === '/home/dev/.claude/settings.json' ? text : null)
  assert.equal(
    cliSignedInHere('claude-code', {}, 'linux', '/home/dev', none, settings('{"apiKeyHelper": "~/bin/key"}')),
    true,
  )
  const local = (path: string) => (path === '/home/dev/.claude/settings.local.json' ? '{"apiKeyHelper": "k"}' : null)
  assert.equal(cliSignedInHere('claude-code', {}, 'linux', '/home/dev', none, local), true)
  // A console sign-in's key, kept in the CLI's state file.
  const state = (path: string) => (path === '/home/dev/.claude.json' ? '{"primaryApiKey": "sk-ant-x"}' : null)
  assert.equal(cliSignedInHere('claude-code', {}, 'linux', '/home/dev', none, state), true)
  assert.equal(cliSignedInHere('claude-code', { CLAUDE_CODE_USE_FOUNDRY: '1' }, 'linux', '/home/dev', none), true)
  const config = (text: string) => (path: string) => (path === '/home/dev/.codex/config.toml' ? text : null)
  assert.equal(
    cliSignedInHere('codex', {}, 'linux', '/home/dev', none, config('cli_auth_credentials_store = "keyring"\n')),
    null,
  )
  assert.equal(cliSignedInHere('codex', {}, 'linux', '/home/dev', none, config('model = "o4"\n')), false)
})
