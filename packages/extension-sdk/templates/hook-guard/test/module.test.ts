// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Drive the source with
// the SDK's fakes, handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost } from '@sprintengine/extension-sdk/testing'

import { activate } from '../extension/src/main'
import { manifest } from './manifest'

const call = (command: string) => ({
  agent: 'claude-agent',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  tool: 'Bash',
  input: { command },
  callId: null,
})

test('a force-push is refused, with the reason the agent reads', async () => {
  const fake = createFakeMainHost({ manifest })
  activate(fake.host)
  const verdict = await fake.hooks.fire('agent.tool.before', call('git push --force origin main'))
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.kind === 'deny' ? verdict.reason : '', /force-pushes/)
})

test('any other call runs', async () => {
  const fake = createFakeMainHost({ manifest })
  activate(fake.host)
  assert.deepEqual(await fake.hooks.fire('agent.tool.before', call('git push origin main')), { kind: 'pass' })
  assert.deepEqual(await fake.hooks.fire('agent.tool.after', { ...call('ls'), output: '', failed: false }), {
    kind: 'pass',
  })
})

test('extension.json lists every hook the worker serves', () => {
  const fake = createFakeMainHost({ manifest })
  activate(fake.host)
  assert.deepEqual(fake.hooks.registered().sort(), manifest.contributes.hooks.map((hook) => hook.point).sort())
  assert.deepEqual(fake.undeclared, [])
})
