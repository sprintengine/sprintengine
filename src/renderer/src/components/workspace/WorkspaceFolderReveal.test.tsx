// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { PANEL_COMMAND_EVENT } from '../../utils/panelCommands'
import { WorkspaceFolderReveal } from './WorkspaceFolderReveal'
import type { Workspace } from '../../../../shared/workspace'

// `Primary+O` outlived the header that used to host it: it answers from a host
// with no chrome, on the folder the followed checkout names.

const workspace = { id: 'w1', name: 'demo', folderPath: '/Users/dev/demo-app', agents: {} } as unknown as Workspace

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const openFolderInTarget = vi.fn(async () => ({ ok: true }))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  openFolderInTarget.mockClear()
  Object.assign(window, { api: { ...window.api, platform: 'darwin', openFolderInTarget } })
  useWorkspaceStore.setState({ focusedAgentByWorkspaceId: {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

test('reveals the workspace checkout when the command names this workspace', async () => {
  act(() => root.render(<WorkspaceFolderReveal activeWorkspace={workspace} activeWorkspaceId="w1" />))
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(PANEL_COMMAND_EVENT, { detail: { id: 'workspace.folder.reveal', workspaceId: 'w1' } }),
    )
  })
  assert.deepEqual(openFolderInTarget.mock.calls.at(-1), [{ target: 'finder', path: '/Users/dev/demo-app' }])
})

test('leaves a reveal meant for another workspace alone', async () => {
  act(() => root.render(<WorkspaceFolderReveal activeWorkspace={workspace} activeWorkspaceId="w1" />))
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(PANEL_COMMAND_EVENT, { detail: { id: 'workspace.folder.reveal', workspaceId: 'w2' } }),
    )
  })
  assert.equal(openFolderInTarget.mock.calls.length, 0)
})
