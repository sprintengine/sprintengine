import { readModuleOverridesSync } from '../../../main/module-host/enablement-store'
import { readExtensionStandingContextSync } from '../../../main/modules/extension-standing-context'
import { discoverUserModules, type InstalledModule } from '../../../main/modules/user-module-registry'
import { reconcileAgentContributions, type ReconcileResult } from './projection'

export type ReconcileInstalledInput = {
  dataDir: string
  /** Where installed extensions live. */
  moduleRoot: string
  /** What was discovered for this change already; read now when absent. */
  modules?: readonly InstalledModule[]
  /** Ids a provider may not take: Studio's own providers' and agent CLIs'. */
  protectedProviderIds?: () => ReadonlySet<string>
  warn?: (message: string) => void
}

/**
 * Project what the extensions installed here hand agents and chats, as they
 * stand on disk now: their approvals and the person's switches. Called at
 * every start and after every install, approval, switch and uninstall.
 */
export async function reconcileInstalledAgentContributions(input: ReconcileInstalledInput): Promise<ReconcileResult> {
  const modules =
    input.modules ??
    (await discoverUserModules(input.moduleRoot, readExtensionStandingContextSync(input.dataDir))).modules
  const overrides = readModuleOverridesSync(input.dataDir)
  return reconcileAgentContributions({
    dataDir: input.dataDir,
    extensions: modules,
    enabled: (key) => overrides[key] !== false,
    ...(input.protectedProviderIds ? { protectedProviderIds: input.protectedProviderIds() } : {}),
    ...(input.warn ? { warn: input.warn } : {}),
  })
}
