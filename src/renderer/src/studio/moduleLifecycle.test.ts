import { expect, test } from 'vitest'

import { windowCatalogueLifecycle, windowModuleLifecycle } from './moduleLifecycle'
import type { ElectronApi } from '../../../shared/electron-api'
import { configureWindowStudio } from './windowStudioClient'

/** A page's api as the window client reads it: only its ticket. */
const pageApi = () => ({ studioWindowTicket: async () => ({}) }) as unknown as Pick<ElectronApi, 'studioWindowTicket'>

// Which window may change what runs on its Studio. A folder names this
// window's disk, so a browser tab (its Studio on another machine) has no
// folder installs; installing from a catalogue or a git URL, approving,
// switching and uninstalling, reviewing an update and managing catalogues
// name nothing on it, so a tab has those.

test('a browser tab installs from a catalogue or a git URL, and not from a folder', () => {
  const tab = pageApi()
  configureWindowStudio(tab, { anotherMachine: true })
  expect(windowModuleLifecycle(tab)).toBeNull()
  expect(windowCatalogueLifecycle(tab)).not.toBeNull()
})

test('a desktop window has both, and a page with no Studio has neither', () => {
  const desktop = pageApi()
  expect(windowModuleLifecycle(desktop)).not.toBeNull()
  expect(windowCatalogueLifecycle(desktop)).not.toBeNull()
  expect(windowCatalogueLifecycle({} as never)).toBeNull()
})
