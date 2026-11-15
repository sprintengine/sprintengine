import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, vi } from 'vitest'

import type { DiagnosticLogInput } from '../../shared/electron-api'
import { parseAgentLaunchSettingsRecord, type AgentLaunchSettingsRecord } from '../../shared/launch-settings'
import type {
  CommitMessageRequest,
  CommitMessageResult,
  TextGenerationResult,
} from '../../shared/text-generation/contract'
import type { TextGenerationWritingStyle } from '../../shared/text-generation/writing-style'
import type { CommitMessageDraftInputOutcome } from '../../main/commit-message-draft'
import { createAgentLaunchSettingsStore } from '../../main/launch-settings-store'
import { createStudioAgentSettings, type StudioAgentSettingsDeps } from './agent-settings-domain'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

// What the protocol's `launchSettings.*`, `textGeneration.*` and
// `commitMessage.*` answer from. The params' shapes are the protocol's to
// check (`packages/studio-protocol/test/agent-settings.test.ts`); who may ask
// is the router's (`src/server/rpc/studio-agent-settings.test.ts`).

const NO_TEXT: Pick<StudioAgentSettingsDeps, 'textGenerationSettings'> = {
  textGenerationSettings: { set: () => undefined },
}

async function withLaunchSettings(
  body: (input: {
    domain: ReturnType<typeof createStudioAgentSettings>
    store: ReturnType<typeof createAgentLaunchSettingsStore>
    heard: AgentLaunchSettingsRecord[]
    stop: () => void
    dataDir: string
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'sprintengine-launch-settings-'))
  const store = createAgentLaunchSettingsStore({ resolveUserDataDir: () => dataDir })
  const domain = createStudioAgentSettings({ ...NO_TEXT, launchSettings: store })
  const heard: AgentLaunchSettingsRecord[] = []
  const stop = domain.onLaunchSettingsChanged((record) => void heard.push(record))
  try {
    await body({ domain, store, heard, stop, dataDir })
  } finally {
    stop()
    // Every queued atomic write settles before the directory goes.
    await store.settled()
    await rm(dataDir, { recursive: true, force: true })
  }
}

test('launch settings: an update is answered with the record, and every follower hears it once', async () => {
  await withLaunchSettings(async ({ domain, heard }) => {
    assert.equal((await domain.launchSettings()).record, null)
    const ack = await domain.updateLaunchSettings({ lastSelectedCli: 'codex' })
    assert.equal(ack.changed, true)
    assert.equal(ack.record.settings.lastSelectedCli, 'codex')
    assert.equal(ack.record.lastWrite.actor, 'ui')
    assert.deepEqual(heard, [ack.record])
    const repeat = await domain.updateLaunchSettings({ lastSelectedCli: 'codex' })
    assert.equal(repeat.changed, false)
    assert.equal(heard.length, 1, 'an update that changes nothing is not told')
  })
})

test('launch settings: a change the Studio makes itself is told the same way, until the follower stops', async () => {
  await withLaunchSettings(async ({ store, heard, stop }) => {
    const result = store.update({ lastAgentSpawnPermissionPreset: 'manual' }, 'system')
    assert.equal(heard.at(-1)?.revision, result.record.revision)
    stop()
    store.update({ lastAgentSpawnPermissionPreset: 'auto' }, 'system')
    assert.equal(heard.length, 1)
  })
})

test('launch settings: a migration is taken while there is no record, refused after, and answered once on disk', async () => {
  await withLaunchSettings(async ({ domain, heard, dataDir }) => {
    const offer = { lastSelectedCli: 'gemini', cliRuntimes: {}, mcp: { syncEnabled: false, servers: {} } }
    const accepted = await domain.migrateLaunchSettings(offer)
    assert.equal(accepted.changed, true)
    assert.equal(accepted.persisted, true)
    const onDisk = parseAgentLaunchSettingsRecord(
      JSON.parse(await readFile(join(dataDir, 'agent-launch-settings.json'), 'utf8')),
    )
    assert.equal(onDisk?.revision, accepted.record.revision)
    assert.equal(heard.length, 1, 'an accepted migration is told like any write')
    const refused = await domain.migrateLaunchSettings({ ...offer, lastSelectedCli: 'codex' })
    assert.equal(refused.changed, false)
    assert.equal(refused.record.settings.lastSelectedCli, 'gemini')
    assert.equal((await domain.launchSettings()).persisted, true)
  })
})

// A title that does not arrive is silent in the window by rule (the heuristic
// title stands), so the diagnostics log is the one place a person can see why
// their chosen engine did not answer.
test('a chat title that failed leaves one info line naming the engine; one that landed leaves none', async () => {
  const logged: DiagnosticLogInput[] = []
  const request = {
    prompt: 'fix the sidebar flicker',
    engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' },
  }
  const failure: TextGenerationResult = { ok: false, code: 'transport', message: 'codex exited 1.' }
  let answer: TextGenerationResult = failure
  const domain = createStudioAgentSettings({
    ...NO_TEXT,
    launchSettings: createAgentLaunchSettingsStore({ resolveUserDataDir: () => tmpdir() }),
    generateTitle: async () => answer,
    log: async (entry) => void logged.push(entry),
  })
  assert.deepEqual(await domain.chatTitle(request), failure)
  assert.equal(logged.length, 1)
  assert.equal(logged[0]!.level, 'info', 'never a warning: a missing title is not an error the person must act on')
  assert.equal(logged[0]!.title, 'Chat title not generated')
  assert.equal(logged[0]!.message, 'codex · gpt-5.6-luna · low: transport — codex exited 1.')
  answer = { ok: true, value: 'Fix sidebar flicker', ms: 4000 }
  assert.deepEqual(await domain.chatTitle(request), answer)
  assert.equal(logged.length, 1)
})

