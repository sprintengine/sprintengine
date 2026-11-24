// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Drive the source with
// the SDK's fakes, handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeFrameStudio } from '@sprintengine/extension-sdk/testing'

import { workspaceFacts } from '../extension/src/workspaces'
import { manifest } from './manifest'

test('the door lists the open workspaces, and shows where the picked one lives', async () => {
  const frame = createFakeFrameStudio({
    manifest,
    workspaces: [
      { id: 'ws-app', name: 'App', folderPath: '/Users/dev/projects/app', mode: 'standard' },
      { id: 'ws-docs', name: 'Docs', folderPath: '/Users/dev/projects/docs', mode: 'standard' },
    ],
  })
  const studio = frame.studio({ point: 'doors', id: 'workspaces' })
  const workspaces = await studio.host.call('workspace.list', {})
  assert.deepEqual(
    workspaces.map((workspace) => workspace.name),
    ['App', 'Docs'],
  )
  assert.deepEqual(workspaceFacts(workspaces[1]!), [
    ['Folder', '/Users/dev/projects/docs'],
    ['Type', 'standard'],
  ])
  assert.deepEqual(frame.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('a workspace without a folder says so', () => {
  assert.equal(
    workspaceFacts({ id: 'ws-scratch', name: 'Scratch', folderPath: null, mode: 'standard' })[0]?.[1],
    'None (a workspace without a folder)',
  )
})
