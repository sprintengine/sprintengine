import assert from 'node:assert/strict'
import { test } from 'vitest'

import { SERVER_METHODS } from '../server/desktop/server-methods'
import { remoteShellTerminals } from './shell-terminals'

// With the Studio server in a process of its own, a prompt the shell is about
// to type to a terminal agent (a tour's) is checked by the server, where the
// terminal and the extensions' hooks run: the shell types what it answers. A
// server that cannot be asked types nothing.
test('out of process, a terminal prompt is hooked by the server that runs the terminal', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  let answer: () => Promise<unknown> = async () => ({ ok: true, text: 'Why? (checked)' })
  const terminals = remoteShellTerminals({
    on: () => () => undefined,
    call: (async (method: string, params: unknown) => {
      calls.push({ method, params })
      return answer()
    }) as never,
  })
  const tour = { inputKind: 'tour' as const, from: 'studio' as const }
  assert.deepEqual(await terminals.hookPrompt('term-1', 'Why?', tour), { ok: true, text: 'Why? (checked)' })
  assert.deepEqual(calls, [
    { method: SERVER_METHODS.terminalHookPrompt, params: { sessionId: 'term-1', text: 'Why?', hookAs: tour } },
  ])
  answer = () => Promise.reject(new Error('gone'))
  const unreached = await terminals.hookPrompt('term-1', 'Why?', tour)
  assert.equal(unreached.ok, false)
})
