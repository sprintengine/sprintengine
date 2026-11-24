// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import type { ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { extensionTakesOver, useExtensionReplacementSwitches } from '../../modules/extension-replacements'
import { ExtensionTakeover } from './ExtensionRow'

// The extension's page lists the Studio actions it runs in place of and holds
// the person's switch for that: on by default, shown only when it replaces
// something, and read by the window's dispatch.

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  useExtensionReplacementSwitches.setState({ off: {} })
})

function view(commands: unknown[]): ThirdPartyModuleView {
  return {
    manifest: { id: 'acme.notes', displayName: 'Notes' },
    extension: { tier: 'worker', permissions: [], contributes: { commands } },
  } as unknown as ThirdPartyModuleView
}

function shown(module: ThirdPartyModuleView): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(<ExtensionTakeover module={module} />))
  return container
}

test('an extension that replaces an action lists it, with a switch that is on until the person turns it off', () => {
  const page = shown(view([{ id: 'notes.back', title: 'Back through notes', replaces: 'workspace.history.back' }]))
  expect(page.textContent).toContain('Back through notes runs in place of Go back (recent workspace)')
  expect(page.textContent).toContain('Let it take over Studio’s actions')
  const toggle = page.querySelector<HTMLElement>('[role="switch"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(extensionTakesOver('acme.notes')).toBe(true)

  act(() => toggle.click())
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(extensionTakesOver('acme.notes')).toBe(false)
  // The switch is the one extension's.
  expect(extensionTakesOver('acme.other')).toBe(true)
})

test('an extension that replaces nothing shows no switch', () => {
  const page = shown(view([{ id: 'notes.clear', title: 'Clear notes' }]))
  expect(page.textContent).toBe('')
})