test('a log that cannot be written never costs the caller its title', async () => {
  const domain = createStudioAgentSettings({
    ...NO_TEXT,
    launchSettings: createAgentLaunchSettingsStore({ resolveUserDataDir: () => tmpdir() }),
    generateTitle: async () => ({ ok: false, code: 'timeout', message: 'codex did not answer in time.' }),
    log: async () => {
      throw new Error('disk full')
    },
  })
  const result = await domain.chatTitle({ prompt: 'x', engine: { cli: 'codex', model: '' } })
  assert.deepEqual(result, { ok: false, code: 'timeout', message: 'codex did not answer in time.' })
})

// ── Commit messages ─────────────────────────────────────────────────────────

const ENGINE = { cli: 'claude-code', model: 'claude-haiku-4-5' }
const DRAFTED: CommitMessageResult = {
  ok: true,
  value: { subject: 'fix: keep the marks', body: '', message: 'fix: keep the marks' },
  ms: 1,
}

function gathered(style: TextGenerationWritingStyle): CommitMessageDraftInputOutcome {
  return {
    ok: true,
    input: {
      branch: 'feature/marks',
      diffStat: ' a.ts | 1 +',
      patch: '+a',
      recentSubjects: [],
      conventionalCommits: false,
      style,
    },
  }
}

function drafter(deps: Pick<StudioAgentSettingsDeps, 'gatherCommit' | 'generateCommit'>) {
  return createStudioAgentSettings({
    ...NO_TEXT,
    ...deps,
    launchSettings: createAgentLaunchSettingsStore({ resolveUserDataDir: () => tmpdir() }),
    log: async () => undefined,
  })
}

test('a draft reads the checkout with the style asked for, and answers with the message', async () => {
  const seen: Array<{ repoRoot: string; style: TextGenerationWritingStyle }> = []
  const requests: CommitMessageRequest[] = []
  const domain = drafter({
    gatherCommit: async (repoRoot, style) => {
      seen.push({ repoRoot, style })
      return gathered(style)
    },
    generateCommit: async (request) => {
      requests.push(request)
      return DRAFTED
    },
  })
  const result = await domain.draftCommitMessage(
    {
      repoRoot: '/Users/dev/app',
      engine: ENGINE,
      cliRuntimes: { 'claude-code': { command: '/opt/claude' } },
      writingStyle: { mode: 'custom', instructions: 'Past tense.' },
    },
    null,
  )
  assert.deepEqual(result, DRAFTED)
  assert.deepEqual(seen, [{ repoRoot: '/Users/dev/app', style: { mode: 'custom', instructions: 'Past tense.' } }])
  assert.deepEqual(requests[0]!.engine, ENGINE)
  assert.deepEqual(requests[0]!.cliRuntimes, { 'claude-code': { command: '/opt/claude' } })
})

test('a draft with no style drafts in the default; a guide over the bound is cut to it', async () => {
  const styles: TextGenerationWritingStyle[] = []
  const domain = drafter({
    gatherCommit: async (_repoRoot, style) => {
      styles.push(style)
      return gathered(style)
    },
    generateCommit: async () => DRAFTED,
  })
  await domain.draftCommitMessage({ repoRoot: '/Users/dev/app', engine: ENGINE }, null)
  await domain.draftCommitMessage(
    { repoRoot: '/Users/dev/app', engine: ENGINE, writingStyle: { mode: 'custom', instructions: 'x'.repeat(5000) } },
    null,
  )
  assert.deepEqual(styles[0], { mode: 'repository', instructions: '' })
  assert.ok(styles[1]!.instructions.length <= 2000)
})

test('a checkout that is not on this computer is refused in words before git is asked', async () => {
  let asked = false
  const domain = drafter({
    gatherCommit: async (_repoRoot, style) => {
      asked = true
      return gathered(style)
    },
    generateCommit: async () => DRAFTED,
  })
  for (const repoRoot of ['ssh://build-box/home/dev/app', 'relative/app'])
    assert.deepEqual(await domain.draftCommitMessage({ repoRoot, engine: ENGINE }, null), {
      ok: false,
      code: 'unsupported',
      message: 'Only a checkout on this computer can be read.',
    })
  assert.equal(asked, false)
})

test('nothing staged is said in words, and no CLI runs', async () => {
  let generated = false
  const domain = drafter({
    gatherCommit: async () => ({ ok: false, message: 'Nothing is staged to commit.' }),
    generateCommit: async () => {
      generated = true
      return DRAFTED
    },
  })
  assert.deepEqual(await domain.draftCommitMessage({ repoRoot: '/Users/dev/app', engine: ENGINE }, null), {
    ok: false,
    code: 'unsupported',
    message: 'Nothing is staged to commit.',
  })
  assert.equal(generated, false)
})

test('stopping a draft by its key aborts the drafting run', async () => {
  let seen: AbortSignal | undefined
  const domain = drafter({
    gatherCommit: async (_repoRoot, style) => gathered(style),
    generateCommit: (request) =>
      new Promise<CommitMessageResult>((resolve) => {
        seen = request.signal
        request.signal?.addEventListener('abort', () =>
          resolve({ ok: false, code: 'cancelled', message: 'claude-code was stopped.' }),
        )
      }),
  })
  const running = domain.draftCommitMessage({ repoRoot: '/Users/dev/app', engine: ENGINE }, 'owner:draft-1')
  await vi.waitFor(() => assert.ok(seen))
  domain.cancelCommitMessage('client-a:draft-1')
  assert.equal(seen?.aborted, false, "another client's key stops nothing")
  domain.cancelCommitMessage('owner:draft-1')
  assert.equal(seen?.aborted, true)
  assert.deepEqual(await running, { ok: false, code: 'cancelled', message: 'claude-code was stopped.' })
})
