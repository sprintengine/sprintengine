import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { ExtensionContributionsResult, ExtensionManifestView } from '../../../shared/modules/manifest'
import { setAppCommandRunner } from '../commands/appCommandRunner'
import { forgetChangedExtensions, loadExtensionContributions } from './extension-contributions'
import {
  REPLACEMENT_TIME_LIMIT_MS,
  forgetExtensionReplacementSwitch,
  forgetExtensionReplacements,
  registerExtensionReplacement,
  replacementFor,
  runBuiltInAction,
  runCommandForWorker,
  runReplaceable,
  setReplacementLog,
  useExtensionReplacementSwitches,
  type ExtensionReplacement,
} from './extension-replacements'
import { createRendererHost } from './renderer-host'

// A worker command that `replaces` one of Studio's actions runs in its place
// when the person fires it; Studio's own is the floor when the worker refuses,
// throws or is slow, and is all a declarative command or a worker's
// `commands.run` ever reaches.

type Answer = { ok: true; result: unknown } | { ok: false; code: 'failed'; message: string }

const keys: string[] = []
let lines: string[] = []
let restoreLog: () => void = () => undefined
let stopRunner: () => void = () => undefined

beforeEach(() => {
  lines = []
  restoreLog = setReplacementLog((key, line) => lines.push(`${key}: ${line}`))
})

afterEach(() => {
  for (const key of keys.splice(0)) forgetExtensionReplacements(key)
  useExtensionReplacementSwitches.setState({ off: {} })
  restoreLog()
  stopRunner()
  vi.useRealTimers()
})

/** Register a replacement whose worker answers with `answer` (or never, for a pending promise). */
function replacement(
  key: string,
  answer: () => Promise<Answer>,
  over: Partial<ExtensionReplacement> = {},
): { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = []
  keys.push(key)
  registerExtensionReplacement({
    key,
    commandId: 'notes.back',
    title: 'Back through notes',
    action: 'workspace.history.back',
    host: {
      getActiveWorkspaceId: () => 'ws-1',
      methods: () =>
        ({
          read: async () => ({ ok: false, code: 'unavailable', message: 'no' }),
          operate: (method: string, params: unknown) => {
            calls.push({ method, params })
            return answer()
          },
        }) as never,
    },
    live: () => true,
    ...over,
  })
  return { calls }
}

function builtIn(): { runs: number; run: () => boolean } {
  const counter = {
    runs: 0,
    run: () => {
      counter.runs += 1
      return true
    },
  }
  return counter
}

test('the worker runs in place of the action, and Studio’s own does not, when it answers in time', async () => {
  const { calls } = replacement('acme.back', async () => ({ ok: true, result: null }))
  const own = builtIn()
  assert.equal(runReplaceable('workspace.history.back', own.run), true, 'the key is taken at once')
  await vi.waitFor(() => assert.equal(calls.length, 1))
  assert.deepEqual(calls[0], {
    method: 'notes.back',
    params: { where: 'replaces', replaces: 'workspace.history.back', workspaceId: 'ws-1' },
  })
  await Promise.resolve()
  assert.equal(own.runs, 0)
  assert.deepEqual(lines, [])
})

test('an action nobody replaces runs Studio’s own directly', () => {
  replacement('acme.back', async () => ({ ok: true, result: null }))
  const own = builtIn()
  assert.equal(runReplaceable('workspace.history.forward', own.run), true)
  assert.equal(own.runs, 1)
})

test('a worker that has not answered within 2 s has Studio run its own, once, and the line says why', async () => {
  vi.useFakeTimers()
  let answer: (value: Answer) => void = () => undefined
  replacement('acme.slow', () => new Promise<Answer>((resolve) => (answer = resolve)))
  const own = builtIn()
  runReplaceable('workspace.history.back', own.run)
  await vi.advanceTimersByTimeAsync(REPLACEMENT_TIME_LIMIT_MS - 1)
  assert.equal(own.runs, 0, 'not before the limit')
  await vi.advanceTimersByTimeAsync(1)
  assert.equal(own.runs, 1)
  assert.deepEqual(lines, [
    'acme.slow: Studio ran its own "workspace.history.back": "notes.back" had not answered within 2 s.',
  ])
  answer({ ok: false, code: 'failed', message: 'late and wrong' })
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(own.runs, 1, 'never twice')
  assert.equal(lines.length, 1)
})

