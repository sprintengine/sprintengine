import assert from 'node:assert/strict'

import { test } from 'vitest'
import { modelDiscoveryLine, modelRefreshProblem } from './modelDiscoveryLine'

const now = Date.parse('2026-09-22T12:00:00Z')
const catalog = (models: { id: string }[], cliVersion?: string) => ({
  models,
  fetchedAt: '2026-09-22T11:58:00Z',
  source: 'agent-sdk' as const,
  ...(cliVersion ? { cliVersion } : {}),
})

test('a CLI that answered names itself, its version and when it was asked', () => {
  assert.equal(
    modelDiscoveryLine({ name: 'Claude Code', catalog: catalog([{ id: 'opus' }], '2.1.280'), now }),
    'From Claude Code 2.1.280, checked 2m ago',
  )
  assert.equal(
    modelDiscoveryLine({ name: 'Grok', catalog: catalog([{ id: 'grok-4' }]), now }),
    'From Grok, checked 2m ago',
    'no version reported, no version shown',
  )
})

test('a version line that names the CLI again does not stutter', () => {
  assert.equal(
    modelDiscoveryLine({ name: 'Claude Code', catalog: catalog([{ id: 'opus' }], '2.1.296 (Claude Code)'), now }),
    'From Claude Code 2.1.296, checked 2m ago',
  )
})

test('no answer yet, or an empty one, is the built-in list', () => {
  const words = 'Built-in list. Codex has not reported its own.'
  assert.equal(modelDiscoveryLine({ name: 'Codex', catalog: undefined, now }), words)
  assert.equal(modelDiscoveryLine({ name: 'Codex', catalog: catalog([]), now }), words)
})

test('while a refresh runs the line says what it is doing', () => {
  assert.equal(
    modelDiscoveryLine({ name: 'Codex', catalog: catalog([{ id: 'x' }]), refreshing: true, now }),
    'Asking Codex for its models…',
  )
})

const after = Date.parse('2026-09-22T12:30:00Z')

test('a failed refresh over a list says the list stayed and points at typing', () => {
  assert.deepEqual(
    modelRefreshProblem({
      name: 'Claude Code',
      outcome: { error: 'Claude Code did not list its models: exited with code 1', at: after },
      catalog: catalog([{ id: 'opus' }]),
      hasRows: true,
    }),
    {
      title: 'Claude Code did not list its models.',
      hint: 'The list below stays as it was. To use another model, type its id.',
      detail: 'exited with code 1',
    },
  )
})

test('a failed refresh with nothing on the list points straight at typing', () => {
  const problem = modelRefreshProblem({
    name: 'Codex',
    outcome: { error: 'Codex listed no models.', at: after },
    catalog: undefined,
    hasRows: false,
  })
  assert.equal(problem?.hint, 'Type a model id below to add one.')
  assert.equal(problem?.detail, undefined, 'an empty answer has no reason to repeat')
})

test('a skipped CLI says why instead of saying nothing', () => {
  const base = { name: 'Kimi', catalog: undefined, hasRows: false }
  assert.equal(
    modelRefreshProblem({ ...base, outcome: { skipped: 'not-installed', at: after } })?.title,
    'Kimi is not installed on this machine.',
  )
  assert.equal(
    modelRefreshProblem({ ...base, outcome: { skipped: 'no-probe', at: after } })?.title,
    'Kimi has no way to report its models.',
  )
  assert.equal(modelRefreshProblem({ ...base, outcome: { skipped: 'fresh', at: after } }), null)
})

test('a list that arrived after the failure clears it', () => {
  assert.equal(
    modelRefreshProblem({
      name: 'Codex',
      outcome: { error: 'timed out', at: Date.parse('2026-09-22T11:00:00Z') },
      catalog: catalog([{ id: 'x' }]),
      hasRows: true,
    }),
    null,
  )
})

test('no outcome, no notice', () => {
  assert.equal(modelRefreshProblem({ name: 'Codex', outcome: null, catalog: undefined, hasRows: false }), null)
})

test('the reason shown is what the CLI said, not the process plumbing around it', () => {
  assert.equal(
    modelRefreshProblem({
      name: 'Claude Code',
      outcome: {
        error:
          'Claude Code did not list its models: Claude Code process exited with code 1. stderr: Error: managed\n  by IT',
        at: after,
      },
      catalog: undefined,
      hasRows: false,
    })?.detail,
    'Error: managed by IT',
  )
})
