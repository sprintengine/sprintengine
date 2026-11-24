import { join } from 'node:path'

import { EXTENSION_MANIFEST_FILENAME } from '../../../packages/extension-sdk/src/extension-manifest'
import type { LoadMainModulesResult } from '../../main/module-host/load-modules'
import { isExtensionRunnable } from '../../main/modules/module-signature'
import type { UserModuleListResult } from '../../main/modules/user-module-registry'
import { extensionDevEvents, type ExtensionDevEvents } from './dev/dev-events'
import { planInstalledExtensions, type InstalledExtensionsPlan } from './extension-plan'
import type { ExtensionWorkers } from './workers/worker-manager'

// Keeps a Studio server's kernel in step with its extensions as they are on
// disk, while it runs. Each time something may have changed (a save in a
// development folder, the extensions folder changing, an install, an
// approval, a folder registered or removed), the extensions are planned again
// and every one whose load identity moved (its folder, whether it may run, the
// approval it runs under, its files, its extension.json) is loaded again: its
// worker stops and starts on the new code, its tools and hooks are registered
// again, and the clients hear `extension.changed` and draw its surfaces again.
// One that is gone is let go.
//
// An installed extension's identity moves only by an install, an approval or
// a change to its files; a change to its files without one leaves it waiting
// for the person (its fingerprint binds them), so nothing loads silently. A
// development folder's moves with every save, and loads again while its
// approval holds.

export type ExtensionReloader = {
  /** Plan again and load what changed; calls run one at a time, and calls made meanwhile are one more run. */
  reload(): Promise<void>
}

export type ExtensionReloaderDeps = {
  /** The plan the kernel was loaded with: changed in place, so the kernel's maps follow. */
  plan: InstalledExtensionsPlan
  discover: () => UserModuleListResult
  workers: () => ExtensionWorkers
  load: () => LoadMainModulesResult | null
  overrides: () => Record<string, boolean>
  /** After a run that changed something: the manifests, the enablement gate and the clients follow. */
  reloaded: (change: { changed: string[]; removed: string[] }) => void
  events?: ExtensionDevEvents
  log?: (message: string) => void
}

function replaceContents<T>(target: Record<string, T>, next: Record<string, T>): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, next)
}

export function createExtensionReloader(deps: ExtensionReloaderDeps): ExtensionReloader {
  const events = deps.events ?? extensionDevEvents
  // A development folder's key, by folder: a save that breaks its
  // extension.json is still reported under the key it had.
  const keyOfFolder = new Map<string, string>()
  // What was last said of each development folder, so a save that changes nothing it is said again.
  const lastSaid = new Map<string, string>()
  let running: Promise<void> | null = null
  let again = false

  const say = (key: string, said: string, event: Parameters<ExtensionDevEvents['add']>[0]) => {
    if (event.kind !== 'reloaded' && lastSaid.get(key) === said) return
    lastSaid.set(key, said)
    events.add(event)
  }

  async function run(): Promise<void> {
    const load = deps.load()
    if (!load) return
    const input = deps.discover()
    const next = planInstalledExtensions(input, deps.workers)
    const current = deps.plan
    const changed = Object.keys(next.identities).filter((key) => current.identities[key] !== next.identities[key])
    const removed = Object.keys(current.identities).filter((key) => next.identities[key] === undefined)

    // What a development folder's save did, for `dev watch`. `reloaded` is
    // said once its new code is in place, so what follows it sees the new one.
    const reloadedKeys: string[] = []
    for (const module of input.modules) {
      if (!module.development) continue
      keyOfFolder.set(module.moduleRoot, module.key)
      if (!changed.includes(module.key)) continue
      const { approval } = module.standing
      if (approval.state === 'pending') {
        say(module.key, `approval:${approval.fingerprint}`, {
          key: module.key,
          kind: 'approval',
          state: 'pending',
          fingerprint: approval.fingerprint,
          growth: approval.growth,
          message:
            approval.growth.length > 0
              ? `It now asks for ${approval.growth.join(', ')}, and waits for your approval.`
              : 'It waits for your approval.',
        })
      } else if (approval.state === 'unavailable') {
        say(module.key, 'unavailable', {
          key: module.key,
          kind: 'status',
          state: 'invalid',
          message: (module.standing.issues ?? []).map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        })
      } else if (isExtensionRunnable(module.standing)) {
        reloadedKeys.push(module.key)
      }
    }
    for (const rejection of input.rejected) {
      const folder = [...keyOfFolder.keys()].find(
        (candidate) => rejection.path === join(candidate, EXTENSION_MANIFEST_FILENAME) || rejection.path === candidate,
      )
      if (!folder) continue
      const key = keyOfFolder.get(folder)!
      const message = rejection.issues
        .map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`)
        .join('; ')
      say(key, `invalid:${message}`, { key, kind: 'status', state: 'invalid', message })
    }

    if (changed.length === 0 && removed.length === 0) return
    replaceContents(current.moduleRoots, next.moduleRoots)
    replaceContents(current.verifiedFiles, next.verifiedFiles)
    replaceContents(current.mcpTools, next.mcpTools)
    replaceContents(current.approvals, next.approvals)
    replaceContents(current.ineligible, next.ineligible)
    replaceContents(current.identities, next.identities)
    current.modules.splice(0, current.modules.length, ...next.modules)
    current.launchErrors.splice(0, current.launchErrors.length, ...next.launchErrors)
    deps.workers().willReload([...changed, ...removed].filter((key) => next.identities[key] !== undefined))
    const report = await load.replaceModules(
      { modules: next.modules.filter((module) => changed.includes(module.manifest.id)), removed },
      deps.overrides(),
    )
    for (const error of report.errors) {
      deps.log?.(`extension ${error.id} did not load again: ${error.message}`)
      events.add({ key: error.id, kind: 'status', state: 'errored', message: error.message })
    }
    deps.reloaded({ changed, removed })
    for (const key of reloadedKeys) {
      if (report.errors.some((error) => error.id === key)) continue
      say(key, 'reloaded', { key, kind: 'reloaded', message: 'Reloaded.' })
    }
  }

  return {
    reload() {
      if (running) {
        again = true
        return running
      }
      running = (async () => {
        try {
          do {
            again = false
            await run().catch((error: unknown) =>
              deps.log?.(
                `extensions could not be loaded again: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
          } while (again)
        } finally {
          running = null
        }
      })()
      return running
    },
  }
}
