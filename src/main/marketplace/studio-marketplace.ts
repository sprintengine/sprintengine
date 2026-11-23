import { resolve } from 'node:path'

import type {
  MarketplaceInstallEnvelope,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
} from '../../../packages/studio-protocol/src/public'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import type { SkillHarness } from '../../shared/skills'
import { writeDiagnosticLog } from '../diagnostics-service'
import { defaultMarketplacePluginStagingRoot, type MarketplaceInstallLog } from './plugin-download'
import {
  createMarketplacePluginLifecycleService,
  defaultMarketplacePluginInstallStorePath,
  type MarketplacePluginLifecycleInstallInput,
} from './plugin-lifecycle'
import { createMarketplacePluginVerifier } from './plugin-verify'
import {
  MarketplaceRegistryClient,
  configuredMarketplaceRegistryUrl,
  defaultMarketplaceRegistryCachePath,
} from './registry-client'
import { resolveInstalledSkillHarnesses } from './skill-harness-targets'
import { consumeTrustToken, issueTrustToken, type TrustGrant } from './trust-tokens'
import { readMarketplaceUpdateStates } from './update-detection'

// The marketplace as a Studio serves it (`marketplace.*`, extensions.ts in the
// Studio protocol): its registry, each installed entry against it, reviewing
// an entry, and installing, updating and uninstalling what was reviewed. The same steps in process and out of process, over the
// data folder the Studio's kernel reads. Nothing here
// needs Electron.
//
// The approval is the review's: a review discloses what installing would do
// and issues a one-time token pinned to exactly that, and an install spends
// it whatever happens next. The client names an entry, never the entry
// itself; the Studio resolves it from its own registry.

type MarketplaceRegistryReader = {
  read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
}

export type StudioMarketplaceDeps = {
  /** The data folder: the receipts, the registry cache and staging. */
  dataDir: () => string
  /** The workspaces the Studio has open: the only folders an install writes skill copies into. */
  openWorkspaceRoots: () => string[]
  /** What is installed or trusted here changed. */
  changed?: () => void
  /** Test seam: the registry entries resolve against. */
  registryReader?: MarketplaceRegistryReader
}

export type StudioMarketplace = {
  read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
  updateStates(input?: MarketplaceRegistryReadInput): Promise<MarketplaceUpdateStatesResult>
  verify(id: string): Promise<MarketplacePluginVerifyResult>
  install(input: MarketplacePluginRegistryInstallInput): Promise<MarketplacePluginRegistryInstallResult>
  update(input: MarketplacePluginRegistryInstallInput): Promise<MarketplacePluginRegistryInstallResult>
  uninstall(input: MarketplacePluginUninstallInput): Promise<MarketplacePluginUninstallResult>
}

/** The registry client a Studio reads its marketplace through. */
export function createMarketplaceRegistryClient(dataDir: string): MarketplaceRegistryClient {
  return new MarketplaceRegistryClient({
    registryUrl: configuredMarketplaceRegistryUrl(),
    cachePath: defaultMarketplaceRegistryCachePath(dataDir),
    // Remote first: the index lives in the public releases repository and is
    // edited there by pull request, so a fetch with ETag is how an added or
    // updated plugin reaches every machine without an app release. The
    // committed seed is the offline and first-boot fallback.
    preferBundledSeed: false,
  })
}

/** Every pipeline event lands in the diagnostics log; a result object alone is invisible. */
const marketplaceLog: MarketplaceInstallLog = (event, detail) => {
  const details = detail === undefined ? undefined : JSON.stringify(detail)
  void writeDiagnosticLog({
    level: event.includes('fail') || event.includes('mismatch') ? 'error' : 'info',
    source: 'marketplace',
    title: 'Marketplace plugin pipeline',
    message: event,
    ...(details ? { details } : {}),
  }).catch(() => undefined)
}

const APPROVAL_SPENT = 'Your approval for this extension expired or was already used. Review it again to install.'

