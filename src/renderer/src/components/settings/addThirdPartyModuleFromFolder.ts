import type { ElectronApi } from '../../../../shared/electron-api'
import type { StudioExtensionApproval } from '../../../../../packages/studio-protocol/src/public'
import type { ModuleLifecycleClient } from '../../studio/moduleLifecycle'
import { copy } from '../../../../shared/copy'

export type AddThirdPartyModuleOutcome =
  | { status: 'cancelled' }
  | {
      status: 'installed'
      id: string | null
      /** Whether it waits for the person's approval, and what to approve. */
      approval: StudioExtensionApproval | null
      /** Symbolic links in the folder that were left out of the copy, relative to it. */
      strippedLinks: string[]
    }
  | { status: 'failed'; message: string }

/**
 * The one folder-picker install round trip used by both Settings and the
 * Extensions drawer. The folder is picked here, on this computer; validation,
 * copying and signature classification are the Studio's (`extension.install`),
 * which installs from a folder on its own machine: the window's Studio is
 * this computer's. This adapter only turns cancellation and failures into UI
 * states.
 */
export async function addThirdPartyModuleFromFolder(
  api: Partial<Pick<ElectronApi, 'openDir'>>,
  lifecycle: (Pick<ModuleLifecycleClient, 'install'> & Partial<Pick<ModuleLifecycleClient, 'devLoad'>>) | null,
  /** `development`: register the folder itself, which loads where it is and again on every save. */
  as: 'install' | 'development' = 'install',
): Promise<AddThirdPartyModuleOutcome> {
  if (typeof api.openDir !== 'function' || !lifecycle) {
    return { status: 'failed', message: copy.settings.addThirdPartyModuleFromFolder.canTInstallExtensionsIn }
  }

  try {
    const folder = await api.openDir()
    if (!folder) return { status: 'cancelled' }

    const devLoad = lifecycle.devLoad
    if (as === 'development' && !devLoad)
      return { status: 'failed', message: 'This Studio cannot load development folders.' }
    const result =
      as === 'development' && devLoad
        ? await devLoad(folder).then((answer) => (answer.ok ? { ...answer, strippedLinks: [] as string[] } : answer))
        : await lifecycle.install(folder)
    if (!result.ok) {
      return {
        status: 'failed',
        message:
          result.message ||
          result.issues?.[0]?.message ||
          copy.settings.addThirdPartyModuleFromFolder.couldnTInstallTheExtension,
      }
    }
    return {
      status: 'installed',
      id: result.moduleId.trim() || null,
      approval: result.approval,
      strippedLinks: result.strippedLinks ?? [],
    }
  } catch (error) {
    return {
      status: 'failed',
      message:
        error instanceof Error ? error.message : copy.settings.addThirdPartyModuleFromFolder.couldnTInstallTheExtension,
    }
  }
}
