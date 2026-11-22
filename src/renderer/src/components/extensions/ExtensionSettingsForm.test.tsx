// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ExtensionSettingContribution } from '../../../../shared/modules/third-party-manifest'

// The form Studio draws for an extension's declared settings follows the
// values wherever they change: another window, another client or the
// extension's own code (`extension.settingsChanged`), and everything once
// more after a reconnect. A connection that may not change Studio's settings
// sees the declared settings read only. An emptied text field with a default
// goes back to it.

const studio = vi.hoisted(() => ({
  writable: true,
  values: { indent: 2, label: 'Main' } as Record<string, unknown>,
  reads: 0,
  heard: null as ((moduleId: string | null) => void) | null,
  saved: [] as unknown[],
}))
vi.mock('../../studio/extensions', () => ({
  windowHasStudio: () => false,
  extensionsApi: {
    canChangeExtensionSettings: async () => studio.writable,
    extensionSettings: async () => {
      studio.reads += 1
      return { ...studio.values }
    },
    onExtensionSettingsChanged: (cb: (moduleId: string | null) => void) => {
      studio.heard = cb
      return () => {
        studio.heard = null
      }
    },
    setExtensionSetting: async (input: unknown) => {
      studio.saved.push(input)
      return { ok: true, values: { ...studio.values } }
    },
  },
}))

const { ExtensionSettingsForm, draftValue } = await import('./ExtensionSettingsForm')

const SETTINGS: ExtensionSettingContribution[] = [
  { key: 'indent', title: 'Indent width', type: 'integer', minimum: 1, maximum: 8, default: 2 },
  { key: 'label', title: 'Label', type: 'string', default: 'Main' },
]

let root: Root | null = null
let host: HTMLElement | null = null
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  studio.writable = true
  studio.values = { indent: 2, label: 'Main' }
  studio.reads = 0
  studio.saved = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

const flush = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
const indent = () => host!.querySelector<HTMLInputElement>('input[type="number"]')!

test('an open form reads the values again when they change elsewhere, and after a reconnect', async () => {
  act(() => root!.render(<ExtensionSettingsForm extensionKey="local.tally" settings={SETTINGS} />))
  await flush()
  expect(indent().value).toBe('2')
  studio.values = { indent: 6, label: 'Main' }
  await act(async () => studio.heard!('local.other'))
  await flush()
  expect(indent().value).toBe('2')
  await act(async () => studio.heard!('local.tally'))
  await flush()
  expect(indent().value).toBe('6')
  studio.values = { indent: 7, label: 'Main' }
  await act(async () => studio.heard!(null))
  await flush()
  expect(indent().value).toBe('7')
})

test('a connection that may not change settings sees them read only, with their defaults', async () => {
  studio.writable = false
  act(() => root!.render(<ExtensionSettingsForm extensionKey="local.tally" settings={SETTINGS} />))
  await flush()
  expect(host!.textContent).toMatch(/Read only here/)
  expect(indent().readOnly).toBe(true)
  expect(indent().value).toBe('2')
  expect(studio.reads).toBe(0)
})

test('text is saved as typed, empty included, and Reset to default is its own control', async () => {
  expect(draftValue(SETTINGS[1]!, '')).toBe('')
  expect(draftValue(SETTINGS[1]!, '  ')).toBe('  ')
  expect(draftValue({ key: 'free', title: 'Free', type: 'string' }, '')).toBe('')
  expect(draftValue(SETTINGS[0]!, ' ')).toBeNull()
  expect(draftValue(SETTINGS[0]!, '4')).toBe(4)

  studio.values = { indent: 5, label: '' }
  act(() => root!.render(<ExtensionSettingsForm extensionKey="local.tally" settings={SETTINGS} />))
  await flush()
  const resets = [...host!.querySelectorAll('button')].filter((button) => button.textContent === 'Reset to default')
  expect(resets.map((button) => button.getAttribute('aria-label'))).toEqual([
    'Reset Indent width to default',
    'Reset Label to default',
  ])
  await act(async () => resets[1]!.click())
  expect(studio.saved).toEqual([{ moduleId: 'local.tally', key: 'label', value: null }])
  // At its default, a setting offers no reset.
  studio.values = { indent: 2, label: 'Main' }
  await act(async () => studio.heard!('local.tally'))
  await flush()
  expect([...host!.querySelectorAll('button')].some((button) => button.textContent === 'Reset to default')).toBe(false)
})