/** Studio's own actions as `runCommand` reaches them: the window's app command runner. */
function appRunner(): { runs: string[] } {
  const seen = { runs: [] as string[] }
  stopRunner = setAppCommandRunner((commandId) => {
    seen.runs.push(commandId)
    return true
  })
  return seen
}

test('a wrapping worker that answers after the 2 s floor does not run Studio’s action a second time', async () => {
  vi.useFakeTimers()
  const app = appRunner()
  let answer: (value: Answer) => void = () => undefined
  replacement('acme.slow', () => new Promise<Answer>((resolve) => (answer = resolve)))
  const own = builtIn()
  runReplaceable('workspace.history.back', own.run)
  await vi.advanceTimersByTimeAsync(REPLACEMENT_TIME_LIMIT_MS)
  assert.equal(own.runs, 1, 'Studio ran its own at the limit')
  // The worker's `await studio.runCommand('workspace.history.back')` lands late.
  assert.equal(runCommandForWorker({ moduleId: 'acme.slow', action: 'workspace.history.back' }), false)
  assert.deepEqual(app.runs, [], 'not run again')
  assert.match(lines.at(-1)!, /after Studio had already run it in its place/)
  // Another action, or another extension's ask, is not held.
  assert.equal(runCommandForWorker({ moduleId: 'acme.slow', action: 'pane.toggle' }), true)
  assert.equal(runCommandForWorker({ moduleId: 'acme.other', action: 'workspace.history.back' }), true)
  answer({ ok: true, result: null })
  await vi.advanceTimersByTimeAsync(0)
  // Once the call has settled, the worker's asks run as ever.
  assert.equal(runCommandForWorker({ moduleId: 'acme.slow', action: 'workspace.history.back' }), true)
  assert.deepEqual(app.runs, ['pane.toggle', 'workspace.history.back', 'workspace.history.back'])
  assert.equal(own.runs, 1)
})

