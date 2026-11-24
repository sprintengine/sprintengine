import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_CAPABILITIES, STUDIO_PROCESSES_CAPABILITY } from '../src/handshake'
import { STUDIO_METHODS, parseStudioMethodParams } from '../src/methods'
import {
  STUDIO_PROCESSES_MAX_STOP,
  STUDIO_PROCESSES_METHODS,
  parseStudioProcessId,
  studioProcessId,
} from '../src/processes'

const refusal = (parsed: { ok: boolean; code?: string }) => (parsed.ok ? null : parsed.code)

test('both processes methods are an owner’s, under their scopes, behind the processes capability', () => {
  // They read the command lines of what agents ran here, and end programs here.
  for (const [method, spec] of Object.entries(STUDIO_PROCESSES_METHODS)) {
    assert.ok(spec.owner, method)
    assert.equal(spec.capability, STUDIO_PROCESSES_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method as keyof typeof STUDIO_METHODS], spec, method)
  }
  assert.equal(STUDIO_PROCESSES_METHODS['processes.list'].scope, 'workspaces:read')
  assert.equal(STUDIO_PROCESSES_METHODS['processes.list'].mutation, false)
  assert.equal(STUDIO_PROCESSES_METHODS['processes.stop'].scope, 'conversation:operate')
  assert.equal(STUDIO_PROCESSES_METHODS['processes.stop'].mutation, true)
  assert.ok((STUDIO_CAPABILITIES as readonly string[]).includes('processes'))
})

test('a row id is a pid and the second it started, and nothing else reads as one', () => {
  assert.equal(studioProcessId(4242, 1_700_000_000_999), '4242-1700000000')
  assert.deepEqual(parseStudioProcessId('4242-1700000000'), { pid: 4242, startSecond: 1_700_000_000 })
  for (const bad of ['', '4242', '0-5', '-1-5', '42-', 'a-1', '1-2-3', ' 1-2', 42, null, '1'.repeat(11) + '-1']) {
    assert.equal(parseStudioProcessId(bad), null, String(bad))
  }
})

test('the list takes no params; a stop takes ids and a command id, de-duplicated and bounded', () => {
  assert.deepEqual(parseStudioMethodParams('processes.list', undefined), { ok: true, params: {} })
  assert.deepEqual(parseStudioMethodParams('processes.stop', { ids: ['1-2', '1-2', '3-4'], commandId: 'c', x: 1 }), {
    ok: true,
    params: { ids: ['1-2', '3-4'], commandId: 'c' },
  })
  const tooMany = Array.from({ length: STUDIO_PROCESSES_MAX_STOP + 1 }, (_, index) => `${index + 1}-1`)
  for (const params of [
    { ids: ['1-2'] },
    { ids: ['1-2'], commandId: '' },
    { ids: [], commandId: 'c' },
    { ids: tooMany, commandId: 'c' },
    { ids: ['1-2', 'pid'], commandId: 'c' },
    { ids: '1-2', commandId: 'c' },
  ]) {
    assert.equal(refusal(parseStudioMethodParams('processes.stop', params)), 'invalid_params', JSON.stringify(params))
  }
})