export function createStudioMarketplace(deps: StudioMarketplaceDeps): StudioMarketplace {
  // Built when first needed: a Studio nobody installs on pays for neither.
  let built:
    | {
        verifier: ReturnType<typeof createMarketplacePluginVerifier>
        lifecycle: ReturnType<typeof createMarketplacePluginLifecycleService>
      }
    | undefined
  const pipeline = () =>
    (built ??= {
      verifier: createMarketplacePluginVerifier({
        stagingRoot: defaultMarketplacePluginStagingRoot(deps.dataDir()),
        log: marketplaceLog,
      }),
      lifecycle: createMarketplacePluginLifecycleService({
        receiptStorePath: defaultMarketplacePluginInstallStorePath(deps.dataDir()),
        stagingRoot: defaultMarketplacePluginStagingRoot(deps.dataDir()),
        resolveSkillHarnesses: () => resolveInstalledSkillHarnesses(),
        log: marketplaceLog,
      }),
    })
  // One registry reader for review, install and update detection, so all
  // three share its cache and its bundled-first/override policy.
  let registryReader: MarketplaceRegistryReader | undefined = deps.registryReader
  const registry = () => (registryReader ??= createMarketplaceRegistryClient(deps.dataDir()))
  const receiptStorePath = () => defaultMarketplacePluginInstallStorePath(deps.dataDir())
  const changed = () => deps.changed?.()

  async function read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult> {
    try {
      return await registry().read(input)
    } catch (error) {
      return {
        ok: false,
        state: 'fetch-error',
        registryUrl: configuredMarketplaceRegistryUrl(),
        stale: false,
        message: formatError(error),
      }
    }
  }

  async function registryEntry(id: string): Promise<MarketplacePluginEntry | { message: string }> {
    const answer = await registry().read()
    if (!answer.ok) return { message: answer.message || 'The marketplace could not be read.' }
    return (
      answer.marketplace.plugins.find((plugin) => plugin.id === id) ?? {
        message: `${id} is not in the marketplace.`,
      }
    )
  }

  // Install and update take the same envelope: which entry, the token its
  // review issued, and where it goes. The token is spent here whatever
  // happens next, so a failed install goes back through the review.
  async function installOrUpdate(
    input: MarketplacePluginRegistryInstallInput,
    run: (input: MarketplacePluginLifecycleInstallInput) => Promise<MarketplacePluginRegistryInstallResult>,
  ): Promise<MarketplacePluginRegistryInstallResult> {
    const id = input.id.trim()
    if (!id) return { ok: false, message: 'An extension id is required.' }
    const envelope = installEnvelope(input, deps.openWorkspaceRoots())
    if (!envelope.ok) return { ok: false, message: envelope.message }
    let grant: TrustGrant | null = null
    if (input.trustToken !== undefined) {
      grant = consumeTrustToken(input.trustToken, id)
      if (!grant) return { ok: false, message: APPROVAL_SPENT }
    }
    // The entry the approval was given for, as the Studio resolved it then;
    // with no approval, only the registry's own copy, which installs only if
    // it needs none.
    let entry = grant?.entry
    if (!entry) {
      const found = await registryEntry(id)
      if ('message' in found) return { ok: false, message: found.message }
      entry = found
    }
    return run({ ...envelope.value, entry, grant })
  }

  const installed = (result: MarketplacePluginRegistryInstallResult) => {
    if (result.ok) changed()
    return result
  }

  return {
    read,

    async updateStates(input) {
      try {
        return await readMarketplaceUpdateStates(
          {
            registryReader: registry(),
            receiptStorePath: receiptStorePath(),
          },
          input ?? {},
        )
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },

    // The client names an entry; the Studio looks it up in its own registry,
    // discloses what installing it would do, and issues the only thing that
    // can approve that install: a one-time token pinned to what was disclosed.
    async verify(id) {
      try {
        const trimmed = id.trim()
        if (!trimmed) return invalidVerifyResult('An extension id is required.')
        const entry = await registryEntry(trimmed)
        if ('message' in entry) return invalidVerifyResult(entry.message)
        const result = await pipeline().verifier.verify(entry)
        if (!result.pin || result.classification === 'invalid') return withoutPin(result)
        return {
          ...result,
          trustToken: issueTrustToken({ entryId: entry.id, pin: result.pin, entry }),
        }
      } catch (error) {
        return invalidVerifyResult(formatError(error))
      }
    },

    async install(input) {
      try {
        return installed(await installOrUpdate(input, pipeline().lifecycle.install))
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },

    async update(input) {
      try {
        return installed(await installOrUpdate(input, pipeline().lifecycle.update))
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },

    // The other end of an install. It takes the same envelope install does,
    // because the skill copies it removes are in the workspace.
    async uninstall(input) {
      try {
        const envelope = installEnvelope(input, deps.openWorkspaceRoots())
        if (!envelope.ok) return { ok: false, message: envelope.message }
        const result = await pipeline().lifecycle.uninstall({ ...envelope.value, pluginId: input.pluginId })
        if (result.ok) changed()
        return result
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  }
}

type InstallEnvelope = Omit<MarketplacePluginLifecycleInstallInput, 'entry' | 'grant'>

// The client-supplied half of an install, checked. `workspaceRoot` is where
// skill copies are written, and a failed update deletes and restores paths
// under it, so it must be a workspace the Studio has open, not any folder a
// client names. Skill harnesses are only ever the Studio's own.
export function installEnvelope(
  input: MarketplaceInstallEnvelope,
  openWorkspaceRoots: string[],
): { ok: true; value: InstallEnvelope } | { ok: false; message: string } {
  const value: InstallEnvelope = {}
  const trimmed = input.workspaceRoot?.trim()
  if (trimmed) {
    if (!openWorkspaceRoots.includes(resolve(trimmed))) {
      return { ok: false, message: 'Open this workspace in SprintEngine Studio, then install again.' }
    }
    value.workspaceRoot = trimmed
  }
  if (input.skillHarnesses) {
    const requested: readonly string[] = input.skillHarnesses
    value.skillHarnesses = SKILL_PACK_HARNESSES.filter((harness) => requested.includes(harness)) as SkillHarness[]
  }
  return { ok: true, value }
}

function invalidVerifyResult(message: string): MarketplacePluginVerifyResult {
  return {
    classification: 'invalid',
    permissions: [],
    sourceUrl: '',
    issues: [{ path: 'source', message }],
    message,
  }
}

// A result there is nothing to approve in carries no pin either.
function withoutPin(result: MarketplacePluginVerifyResult): MarketplacePluginVerifyResult {
  const { pin: _pin, ...rest } = result
  return rest
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
