import type { ElectronApi } from '../shared/electron-api'
import { appMenuApi } from './api/app-menu'
import { appearanceApi } from './api/appearance'
import { authApi } from './api/auth'
import { automationApi } from './api/automation'
import { studioLocalAppsApi } from './api/studio-local-apps'
import { studioConnectionApi } from './api/studio-connection'
import { studioServerApi } from './api/studio-server'
import { meshApi } from './api/mesh'
import { scheduledAgentsApi } from './api/scheduled-agents'
import { backlogApi } from './api/backlog'
import { buildStampApi } from './api/build-stamp'
import { builtinSkillsApi } from './api/builtinSkills'
import { clipboardApi } from './api/clipboard'
import { chatExportApi } from './api/chat-export'
import { conversationPeekApi } from './api/conversation-peek'
import { agentCompactApi } from './api/agent-compact'
import { pullRequestApi } from './api/pull-request'
import { filesystemApi } from './api/filesystem'
import { gitApi } from './api/git'
import { artifactsApi } from './api/artifacts'
import { marketplaceApi } from './api/marketplace'
import { hostedSourcesFeedApi } from './api/hosted-sources-feed'
import { hostedCardFeedApi } from './api/hosted-card-feed'
import { modulesApi } from './api/modules'
import { pluginsApi } from './api/plugins'
import { hostsApi } from './api/hosts'
import { sshEnvironmentsApi } from './api/ssh-environments'
import { environmentsApi } from './api/environments'
import { splashApi } from './api/splash'
import { startupApi } from './api/startup'
import { updateApi } from './api/update'
import { windowApi } from './api/window'
import { browserApi } from './api/browser'
import { canvasApi } from './api/canvas'
import { editorRevealApi } from './api/editor-reveal'
import { toursApi } from './api/tours'
import { workspaceBackupApi } from './api/workspace-backup'
import { workspaceSyncApi } from './api/workspace-sync'
import { extensionScaffoldApi } from './api/extension-scaffold'
import { previewsApi } from './api/previews'
import { webDevicesApi } from './api/web-devices'

// Every `window.api` member the preload builds from its api modules: all of
// them but the values it computes from its own process. One list, which
// the preload and the web client both spread, so a member added here reaches
// both and the compiler holds each to `ElectronApi`.

/** The values the preload computes from its own process rather than an api module. */
export type ComputedApiMembers =
  | 'platform'
  | 'hostPlatform'
  | 'clientCapabilities'
  | 'sshMachinesEnabled'
  | 'isDevelopment'
  | 'isDiagnosticsEnabled'
  | 'diagnosticsGetIpcStats'

export const apiModules = {
  ...windowApi,
  ...browserApi,
  ...canvasApi,
  ...editorRevealApi,
  ...toursApi,
  ...splashApi,
  ...startupApi,
  ...buildStampApi,
  ...appearanceApi,
  ...artifactsApi,
  ...authApi,
  ...automationApi,
  ...studioLocalAppsApi,
  ...studioConnectionApi,
  ...studioServerApi,
  ...meshApi,
  ...scheduledAgentsApi,
  ...backlogApi,
  ...builtinSkillsApi,
  ...clipboardApi,
  ...chatExportApi,
  ...hostedSourcesFeedApi,
  ...hostedCardFeedApi,
  ...filesystemApi,
  ...hostsApi,
  ...sshEnvironmentsApi,
  ...environmentsApi,
  ...gitApi,
  ...marketplaceApi,
  ...modulesApi,
  ...pluginsApi,
  ...conversationPeekApi,
  ...agentCompactApi,
  ...pullRequestApi,
  ...updateApi,
  ...appMenuApi,
  ...workspaceBackupApi,
  ...workspaceSyncApi,
  ...extensionScaffoldApi,
  ...previewsApi,
  ...webDevicesApi,
} satisfies Omit<ElectronApi, ComputedApiMembers>
