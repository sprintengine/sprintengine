// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes,
// handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import type { ModuleWorkspaceView } from '@sprintengine/extension-sdk'
import { createFakeRendererHost, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { WorkspacesView } from '../src/workspaces'
import { manifest } from './manifest'

test('the door lists the open workspaces, and shows where the picked one lives', async () => {
  const renderer = createFakeRendererHost({
    manifest,
    workspaces: [
      { id: 'ws-app', name: 'App', folderPath: '/Users/dev/projects/app', mode: 'standard' },
      { id: 'ws-docs', name: 'Docs', folderPath: '/Users/dev/projects/docs', mode: 'standard' },
    ],
  })
  const studio = renderer.studio({ point: 'doors', id: 'workspaces' })
  let workspaces: ModuleWorkspaceView[] = []
  const stop = studio.watchWorkspaces((list) => (workspaces = list))
  stop()
  assert.deepEqual(
    workspaces.map((workspace) => workspace.name),
    ['App', 'Docs'],
  )

  const html = await renderToHtml(createElement(WorkspacesView, { workspaces, selectedId: 'ws-docs', onSelect() {} }))
  assert.match(html, /\/Users\/dev\/projects\/docs/)
  assert.deepEqual(renderer.undeclared, [], 'everything it used is declared in extension/extension.json')
})
