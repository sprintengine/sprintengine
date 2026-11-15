import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_AGENT_SETTINGS_METHODS, STUDIO_AGENT_SETTINGS_TOPICS } from '../src/agent-settings'
import { STUDIO_METHOD_ACCESS, parseStudioMethodParams, parseStudioTopicParams } from '../src/methods'

// The agent CLIs' and launch settings' params, as a Studio reads them: what is
// kept, what is dropped, and what is refused before a domain is asked.

const ok = <T>(parsed: { ok: boolean; params?: T }) => (parsed.ok ? parsed.params : undefined)
const refused = (parsed: { ok: boolean }) => parsed.ok === false

test('a CLI runtime names a program and a machine, nothing else, and only a known kind of machine', () => {
  assert.deepEqual(
    ok(
      parseStudioMethodParams('cliRuntimes.detect', {
        cli: 'codex',
        runtime: { command: '/opt/codex', hostId: 'wsl:Ubuntu', models: ['x'] },
        extra: 1,
      }),
    ),
    { cli: 'codex', runtime: { command: '/opt/codex', hostId: 'wsl:Ubuntu' } },
  )
  assert.deepEqual(ok(parseStudioMethodParams('cliRuntimes.detect', { cli: 'codex', runtime: {} })), { cli: 'codex' })
  assert.ok(refused(parseStudioMethodParams('cliRuntimes.detect', { cli: 'codex', runtime: { hostId: 'ssh:box' } })))
  assert.ok(refused(parseStudioMethodParams('cliRuntimes.detect', { cli: '' })))
  assert.ok(
    refused(parseStudioMethodParams('cliRuntimes.install', { commandId: 'c', cli: 'codex' })),
    'a method is needed',
  )
})

test('every mutation of the family carries a command id, and every read takes none', () => {
  for (const [method, spec] of Object.entries(STUDIO_AGENT_SETTINGS_METHODS))
    if (spec.mutation)
      assert.ok(refused(parseStudioMethodParams(method as never, {})), `${method} refuses no commandId`)
  assert.deepEqual(ok(parseStudioMethodParams('cliRuntimes.updateAll', { commandId: 'c1', extra: true })), {
    commandId: 'c1',
  })
})

test('a discovery keeps what it names, and only the ids and first sightings of the catalogs it carries', () => {
  const parsed = ok(
    parseStudioMethodParams('cliModels.discover', {
      clis: ['codex'],
      force: true,
      previous: {
        codex: {
          models: [{ id: 'gpt-5', firstSeenAt: '2026-11-01', displayName: 'GPT', injected: '<b>' }],
          fetchedAt: '2026-11-01',
          source: 'argv-probe',
        },
      },
    }),
  )
  assert.deepEqual(parsed, {
    clis: ['codex'],
    force: true,
    previous: {
      codex: { models: [{ id: 'gpt-5', firstSeenAt: '2026-11-01' }], fetchedAt: '2026-11-01', source: 'argv-probe' },
    },
  })
  assert.ok(refused(parseStudioMethodParams('cliModels.discover', { clis: 'codex' })))
  assert.ok(refused(parseStudioMethodParams('cliModels.discover', { cliRuntimes: { codex: { command: 7 } } })))
})

test('a title and a draft need an engine; a draft its folder and a readable style', () => {
  assert.ok(refused(parseStudioMethodParams('textGeneration.chatTitle', { prompt: 'x', engine: { cli: 'codex' } })))
  assert.ok(
    refused(
      parseStudioMethodParams('textGeneration.chatTitle', {
        prompt: 'x',
        engine: { cli: 'codex', model: '' },
        timeoutMs: 0,
      }),
    ),
  )
  const engine = { cli: 'claude-code', model: 'haiku', reasoning: 'low' }
  assert.deepEqual(
    ok(parseStudioMethodParams('commitMessage.draft', { repoRoot: '/Users/dev/app', engine, draftId: 'd1' })),
    {
      repoRoot: '/Users/dev/app',
      engine,
      draftId: 'd1',
    },
  )
  assert.ok(refused(parseStudioMethodParams('commitMessage.draft', { engine })))
  assert.ok(
    refused(
      parseStudioMethodParams('commitMessage.draft', {
        repoRoot: '/a',
        engine,
        writingStyle: { mode: 'yaml', instructions: '' },
      }),
    ),
  )
})

test('the titles setting and a launch settings write are objects of their own shape', () => {
  const settings = { enabled: true, engine: null, writingStyle: { mode: 'repository', instructions: '' } }
  assert.deepEqual(ok(parseStudioMethodParams('textGeneration.setSettings', { commandId: 'c', settings })), {
    commandId: 'c',
    settings,
  })
  assert.ok(
    refused(parseStudioMethodParams('textGeneration.setSettings', { commandId: 'c', settings: { enabled: 'yes' } })),
  )
  assert.ok(refused(parseStudioMethodParams('launchSettings.update', { commandId: 'c', patch: [] })))
  assert.ok(refused(parseStudioMethodParams('launchSettings.migrate', { commandId: 'c' })))
})

test('an install’s output is followed per CLI and machine; the rest of the streams take nothing', () => {
  assert.deepEqual(ok(parseStudioTopicParams('cliRuntimes.output', { cli: 'codex', hostId: 'wsl:Ubuntu' })), {
    cli: 'codex',
    hostId: 'wsl:Ubuntu',
  })
  assert.ok(refused(parseStudioTopicParams('cliRuntimes.output', {})))
  assert.ok(refused(parseStudioTopicParams('cliRuntimes.output', { cli: 'codex', hostId: 'elsewhere' })))
  for (const topic of Object.keys(STUDIO_AGENT_SETTINGS_TOPICS).filter((name) => name !== 'cliRuntimes.output'))
    assert.deepEqual(ok(parseStudioTopicParams(topic as never, undefined)), {}, topic)
})

test('installing keeps the machine, reading what can run is providers:read, and the launch settings, titles and commit messages are an owner’s', () => {
  assert.deepEqual(STUDIO_METHOD_ACCESS['cliRuntimes.install'], { permissions: ['environment:maintain'] })
  assert.deepEqual(STUDIO_METHOD_ACCESS['cliRuntimes.detect'], { permissions: ['providers:read'] })
  assert.deepEqual(STUDIO_METHOD_ACCESS['cliVersions.setEnabled'], { permissions: ['settings:write'] })
  // A title or a commit message runs a CLI here outside any chat: the window's, never a paired client's.
  for (const method of ['textGeneration.chatTitle', 'commitMessage.draft', 'commitMessage.cancel'] as const) {
    const access = STUDIO_METHOD_ACCESS[method]
    assert.ok('permissions' in access, method)
    assert.deepEqual(access.permissions, ['conversation:operate'], method)
    assert.ok(access.owner, method)
  }
  const owners = Object.keys(STUDIO_AGENT_SETTINGS_METHODS).filter((method) => {
    const access = STUDIO_METHOD_ACCESS[method as keyof typeof STUDIO_METHOD_ACCESS]
    return 'permissions' in access && access.owner !== undefined
  })
  assert.deepEqual(owners.sort(), [
    'commitMessage.cancel',
    'commitMessage.draft',
    'launchSettings.get',
    'launchSettings.migrate',
    'launchSettings.update',
    'textGeneration.chatTitle',
  ])
})
