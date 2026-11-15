import { resolve } from 'node:path'

import type {
  GithubExtensionInstallInput,
  GithubExtensionResolveResult,
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
import type { MarketplaceComponentKind, MarketplacePluginEntry } from '../../shared/marketplace'
import { SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import type { SkillHarness } from '../../shared/skills'
import { writeDiagnosticLog } from '../diagnostics-service'
import type { McpConfigService } from '../mcp-config-service'
import { forgetModules } from '../modules/forget-modules'
import { readModuleTrustContextSync } from '../modules/trust-context'
import { setModuleTrust } from '../modules/trust-store'
import { defaultUserModuleRoot } from '../modules/user-module-registry'
import { githubReviewChanges, resolveGithubExtension } from './github-extension-source'
import {
  defaultMarketplacePluginStagingRoot,
  type MarketplaceInstallLog,
  type MarketplacePluginDownloadFetch,
} from './plugin-download'
import {
  createMarketplacePluginLifecycleService,
  defaultMarketplacePluginInstallStorePath,
  readMarketplacePluginInstallReceipt as readInstallReceipt,
  readMarketplacePluginInstallReceipts,
  type MarketplacePluginInstallReceipt,
  type MarketplacePluginLifecycleInstallInput,
} from './plugin-lifecycle'
import { createMarketplacePluginVerifier } from './plugin-verify'
import {
  MarketplaceRegistryClient,
  configuredMarketplaceRegistryUrl,
  defaultMarketplaceRegistryCachePath,
} from './registry-client'
import { resolveInstalledSkillHarnesses } from './skill-harness-targets'
import { consumeTrustToken, issueTrustToken, peekTrustToken, type TrustGrant } from './trust-tokens'
import { readMarketplaceUpdateStates } from './update-detection'

// The marketplace as a Studio serves it (`marketplace.*`, extensions.ts in the
// Studio protocol): its registry, each installed entry against it, reviewing
// an entry or a GitHub repository, and installing, updating and uninstalling
// what was reviewed. The same steps in process and out of process, over the
// data folder and the module root the Studio's kernel reads. Nothing here
// needs Electron.
//
// The approval is the review's: a review discloses what installing would do
// and issues a one-time token pinned to exactly that, and an install spends
// it whatever happens next. The client names an entry, never the entry
// itself; the Studio resolves it from its own registry (or from the token).
// A card's `install.module` goes through the same lifecycle
// (`cardMarketplace`): same trust gate, same receipts, same rollback.

type MarketplaceRegistryReader = {
  read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
}

export type StudioMarketplaceDeps = {
  /** The data folder: trust grants, enablement, the receipts, the registry cache and staging. */
  dataDir: () => string
  /** The MCP sync an MCP component's install and removal write through. */
  mcpConfig: () => McpConfigService
  /** The workspaces the Studio has open: the only folders an install writes MCP configs and skill copies into. */
  openWorkspaceRoots: () => string[]
  /** What is installed or trusted here changed. */
  changed?: () => void
  /** Test seams: the registry entries resolve against, and the network a review and an install read. */
  registryReader?: MarketplaceRegistryReader
  fetcher?: MarketplacePluginDownloadFetch
}

/** What a card's `install.module` needs of the marketplace. */
export type StudioCardMarketplaceSource = {
  readMarketplaceRegistry(): Promise<MarketplaceRegistryReadResult>
  listMarketplaceReceipts(): ReturnType<typeof readMarketplacePluginInstallReceipts>
  installMarketplaceEntry(
    input: MarketplacePluginLifecycleInstallInput,
  ): Promise<MarketplacePluginRegistryInstallResult>
}

export type StudioMarketplace = {
  read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
  updateStates(input?: MarketplaceRegistryReadInput): Promise<MarketplaceUpdateStatesResult>
  verify(id: string): Promise<MarketplacePluginVerifyResult>
  install(input: MarketplacePluginRegistryInstallInput): Promise<MarketplacePluginRegistryInstallResult>
  update(input: MarketplacePluginRegistryInstallInput): Promise<MarketplacePluginRegistryInstallResult>
  uninstall(input: MarketplacePluginUninstallInput): Promise<MarketplacePluginUninstallResult>
  resolveGithub(url: string): Promise<GithubExtensionResolveResult>
  installGithub(input: GithubExtensionInstallInput): Promise<MarketplacePluginRegistryInstallResult>
  /** The same lifecycle, for a card's `install.module`. */
  readonly cardMarketplace: StudioCardMarketplaceSource
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
  const trustContext = () => readModuleTrustContextSync(deps.dataDir())
  const fetcher = deps.fetcher ? { fetcher: deps.fetcher } : {}
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
        trustContext,
        stagingRoot: defaultMarketplacePluginStagingRoot(deps.dataDir()),
        log: marketplaceLog,
        ...fetcher,
      }),
      lifecycle: createMarketplacePluginLifecycleService({
        mcpConfigService: deps.mcpConfig(),
        trustContext,
        receiptStorePath: defaultMarketplacePluginInstallStorePath(deps.dataDir()),
        stagingRoot: defaultMarketplacePluginStagingRoot(deps.dataDir()),
        resolveSkillHarnesses: () => resolveInstalledSkillHarnesses(),
        // The trust the review already took, written through the one trust-store
        // writer `module.setTrust` uses, so a trusted install does not land
        // behind a second, identical switch in Settings.
        setModuleTrust: async (id, manifestFp) => {
          const { result, previous } = await setModuleTrust(deps.dataDir(), id, manifestFp)
          return { ...result, previous }
        },
        log: marketplaceLog,
        ...fetcher,
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

  async function reviewGithubExtension(
    url: string,
    installed: MarketplacePluginInstallReceipt | undefined,
  ): Promise<GithubExtensionResolveResult> {
    const resolved = await resolveGithubExtension(url, { trustContext, ...fetcher })
    if (!resolved.ok) return resolved
    const verify = await pipeline().verifier.verify(resolved.entry, {
      allowUnsignedCode: true,
      requireModuleFileDigests: true,
    })
    if (verify.classification === 'invalid' || !verify.pin) {
      return {
        ok: false,
        message: verify.message ?? 'This extension could not be verified.',
        ...(verify.issues ? { issues: verify.issues } : {}),
      }
    }
    const classification = verify.classification
    const receipt = installed ?? (await readInstallReceipt(receiptStorePath(), resolved.entry.id))
    const unsignedCode = classification === 'unsigned' && verify.codeBearing === true
    const trustToken = issueTrustToken({
      entryId: resolved.entry.id,
      source: 'github',
      pin: verify.pin,
      entry: resolved.entry,
      github: resolved.origin,
      allowUnsignedCode: unsignedCode,
    })
    return {
      ok: true,
      trustToken,
      preview: {
        id: resolved.entry.id,
        displayName: resolved.entry.name,
        version: resolved.entry.latest,
        publisher: resolved.entry.publisher,
        summary: resolved.entry.summary,
        provides: resolved.entry.provides.filter((kind): kind is MarketplaceComponentKind => kind !== 'cli'),
        origin: resolved.origin,
        verify: { ...verify, classification },
        ...(receipt
          ? {
              installed: {
                version: receipt.version,
                ...(receipt.source?.kind === 'github' ? { sha: receipt.source.sha } : {}),
                changes: githubReviewChanges(
                  {
                    classification: receipt.classification,
                    ...(receipt.permissions ? { permissions: receipt.permissions } : {}),
                    ...(receipt.mcpDigest ? { mcpDigest: receipt.mcpDigest } : {}),
                    ...(receipt.source ? { source: receipt.source } : {}),
                  },
                  verify,
                  resolved.origin,
                ),
              },
            }
          : {}),
      },
    }
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
            moduleRoot: defaultUserModuleRoot,
            trustContext,
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
          trustToken: issueTrustToken({ entryId: entry.id, source: 'registry', pin: result.pin, entry }),
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
    // because removing an MCP component writes the CLI configs and needs the
    // workspace and settings to do it. A module it took out leaves nothing
    // under its id, as one `module.uninstall` removes does.
    async uninstall(input) {
      try {
        const envelope = installEnvelope(input, deps.openWorkspaceRoots())
        if (!envelope.ok) return { ok: false, message: envelope.message }
        const result = await pipeline().lifecycle.uninstall({ ...envelope.value, pluginId: input.pluginId })
        const removedModules = (result.removed ?? []).filter((component) => component.kind === 'module')
        if (removedModules.length > 0) {
          await forgetModules(
            deps.dataDir(),
            removedModules.map((component) => component.id),
          )
          changed()
        }
        return result
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },

    // Any repository a person pastes: its default branch (or the ref the URL
    // names) resolved to a commit, plugin.json and the components read at
    // that commit and disclosed exactly as a registry review is; the token
    // carries the entry, the pin and the repository, so the install needs
    // nothing else from the client.
    async resolveGithub(url) {
      try {
        const trimmed = url.trim()
        if (!trimmed) return { ok: false, message: 'Paste a GitHub repository URL.' }
        return await reviewGithubExtension(trimmed, undefined)
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },

    async installGithub(input) {
      try {
        // The token names its entry; only a token issued for a GitHub review
        // installs here, and it is spent whatever happens next.
        const named = peekTrustToken(input.trustToken)
        if (!named || named.source !== 'github') return { ok: false, message: APPROVAL_SPENT }
        const envelope = installEnvelope(input, deps.openWorkspaceRoots())
        if (!envelope.ok) return { ok: false, message: envelope.message }
        const grant = consumeTrustToken(input.trustToken, named.entryId)
        if (!grant?.entry) return { ok: false, message: APPROVAL_SPENT }
        // Unsigned code installs only on the person's own "I trust this code",
        // said at the review this token came from.
        if (grant.allowUnsignedCode && input.trustCode !== true) {
          return {
            ok: false,
            classification: 'unsigned',
            message: 'This extension runs unsigned code. Review it again and confirm you trust the code to install it.',
          }
        }
        return installed(await pipeline().lifecycle.install({ ...envelope.value, entry: grant.entry, grant }))
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },

    cardMarketplace: {
      readMarketplaceRegistry: () => read(),
      listMarketplaceReceipts: () => readMarketplacePluginInstallReceipts(receiptStorePath()),
      installMarketplaceEntry: async (input) => {
        const result = await pipeline().lifecycle.install(input)
        if (result.ok) changed()
        return result
      },
    },
  }
}

type InstallEnvelope = Omit<MarketplacePluginLifecycleInstallInput, 'entry' | 'grant'>

// The client-supplied half of an install, checked. `workspaceRoot` is where
// MCP configs and skill copies are written, and a failed update deletes and
// restores paths under it, so it must be a workspace the Studio has open, not
// any folder a client names. Skill harnesses are only ever the Studio's own.
// Settings and clients pass through to the MCP sync, which normalises every
// server it writes.
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
  if (input.mcpSettings) value.mcpSettings = input.mcpSettings
  if (input.mcpClients) value.mcpClients = [...input.mcpClients]
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
