import type {
  AgentCli,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliRuntimeSettings,
  CliVersionAdvisoriesInput,
  CliVersionAdvisoriesResult,
} from '../shared/electron-api'
import { recordCliDetection } from './cli-availability'
import { cliInstallMethods, detectCli, installCli, updateCli } from './cli-runtime-install'
import {
  noteCliDetected,
  onCliVersionAdvisoriesChanged,
  outdatedCliTargets,
  readCliVersionAdvisories,
  setCliVersionChecksEnabled,
  type CliUpdateTarget,
} from './cli-version-advisory-service'
import type { CliUpdateAllItem, CliUpdateAllResult } from '../shared/ipc/cli-update-all'
import { isWslHostId, LOCAL_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { CliModelDiscoveryInput } from '../shared/ipc/cli-model-discovery'
import { discoverAndBroadcastCliModels } from './model-discovery/discovery-pass'

type Runtime = Partial<CliRuntimeSettings> | undefined

type ModelDiscovery = (input: CliModelDiscoveryInput) => Promise<unknown>

type CliRun = { kind: 'install' | 'update'; result: Promise<CliInstallResult> }

/**
 * The agent CLIs on this machine and its WSL distributions, as the Studio
 * protocol serves them (`cliRuntimes.*`, `cliVersions.*`): detecting one,
 * installing or updating it, updating every outdated one, and whether each is
 * behind its published version. Every client reaches them the same way; the
 * output of an install and the progress of an update are heard by whoever
 * follows them.
 */
export type CliRuntimes = {
  detect(cli: AgentCli, runtime?: Runtime): Promise<CliDetectResult>
  installMethods(cli: AgentCli, runtime?: Runtime): Promise<CliInstallMethodInfo[]>
  install(input: CliInstallInput, runtime?: Runtime): Promise<CliInstallResult>
  update(cli: AgentCli, runtime?: Runtime): Promise<CliInstallResult>
  updateAll(): Promise<CliUpdateAllResult>
  advisories(input: CliVersionAdvisoriesInput): Promise<CliVersionAdvisoriesResult>
  setVersionChecksEnabled(enabled: boolean): boolean
  /** An install's or update's output, as it is written, for the CLI and machine it runs on. */
  onOutput(listener: (cli: AgentCli, hostId: ExecutionHostId, chunk: string) => void): () => void
  /** Every item of an Update everything, each time one moves. */
  onUpdateAllProgress(listener: (items: CliUpdateAllItem[]) => void): () => void
  /** The version advisories, when they moved. */
  onAdvisoriesChanged(listener: (result: CliVersionAdvisoriesResult) => void): () => void
}

export function createCliRuntimes(
  options: {
    /**
     * The pass that follows an install. In process it runs here; with the
     * Studio server in a process of its own it runs there, the one writer of
     * the model catalog cache.
     */
    discoverModels?: ModelDiscovery
    /** What Update everything updates; the version check's outdated CLIs unless a test names its own. */
    outdatedTargets?: () => Promise<{ ok: true; targets: CliUpdateTarget[] } | { ok: false; message: string }>
    /** The version check; the service's unless a test names its own. */
    readAdvisories?: (input: CliVersionAdvisoriesInput) => Promise<CliVersionAdvisoriesResult>
    setChecksEnabled?: (enabled: boolean) => boolean
    onAdvisoriesChanged?: (listener: (result: CliVersionAdvisoriesResult) => void) => () => void
  } = {},
): CliRuntimes {
  const outdatedTargets = options.outdatedTargets ?? outdatedCliTargets
  const discoverModels: ModelDiscovery = options.discoverModels ?? ((input) => discoverAndBroadcastCliModels(input))
  const readAdvisories = options.readAdvisories ?? ((input) => readCliVersionAdvisories(input))
  const outputListeners = new Set<(cli: AgentCli, hostId: ExecutionHostId, chunk: string) => void>()
  const progressListeners = new Set<(items: CliUpdateAllItem[]) => void>()
  const listen = <L>(set: Set<L>, listener: L) => {
    set.add(listener)
    return () => void set.delete(listener)
  }

  // One install or update of a CLI on a machine at a time. Two package
  // managers writing the same global install at once (an Update pressed in two
  // windows, or in the toast and the Settings row) can leave it broken. A
  // second request of the same kind joins the one running and gets the same
  // answer; one of the other kind is turned away. Another machine's copy is
  // its own, and runs beside it.
  const runs = new Map<string, CliRun>()
  const exclusive = (
    kind: CliRun['kind'],
    cli: AgentCli,
    runtime: Runtime,
    start: (onData: (chunk: string) => void) => Promise<CliInstallResult>,
  ): Promise<CliInstallResult> => {
    const hostId = machineOf(runtime)
    const key = `${cli}\0${hostId}`
    const running = runs.get(key)
    if (running) return running.kind === kind ? running.result : Promise.resolve(alreadyRunning(cli, running.kind))
    const result = start((chunk) => {
      for (const listener of outputListeners) listener(cli, hostId, chunk)
    })
      .then((done) => {
        afterInstall(cli, runtime, done, discoverModels)
        return done
      })
      .finally(() => runs.delete(key))
    runs.set(key, { kind, result })
    return result
  }

  // Update everything: each outdated CLI on each machine, through the same
  // lock and output a row's Update takes, so one already updating from a row
  // is joined rather than run twice. A machine's CLIs go one after another
  // (two package managers on one machine can share a global prefix); machines
  // run beside each other. A second ask while one runs joins it.
  let updateAll: Promise<CliUpdateAllResult> | null = null

  async function runUpdateAll(): Promise<CliUpdateAllResult> {
    const listed = await outdatedTargets()
    if (!listed.ok) return listed
    const items: CliUpdateAllItem[] = listed.targets.map((target) => ({
      hostId: target.hostId,
      cli: target.cli,
      from: target.currentVersion,
      latest: target.latestVersion,
      state: 'queued',
    }))
    const tell = () => {
      const snapshot = items.map((item) => ({ ...item }))
      for (const listener of progressListeners) listener(snapshot)
    }
    tell()
    const byMachine = new Map<string, number[]>()
    listed.targets.forEach((target, index) => {
      byMachine.set(target.hostId, [...(byMachine.get(target.hostId) ?? []), index])
    })
    await Promise.all(
      [...byMachine.values()].map(async (indexes) => {
        for (const index of indexes) {
          const target = listed.targets[index]!
          const item = items[index]!
          item.state = 'updating'
          tell()
          try {
            const done = await exclusive('update', target.cli, target.runtime, (onData) =>
              updateCli(target.cli, target.runtime, onData),
            )
            item.to = done.version
            if (!done.ok) {
              item.state = 'failed'
              item.error = done.error ?? 'The update did not finish.'
            } else {
              item.state =
                done.version && done.version.trim() === (target.currentVersion ?? '').trim() ? 'unchanged' : 'updated'
            }
          } catch (error) {
            item.state = 'failed'
            item.error = error instanceof Error ? error.message : String(error)
          }
          tell()
        }
      }),
    )
    return { ok: true, items: items.map((item) => ({ ...item })) }
  }

  return {
    // A row's own detection (opening it, or its Re-check): a probe of this one
    // CLI on this one machine, which the shared answer takes on, so the list,
    // the pickers and the version check agree with what the row just found.
    async detect(cli, runtime) {
      const result = await detectCli(cli, runtime)
      // A changed answer schedules the version check's comparison (app-services).
      if (result.error === null) recordCliDetection(runtime, result)
      return result
    },
    installMethods: (cli, runtime) => cliInstallMethods(cli, runtime),
    install: (input, runtime) =>
      exclusive('install', input.cli, runtime, (onData) =>
        installCli({ cli: input.cli, methodId: input.methodId }, runtime, onData),
      ),
    // The CLI's own updater where the manifest declares one, else its install
    // again, on the same output an install writes.
    update: (cli, runtime) => exclusive('update', cli, runtime, (onData) => updateCli(cli, runtime, onData)),
    updateAll() {
      updateAll ??= runUpdateAll().finally(() => {
        updateAll = null
      })
      return updateAll
    },
    // One advisory per CLI per machine, comparing the installed versions
    // detection last found against the registry (cached an hour). `detect` is
    // Settings' Re-check: every machine's CLIs are detected again first.
    async advisories(input) {
      try {
        return await readAdvisories(input)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    setVersionChecksEnabled: (enabled) => (options.setChecksEnabled ?? setCliVersionChecksEnabled)(enabled),
    onOutput: (listener) => listen(outputListeners, listener),
    onUpdateAllProgress: (listener) => listen(progressListeners, listener),
    onAdvisoriesChanged: (listener) => (options.onAdvisoriesChanged ?? onCliVersionAdvisoriesChanged)(listener),
  }
}

// The machine a runtime override names, as the version check and the output
// channel key it: a WSL distribution, else this machine.
function machineOf(runtime: Runtime): ExecutionHostId {
  return isWslHostId(runtime?.hostId) ? runtime.hostId : LOCAL_HOST_ID
}

function alreadyRunning(cli: AgentCli, kind: CliRun['kind']): CliInstallResult {
  return {
    ok: false,
    cli,
    installed: false,
    version: null,
    resolvedPath: null,
    log: '',
    error: `It is already being ${kind === 'update' ? 'updated' : 'installed'} on this machine. Try again once that has finished.`,
  }
}

// Both flows end by detecting their CLI again on the machine they ran on. That
// answer is the new truth for that one CLI there: it replaces the cached one,
// and the version advisories are compared again from it, so the row's version
// moves and its update badge clears without re-scanning every CLI. Only a CLI
// found afterwards is recorded; one that was not may be a detection that could
// not run, and the next read looks again.
//
// A new binary is a new model list too: the version it reports no longer
// matches the one that produced the stored catalog, so this pass re-probes it
// (and a first install gets its first catalog) without waiting for the next
// refresh. Neither is awaited — the result goes back to Settings at once.
function afterInstall(cli: AgentCli, runtime: Runtime, result: CliInstallResult, discoverModels: ModelDiscovery): void {
  if (!result.installed) return
  const hostId = machineOf(runtime)
  void noteCliDetected(runtime, {
    cli,
    binary: runtime?.command?.trim() || cli,
    installed: true,
    version: result.version,
    resolvedPath: result.resolvedPath,
    hostId,
    error: null,
  }).catch(() => undefined)
  if (!result.ok) return
  void discoverModels({ clis: [cli], ...(runtime ? { cliRuntimes: { [cli]: runtime } } : {}) }).catch(() => undefined)
}
