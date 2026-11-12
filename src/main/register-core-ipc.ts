import { machineAwareIpc } from './environments/ssh/machine-ipc'
import { app, BrowserWindow, nativeImage, shell, webContents } from 'electron'
import type { IpcMain } from 'electron'
import { registerAppearanceIpc } from './ipc/appearance-ipc'
import { registerBackgroundModeIpc } from './ipc/background-mode-ipc'
import { registerTelemetryIpc } from './ipc/telemetry-ipc'
import { registerQuitConfirmationIpc } from './ipc/quit-confirmation-ipc'
import { registerAgentNotificationsIpc } from './ipc/agent-notifications-ipc'
import { registerAgentBrowserToolsIpc } from './ipc/agent-browser-tools-ipc'
import { registerArtifactsIpc } from './ipc/artifacts-ipc'
import { registerKeepAwakeIpc } from './ipc/keep-awake-ipc'
import { registerAuthIpc } from './ipc/auth-ipc'
import { registerStudioWindowTicketIpc, type StudioWindowTicketIssuer } from './ipc/studio-window-ticket-ipc'
import { assertAppSender } from './ipc/ipc-sender'
import { registerAppMenuIpc } from './app-menu'
import { registerStudioPluginIpc } from './ipc/studio-plugin-ipc'
import { registerPullRequestCreateIpc } from './ipc/pull-request-create-ipc'
import { registerClipboardIpc } from './ipc/clipboard-ipc'
import { registerChatExportIpc } from './ipc/chat-export-ipc'
import { getPluginRegistry } from './plugin-registry-instance'
import type { ConversationTranscriptInput } from '../shared/conversation-runtime'
import { registerConversationPeekIpc } from './ipc/conversation-peek-ipc'
import { registerAgentCompactIpc } from './ipc/agent-compact-ipc'
import { registerDiagnosticsIpc } from './ipc/diagnostics-ipc'
import { registerFilesystemMutationIpc } from './ipc/filesystem-mutation-ipc'
import { registerAttachedFilesIpc } from './ipc/attached-files-ipc'
import { createAttachedFileRegistry, createAttachedFiles, createAttachedFileThumbnails } from './attached-files'
import { registerFilesystemReadIpc } from './ipc/filesystem-read-ipc'
import { registerFilesystemWatchSearchIpc } from './ipc/filesystem-watch-search-ipc'
import { registerGitRepoWatchIpc } from './ipc/git-repo-watch-ipc'
import { createFolderOpenIpcDependencies, registerFolderOpenIpc } from './ipc/folder-open-ipc'
import { registerGitIpc } from './ipc/git-ipc'
import { registerMenuDialogIpc } from './ipc/menu-dialog-ipc'
import { registerProjectlessChatsIpc } from './ipc/projectless-chats-ipc'
import { registerMarketplacePluginIpc } from './ipc/marketplace-plugin-ipc'
import { registerMarketplaceRegistryIpc } from './ipc/marketplace-registry-ipc'
import { registerHostedSourcesFeedIpc } from './ipc/hosted-feed-ipc'
import { registerHostedCardFeedIpc } from './ipc/card-feed-ipc'
import { registerModuleAppStateIpc } from './ipc/module-app-state-ipc'
import { registerModuleRegistryIpc } from './ipc/module-registry-ipc'
import { registerPluginIpc } from './ipc/plugins-ipc'
import { registerPullRequestIpc } from './ipc/pull-request-ipc'
import { webContentsIdOfWindowKey } from './ipc/studio-window-ticket-ipc'
import { registerThirdPartyModuleIpc } from './ipc/third-party-module-ipc'
import type { ThirdPartyLaunchSession } from './modules/third-party-main-loader'
import { registerUpdateIpc } from './ipc/update-ipc'
import { registerVersionControlIpc } from './ipc/version-control-ipc'
import { registerWindowIpc } from './ipc/window-ipc'
import { registerPanePopOutIpc } from './ipc/pane-popout-ipc'
import { registerBrowserIpc } from './ipc/browser-ipc'
import { stat } from 'node:fs/promises'

