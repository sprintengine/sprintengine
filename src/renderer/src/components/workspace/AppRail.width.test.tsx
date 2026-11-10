// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'

import { APP_RAIL_WIDTH, AppRail, TRAFFIC_LIGHT_RESERVE, appRailWidth, trafficLightOverhang } from './AppRail'

// The macOS traffic lights end at TRAFFIC_LIGHT_RESERVE, past the rail's own
// measure. Expanded, the sidebar's chrome row covers the rest; collapsed there
// is nothing beside the rail but the workspace card, so the rail takes the
// lights' whole reserve and no edge runs through the zoom button.
const mac = { isMac: true, isFullScreen: false }

test('collapsed on a windowed Mac, the rail widens to the traffic lights’ reserve', () => {
  expect(appRailWidth({ ...mac, sidebarCollapsed: true })).toBe(TRAFFIC_LIGHT_RESERVE)
  expect(trafficLightOverhang({ ...mac, railWidth: TRAFFIC_LIGHT_RESERVE })).toBe(0)
})

test('expanded, the rail keeps its own measure and the sidebar’s chrome row insets for the rest', () => {
  expect(appRailWidth({ ...mac, sidebarCollapsed: false })).toBe(APP_RAIL_WIDTH)
  expect(trafficLightOverhang({ ...mac, railWidth: APP_RAIL_WIDTH })).toBe(TRAFFIC_LIGHT_RESERVE - APP_RAIL_WIDTH)
})

test('in fullscreen or off macOS there are no lights to clear', () => {
  for (const sidebarCollapsed of [true, false]) {
    expect(appRailWidth({ ...mac, isFullScreen: true, sidebarCollapsed })).toBe(APP_RAIL_WIDTH)
    expect(appRailWidth({ ...mac, isMac: false, sidebarCollapsed })).toBe(APP_RAIL_WIDTH)
  }
  expect(trafficLightOverhang({ ...mac, isFullScreen: true, railWidth: APP_RAIL_WIDTH })).toBe(0)
  expect(trafficLightOverhang({ ...mac, isMac: false, railWidth: APP_RAIL_WIDTH })).toBe(0)
})

test('the rail stands as wide as it is told', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = {}
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = (width?: number) =>
    act(async () =>
      root.render(
        <AppRail
          section="home"
          onSelectSection={() => undefined}
          surfaces={[]}
          activeGlobalSurface={null}
          onOpenSurface={() => undefined}
          width={width}
        />,
      ),
    )
  const rail = () => host.querySelector<HTMLElement>('nav[aria-label="App rail"]')
  await render()
  expect(rail()?.style.width).toBe(`${APP_RAIL_WIDTH}px`)
  await render(TRAFFIC_LIGHT_RESERVE)
  expect(rail()?.style.width).toBe(`${TRAFFIC_LIGHT_RESERVE}px`)
  await act(async () => root.unmount())
  host.remove()
})
