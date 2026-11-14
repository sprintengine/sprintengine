import type { ClientCapability } from './client-capabilities'
import type { AttachedFileBytes, AttachedFilePreview } from './attached-files'
import type { ChatLink } from './deep-link'
import type { AgentNotificationMode } from './agent-notifications'
import type { PreviewOpenAnswer, PreviewPort, PreviewSummary } from './web-client'
import type {
  SshEnvironmentResult,
  SshEnvironmentSettings,
  SshEnvironmentSummary,
  SshPromptRequest,
  SshResolveResult,
} from './ssh-environments'
import type { EnvironmentEntry, EnvironmentTicketResult } from './environments'
import type { SshPreviewStatus } from './ssh-preview'
import type { ServerMode } from './server-mode'
import type { ChatExportInput, ChatExportResult } from './chat-export'
import type { StudioServerInfo, StudioServerStatus } from './studio-server-status'
import type { EditorRevealAck, EditorRevealRequest, EditorStateQuery, EditorStateReply } from './editor-reveal'
import type {
  LiveTour,
  TourAsk,
  TourChangedEvent,
  TourGotoAnswer,
  TourGotoRequest,
  TourPlayback,
  TourResult,
  TourRevealRequest,
  TourSummary,
} from './tours/tour-types'
import type { ConversationPeek } from './conversation-peek'

export type { ConversationPeek, ConversationPeekMessage, ConversationPeekSource } from './conversation-peek'
export type { HostedSource, HostedSourceKind, HostedSourcesFeed } from './hosted-sources-feed'
export type {
  CardAction,
  CardActionVerb,
  CardSurfaceView,
  HostedCard,
  HostedCardFeed,
  HostedCardKind,
} from './hosted-card-feed'
// The build-identity shape a window reports; re-exported because it is part of
// this IPC contract like the rest of the surface below.
import type { BuildStamp } from './build-stamp'
export type { BuildStamp } from './build-stamp'
import type {
  BrowserCaptureInput,
  BrowserClearResult,
  BrowserConfig,
  BrowserHostKey,
  BrowserPointerEvent,
  BrowserRecordingEnded,
  BrowserRecordingStart,
  BrowserRecordingStarted,
  BrowserRegisterInput,
  BrowserRegisterResult,
  BrowserScreenshotResult,
  BrowserTabState,
  LocalServer,
} from './browser'
import type { BrowserColorScheme, BrowserViewport } from './browser-devices'
import type {
  CanvasBoardRef,
  CanvasBoardState,
  CanvasBoardSummary,
  CanvasContinueInput,
  CanvasContinueResult,
  CanvasElement,
  CanvasExportImages,
  CanvasExportResult,
  CanvasMachineListing,
  CanvasPresence,
  CanvasResult,
  CanvasScenePush,
} from './canvas/types'
import type { CanvasWorkerReport, CanvasWorkerRequest, CanvasWorkerResponse } from './canvas/worker-protocol'
import type { FolderOpenRequest, FolderOpenResult, FolderOpenTargetAvailability } from './folder-open-targets'
// Re-exported because these shapes are the open-in-editor IPC contract itself:
// the renderer reads them off this module like the rest of the API surface.
export type {
  FolderOpenFailureReason,
  FolderOpenRequest,
  FolderOpenResult,
  FolderOpenTargetAvailability,
  FolderOpenTargetId,
} from './folder-open-targets'
// Re-exported because the harness identity is part of this IPC contract: it
// rides BuiltinSkill, WorkspaceSkill and every install/uninstall result.
export type { SkillHarness } from './skills'
// Which transport the skills service reads repositories over. It rides
// `SkillSourcesResult` because every surface that says why a cadence or a
// shortfall applies has to know (git-transport ruling, owner 2026-09-08).
export type { SkillRepoTransport } from './skills'
// The capability query's shapes live with the other skill shapes; these are its
// IPC envelopes, same split as the skill-source calls below.
export type {
  AgentCapabilitiesInput,
  AgentCapabilitiesResult,
  AgentMcpServer,
  AgentSkill,
  AgentSkillSource,
  CapabilityDiagnostic,
} from './skills'
import type { StudioWindowTicket } from './studio-connection'
// Re-exported because the probe shape is part of this IPC contract: the
// version-control settings sections read it straight off the api surface.
export type {
  VersionControlProbeFailure,
  VersionControlProviderId,
  VersionControlProviderProbe,
} from './version-control'
import type { SprintEngineAuthState } from './ipc/account'
import type { ThirdPartyModuleRevealResult } from './modules/manifest'
import type { AppMenuAcceleratorUpdate, AppMenuAcceleratorUpdateResult, ColorScheme, WindowMaterial } from './ipc/app'
import type { DiagnosticLogEntry, DiagnosticLogInput } from './ipc/diagnostics'
import type { GitPatchSaveResult } from './ipc/git'
import type { IpcStatsSnapshot, ProcessMetricsSnapshot } from './ipc/terminal'
import type {
  AppUpdateChannelSetting,
  AppUpdateCheckResult,
  AppUpdateState,
  AppUpdateTrack,
  AuxWindowRetargetPayload,
  CreateWorkspaceWindowInput,
  CreateWorkspaceWindowResult,
  DiffToChatInput,
  DiffToChatPayload,
  DiffToChatResult,
  DockDiffToWorkspaceInput,
  DockDiffToWorkspacePayload,
  DockDiffToWorkspaceResult,
  DockFileToWorkspaceInput,
  OpenAuxWindowInput,
  OpenAuxWindowResult,
  OpenExternalResult,
  WindowPlacement,
  WindowState,
} from './ipc/window'
import type {
  PanePopOutAction,
  PanePopOutActionEvent,
  PanePopOutClosedEvent,
  PanePopOutOpenInput,
  PanePopOutOpenResult,
  PanePopOutSnapshot,
  PanePopOutState,
  PanePopOutStatePush,
} from './ipc/pane-popout'