import { continueCanvasBoardInNewChat } from './canvas/canvas-board-chat'
import { createProjectlessChatFolder } from './projectless-chat-folders'
import { registerCanvasIpc } from './ipc/canvas-ipc'
import { createNodeCanvasFs } from './canvas/canvas-node-fs'
import { registerEditorRevealIpc } from './ipc/editor-reveal-ipc'
import { registerToursIpc } from './ipc/tours-ipc'
import { pickCanvasExportDirectory, revealCanvasBoardFile } from './ipc/canvas-export-dialog'
import { registerExtensionScaffoldIpc } from './ipc/extension-scaffold-ipc'
import {
  confirmWorkspaceWindowClose,
  createDiagnosticsWindow,
  createMainWindow,
  isAuxWindow,
  isWorkspaceWindowWebContents,
  openAuxWindow,
  openPanePopOutWindow,
} from './window-factory'
import type { AppServices } from './app-services'
import { registerServerDomainIpc } from '../server/desktop/server-ipc'
import { createFilesystemMutationHandlers } from './filesystem-mutation-handlers'
import { createFilesystemReadHandlers } from './filesystem-read'
import { createProjectLogoIo } from './project-logo-io'
import { createFilesystemWatchSearchHandlers } from './filesystem-watch-search-handlers'
import { openDiagnosticsLogsFolder } from './diagnostics-folder'
import { writeDiagnosticLog } from './diagnostics-service'

export type CoreIpcOptions = {
  /** What this session's third-party main halves did, for Settings → Extensions. */
  readThirdPartyLaunchSession?: () => Promise<ThirdPartyLaunchSession>
  /**
   * The Studio server in a process of its own: its domains register there, on
   * its IPC tunnel, and it mints the tickets a window's protocol connection to it presents.
   */
  server?: {
    windowTickets: StudioWindowTicketIssuer
    /** A chat's transcript and pictures for Export chat, read by the server, which holds the chats. */
    readChatExportSource(key: ConversationTranscriptInput): Promise<unknown>
  }
}

/** What registration hands back for the app's shutdown to finish. */
export type CoreIpcHandles = {
  conversationCommands: { dispose(): Promise<void> }
}

