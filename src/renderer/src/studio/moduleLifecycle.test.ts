import { expect, test } from 'vitest'

import { windowCatalogueLifecycle, windowModuleLifecycle } from './moduleLifecycle'
import { configureWindowStudio } from './windowStudioClient'

// Which window may change what runs on its Studio. A folder names this
// window's disk, so a browser tab (its Studio on another machine) has no
// folder installs; installing from a catalogue or a git URL, reviewing an
// update and managing catalogues name nothing on it, so a tab has those.

test('a browser tab installs from a catalogue or a git URL, and not from a folder', () => {
  const tab = { studioWindowTicket: async () => 'session' }
  configureWindowStudio(tab, { anotherMachine: true })
  expect(windowModuleLifecycle(tab)).toBeNull()
  expect(windowCatalogueLifecycle(tab)).not.toBeNull()
})

test('a desktop window has both, and a page with no Studio has neither', () => {
  const desktop = { studioWindowTicket: async () => 'ticket' }
  expect(windowModuleLifecycle(desktop)).not.toBeNull()
  expect(windowCatalogueLifecycle(desktop)).not.toBeNull()
  expect(windowCatalogueLifecycle({} as never)).toBeNull()
})