// The contract, one module per domain. Everything a caller imports from this
// file is declared in one of them; this file adds the ElectronApi shape.
export type * from './ipc/filesystem'
export type * from './ipc/memory'
export type * from './ipc/studio-plugin'
export type * from './ipc/agent-cli'
export type * from './ipc/marketplace'
export type * from './ipc/cli-version'
export type * from './ipc/hosted-feeds'
export type * from './ipc/cards'
export type * from './ipc/marketplace-registry'
export type * from './ipc/conversations'
export type * from './ipc/agent-runtime'
export type * from './ipc/mcp'
export type * from './ipc/agent-config'
export type * from './ipc/conversation-import'
export type * from './ipc/skills'
export type * from './ipc/terminal'
export type * from './ipc/git'
export type * from './ipc/worktree-pool'
export type * from './ipc/settled-chats'
export type * from './ipc/diagnostics'
export type * from './ipc/window'
export type * from './ipc/pane-popout'
export type * from './ipc/account'
export type * from './ipc/workspace-backup'
export type * from './ipc/app'
export type * from './ipc/backlog'

/** `restarting: false` when the person answered Cancel to the quit question. */
export type AppRestartResult = { restarting: boolean }

export type ElectronApi = {
  /**
   * The OS of the machine the person is at: the client. It decides the
   * Primary modifier, the keyboard's labels and the window chrome. In a
   * desktop window it is the preload's `process.platform`; in a browser tab,
   * the browser's own (phase 9 spec, 3.3).
   */
  platform: string
  /**
   * The OS of the machine the Studio server runs on. It decides path syntax,
   * the "Reveal in Finder/Explorer" wording and CLI hints. The same as
   * `platform` for a desktop window on its own server.
   */
  hostPlatform: string
  /** What this shell can do (src/shared/client-capabilities.ts); ask `clientSupports`, not `typeof`. */
  clientCapabilities: readonly ClientCapability[]
  /** The ports the server's agents listen on, for a preview (web client only; `previews`). */
  previewsList: () => Promise<{ ports: PreviewPort[] }>
  /** Open a preview of a port on the server's loopback, on an origin of its own. */
  previewsOpen: (input: { port: number; typed?: boolean }) => Promise<PreviewOpenAnswer>
  previewsClose: (previewId: string) => Promise<boolean>
  onPreviewsChanged: (cb: (previews: PreviewSummary[]) => void) => () => void
  /** Whether this session has SSH machines (a preview, off by default; phase 8). */
  sshMachinesEnabled?: boolean
  isDevelopment: boolean
  isDiagnosticsEnabled: boolean
  windowMinimize: () => Promise<void>
  windowToggleMaximize: () => Promise<WindowState | null>
  windowClose: () => Promise<void>
  getWindowState: () => Promise<WindowState | null>
  getWindowPlacement: () => Promise<WindowPlacement | null>
  /**
   * This window's zoom (View ▸ Zoom), read in process with no IPC. The browser
   * tab's device frame divides by it, so a zoomed window lays a page out at
   * the device's own size. 1 where there is no window to zoom.
   */
  getWindowZoomFactor: () => number
  createWorkspaceWindow: (input: CreateWorkspaceWindowInput) => Promise<CreateWorkspaceWindowResult>
  openAuxWindow: (input: OpenAuxWindowInput) => Promise<OpenAuxWindowResult>
  onAuxWindowRetarget: (cb: (payload: AuxWindowRetargetPayload) => void) => () => void
  dockFileToWorkspace: (input: DockFileToWorkspaceInput) => Promise<void>
  onDockFileToWorkspace: (cb: (input: DockFileToWorkspaceInput) => void) => () => void
  dockDiffToWorkspace: (input: DockDiffToWorkspaceInput) => Promise<DockDiffToWorkspaceResult>
  onDockDiffToWorkspace: (cb: (input: DockDiffToWorkspacePayload) => void) => () => void
  /** The receiving window's half of the hand-off: "I opened the tab." */
  ackDockDiffToWorkspace: (requestId: string) => void
  /** The diff window's "Add to chat": a quote for the composer of the workspace's chat. */
  sendDiffToChat: (input: DiffToChatInput) => Promise<DiffToChatResult>
  onDiffToChat: (cb: (input: DiffToChatPayload) => void) => () => void
  /** The receiving window's half: "it is in the chat's composer." */
  ackDiffToChat: (requestId: string) => void
  confirmWindowClose: () => Promise<void>
  openExternal: (url: string) => Promise<OpenExternalResult>
  onWindowStateChanged: (cb: (state: WindowState) => void) => () => void
  /** Main's word on whether this window is minimized, hidden or behind a locked screen. */
  onWindowHiddenChanged: (cb: (hidden: boolean) => void) => () => void
  onWindowPlacementChanged: (cb: (placement: WindowPlacement) => void) => () => void
  onWindowCloseRequested: (cb: () => void) => () => void
  /**
   * A `sprintengine://chat/…` link for this window to open. Subscribing tells
   * main the window is listening, so call it once the registry has loaded: a
   * link that launched the app waits in main until then (chat-link-router.ts).
   */
  onChatLinkOpen: (cb: (link: ChatLink) => void) => () => void
  // The pane, or one tab, in a window of its own (ipc/pane-popout.ts). The
  // first six are the owner window's half, the last three the pop-out's.
  panePopOutOpen: (input: PanePopOutOpenInput) => Promise<PanePopOutOpenResult>
  /** Fire-and-forget: the owner's latest word on what the window shows. */
  panePopOutPush: (popOutId: string, state: PanePopOutState) => void
  panePopOutFocus: (popOutId: string) => Promise<void>
  panePopOutClose: (popOutId: string) => Promise<void>
  onPanePopOutAction: (cb: (event: PanePopOutActionEvent) => void) => () => void
  onPanePopOutClosed: (cb: (event: PanePopOutClosedEvent) => void) => () => void
  panePopOutGetState: (popOutId: string) => Promise<PanePopOutSnapshot | null>
  onPanePopOutState: (cb: (push: PanePopOutStatePush) => void) => () => void
  /** Fire-and-forget: what the person did in the pop-out, for the owner to apply. */
  panePopOutAct: (popOutId: string, action: PanePopOutAction) => void
  // The embedded browser (browser-pane epic, src/shared/browser.ts). The
  // renderer mounts the `<webview>` and registers its WebContents id; main
  // drives it and pushes `onBrowserState` for every registered tab.
  /** The partition for a workspace's tabs: an SSH machine's, behind its forward, or this computer's (phase 8). */
  browserConfig: (input?: { workspaceId?: string }) => Promise<BrowserConfig>
  browserRegister: (input: BrowserRegisterInput) => Promise<BrowserRegisterResult>
  browserUnregister: (tabId: string) => Promise<void>
  browserNavigate: (tabId: string, url: string) => Promise<boolean>
  browserBack: (tabId: string) => Promise<boolean>
  browserForward: (tabId: string) => Promise<boolean>
  browserReload: (tabId: string, ignoreCache?: boolean) => Promise<boolean>
  browserStop: (tabId: string) => Promise<boolean>
  browserOpenExternal: (tabId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  browserZoomStep: (tabId: string, direction: 1 | -1 | 0) => Promise<boolean>
  browserSetColorScheme: (tabId: string, scheme: BrowserColorScheme) => Promise<boolean>
  browserOpenDevTools: (tabId: string) => Promise<boolean>
  browserOpenWindow: (tabId: string) => Promise<boolean>
  browserClearCookies: () => Promise<BrowserClearResult>
  browserClearCache: () => Promise<BrowserClearResult>
  browserCapture: (input: BrowserCaptureInput) => Promise<BrowserScreenshotResult>
  browserCopyScreenshot: (tabId: string) => Promise<BrowserClearResult>
  browserLocalServers: (workspaceId: string) => Promise<LocalServer[]>
  /** Tell main which tab the person is looking at in a workspace's pane (agent tools target it). */
  browserNoteActive: (workspaceId: string, tabId: string | null) => Promise<void>
  /** An agent asked for a URL in this workspace's pane (browser.open); the renderer opens or navigates a tab. */
  onBrowserOpenRequest: (
    cb: (payload: { workspaceId: string; url: string | null; tabId: string | null }) => void,
  ) => () => void
  /** The agent's pointer is about to act at a point in a tab's viewport (the cursor overlay). */
  onBrowserPointer: (cb: (event: BrowserPointerEvent) => void) => () => void
  /** An agent asked for a device viewport on a tab (browser.resize); the renderer owns viewport state. */
  onBrowserViewportRequest: (cb: (payload: { tabId: string; viewport: BrowserViewport }) => void) => () => void
  onBrowserState: (cb: (state: BrowserTabState) => void) => () => void
  onBrowserFocusUrl: (cb: (payload: { tabId: string }) => void) => () => void
  onBrowserHostKey: (cb: (payload: { tabId: string; key: BrowserHostKey }) => void) => () => void
  /** The person's Stop on a recording an agent started on this tab. */
  browserStopRecording: (tabId: string) => Promise<boolean>
  /**
   * Main asks this window to record one of its tabs (`browser.record_start`):
   * the window captures the guest, encodes it and answers with the three sends below.
   */
  onBrowserRecordingStart: (cb: (start: BrowserRecordingStart) => void) => () => void
  onBrowserRecordingStop: (cb: (payload: { recordingId: string }) => void) => () => void
  browserRecordingStarted: (payload: BrowserRecordingStarted) => void
  /** One chunk of a recording's WebM, in order. */
  browserRecordingChunk: (recordingId: string, bytes: Uint8Array) => void
  /** After the last chunk. */
  browserRecordingEnded: (payload: BrowserRecordingEnded) => void
  // The Canvas pane (src/shared/canvas). Main owns the `.excalidraw` file, the
  // revision and the merge; a tab subscribes by opening a board and is pushed
  // every accepted scene until it closes it. Every path crossing here is
  // resolved against the workspace root on the main side, so a renderer cannot
  // name a file outside the project however it spells one.
  canvasListBoards: (workspaceId: string) => Promise<CanvasResult<CanvasBoardSummary[]>>
  /** Every board on this machine, each with its project; `workspaceId` marks which rows are the asker's own. */
  canvasListAllBoards: (workspaceId?: string) => Promise<CanvasResult<CanvasMachineListing>>
  /** Start a chat whose first message names this board by id. The board's own tab is the caller's to open. */
  canvasContinueInNewChat: (input: CanvasContinueInput) => Promise<CanvasResult<CanvasContinueResult>>
  /** Opens (optionally creating) a board and subscribes the calling window to it. */
  canvasOpenBoard: (input: CanvasBoardRef & { create?: boolean }) => Promise<CanvasResult<CanvasBoardState>>
  canvasCloseBoard: (input: CanvasBoardRef) => Promise<void>
  /**
   * The person's edit, debounced by the tab. `elements` is the full array
   * including tombstones, and `baseRevision` is what the tab last saw, so main
   * can merge rather than overwrite. `elements` comes back non-null only when
   * the merge differs from what was sent — that is the tab's cue to reconcile,
   * and sending it back unconditionally would echo every keystroke.
   */
  canvasCommitScene: (
    input: CanvasBoardRef & {
      baseRevision: number
      elements: CanvasElement[]
      appState: Record<string, unknown>
      files: Record<string, unknown>
    },
  ) => Promise<CanvasResult<{ revision: number; elements: CanvasElement[] | null }>>
  /**
   * Export the board into a folder the person picks: main shows the picker
   * (opening at `defaultDirectory` when given) and writes `<name>.excalidraw`
   * there, plus `<name>.png` / `<name>.svg` for each image the tab rendered.
   * The board itself stays where it is. `cancelled` when the picker was
   * dismissed.
   */
  canvasExportBoard: (
    input: CanvasBoardRef & { defaultDirectory?: string; images?: CanvasExportImages },
  ) => Promise<CanvasResult<CanvasExportResult>>
  /**
   * Show the board's file in the system file manager. Main resolves where it
   * is: a store board lives in the app's data folder, outside the project.
   */
  canvasRevealBoard: (input: CanvasBoardRef) => Promise<CanvasResult<void>>
  /**
   * The person has started a gesture on this board. Presence ONLY: it moves the
   * badge every other window shows, so an agent stops looking like it holds the
   * pen. It cancels nothing — an agent action in flight keeps running, and what
   * protects the person's work is the per-element merge in main, which
   * recomputes a contested agent edit once and then fails it `interrupted`.
   * Fire-and-forget.
   */
  canvasNoteHumanInput: (input: CanvasBoardRef) => void
  onCanvasScene: (cb: (push: CanvasScenePush) => void) => () => void
  onCanvasPresence: (cb: (presence: CanvasBoardRef & CanvasPresence) => void) => () => void
  /** An agent asked for a board in this workspace's pane (canvas.open); the tab opens docked. */
  onCanvasOpenRequest: (cb: (ref: CanvasBoardRef) => void) => () => void
  /**
   * Export a scene this window holds (a paired chat's board, as the window
   * last read it) into a folder the person picks here: the copy is theirs, on
   * this computer's disk.
   */
  canvasExportScene: (input: {
    name: string
    elements: CanvasElement[]
    appState: Record<string, unknown>
    files: Record<string, unknown>
    images?: CanvasExportImages
  }) => Promise<CanvasResult<CanvasExportResult>>
  // Diff tours (src/main/tours). The Diff viewer reads and plays them; the
  // workspace window docks a tour's Diff tab when an agent writes one.
  tourList: (workspaceId: string) => Promise<TourSummary[]>
  tourRead: (workspaceId: string, tourId: string) => Promise<TourResult<LiveTour>>
  tourReportPlayback: (workspaceId: string, tourId: string, playback: TourPlayback) => Promise<void>
  tourAsk: (
    workspaceId: string,
    tourId: string,
    stepId: string,
    question: string,
  ) => Promise<TourResult<TourAsk> & { authorGone?: boolean }>
  tourCancelAsk: (workspaceId: string, tourId: string, askId: string) => Promise<void>
  tourAskNewAgent: (
    workspaceId: string,
    tourId: string,
    stepId: string,
    question: string,
  ) => Promise<TourResult<{ agentId: string }>>
  /** This window docked the tour's tab: `tour.create` answers `revealed: true`. */
  tourAcknowledgeReveal: (requestId: string) => void
  tourAnswerGoto: (answer: TourGotoAnswer) => void
  onTourChanged: (cb: (event: TourChangedEvent) => void) => () => void
  onTourRevealRequest: (cb: (request: TourRevealRequest) => void) => () => void
  onTourGotoRequest: (cb: (request: TourGotoRequest) => void) => () => void
  // The hidden canvas worker window's half of the same surface. Only that window
  // uses these three: it announces itself once its editor instance has mounted,
  // then answers requests until main disposes it.
  /**
   * Ready to take requests, and how the fonts went. A family in `missing` means
   * every label the worker measures is measured in a fallback face and written
   * to the person's file at that size, so main appends a warning to every edit,
   * layout and import it makes while that is true.
   */
  canvasWorkerReady: (report: CanvasWorkerReport) => void
  onCanvasWorkerRequest: (cb: (request: CanvasWorkerRequest) => void) => () => void
  canvasWorkerRespond: (response: CanvasWorkerResponse) => void
  // The editor reveal (editor.* tools): main asks every workspace window to
  // open a file or diff an agent means; the window showing that workspace
  // does, and says how. `editorRevealClaim` takes the reveal that waited for a
  // workspace no window was showing.
  onEditorRevealRequest: (cb: (request: EditorRevealRequest) => void) => () => void
  ackEditorReveal: (ack: EditorRevealAck) => void
  onEditorRevealPending: (cb: (payload: { workspaceIds: string[] }) => void) => () => void
  editorRevealClaim: (workspaceId: string) => Promise<EditorRevealRequest | null>
  editorRevealListPending: () => Promise<string[]>
  onEditorStateQuery: (cb: (query: EditorStateQuery) => void) => () => void
  replyEditorState: (reply: EditorStateReply) => void
  // Splash boot handshake. `notifyBootComplete` is sent once by the primary
  // workspace window when its first frame is on screen, and is what closes the
  // splash and reveals the main window (main also holds a hard timeout, so a
  // renderer that never gets there cannot strand a hidden main window). The
  // plate's own progress subscription is not here: the plate loads a preload of
  // its own (`src/preload/splash.ts`).
  notifyBootComplete: () => void
  // Boot measurement, off unless asked for. The flag is resolved in
  // preload from the same environment main reads, so the renderer never reports
  // marks into a main process that is not collecting them. A mark is an epoch
  // millisecond because the two processes have different `performance.now()`
  // origins — see src/shared/startup-timeline.ts.
  startupTimelineEnabled: boolean
  reportStartupMark: (id: string, atEpochMs: number) => void
  // Build identity. Every window reports the commit its bundle was
  // built from; main compares it against its own and says so once when the two
  // halves have diverged — see src/shared/build-stamp.ts.
  reportBuildStamp: (stamp: BuildStamp) => void
  /**
   * Where this window's next connection to its Studio goes, and the ticket
   * its socket and hello present: good once, within thirty seconds. Asked
   * again before every connection, reconnects included.
   */
  studioWindowTicket: () => Promise<StudioWindowTicket>
  /**
   * Main asks the chrome to open the Remote popover — the click on an OS
   * notification about a pair request or a machine's answer lands here.
   */
  onRemoteOpenRequested: (cb: () => void) => () => void
  authGetState: () => Promise<SprintEngineAuthState>
  authLogin: (organizationId?: string | null) => Promise<{ state: string; authorizationUrl: string }>
  authLogout: () => Promise<{ loggedOut: true }>
  authRefreshAccount: () => Promise<SprintEngineAuthState>
  onAuthStateChanged: (cb: (state: SprintEngineAuthState) => void) => () => void
  onAuthCallbackError: (cb: (message: string) => void) => () => void
  getPathForFile: (file: unknown) => string
  /**
   * A dropped, picked or pasted file's path, as `getPathForFile` reads it, and
   * that file remembered as attached: the paths `openAttachedFile` will open.
   * '' for a file with no path on disk.
   */
  attachFile: (file: unknown) => string
  /** What an attached path is now, the system's thumbnail of it, and whether a click may open it. */
  previewAttachedFile: (path: string) => Promise<AttachedFilePreview>
  /** An attached file's bytes, for a chat on another machine to take with a message (registered paths only). */
  readAttachedFile: (path: string) => Promise<AttachedFileBytes>
  /**
   * Open an attached file in its default app. Refuses, with the reason, a path
   * that was not attached and a file that would run as a program when opened.
   */
  openAttachedFile: (path: string) => Promise<void>
  /** Send dropped files that have no path to the server; answers a path there for each (`file-uploads`). */
  uploadFiles: (files: File[]) => Promise<string[]>
  logDiagnostic: (input: DiagnosticLogInput) => Promise<DiagnosticLogEntry>
  openDiagnosticsLogsFolder: () => Promise<{ opened: true; path: string }>
  updateGetState: () => Promise<AppUpdateState>
  updateCheck: () => Promise<AppUpdateCheckResult>
  updateDownload: () => Promise<AppUpdateCheckResult>
  updateQuitAndInstall: () => Promise<AppUpdateCheckResult>
  /**
   * Relaunch the app, asked about like a quit when agents are working. Absent
   * where there is no app to relaunch (a browser tab).
   */
  restartApp?: () => Promise<AppRestartResult>
  updateOpenReleaseNotes: () => Promise<{ opened: true; url: string }>
  /** The release channel the updater follows, and whether the person chose it. */
  /** The Studio server: its phase in words, the Advanced toggle, and the actions on it. */
  studioServerStatus: () => Promise<StudioServerStatus>
  studioServerInfo: () => Promise<StudioServerInfo | null>
  studioServerRetry: () => Promise<void>
  studioServerRestart: () => Promise<void>
  studioServerOpenLog: () => Promise<boolean>
  studioServerSetMode: (mode: ServerMode) => Promise<StudioServerStatus>
  studioServerRelaunch: (options?: { compatibility?: boolean }) => Promise<void>
  onStudioServerStatus: (cb: (status: StudioServerStatus) => void) => () => void
  updateGetChannel: () => Promise<AppUpdateChannelSetting>
  /** Save a channel choice, re-point the updater at it and check that channel. */
  updateSetChannel: (channel: AppUpdateTrack) => Promise<AppUpdateCheckResult>
  /** Download updates as soon as they are found, or wait to be asked (the default). */
  updateSetAutoDownload: (enabled: boolean) => Promise<AppUpdateState>
  /** The last update's result has been shown; stop reporting it. */
  updateDismissInstallOutcome: () => Promise<AppUpdateState>
  onUpdateStateChanged: (cb: (state: AppUpdateState) => void) => () => void
  /**
   * Every machine this desktop knows, this one first, with how each stands
   * (design-environments): the one list every surface draws machines from.
   */
  environmentsList: () => Promise<EnvironmentEntry[]>
  /** Ask the owner of a route (`formatEnvironmentRoute`) to try it again now. */
  environmentsRetry: (route: string) => Promise<void>
  /**
   * A ticket for one connection from this window to that route's Studio
   * (`formatEnvironmentRoute`): good once, for thirty seconds. Spend it on the
   * connection it was asked for and keep nothing; ask again for the next.
   */
  environmentsTicket: (route: string) => Promise<EnvironmentTicketResult>
  /** The machine list reads differently now; ask again. Returns the unsubscribe. */
  onEnvironmentsChanged: (cb: () => void) => () => void
  /** SSH machines (phase 8): saved, with their state in words. */
  sshEnvironmentsList: () => Promise<SshEnvironmentSummary[]>
  /** What `ssh -G` makes of a destination, shown before it is saved. */
  sshEnvironmentResolve: (destination: string) => Promise<SshResolveResult>
  /** The plain `Host` names in the person's SSH config. */
  sshEnvironmentSuggestions: () => Promise<string[]>
  sshEnvironmentAdd: (input: { destination: string; label?: string }) => Promise<SshEnvironmentResult & { id?: string }>
  sshEnvironmentUpdate: (
    id: string,
    patch: Partial<SshEnvironmentSettings> & { label?: string },
  ) => Promise<SshEnvironmentResult>
  /** Connect now, as the person asked: ssh's questions may be shown. */
  sshEnvironmentConnect: (id: string) => Promise<SshEnvironmentResult>
  sshEnvironmentDisconnect: (id: string) => Promise<SshEnvironmentResult>
  sshEnvironmentStopServer: (id: string) => Promise<SshEnvironmentResult>
  sshEnvironmentUpgradeServer: (id: string) => Promise<SshEnvironmentResult>
  sshEnvironmentForget: (
    id: string,
    options?: { stopServer?: boolean; clearBrowsingData?: boolean },
  ) => Promise<SshEnvironmentResult>
  sshEnvironmentDiagnostics: (id: string) => Promise<{ ok: true; text: string } | { ok: false; message: string }>
  /** Sign a chat's CLI in on an SSH machine, with no terminal (decision R34). */
  sshSignIn: (id: string, providerId: string) => Promise<SshEnvironmentResult>
  onSshEnvironmentsChanged: (cb: () => void) => () => void
  /** ssh asks something; answer with `sshPromptAnswer`. */
  onSshPrompt: (cb: (request: SshPromptRequest) => void) => () => void
  /** A prompt is over without this window's answer (timed out, answered elsewhere, ssh gave up). */
  onSshPromptClosed: (cb: (id: string) => void) => () => void
  sshPromptAnswer: (id: string, answer: string | null) => void
  /** The SSH machines preview switch: this session's, and the next launch's. */
  sshPreviewStatus: () => Promise<SshPreviewStatus>
  sshPreviewSet: (enabled: boolean) => Promise<SshPreviewStatus>
  /**
   * Open one conversation image attachment in the operating system's own image
   * viewer. The attachment exists only as base64 in the renderer, so the bytes
   * are written to the app's temp images folder first; `name` is a suggestion
   * for what that file is called, never a path.
   */
  openImageAttachment: (input: { mediaType: string; dataBase64: string; name?: string }) => Promise<void>
  showItemInFolder: (targetPath: string) => Promise<void>
  openHtmlFileInBrowser: (targetPath: string) => Promise<void>
  listFolderOpenTargets: () => Promise<FolderOpenTargetAvailability[]>
  openFolderInTarget: (request: FolderOpenRequest) => Promise<FolderOpenResult>
  openDir: (options?: { defaultPath?: string }) => Promise<string | null>
  /** The file dialog for a project's icon, filtered to images. */
  openProjectIconFile: (options?: { defaultPath?: string }) => Promise<string | null>
  showMenubarMenu: (label: string, position?: { x?: number; y?: number }) => Promise<boolean>
  clipboardReadText: () => Promise<string>
  clipboardWriteText: (text: string) => Promise<void>
  /**
   * Plain text and HTML in one write, so a paste into a rich editor keeps the
   * formatting and a paste into a terminal gets the text. Absent where the
   * host has no rich clipboard of its own.
   */
  clipboardWriteRich?: (payload: { text: string; html: string }) => Promise<void>
  /**
   * Export chat: a chat tab's whole conversation saved as a PDF, Word or
   * Markdown file where the save dialog says, or copied to the clipboard.
   * The window hands over the chat as its Studio read it
   * (`conversation.exportPage`); main reads nothing, and asks where to save.
   */
  saveChatExport: (input: ChatExportInput) => Promise<ChatExportResult>
  /** The same text, through the OS save dialog. */
  saveGitPatch: (repoRoot: string, patch: string, defaultFileName?: string) => Promise<GitPatchSaveResult>
  /** Open an installed third-party module's folder. Absent where there is no file manager to open it in. */
  revealThirdPartyModule?: (id: string) => Promise<ThirdPartyModuleRevealResult>
  // The conversation peek: what has been said in a chat the person is hovering
  // rather than looking at — the first message and everything since, from the
  // prompts this app captured. `source` says whether there is an answer, a
  // runtime that reports nothing, or no record at all, because the card is
  // required to say so rather than look broken. See `shared/conversation-peek.ts`.
  readConversationPeek: (sessionId: string) => Promise<ConversationPeek>
  // Compact a terminal agent's conversation: `/compact` at its prompt, once
  // main has checked the prompt is Claude Code's, waiting and empty
  // (terminalCompactBlocker in shared/prompt-cache.ts). Offered as its prompt
  // cache expires, so the next message re-sends a summary rather than all of it.
  compactAgentSession: (sessionId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  // The hover hook for a terminal agent's pull request marks: the shell asks
  // the Studio server to look the session's branch up (once per key per hold)
  // and re-read any state older than ~60s. The pull requests themselves arrive as a fresh
  // `terminal.sessions` carrying the session's `pullRequests`, never as
  // a return value, so one path owns the fact. The boolean says only whether
  // there was anything to ask about — false for a session main cannot name, or
  // one whose checkout has not resolved yet — so a caller that asks once per
  // session can tell "asked" from "could not ask yet" and try again.
  refreshPullRequestsForSession: (sessionId: string) => Promise<boolean>
  diagnosticsGetProcessMetrics: () => Promise<ProcessMetricsSnapshot>
  // Synchronous: returns the preload's accumulated IPC counters (empty channels
  // when diagnostics is disabled, since instrumentation is skipped entirely).
  diagnosticsGetIpcStats: () => IpcStatsSnapshot
  diagnosticsOpenWindow: () => Promise<void>
  onAppMenuCommand: (cb: (command: string) => void) => () => void
  updateAppMenuAccelerators: (updates: AppMenuAcceleratorUpdate[]) => Promise<AppMenuAcceleratorUpdateResult>
  setColorScheme: (scheme: ColorScheme) => Promise<void>
  // `canvasColor` is the theme's opaque window ground (`#rrggbb`), sent with an
  // opaque material so main can paint new windows in it; omitted under glass.
  setWindowMaterial: (material: WindowMaterial, canvasColor?: string) => Promise<void>
  // Renderer → main mirror of `appSettings.keepRunningInBackground`.
  // Main reads it inside `window-all-closed`, when no renderer is left to ask.
  setBackgroundMode: (enabled: boolean) => Promise<void>
  // Renderer → main mirror of `appSettings.telemetryEnabled`. Main reads it on
  // every event it records, including ones emitted with no window open. This is
  // the whole renderer-facing telemetry surface — there is no channel for the
  // renderer to send an event, only this one to stop main sending them.
  setTelemetryEnabled: (enabled: boolean) => Promise<void>
  // "Ask before quitting while agents are working", which main owns: the quit
  // dialog's "Don't ask again" turns it off with no renderer involved. Both
  // answer with the value main now holds; null from a client with no quit of
  // its own to ask about (a browser tab).
  getQuitConfirmation: () => Promise<boolean | null>
  setQuitConfirmation: (enabled: boolean) => Promise<boolean | null>
  /** Whether agents are given the built-in browser's tools (Settings → Agents); null where main has none. */
  getAgentBrowserTools: () => Promise<boolean | null>
  setAgentBrowserTools: (enabled: boolean) => Promise<boolean | null>
  /** Banners for a chat that finished or waits on the person (Settings → General); null where main has none. */
  getAgentNotifications: () => Promise<AgentNotificationMode | null>
  setAgentNotifications: (mode: AgentNotificationMode) => Promise<AgentNotificationMode | null>
  // "Keep the computer awake while agents work", which main owns: it takes and
  // releases the power-save blocker as agents start and stop. Null from a
  // client whose machine is not this one to keep awake (a browser tab).
  getKeepAwake: () => Promise<boolean | null>
  setKeepAwake: (enabled: boolean) => Promise<boolean | null>
}
