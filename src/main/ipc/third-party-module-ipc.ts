import { app, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import type { ThirdPartyModuleRevealResult } from '../../shared/modules/manifest'
import { isModuleIdSegment } from '../modules/forget-modules'
import { readModuleTrustContextSync } from '../modules/trust-context'
import { defaultUserModuleRoot, discoverUserModules } from '../modules/user-module-registry'
import { assertAppSender } from './ipc-sender'

// "Show files" in Settings ▸ Extensions: open an installed extension's own
// folder in this computer's file manager. The window never learns where
// extensions live, so the shell resolves the id to its folder. Listing,
// installing, trusting and uninstalling are the Studio's (`module.*`).
export function registerThirdPartyModuleIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'modules:third-party:reveal',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<ThirdPartyModuleRevealResult> => {
      assertAppSender(event)
      const id = typeof input === 'string' ? input.trim() : ''
      if (!isModuleIdSegment(id)) return { ok: false, message: 'A module id is required.' }
      const { modules } = await discoverUserModules(
        defaultUserModuleRoot(),
        readModuleTrustContextSync(app.getPath('userData')),
      )
      const target = modules.find((module) => module.manifest.id === id)
      if (!target) return { ok: false, message: `Module "${id}" is not installed.` }
      const failure = await shell.openPath(target.moduleRoot)
      return failure ? { ok: false, message: failure } : { ok: true }
    },
  )
}
