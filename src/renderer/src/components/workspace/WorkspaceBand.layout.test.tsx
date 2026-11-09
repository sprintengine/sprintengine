// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { WorkspaceBand, WorkspaceBandGround } from './WorkspaceBand'

vi.mock('flexlayout-react/style/combined.css', () => ({}))

// The band holds what has no other home, and lets the tabs under it be pressed:
// everything of it that takes the pointer says so, and the rest does not.

const WS = 'ws-band'
const noop = () => undefined
let root: Root
let host: HTMLElement

function render(props: Partial<React.ComponentProps<typeof WorkspaceBand>>) {
  act(() =>
    root.render(
      <div data-band-column="">
        <WorkspaceBandGround />
        <WorkspaceBand
          activeWorkspaceId={WS}
          isMac={false}
          isFullScreen={false}
          sidebarCollapsed={false}
          captionReserve={0}
          onToggleSidebar={noop}
          onOpenSearch={noop}
          onNewChat={noop}
          menuItems={[]}
          onShowMenu={noop}
          actionsSlot={null}
          globalSurfaceActive={false}
          surfaceBarSlotRef={noop}
          {...props}
        />
      </div>,
    ),
  )
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, {
    api: { ...window.api, platform: 'win32' },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  })
  useWorkspaceStore.setState({
    workspaces: [
      { id: WS, name: 'Band', agents: {}, paneState: { open: false, activeTabId: null, tabs: [] } },
    ] as never,
    workspacePaneMaximised: false,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

test('the ground drags the window, and the row over it lets the pointer through to the tabs', () => {
  render({})
  expect(host.querySelector('.app-drag.chrome-bar')).not.toBeNull()
  const band = host.querySelector('[data-pane-switch]')?.closest('.pointer-events-none')
  expect(band, 'the row ignores the pointer').not.toBeNull()
  expect(host.querySelector('[data-pane-switch]')?.closest('.pointer-events-auto')).not.toBeNull()
})

test('the caption reserve stands at the band’s end, past every control', () => {
  render({ captionReserve: 120 })
  const toggle = host.querySelector('[data-pane-switch]')!
  const reserve = [...host.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find(
    (node) => node.style.width === '120px',
  )
  expect(reserve).toBeDefined()
  expect(toggle.compareDocumentPosition(reserve!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('a door gets the bar slot and loses the panel toggle', () => {
  const slot = vi.fn()
  render({ globalSurfaceActive: true, surfaceBarSlotRef: slot })
  expect(slot).toHaveBeenCalled()
  expect(host.querySelector('[data-pane-switch]')).toBeNull()
})

test('the launcher stands in the band with the sidebar hidden', () => {
  render({ sidebarCollapsed: true })
  expect(host.querySelector('[aria-label="Open sidebar"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="New chat"]')).not.toBeNull()
})

test('the ground is the drag region for the whole band, and no card takes it back', () => {
  render({})
  expect(host.querySelector('.app-drag.chrome-bar')?.className).toContain('h-[36px]')
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/assets/index.css'), 'utf8')
  expect(css).not.toMatch(/\.flexlayout__tab\s*\{[^}]*app-region/)
})
