import type { CliModelDiscoveryInput, CliModelDiscoveryResult } from '../../shared/ipc/cli-model-discovery'
import { discoverCliModels } from './service'

export type CliModelDiscoveryPassDeps = {
  discover?: (input: CliModelDiscoveryInput) => Promise<CliModelDiscoveryResult>
  // The CLI command and WSL overrides a pass runs with when its caller sends
  // none; defaults to the resolver the composition installs (below).
  mainCliRuntimes?: () => CliModelDiscoveryInput['cliRuntimes']
}

// A pass the Studio starts on its own — the boot pass, the pass after an
// install — has no client to hand it the person's per-CLI command and WSL
// overrides. The Studio owns those settings (launch-settings-store.ts), which
// is what makes this kind of headless path possible, and its composition
// points this resolver at that store. Without it a boot pass on a Windows
// machine with a CLI installed both natively and in WSL would probe the
// native one and serve its list for a day.
let resolveMainCliRuntimes: (() => CliModelDiscoveryInput['cliRuntimes']) | null = null

export function setCliModelDiscoveryRuntimesResolver(
  resolver: (() => CliModelDiscoveryInput['cliRuntimes']) | null,
): void {
  resolveMainCliRuntimes = resolver
}

function withMainCliRuntimes(
  input: CliModelDiscoveryInput,
  resolve: (() => CliModelDiscoveryInput['cliRuntimes']) | null,
): CliModelDiscoveryInput {
  if (input.cliRuntimes) return input
  let cliRuntimes: CliModelDiscoveryInput['cliRuntimes']
  try {
    cliRuntimes = resolve?.()
  } catch {
    cliRuntimes = undefined
  }
  return cliRuntimes && Object.keys(cliRuntimes).length > 0 ? { ...input, cliRuntimes } : input
}

// Whoever follows the catalogs: the Studio protocol's `cliModels.changed`.
const changedListeners = new Set<(result: CliModelDiscoveryResult) => void>()

/** Hear every catalog a pass produced, whoever started it. Returns the unsubscriber. */
export function onCliModelsChanged(listener: (result: CliModelDiscoveryResult) => void): () => void {
  changedListeners.add(listener)
  return () => void changedListeners.delete(listener)
}

// Runs a discovery pass and tells every follower each catalog a probe actually
// produced, so a client that did not ask (a second window, or any window when
// the pass came from the Studio at boot or after an install) still updates its
// pickers. A skipped or failed CLI is not told: there is nothing new to store.
export async function discoverAndBroadcastCliModels(
  input: CliModelDiscoveryInput = {},
  deps: CliModelDiscoveryPassDeps = {},
): Promise<CliModelDiscoveryResult> {
  const result = await (deps.discover ?? discoverCliModels)(
    withMainCliRuntimes(input, deps.mainCliRuntimes ?? resolveMainCliRuntimes),
  )
  const produced = result.entries.filter((entry) => entry.catalog && !entry.skipped)
  if (produced.length > 0) {
    const payload: CliModelDiscoveryResult = { ...result, entries: produced }
    for (const listener of [...changedListeners]) listener(payload)
  }
  return result
}
