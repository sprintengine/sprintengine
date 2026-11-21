import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  DoorModuleNotInstalledSurface,
  ModuleNotInstalledSurface,
  moduleLabelForMode,
  moduleLabelForModuleId,
  workspaceModuleAbsence,
} from './ModuleAbsenceSurfaces'
import { test } from 'vitest'

test('ModuleAbsenceSurfaces', async () => {
  // Module absence surfaces: the workspace-level and per-tab "module not
  // installed" states. Rendered statically (the same way the settings-row tests
  // render) so copy, labeling, and the one action are pinned without a DOM.

  function testNotInstalledSurfaceNamesTheModuleAndOffersInstall(): void {
    const html = renderToStaticMarkup(<ModuleNotInstalledSurface label="Calendar" onOpenMarketplace={() => {}} />)
    assert.match(html, /Calendar isn’t installed/)
    assert.match(html, /safe on disk/, 'the surface says the data is untouched')
    assert.match(html, /Find it in Plugins/, 'the install affordance is present')
    assert.match(html, /aria-label="Extension not installed"/)
  }

  function testModeLabelFallsBackToCapitalizedId(): void {
    assert.equal(moduleLabelForMode('calendar'), 'Calendar')
  }

  // The door-level absence surface — door name, one sentence, one CTA
  // into Extensions — with copy that stays honest between "not installed" and
  // "installed but disabled".
  function testDoorNotInstalledSurfaceNamesTheDoorAndOffersExtensions(): void {
    const html = renderToStaticMarkup(<DoorModuleNotInstalledSurface label="Reviews" onOpenExtensions={() => {}} />)
    assert.match(html, /Reviews/)
    assert.match(html, /The Reviews extension isn’t installed\./)
    assert.match(html, /Find it in Plugins/, 'the single CTA is present')
    assert.match(html, /aria-label="Door extension not installed"/)

    const disabled = renderToStaticMarkup(
      <DoorModuleNotInstalledSurface label="Reviews" installed onOpenExtensions={() => {}} />,
    )
    assert.match(disabled, /The Reviews extension is turned off\./)
    assert.doesNotMatch(disabled, /isn’t installed\./, 'a disabled module is never called uninstalled')
  }

  // A persisted workspace whose type IS registered but whose module is
  // switched off: the module is on the machine, so the copy must say turned off
  // rather than not installed, and the action must lead to the toggle rather than
  // a storefront.
  function testTurnedOffWorkspaceSurfaceSaysSoAndLeadsToTheToggle(): void {
    const html = renderToStaticMarkup(
      <ModuleNotInstalledSurface
        label="Automations"
        installed
        actionLabel="Open extension settings"
        onOpenMarketplace={() => {}}
      />,
    )
    assert.match(html, /Automations is turned off/)
    assert.match(html, /turn the extension back on/, 'the body names the remedy')
    assert.match(html, /Open extension settings/, 'the enable affordance replaces the storefront signpost')
    assert.doesNotMatch(html, /Find it in Plugins/)
  }

  // A workspace type id and its owning module id need not match — a module may
  // register a type under a name of its own — so the turned-off surface reads the
  // label off the MODULE id, not the mode.
  function testModuleIdLabelNamesTheBundledModule(): void {
    assert.equal(moduleLabelForModuleId('scheduled-agents'), 'Scheduled agents')
    assert.equal(moduleLabelForModuleId('tide-tables'), 'tide-tables', 'an id no manifest knows is returned as-is')
  }

  // The rule behind the surface above. A registered workspace type owned
  // by a module that is switched off must produce the turned-off answer rather
  // than letting the layout mount — and turning it back on must produce no answer
  // at all.
  function testWorkspaceAbsenceAnswersInstalledAbsentAndDisabled(): void {
    const deps = (enabled: boolean, registered = true) => ({
      workspaceTypeModuleId: (mode: string) => (registered && mode === 'tide-tables' ? 'tide-tables' : undefined),
      isModuleEnabled: () => enabled,
    })

    assert.equal(workspaceModuleAbsence('standard', deps(true)), null, 'the shell mode is never absent')
    assert.equal(
      workspaceModuleAbsence('tide-tables', deps(true)),
      null,
      'with the module on, the workspace renders its own layout',
    )
    assert.deepEqual(
      workspaceModuleAbsence('tide-tables', deps(false)),
      { kind: 'disabled', label: 'tide-tables', moduleId: 'tide-tables' },
      'a persisted workspace whose module is switched off opens on the turned-off surface',
    )
    assert.deepEqual(
      workspaceModuleAbsence('tide-tables', deps(true, false)),
      { kind: 'not-installed', label: 'Tide-tables' },
      'with nothing registering the type, the same workspace offers an install',
    )
  }

  testWorkspaceAbsenceAnswersInstalledAbsentAndDisabled()
  testTurnedOffWorkspaceSurfaceSaysSoAndLeadsToTheToggle()
  testModuleIdLabelNamesTheBundledModule()
  testNotInstalledSurfaceNamesTheModuleAndOffersInstall()
  testModeLabelFallsBackToCapitalizedId()
  testDoorNotInstalledSurfaceNamesTheDoorAndOffersExtensions()
  console.log('ModuleAbsenceSurfaces tests passed')
})
