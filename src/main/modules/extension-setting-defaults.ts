import { readFileSync, statSync } from 'fs'
import { join } from 'path'

import {
  EXTENSION_MANIFEST_FILENAME,
  extensionSettingDefaults,
  parseExtensionInstallKey,
  parseExtensionManifest,
} from '../../../packages/extension-sdk/src/extension-manifest'
import type { ModuleAppStateMirror } from '../module-host/module-app-state-mirror'

// The settings an extension declares in extension.json are read by its own
// code through the same store its Settings values live in
// (`settings.get` in a frame, `getModuleAppState` in a worker). A declared
// setting the person never set reads as its `default`: this lays each
// extension's declared defaults under what is stored, read from its
// extension.json (kept while the file is unchanged), so every reader agrees.

type Cached = { mtimeMs: number; size: number; defaults: Readonly<Record<string, unknown>> }
const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({})

/** What `moduleId`'s extension.json under `moduleRoot` declares as defaults, by key. */
export function declaredSettingDefaultsReader(
  moduleRoot: () => string,
): (moduleId: string) => Readonly<Record<string, unknown>> {
  const cache = new Map<string, Cached>()
  return (moduleId) => {
    if (!parseExtensionInstallKey(moduleId)) return EMPTY
    const path = join(moduleRoot(), moduleId, EXTENSION_MANIFEST_FILENAME)
    try {
      const info = statSync(path)
      const cached = cache.get(path)
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.defaults
      const parsed = parseExtensionManifest(readFileSync(path, 'utf8'))
      const defaults = parsed.ok ? extensionSettingDefaults(parsed.manifest.contributes.settings) : EMPTY
      cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, defaults })
      return defaults
    } catch {
      return EMPTY
    }
  }
}

/** The store, with each extension's declared defaults under its stored values. */
export function withDeclaredSettingDefaults(
  store: ModuleAppStateMirror,
  defaultsFor: (moduleId: string) => Readonly<Record<string, unknown>>,
): ModuleAppStateMirror {
  const merged = (moduleId: string, values: Readonly<Record<string, unknown>>) => {
    const defaults = defaultsFor(moduleId)
    return defaults === EMPTY || Object.keys(defaults).length === 0 ? values : { ...defaults, ...values }
  }
  return {
    get: (moduleId) => merged(moduleId, store.get(moduleId)),
    setValue: (moduleId, key, value) => store.setValue(moduleId, key, value),
    subscribe: (moduleId, listener) => store.subscribe(moduleId, (values) => listener(merged(moduleId, values))),
  }
}
