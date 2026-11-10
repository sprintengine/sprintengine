// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'

import { SidebarChrome } from './SidebarChrome'

async function renderChrome(revealed: boolean) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onToggleSidebar = vi.fn()
  await act(async () =>
    root.render(
      <SidebarChrome
        isMac={false}
        isFullScreen={false}
        onToggleSidebar={onToggleSidebar}
        onNavigateBack={() => undefined}
        onNavigateForward={() => undefined}
        onOpenSearch={() => undefined}
        menuItems={[]}
        onShowMenu={() => undefined}
        revealed={revealed}
      />,
    ),
  )
  return { host, onToggleSidebar, unmount: () => act(async () => root.unmount()) }
}

test('the expanded sidebar offers to collapse, and says it is open', async () => {
  const { host, unmount } = await renderChrome(false)
  const toggle = host.querySelector('[aria-label="Collapse sidebar"]')
  expect(toggle?.getAttribute('aria-pressed')).toBe('true')
  await unmount()
})

test('a collapsed sidebar shown at the edge offers to stay open, through the same toggle', async () => {
  const { host, onToggleSidebar, unmount } = await renderChrome(true)
  expect(host.querySelector('[aria-label="Collapse sidebar"]')).toBeNull()
  const toggle = host.querySelector<HTMLElement>('[aria-label="Keep sidebar open"]')
  expect(toggle?.getAttribute('aria-pressed')).toBe('false')
  await act(async () => toggle?.click())
  expect(onToggleSidebar).toHaveBeenCalledTimes(1)
  await unmount()
})
