import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi, StudioPluginStatus } from '../../shared/electron-api'

// The app's own plugin: something the app puts in a workspace and keeps
// there. Its skills and their switches are the Studio protocol's
// (`builtinSkills.*`, `areaSkills.*`).
export const builtinSkillsApi = {
  studioPluginStatus: (input: { workspaceRoot: string | null }): Promise<StudioPluginStatus> =>
    ipcRenderer.invoke('studio-plugin:status', input),
} satisfies Pick<ElectronApi, 'studioPluginStatus'>
