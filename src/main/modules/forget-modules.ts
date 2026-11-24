import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { readModuleOverridesSync, writeModuleOverrides } from '../module-host/enablement-store'
import { moduleAppStateMirrorFor } from '../module-host/module-app-state-mirror'
import { deleteModuleSecrets } from '../module-host/module-secrets'
import { MODULE_DATA_DIRECTORY } from '../module-host/module-storage'
import { getSharedCredentialStore } from '../secret-store'

// Everything the app kept for a module outside its folder, dropped once the
// module is uninstalled — by whichever door: Settings → Extensions, or the
// marketplace's own Uninstall — or its development folder removed. Its
// enablement choice, its Settings values, its stored secrets, the keys entered
// for its model providers, its per-user storage and its data directory would
// otherwise wait under its id
// for the next module to take that id, which would start with the keys and
// data the person gave this one. Trust is revoked by whoever removed the folder.
//
// Storage a module kept for a project (`modules/<id>` in the project's store,
// workspace-store.ts) is the project's, and stays with it.
export async function forgetModules(userData: string, moduleIds: readonly string[]): Promise<void> {
  const ids = moduleIds.filter(isModuleIdSegment)
  if (ids.length === 0) return
  const overrides = readModuleOverridesSync(userData)
  if (ids.some((id) => id in overrides)) {
    const next = { ...overrides }
    for (const id of ids) delete next[id]
    await writeModuleOverrides(userData, next)
  }
  for (const id of ids) {
    // Its Settings values (`module:<id>`), on disk and in the process's copy,
    // whose listeners (Settings, its worker's watch) hear them gone.
    moduleAppStateMirrorFor(userData).forget(id)
    await deleteModuleSecrets(userData, id).catch(() => undefined)
    await rm(join(userData, 'module-storage', id), { recursive: true, force: true }).catch(() => undefined)
    // The module's private directory (`MainHost.getModuleDataDir`).
    await rm(join(userData, MODULE_DATA_DIRECTORY, id), { recursive: true, force: true }).catch(() => undefined)
    // The keys the person entered for its model providers (`<id>/<provider id>`).
    await getSharedCredentialStore()
      .forgetUnder(`${id}/`)
      .catch(() => undefined)
  }
}

export function isModuleIdSegment(id: string): boolean {
  return id.length > 0 && id.length <= 200 && !/[\\/\0]/.test(id) && id !== '.' && id !== '..'
}
