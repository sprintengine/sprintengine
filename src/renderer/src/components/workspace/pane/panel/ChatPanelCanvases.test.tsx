// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { StudioError } from '../../../../../../../packages/client-runtime/src/public'
import { fakePairedStudios } from '../../../../studio/environmentStudio.double'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { Workspace } from '../../../../types/workspace'
import { CanvasTab } from '../canvas/CanvasTab'
import { ChatPanel } from './ChatPanel'

// The panel's Canvases row on a chat of a paired machine: the row opens the
// pane's Canvas tab, and that tab's picker lists the boards of the machine the
// chat runs on, not this one's. The two were built apart, so this holds them
// together: through the store, as the window has them.

vi.mock('./useWorkspaceCheckoutFacts', () => ({
  useWorkspaceCheckoutFacts: () => ({ branch: null, changes: null }),
}))

const WS = 'ws-paired'
// One of that machine's boards, as its Studio's `canvas.list` names it.
const farBoard = (path: string) => ({
  id: null,
  here: true,
  name: path.replace(/^.*\/|\.excalidraw$/gu, ''),
  path,
  bytes: 10,
  modifiedAt: 1,
  project: null,
  workspaceId: 'far-workspace',
})

let roots: Root[] = []
let canvasList: ReturnType<typeof vi.fn<(params: Record<string, unknown>) => unknown>>

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => root.render(node))
  return host
}

const panel = (
  <ChatPanel
    workspaceId={WS}
    tabs={[]}
    items={[]}
    currentTabId={null}
    onOpenTab={() => undefined}
    onCloseTab={() => undefined}
    onTabContextMenu={() => undefined}
    addControl={null}
  />
)

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, {
    api: {
      ...window.api,
      platform: 'darwin',
    },
  })
  // That machine's Studio, as this window's own client of it reaches it: it
  // carries its boards here (`canvas-boards`).
  canvasList = vi.fn(() => ({
    note: null,
    boards: [farBoard('diagrams/flow.excalidraw'), farBoard('diagrams/plan.excalidraw')],
  }))
  fakePairedStudios(window.api, { 'canvas.list': (params) => canvasList(params) })
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: WS,
        name: 'demo-app',
        folderPath: '',
        agents: {},
        remoteOrigin: {
          connectionId: 'connection',
          machineName: 'mac-mini',
          workspaceId: 'far-workspace',
          workspaceName: 'demo-app',
          workspaceRoot: null,
        },
      } as unknown as Workspace,
    ],
    focusedAgentByWorkspaceId: {},
  })
})

afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount()
  })
  roots = []
  document.body.replaceChildren()
})

test('on a paired chat the row says how many boards that machine has, and opens that machine’s picker', async () => {
  const host = mount(panel)
  await act(async () => undefined)
  const row = [...host.querySelectorAll<HTMLElement>('[data-panel-row]')].find((item) =>
    item.textContent?.startsWith('Canvases'),
  )
  expect(row?.textContent).toBe('Canvases2')
  expect(row?.getAttribute('data-panel-row')).toBe('action')

  await act(async () => row!.click())
  const tab = useWorkspaceStore.getState().workspaces[0]!.paneState?.tabs.find((entry) => entry.kind === 'canvas')
  expect(tab).toBeDefined()
  const picker = mount(<CanvasTab workspaceId={WS} tab={tab!} active />)
  await act(async () => undefined)
  expect(picker.textContent).toContain('flow')
  expect(picker.textContent).toContain('plan')
  expect(picker.textContent).not.toContain('The boards could not be listed')
  expect(canvasList).toHaveBeenLastCalledWith({ workspaceId: 'far-workspace' })
})

test('a machine that cannot list its boards leaves the row with no number, and still a door', async () => {
  canvasList = vi.fn(() => {
    throw new StudioError('forbidden', 'Not offered.')
  })
  const host = mount(panel)
  await act(async () => undefined)
  const row = [...host.querySelectorAll<HTMLElement>('[data-panel-row]')].find((item) =>
    item.textContent?.startsWith('Canvases'),
  )
  expect(row?.textContent).toBe('Canvases')
  expect(row?.getAttribute('data-panel-row')).toBe('action')
})
