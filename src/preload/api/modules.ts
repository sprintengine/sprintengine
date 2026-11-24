import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type { ThirdPartyModuleRevealResult } from '../../shared/modules/manifest'

type ModulesIpcRenderer = {
  invoke(channel: 'modules:third-party:reveal', id: string): Promise<ThirdPartyModuleRevealResult>
  invoke(channel: 'extension-frames:stage', hash: string, html: string): Promise<boolean>
}

// Showing an installed extension's folder in this computer's file manager,
// and staging the document an extension's surface is drawn from with the
// shell, which serves it to the window's sandboxed frame
// (main/extension-frames). Listing, installing, approving and switching
// extensions, and building a frame's document, are the window's Studio's
// (`extension.*`).
export function createModulesApi(renderer: ModulesIpcRenderer) {
  return {
    revealThirdPartyModule: (id: string): Promise<ThirdPartyModuleRevealResult> =>
      renderer.invoke('modules:third-party:reveal', id),
    stageExtensionFrame: (hash: string, html: string): Promise<boolean> =>
      renderer.invoke('extension-frames:stage', hash, html),
  } satisfies Pick<ElectronApi, 'revealThirdPartyModule' | 'stageExtensionFrame'>
}

export const modulesApi = createModulesApi(ipcRenderer)
