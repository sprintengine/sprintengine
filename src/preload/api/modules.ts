import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type {
  ElectronApi,
  ModuleEnablementOverrides,
  ModuleEnablementWriteResult,
  ThirdPartyModuleUninstallInput,
  ThirdPartyModuleUninstallResult,
} from '../../shared/electron-api'
import type {
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
  ThirdPartyRendererEntriesResult,
} from '../../shared/modules/manifest'
import { THIRD_PARTY_RENDERER_ENTRIES_CHANNEL } from '../../shared/modules/manifest'
import type { ModuleRegistrySnapshot, ModuleRegistrySnapshotWriteResult } from '../../shared/modules/registry-snapshot'
import { MODULE_REGISTRY_SNAPSHOT_CHANNEL } from '../../shared/modules/registry-snapshot'

type ModulesIpcRenderer = {
  invoke(channel: 'modules:set-enablement', overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult>
  invoke(channel: 'modules:set-app-state', bag: Record<string, Record<string, unknown>>): Promise<void>
  invoke(
    channel: typeof MODULE_REGISTRY_SNAPSHOT_CHANNEL,
    snapshot: ModuleRegistrySnapshot,
  ): Promise<ModuleRegistrySnapshotWriteResult>
  invoke(channel: 'modules:third-party:list'): Promise<ThirdPartyModuleListResult>
  invoke(channel: 'modules:third-party:install-folder', srcDir: string): Promise<ThirdPartyModuleInstallResult>
  invoke(
    channel: 'modules:third-party:set-trust',
    payload: { id: string; trusted: boolean },
  ): Promise<ThirdPartyModuleTrustResult>
  invoke(channel: 'modules:third-party:reveal', id: string): Promise<ThirdPartyModuleTrustResult>
  invoke(
    channel: 'modules:third-party:uninstall',
    input: ThirdPartyModuleUninstallInput,
  ): Promise<ThirdPartyModuleUninstallResult>
  invoke(channel: typeof THIRD_PARTY_RENDERER_ENTRIES_CHANNEL): Promise<ThirdPartyRendererEntriesResult>
  on(channel: 'modules:third-party:changed', listener: (event: IpcRendererEvent) => void): unknown
  removeListener(channel: 'modules:third-party:changed', listener: (event: IpcRendererEvent) => void): unknown
}

export function createModulesApi(renderer: ModulesIpcRenderer) {
  return {
    setModuleEnablement: (overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult> =>
      renderer.invoke('modules:set-enablement', overrides),
    setModuleAppState: (bag: Record<string, Record<string, unknown>>): Promise<void> =>
      renderer.invoke('modules:set-app-state', bag),
    setModuleRegistrySnapshot: (snapshot: ModuleRegistrySnapshot): Promise<ModuleRegistrySnapshotWriteResult> =>
      renderer.invoke(MODULE_REGISTRY_SNAPSHOT_CHANNEL, snapshot),
    listThirdPartyModules: (): Promise<ThirdPartyModuleListResult> => renderer.invoke('modules:third-party:list'),
    installThirdPartyModuleFolder: (srcDir: string): Promise<ThirdPartyModuleInstallResult> =>
      renderer.invoke('modules:third-party:install-folder', srcDir),
    setThirdPartyModuleTrust: (id: string, trusted: boolean): Promise<ThirdPartyModuleTrustResult> =>
      renderer.invoke('modules:third-party:set-trust', { id, trusted }),
    uninstallThirdPartyModule: (input: ThirdPartyModuleUninstallInput): Promise<ThirdPartyModuleUninstallResult> =>
      renderer.invoke('modules:third-party:uninstall', input),
    revealThirdPartyModule: (id: string): Promise<ThirdPartyModuleTrustResult> =>
      renderer.invoke('modules:third-party:reveal', id),
    listThirdPartyRendererEntries: (): Promise<ThirdPartyRendererEntriesResult> =>
      renderer.invoke(THIRD_PARTY_RENDERER_ENTRIES_CHANNEL),
    onThirdPartyModulesChanged: (cb: () => void) => {
      const handler = () => cb()
      renderer.on('modules:third-party:changed', handler)
      return () => renderer.removeListener('modules:third-party:changed', handler)
    },
  } satisfies Pick<
    ElectronApi,
    | 'setModuleEnablement'
    | 'setModuleAppState'
    | 'setModuleRegistrySnapshot'
    | 'listThirdPartyModules'
    | 'installThirdPartyModuleFolder'
    | 'setThirdPartyModuleTrust'
    | 'uninstallThirdPartyModule'
    | 'revealThirdPartyModule'
    | 'listThirdPartyRendererEntries'
    | 'onThirdPartyModulesChanged'
  >
}

export const modulesApi = createModulesApi(ipcRenderer)
