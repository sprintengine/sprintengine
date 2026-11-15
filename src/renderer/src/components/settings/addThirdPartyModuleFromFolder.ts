import type { ElectronApi } from '../../../../shared/electron-api'
import type { ModuleTrustStatus } from '../../../../shared/modules/manifest'
import type { ModuleLifecycleClient } from '../../studio/moduleLifecycle'

export type AddThirdPartyModuleOutcome =
  | { status: 'cancelled' }
  | { status: 'installed'; id: string | null; trust: ModuleTrustStatus | null }
  | { status: 'failed'; message: string }

/**
 * The one folder-picker install round trip used by both Settings and the
 * Extensions drawer. The folder is picked here, on this computer; validation,
 * copying and signature classification are the Studio's (`module.install`),
 * which installs from a folder on its own machine: the window's Studio is
 * this computer's. This adapter only turns cancellation and failures into UI
 * states.
 */
export async function addThirdPartyModuleFromFolder(
  api: Partial<Pick<ElectronApi, 'openDir'>>,
  lifecycle: Pick<ModuleLifecycleClient, 'install'> | null,
): Promise<AddThirdPartyModuleOutcome> {
  if (typeof api.openDir !== 'function' || !lifecycle) {
    return { status: 'failed', message: 'Installing extension modules is unavailable in this build.' }
  }

  try {
    const folder = await api.openDir()
    if (!folder) return { status: 'cancelled' }

    const result = await lifecycle.install(folder)
    if (!result.ok) {
      return {
        status: 'failed',
        message: result.message || result.issues?.[0]?.message || 'Could not install the extension module.',
      }
    }
    return {
      status: 'installed',
      id: result.moduleId.trim() || null,
      trust: result.trust,
    }
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Extension module installation failed.',
    }
  }
}