test('a worker that runs Studio’s action and then fails, or goes quiet, does not have Studio run it again', async () => {
  vi.useFakeTimers()
  const app = appRunner()
  let fail: (value: Answer) => void = () => undefined
  replacement('acme.wraps', () => new Promise<Answer>((resolve) => (fail = resolve)))
  const failed = builtIn()
  runReplaceable('workspace.history.back', failed.run)
  await vi.advanceTimersByTimeAsync(10)
  assert.equal(runCommandForWorker({ moduleId: 'acme.wraps', action: 'workspace.history.back' }), true)
  fail({ ok: false, code: 'failed', message: 'after the back' })
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(failed.runs, 0, 'no fallback on its failure')
  assert.deepEqual(app.runs, ['workspace.history.back'], 'once, by the worker')
  assert.match(lines.at(-1)!, /did not run: after the back, after running Studio's "workspace\.history\.back" itself/)

  // The same with silence past the limit.
  const quiet = builtIn()
  runReplaceable('workspace.history.back', quiet.run)
  await vi.advanceTimersByTimeAsync(10)
  runCommandForWorker({ moduleId: 'acme.wraps', action: 'workspace.history.back' })
  await vi.advanceTimersByTimeAsync(REPLACEMENT_TIME_LIMIT_MS)
  assert.equal(quiet.runs, 0)
  assert.deepEqual(app.runs, ['workspace.history.back', 'workspace.history.back'])
  fail({ ok: true, result: null })
})

test('a worker that refuses or throws has Studio run its own at once', async () => {
  const refused = builtIn()
  replacement('acme.refuses', async () => ({ ok: false, code: 'failed', message: 'No history.' }))
  runReplaceable('workspace.history.back', refused.run)
  await vi.waitFor(() => assert.equal(refused.runs, 1))
  assert.match(lines[0]!, /acme\.refuses: .*"notes\.back" did not run: No history\./)
  forgetExtensionReplacements('acme.refuses')

  const thrown = builtIn()
  replacement('acme.throws', async () => {
    throw new Error('worker gone')
  })
  runReplaceable('workspace.history.back', thrown.run)
  await vi.waitFor(() => assert.equal(thrown.runs, 1))
  assert.match(lines[1]!, /acme\.throws: .*"notes\.back" failed: worker gone/)
})

test('of two that replace one action, the one installed first does; ties go by key', async () => {
  const later = replacement('acme.later', async () => ({ ok: true, result: null }), { installedAt: 2000 })
  const first = replacement('zeta.first', async () => ({ ok: true, result: null }), { installedAt: 1000 })
  replacement('acme.unknown', async () => ({ ok: true, result: null }))
  assert.equal(replacementFor('workspace.history.back')?.key, 'zeta.first')
  runReplaceable('workspace.history.back', builtIn().run)
  await vi.waitFor(() => assert.equal(first.calls.length, 1))
  assert.equal(later.calls.length, 0)

  replacement('alpha.tie', async () => ({ ok: true, result: null }), { installedAt: 1000 })
  assert.equal(replacementFor('workspace.history.back')?.key, 'alpha.tie')
})

test('switched off on its page, or not live, an extension replaces nothing and the next one does', () => {
  let live = true
  replacement('acme.first', async () => ({ ok: true, result: null }), { installedAt: 1, live: () => live })
  replacement('acme.second', async () => ({ ok: true, result: null }), { installedAt: 2 })
  assert.equal(replacementFor('workspace.history.back')?.key, 'acme.first')

  useExtensionReplacementSwitches.getState().setTakesOver('acme.first', false)
  assert.equal(replacementFor('workspace.history.back')?.key, 'acme.second')
  useExtensionReplacementSwitches.getState().setTakesOver('acme.second', false)
  const own = builtIn()
  runReplaceable('workspace.history.back', own.run)
  assert.equal(own.runs, 1, 'with both switched off Studio runs its own')

  useExtensionReplacementSwitches.setState({ off: {} })
  live = false
  assert.equal(replacementFor('workspace.history.back')?.key, 'acme.second', 'a disabled one is skipped')
})

test('a worker’s commands.run always runs Studio’s own action, never a replacement, and only actions it may name', () => {
  const { calls } = replacement('acme.back', async () => ({ ok: true, result: null }))
  const ran: string[] = []
  stopRunner = setAppCommandRunner((commandId) => {
    ran.push(commandId)
    return true
  })
  assert.equal(runBuiltInAction('workspace.history.back'), true)
  assert.equal(runBuiltInAction('pane.toggle'), true)
  assert.equal(runBuiltInAction('git.fetch'), true)
  assert.equal(runBuiltInAction('app.quit'), false, 'not an action an extension may name')
  assert.deepEqual(ran, ['workspace.history.back', 'pane.toggle', 'git.fetch'])
  assert.equal(calls.length, 0)
})

// ── Registered from what the Studio serves ──────────────────────────────────

function served(key: string, installedAt: number | undefined, title = 'Back'): ExtensionContributionsResult {
  const id = key.slice(key.indexOf('.') + 1)
  const empty = Object.fromEntries(
    [
      'commands',
      'menus',
      'topBarItems',
      'panels',
      'doors',
      'settingsSections',
      'mcpTools',
      'hooks',
      'events',
      'syntaxes',
      'customEditors',
      'keybindings',
      'statusBarItems',
      'settings',
      'skills',
      'mcpServers',
      'providers',
    ].map((point) => [point, []]),
  ) as unknown as ExtensionManifestView['contributes']
  return {
    extensions: [
      {
        id: key,
        manifest: { id: key, displayName: id, version: '1.0.0', defaultEnabled: true, source: 'third-party' },
        extension: {
          manifestVersion: 1,
          id,
          version: '1.0.0',
          engines: { studio: '>=0.13.0' },
          tier: 'worker',
          main: 'dist/main.cjs',
          name: id,
          permissions: [],
          contributes: {
            ...empty,
            commands: [{ id: 'notes.back', title, replaces: 'workspace.history.back' }],
          },
        },
        ...(installedAt === undefined ? {} : { installedAt }),
      },
    ],
    failures: {},
  }
}

test('a served command that replaces an action registers it, at its install time, and leaves with the extension', () => {
  const kernel = createRendererHost()
  keys.push('local.served')
  loadExtensionContributions(kernel, served('local.served', 5), false)
  const registeredNow = replacementFor('workspace.history.back')
  assert.equal(registeredNow?.key, 'local.served')
  assert.equal(registeredNow?.installedAt, 5)
  assert.equal(registeredNow?.title, 'Back')

  // Served changed: taken out, so it replaces nothing until registered again.
  forgetChangedExtensions(served('local.served', 5, 'Back, changed'), () => undefined)
  assert.equal(replacementFor('workspace.history.back'), null)
})

test('an uninstalled extension’s takeover switch is forgotten, so installed again it starts on', () => {
  useExtensionReplacementSwitches.getState().setTakesOver('acme.back', false)
  useExtensionReplacementSwitches.getState().setTakesOver('acme.kept', false)
  forgetExtensionReplacementSwitch('acme.back')
  assert.deepEqual(useExtensionReplacementSwitches.getState().off, { 'acme.kept': true })
})
