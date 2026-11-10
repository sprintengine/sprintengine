import { expect, test } from 'vitest'
import { APP_RAIL_WIDTH, TRAFFIC_LIGHT_RESERVE } from './AppRail'
import { bandTrafficLightInset } from './WorkspaceBand'

const mac = { isMac: true, isFullScreen: false, sidebarCollapsed: true }

test('beside the rail the band leaves no room: the rail beside a collapsed sidebar covers the traffic lights', () => {
  expect(TRAFFIC_LIGHT_RESERVE).toBeGreaterThan(APP_RAIL_WIDTH)
  expect(bandTrafficLightInset({ ...mac, besideRail: true })).toBe(0)
})

test('with the rail hidden by the narrow layout, the band leaves room for all of the traffic lights', () => {
  expect(bandTrafficLightInset({ ...mac, besideRail: false })).toBe(TRAFFIC_LIGHT_RESERVE)
})

test('no room is left with the sidebar open, in fullscreen, or off macOS', () => {
  for (const besideRail of [true, false]) {
    expect(bandTrafficLightInset({ ...mac, sidebarCollapsed: false, besideRail })).toBe(0)
    expect(bandTrafficLightInset({ ...mac, isFullScreen: true, besideRail })).toBe(0)
    expect(bandTrafficLightInset({ ...mac, isMac: false, besideRail })).toBe(0)
  }
})

test('a strip on the top row stands in the band, and at its ends keeps clear of what stands there', async () => {
  const { bandStripMarks } = await import('./WorkspaceLayout')
  const layout = { x: 0, y: 0, width: 1000, height: 800 }
  expect(bandStripMarks({ x: 0, y: 0, width: 1000, height: 800 }, layout)).toEqual({
    'data-band-strip': '',
    'data-band-start': '',
    'data-band-end': '',
  })
  expect(bandStripMarks({ x: 0, y: 0, width: 500, height: 800 }, layout)).toEqual({
    'data-band-strip': '',
    'data-band-start': '',
  })
  expect(bandStripMarks({ x: 500, y: 0, width: 500, height: 800 }, layout)).toEqual({
    'data-band-strip': '',
    'data-band-end': '',
  })
  expect(bandStripMarks({ x: 0, y: 400, width: 1000, height: 400 }, layout), 'under a split it stays put').toBe(null)
})

test('a tab cuts a notch only at the band ends it stands at', async () => {
  const { bandClearVars } = await import('./WorkspaceLayout')
  const whole = bandClearVars({ 'data-band-strip': '', 'data-band-start': '', 'data-band-end': '' })
  expect(whole['--band-clearance']).toBe('36px')
  expect(whole['--band-notch-left']).toContain('--band-inset-left')
  expect(whole['--band-notch-right']).toContain('--band-inset-right')
  const leftOfSplit = bandClearVars({ 'data-band-strip': '', 'data-band-start': '' })
  expect(leftOfSplit['--band-notch-right']).toBe('0px')
  expect(bandClearVars(null)).toEqual({
    '--band-clearance': '0px',
    '--band-notch-left': '0px',
    '--band-notch-right': '0px',
  })
})
