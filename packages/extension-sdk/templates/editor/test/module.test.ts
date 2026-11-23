// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Drive the source with
// the SDK's fakes, handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeFrameStudio } from '@sprintengine/extension-sdk/testing'

import { formatPairs, parsePairs, type Pair } from '../extension/src/pairs'
import { manifest } from './manifest'

const surface = { point: 'customEditors', id: 'pairs', workspaceId: 'ws-app' } as const
const codec = {
  decode: (content: { kind: string; text?: string }) => parsePairs(content.text ?? ''),
  encode: (pairs: Pair[]) => ({ kind: 'text' as const, text: formatPairs(pairs) }),
}

test('a file’s pairs read and write back the same', () => {
  assert.deepEqual(parsePairs('name = Ada\ncity=London\n'), [
    { key: 'name', value: 'Ada' },
    { key: 'city', value: 'London' },
  ])
  assert.equal(formatPairs([{ key: 'name', value: 'Ada' }]), 'name = Ada\n')
})

test('a change reaches Studio as an edit, and Studio saves it', async () => {
  const frame = createFakeFrameStudio({ manifest, document: { text: 'name = Ada\n' } })
  const session = await frame.studio(surface).document!.session<Pair[]>(codec)
  session.change([...session.value, { key: 'city', value: 'London' }])
  assert.equal(await frame.document.save(), true)
  assert.equal(frame.document.text, 'name = Ada\ncity = London\n')
  session.dispose()
})

test('a change made outside wins over an edit made against the old version', async () => {
  const frame = createFakeFrameStudio({ manifest, document: { text: 'name = Ada\n' } })
  const session = await frame.studio(surface).document!.session<Pair[]>({ ...codec, debounceMs: 60_000 })
  session.change([{ key: 'name', value: 'Grace' }])
  frame.document.replace('name = Alan\n')
  await assert.rejects(session.flush(), { code: 'conflict' })
  assert.deepEqual(session.value, [{ key: 'name', value: 'Alan' }])
  assert.equal(frame.document.text, 'name = Alan\n')
  session.dispose()
})
