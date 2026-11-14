import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type { ThirdPartyModuleRevealResult } from '../../shared/modules/manifest'

type ModulesIpcRenderer = {
  invoke(channel: 'modules:third-party:reveal', id: string): Promise<ThirdPartyModuleRevealResult>
}

// Showing an installed extension's folder in this computer's file manager.
// Listing, installing, trusting, switching and loading extensions are the
// window's Studio's (`module.*`, studio/modules.ts).
export function createModulesApi(renderer: ModulesIpcRenderer) {
  return {
    revealThirdPartyModule: (id: string): Promise<ThirdPartyModuleRevealResult> =>
      renderer.invoke('modules:third-party:reveal', id),
  } satisfies Pick<ElectronApi, 'revealThirdPartyModule'>
}

export const modulesApi = createModulesApi(ipcRenderer)
