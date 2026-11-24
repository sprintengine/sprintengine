import { readFileSync, statSync } from 'fs'
import { join } from 'path'

import {
  EXTENSION_MANIFEST_FILENAME,
  extensionSettingValues,
  parseExtensionInstallKey,
  parseExtensionManifest,
  settingValueProblem,
  type ExtensionSettingContribution,
} from '../../../packages/extension-sdk/src/extension-manifest'
import type { ModuleAppStateMirror } from '../module-host/module-app-state-mirror'

// The settings an extension declares in extension.json are read by its own
// code through the same store its Settings values live in
// (`settings.get` in a frame, `getModuleAppState` in a worker), and through
// the same rule Settings itself reads them by (`extensionSettingValues`): a
// declared setting reads as the stored value while it fits the declaration,
// else as its default. A write to a declared setting is held to the
// declaration on every path, a frame's `settings.set` included. Keys the
// extension does not declare (what its own settings section keeps) pass
// through as they are. Each extension.json is read once while it is unchanged.

type Cached = { mtimeMs: number; size: number; settings: readonly ExtensionSettingContribution[] }
const NONE: readonly ExtensionSettingContribution[] = Object.freeze([])

/** The settings `moduleId`'s extension.json under `moduleRoot` declares. */
export function declaredSettingsReader(
  moduleRoot: () => string,
): (moduleId: string) => readonly ExtensionSettingContribution[] {
  const cache = new Map<string, Cached>()
  return (moduleId) => {
    if (!parseExtensionInstallKey(moduleId)) return NONE
    const path = join(moduleRoot(), moduleId, EXTENSION_MANIFEST_FILENAME)
    try {
      const info = statSync(path)
      const cached = cache.get(path)
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.settings
      const parsed = parseExtensionManifest(readFileSync(path, 'utf8'))
      const settings = parsed.ok ? parsed.manifest.contributes.settings : NONE
      cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, settings })
      return settings
    } catch {
      return NONE
    }
  }
}

/** A refused write to a declared setting, in the declaration's words. */
export class DeclaredSettingRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeclaredSettingRefusal'
  }
}

/** The store as an extension's code reads and writes it: declared settings held to their declaration. */
export function withDeclaredSettings(
  store: ModuleAppStateMirror,
  declaredFor: (moduleId: string) => readonly ExtensionSettingContribution[],
): ModuleAppStateMirror {
  const read = (moduleId: string, stored: Readonly<Record<string, unknown>>) => {
    const declared = declaredFor(moduleId)
    if (declared.length === 0) return stored
    const values: Record<string, unknown> = { ...stored }
    for (const setting of declared) delete values[setting.key]
    return { ...values, ...extensionSettingValues(declared, stored) }
  }
  return {
    get: (moduleId) => read(moduleId, store.get(moduleId)),
    setValue(moduleId, key, value) {
      const setting = declaredFor(moduleId).find((candidate) => candidate.key === key)
      if (setting && value !== undefined) {
        const problem = settingValueProblem(setting, value)
        if (problem) throw new DeclaredSettingRefusal(`${setting.title} ${problem}`)
      }
      store.setValue(moduleId, key, value)
    },
    subscribe: (moduleId, listener) => store.subscribe(moduleId, (values) => listener(read(moduleId, values))),
  }
}
