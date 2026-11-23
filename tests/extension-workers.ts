// A Studio server's module kernel with real worker processes, for the worker
// suites: installed extensions written to a scratch folder, approved as they
// are, loaded the way server-modules.ts loads them, each worker forked from
// the built entry (tests/extension-worker.ts).

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extensionManifest, writeExtensionFolder } from './extension-folder'
import { workerEntryForTests } from './extension-worker'
import {
  loadMainModules,
  type CapabilityModule,
  type LoadMainModulesResult,
} from '../src/main/module-host/load-modules'
import { createServiceToken, WORKSPACE_GIT_INFO_SERVICE_KEY } from '../src/main/module-host/main-host'
import { approvedContext } from '../src/main/modules/extension-approvals.test-helper'
import { discoverUserModulesSync } from '../src/main/modules/user-module-registry'
import type { ModuleNotifyInput } from '../src/shared/modules/notifications'
import { planInstalledExtensions } from '../src/server/extensions/extension-plan'
import {
  ExtensionWorkers,
  type ExtensionWorkersOptions,
  type InstalledStanding,
} from '../src/server/extensions/workers/worker-manager'

export type TestExtension = {
  id: string
  /** Its worker, as CommonJS (or as `sources[mainPath]`). */
  main: string
  /** Its worker's file, when not `dist/main.cjs`: `main` is written there. */
  mainPath?: string
  /** More of its files, by path: modules its worker imports. */
  sources?: Record<string, string>
  permissions?: string[]
  background?: boolean
  mcpTools?: Array<{
    name: string
    description: string
    access: 'read' | 'operate'
    inputSchema?: Record<string, unknown>
  }>
  hooks?: Array<{ point: string; onError?: 'pass' | 'deny' }>
  /** Its display name; the id when absent. */
  name?: string
}

export type WorkerHarness = {
  load: LoadMainModulesResult
  workers: ExtensionWorkers
  /** The approvals the workers hold each extension to, by install key; change them to revoke one. */
  approvals: Map<string, { fingerprint: string }>
  /** The extensions as installed now, as discovery would find them; change them to remove or change one. */
  installed: Map<string, InstalledStanding>
  /** Bell rows rung for an extension. */
  bell: Array<{ moduleId: string; input: ModuleNotifyInput }>
  toolsChanged: () => number
  logDir: string
  close(): Promise<void>
}

/**
 * The app's part, providing the workspace git reader `getWorkspaceGitInfo`
 * reaches (a host method that needs `workspace:read` of its invoker), and any
 * stand-in services a suite names by key.
 */
function appModule(services: Record<string, unknown>): CapabilityModule {
  return {
    manifest: { id: 'agent-runtime', displayName: 'Agent runtime', version: 1, defaultEnabled: true },
    registerMain: (host) => {
      host.provideService(createServiceToken(WORKSPACE_GIT_INFO_SERVICE_KEY), () => ({
        read: async (workspaceId: string) => ({ ok: true, workspaceId, branch: 'main', remotes: [] }),
      }))
      for (const [key, value] of Object.entries(services)) host.provideService(createServiceToken(key), () => value)
    },
  }
}

export function startWorkerHarness(
  extensions: TestExtension[],
  options: Partial<Omit<ExtensionWorkersOptions, 'gate' | 'toolNameProblem' | 'notify' | 'approvals'>> = {},
  services: Record<string, unknown> = {},
): WorkerHarness {
  const scratch = mkdtempSync(join(tmpdir(), 'extension-workers-'))
  const root = join(scratch, 'extensions')
  const folders: Record<string, string> = {}
  for (const extension of extensions) {
    const key = `local.${extension.id}`
    folders[key] = writeExtensionFolder(join(root, key), {
      manifest: extensionManifest({
        id: extension.id,
        name: extension.name ?? extension.id,
        permissions: extension.permissions ?? [],
        ...(extension.mainPath ? { main: extension.mainPath } : {}),
        ...(extension.background ? { background: true } : {}),
        ...(extension.mcpTools || extension.hooks
          ? {
              contributes: {
                ...(extension.mcpTools ? { mcpTools: extension.mcpTools } : {}),
                ...(extension.hooks ? { hooks: extension.hooks } : {}),
              },
            }
          : {}),
      }),
      files: { [extension.mainPath ?? 'dist/main.cjs']: extension.main, ...extension.sources },
    })
  }
  const context = approvedContext(folders)
  const approvals = new Map([...context.approvals].map(([key, record]) => [key, { fingerprint: record.fingerprint }]))
  const installed = new Map<string, InstalledStanding>(
    [...approvals].map(([key, { fingerprint }]) => [key, { runnable: true, fingerprint }]),
  )
  const bell: WorkerHarness['bell'] = []
  let toolsChanged = 0
  let kernelRef: LoadMainModulesResult['kernel'] | null = null
  const logDir = join(scratch, 'logs')
  const workers = new ExtensionWorkers({
    entryPath: workerEntryForTests(),
    logDir,
    approvals: () => approvals,
    installed: () => installed,
    gate: (moduleId, method) => kernelRef!.gateHostMethod(moduleId, method),
    toolNameProblem: (moduleId, names) => kernelRef!.mcpToolNameProblem(moduleId, names),
    notify: (moduleId, input) => {
      bell.push({ moduleId, input })
      kernelRef!.emitNotification(moduleId, input)
    },
    toolsChanged: () => void toolsChanged++,
    ...options,
  })
  const listed = discoverUserModulesSync(root, context)
  if (listed.rejected.length > 0) throw new Error(JSON.stringify(listed.rejected))
  const plan = planInstalledExtensions(listed, () => workers)
  const load = loadMainModules({
    modules: [appModule(services), ...plan.modules],
    moduleRoots: plan.moduleRoots,
    moduleVerifiedFiles: plan.verifiedFiles,
    moduleMcpTools: plan.mcpTools,
    extensionApprovals: plan.approvals,
    ineligible: plan.ineligible,
    launchErrors: plan.launchErrors,
    onKernel: (kernel) => {
      kernelRef = kernel
      kernel.attachWorkers(workers)
    },
  })
  return {
    load,
    workers,
    approvals,
    installed,
    bell,
    toolsChanged: () => toolsChanged,
    logDir,
    close: () => workers.close(),
  }
}

/** Wait until `check` holds, or fail after `ms`. */
export async function until(check: () => boolean, ms = 10_000, what = 'the condition'): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Whether a process id is alive. */
export function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
