import { webUtils } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type {
  DiagnosticLogEntry,
  DiagnosticLogInput,
  ElectronApi,
  FolderOpenRequest,
  FolderOpenResult,
  FolderOpenTargetAvailability,
  ProcessMetricsSnapshot,
} from '../../shared/electron-api'
import type { AttachedFilePreview } from '../../shared/attached-files'

export const filesystemApi = {
  getPathForFile: (file: unknown): string => {
    try {
      return webUtils.getPathForFile(file as File)
    } catch {
      return ''
    }
  },
  // The path is read here, off the person's own `File`, and only then told to
  // main: a renderer cannot hand main a path of its choosing to open later.
  attachFile: (file: unknown): string => {
    let path = ''
    try {
      path = webUtils.getPathForFile(file as File)
    } catch {
      return ''
    }
    if (path) void ipcRenderer.invoke('attached-files:register', path).catch(() => undefined)
    return path
  },
  previewAttachedFile: (path: string): Promise<AttachedFilePreview> =>
    ipcRenderer.invoke('attached-files:preview', path),
  openAttachedFile: (path: string): Promise<void> => ipcRenderer.invoke('attached-files:open', path),
  // A desktop window reads a dropped file's own path; only a browser uploads.
  uploadFiles: async (): Promise<string[]> => {
    throw new Error('Uploading is the web client’s; a desktop window reads a dropped file by its path.')
  },
  logDiagnostic: (input: DiagnosticLogInput): Promise<DiagnosticLogEntry> =>
    ipcRenderer.invoke('diagnostics:log', input),
  openDiagnosticsLogsFolder: (): Promise<{ opened: true; path: string }> =>
    ipcRenderer.invoke('diagnostics:open-logs-folder'),
  diagnosticsGetProcessMetrics: (): Promise<ProcessMetricsSnapshot> =>
    ipcRenderer.invoke('diagnostics:get-process-metrics'),
  diagnosticsOpenWindow: (): Promise<void> => ipcRenderer.invoke('diagnostics:open-window'),
  openImageAttachment: (input: { mediaType: string; dataBase64: string; name?: string }): Promise<void> =>
    ipcRenderer.invoke('fs:open-image-attachment', input),
  showItemInFolder: (targetPath: string) => ipcRenderer.invoke('fs:show-item-in-folder', targetPath),
  openHtmlFileInBrowser: (targetPath: string) => ipcRenderer.invoke('fs:open-html-file-in-browser', targetPath),
  listFolderOpenTargets: (): Promise<FolderOpenTargetAvailability[]> => ipcRenderer.invoke('fs:folder-open-targets'),
  openFolderInTarget: (request: FolderOpenRequest): Promise<FolderOpenResult> =>
    ipcRenderer.invoke('fs:open-folder-in-target', request),
  openDir: (options?: { defaultPath?: string }) => ipcRenderer.invoke('fs:dialog:opendir', options),
  openProjectIconFile: (options?: { defaultPath?: string }) =>
    ipcRenderer.invoke('fs:dialog:open-project-icon', options),
  projectlessChatsRoot: () => ipcRenderer.invoke('chats:projectless-root'),
  createProjectlessChatFolder: (prompt?: string) => ipcRenderer.invoke('chats:projectless-folder:create', prompt),
  showMenubarMenu: (label: string, position?: { x?: number; y?: number }) =>
    ipcRenderer.invoke('app:show-menubar-menu', label, position),
} satisfies Pick<
  ElectronApi,
  | 'getPathForFile'
  | 'attachFile'
  | 'previewAttachedFile'
  | 'openAttachedFile'
  | 'uploadFiles'
  | 'logDiagnostic'
  | 'openDiagnosticsLogsFolder'
  | 'diagnosticsGetProcessMetrics'
  | 'diagnosticsOpenWindow'
  | 'openImageAttachment'
  | 'showItemInFolder'
  | 'openHtmlFileInBrowser'
  | 'listFolderOpenTargets'
  | 'openFolderInTarget'
  | 'openDir'
  | 'openProjectIconFile'
  | 'projectlessChatsRoot'
  | 'createProjectlessChatFolder'
  | 'showMenubarMenu'
>