export function registerCoreIpc(
  ipcMain: IpcMain,
  services: AppServices,
  diagnosticsEnabled: boolean,
  options: CoreIpcOptions = {},
): CoreIpcHandles {
  // The file, git, terminal and folder channels never touch this computer for
  // a workspace on an SSH machine: its paths are spelled `ssh://…`, and these
  // registrations send them to that machine's server or refuse them in words
  // (phase 8).
  const machineIpc = machineAwareIpc(
    ipcMain,
    services.ssh ? { call: (id, channel, args) => services.ssh!.environments.machineCall(id, channel, args) } : null,
  )
  registerWindowIpc(ipcMain, {
    createWorkspaceWindow: ({ windowId, bounds, isMaximized }) => {
      createMainWindow({ diagnosticsEnabled, windowId, bounds, isMaximized })
    },
    confirmWindowClose: confirmWorkspaceWindowClose,
    openAuxWindow,
    isAuxWindow,
  })
  const panePopOuts = registerPanePopOutIpc(ipcMain, {
    openWindow: openPanePopOutWindow,
    isWorkspaceWindow: isWorkspaceWindowWebContents,
    windowOf: (contents) => BrowserWindow.fromWebContents(contents),
  })
  registerBrowserIpc(ipcMain, services.browserManager, services.browserRecorder)
  registerCanvasIpc(ipcMain, services.canvasService, services.canvasSubscribers, {
    pickExportDirectory: pickCanvasExportDirectory,
    revealFile: revealCanvasBoardFile,
    remote: () => services.automationService?.mesh().remoteCanvas ?? null,
    exportFs: createNodeCanvasFs(),
    continueInNewChat: (input) =>
      continueCanvasBoardInNewChat(
        {
          folderOf: (workspaceId) =>
            services.workspaceSyncService
              .getSnapshot()
              .state.workspaces.find((workspace) => workspace.id === workspaceId)?.folderPath ?? null,
          folderExists: (folder) =>
            stat(folder).then(
              (found) => found.isDirectory(),
              () => false,
            ),
          launch: services.conversationLaunchService.launch,
          newProjectlessFolder: createProjectlessChatFolder,
        },
        input,
      ),
  })
  registerEditorRevealIpc(ipcMain, services.editorRevealBroker, {
    // The answering window, never a name the message carries; only workspace
    // windows show a workspace, so only they are heard.
    senderId: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win && isWorkspaceWindowWebContents(event.sender) ? win : null
    },
  })
  registerToursIpc(ipcMain, services.tourService)
  // A window's tickets come from the server that holds the chats, wherever it runs.
  const windowTickets = options.server?.windowTickets ?? services.studioRpcService
  if (windowTickets) registerStudioWindowTicketIpc(ipcMain, windowTickets)
  registerAppMenuIpc(ipcMain)
  registerClipboardIpc(ipcMain)
  // Export chat (a chat tab's menu): the chat read where the chats run, written
  // or copied here, where the window and its dialogs are.
  registerChatExportIpc(ipcMain, {
    run: async (input, sender) => {
      const [{ exportChat }, { parseChatExportSourceWire, readChatExportSource }] = await Promise.all([
        import('./chat-export/chat-export-electron'),
        import('./chat-export/chat-export-source'),
      ])
      return exportChat(input, {
        sender,
        workspaces: () => services.workspaceSyncService.getSnapshot().state.workspaces,
        readSource: async (key) => {
          if (!options.server) return readChatExportSource(services.conversations, key)
          const answer = await options.server.readChatExportSource(key)
          const source = parseChatExportSourceWire((answer as { source?: unknown } | null)?.source)
          if (source) return { ok: true, source }
          const message = (answer as { message?: unknown } | null)?.message
          return { ok: false, message: typeof message === 'string' ? message : 'The chat could not be read.' }
        },
        cliDisplayName: (cli) =>
          getPluginRegistry()
            .loaded()
            .find((plugin) => plugin.manifest.id === cli)?.manifest.displayName ?? null,
      })
    },
  })
  // The chat's "Create PR": git, gh and the drafting CLI all run on this computer.
  registerPullRequestCreateIpc(ipcMain)
  registerAuthIpc(ipcMain, services.sprintengineAuth)
  registerStudioPluginIpc(ipcMain, services.studioPluginService)
  const filesystemSearchHandlers = createFilesystemWatchSearchHandlers()
  registerFilesystemWatchSearchIpc(machineIpc, filesystemSearchHandlers)
  const filesystemReadHandlers = createFilesystemReadHandlers({ opener: shell, projectLogoIo: createProjectLogoIo() })
  registerFilesystemReadIpc(machineIpc, filesystemReadHandlers)
  // The file-manager target of the open-in-editor control is the same reveal the
  // rest of the app already uses, so it is handed the very same handler.
  // On plain `ipcMain`: a folder on an SSH machine is opened by an editor here
  // over its own SSH, so the handler reads the machine path itself
  // (folder-open-ipc.ts) and never hands it to this computer's disk.
  registerFolderOpenIpc(
    ipcMain,
    createFolderOpenIpcDependencies(filesystemReadHandlers.showItemInFolder, {
      openExternal: (url) => shell.openExternal(url),
      sshDestination: (id) =>
        services.ssh?.environments.list().find((machine) => machine.id === id)?.destination ?? null,
    }),
  )
  // Memory/knowledge-graph backend is foundational: agent context injection
  // (TerminalView) and the Knowledge Graph settings tab
  // depend on it, so it is always registered. The memory-graph capability
  // module gates only the visualization panel (renderer side).
  registerDiagnosticsIpc(ipcMain, {
    writeDiagnosticLog,
    openDiagnosticsLogsFolder,
    openDiagnosticsWindow: () => {
      createDiagnosticsWindow()
    },
    listConversationRoots: () => services.conversations.listLiveConversationRoots(),
  })
  registerUpdateIpc(ipcMain, { updateService: services.updateService })
  registerFilesystemMutationIpc(machineIpc, createFilesystemMutationHandlers())
  // A file attached to a message by path opens in its default app, and only
  // one the person attached here; on plain `ipcMain`, as it is this computer's.
  const attachedFileRegistry = createAttachedFileRegistry({ resolveUserDataDir: () => app.getPath('userData') })
  // Its writes wait a moment so a drop of many files is one; one still
  // waiting is written as the app goes.
  app.on('will-quit', () => attachedFileRegistry.flush())
  registerAttachedFilesIpc(
    ipcMain,
    createAttachedFiles({
      registry: attachedFileRegistry,
      thumbnails: createAttachedFileThumbnails({
        platform: process.platform,
        createThumbnail: (path, size) => nativeImage.createThumbnailFromPath(path, size),
      }),
      platform: process.platform,
      openPath: (path) => shell.openPath(path),
    }),
  )
  registerGitIpc(
    machineIpc,
    {
      enabled: diagnosticsEnabled,
      logMainPerfEvent: services.logMainPerfEvent,
      withIpcDiagnostics: services.withIpcDiagnostics,
    },
    // The changelist store's home. Resolved here rather than inside the git
    // modules so those stay free of `electron.app` and remain testable against
    // a temp directory.
    {
      userDataDir: app.getPath('userData'),
      onChangelistsChanged: services.broadcastGitChangelistsChanged,
    },
  )
  registerGitRepoWatchIpc(machineIpc)
  registerVersionControlIpc(machineIpc)
  registerMenuDialogIpc(ipcMain)
  registerProjectlessChatsIpc(ipcMain)
  // Module app state (Settings section values), mirrored for `entry.main`.
  registerModuleAppStateIpc(ipcMain)
  registerModuleRegistryIpc(ipcMain, services.moduleRegistryMirror)
  registerAppearanceIpc(ipcMain)
  registerBackgroundModeIpc(ipcMain, services.backgroundModeStore)
  registerTelemetryIpc(ipcMain, services.telemetryConsentStore)
  registerQuitConfirmationIpc(ipcMain, services.quitConfirmationStore)
  registerAgentNotificationsIpc(ipcMain, services.agentNotificationsStore)
  registerAgentBrowserToolsIpc(ipcMain, services.agentBrowserToolsStore, () => {
    void services.desktopShell?.refreshToolsets()
  })
  registerKeepAwakeIpc(ipcMain, services.keepAwakeStore, () => services.agentKeepAwake.refresh())
  registerArtifactsIpc(ipcMain, {
    store: services.artifactsSettingsStore,
    setUp: services.setUpArtifacts,
    consent: services.artifactsSetupConsent,
  })
  registerMarketplaceRegistryIpc(ipcMain)
  registerHostedSourcesFeedIpc(ipcMain)
  registerHostedCardFeedIpc(ipcMain)
  registerMarketplacePluginIpc(ipcMain, services)
  registerPluginIpc(ipcMain)
  // The domains the Studio server owns: registered here while it runs in
  // process, and by the server itself on its IPC tunnel when it runs in a
  // process of its own (src/server/desktop/server-ipc.ts).
  const { automationService, studioRpcService, workspaceBackupService, conversationTerminalHandoff } = services
  const { conversationCommands } =
    !options.server && automationService && studioRpcService && workspaceBackupService && conversationTerminalHandoff
      ? registerServerDomainIpc(ipcMain, {
          core: services.studioCore,
          gateway: automationService,
          studioRpc: studioRpcService,
          githubTokenStore: services.githubTokenStore,
          workspaceBackup: workspaceBackupService,
          terminalHandoff: (input) => conversationTerminalHandoff.handoff(input),
          files: { ...filesystemSearchHandlers, ...filesystemReadHandlers },
          assertAppSender,
          scheduledAgents: () => services.scheduledAgents(),
        })
      : // The server registers them, and disposes its own command lists.
        { conversationCommands: { dispose: async () => undefined } }
  registerThirdPartyModuleIpc(ipcMain, {
    ...(options.readThirdPartyLaunchSession ? { readLaunchSession: options.readThirdPartyLaunchSession } : {}),
  })

  // Terminals are served over the Studio protocol (src/server/terminals/),
  // and a pane terminal moves between windows by re-attaching: the last
  // attach takes the pty's output. A pop-out's attach that crossed the
  // owner's taking the tab back must not be the last word.
  services.setTerminalAttachGuard((windowKey, sessionId) => {
    const id = webContentsIdOfWindowKey(windowKey)
    const contents = id === null ? undefined : webContents.fromId(id)
    return contents ? panePopOuts.mayAttachTerminal(contents, sessionId) : true
  })

  // The conversation peek reads a terminal session, so it registers alongside
  // the runtime that owns one rather than with the core surfaces.
  registerConversationPeekIpc(ipcMain, services.conversationPeek)

  // Compacting a terminal agent types at its prompt, through the control plane
  // where the session runs (the core's in process, the server's out of process),
  // which checks the session as it stands then.
  registerAgentCompactIpc(ipcMain, (sessionId) => services.shellTerminals.compact(sessionId))

  // Same reason: a terminal agent's pull request marks follow its session, so
  // the hover's refresh registers beside the runtime that owns the session.
  // The lists themselves are the Studio server's, read over the protocol.
  registerPullRequestIpc(machineIpc, {
    refreshPullRequestsForSession: (sessionId) => services.refreshPullRequestsForSession(sessionId),
  })
  // ── extension-platform additions ──
  // Build your own extension: the SDK's templates, the machine check, the project.
  registerExtensionScaffoldIpc(machineIpc)
  return { conversationCommands }
}
