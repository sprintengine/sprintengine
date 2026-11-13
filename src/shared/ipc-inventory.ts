// Every channel between a window and main, said once: which way it goes, and
// whether it stays on IPC (the desktop shell's own) or moves to the Studio
// protocol. The target is IPC for the shell alone (windows, dialogs, updates,
// revealing a file), with everything else a typed protocol method every
// client reaches the same way, so a feature built for the local window is
// built for a paired desktop, the phone and a browser tab too.
//
// The rule is held three ways:
// - main refuses, at registration, any channel this table does not list
//   (`mayRegisterIpcChannel`, used by `guardIpcSenders` in main's entry);
// - `src/main/ipc-inventory.test.ts` drives every registration site, every
//   module (an installed extension included) and every preload member, and
//   holds what they register and use to this table both ways;
// - the same test counts the server rows per area. A new server channel fails
//   it: add a protocol method instead. Moving an area's channels off IPC
//   deletes its rows and lowers its count.
//
// `invoke` is a renderer's `invoke` that main `handle`s, `send` a renderer's
// fire-and-forget message that main listens `on`, `push` a message main
// sends a window. A name ending in `:*` stands for every channel it begins:
// the ones made per watch, follow or install.

export type IpcDirection = 'invoke' | 'send' | 'push'

/** Where a server channel goes: the area of the Studio protocol that replaces it. */
export type IpcServerArea =
  'conversations' | 'terminals' | 'modules' | 'extensions' | 'paired-machines' | 'access' | 'workspaces' | 'web-tab'

export type IpcInventoryRow =
  | { readonly dir: IpcDirection; readonly shell: string }
  | { readonly dir: IpcDirection; readonly server: IpcServerArea }

const shell =
  (reason: string) =>
  (dir: IpcDirection): IpcInventoryRow => ({ dir, shell: reason })
const server =
  (area: IpcServerArea) =>
  (dir: IpcDirection): IpcInventoryRow => ({ dir, server: area })

const WINDOW = shell('It acts on a window of this app.')
const DESKTOP = shell("It acts on this computer's desktop: a dialog, a menu, the clipboard or another app.")
const UPDATE = shell('It updates this installed app.')
const PREFERENCE = shell('A preference of this installed app on this computer.')
const BOOT = shell("This window's own startup.")
const BROWSER_PANE = shell('The browser pane, a page this app shows (the browser tool agents are offered).')
const CANVAS = shell('The canvas this window draws (the canvas tool agents are offered).')
const EDITOR = shell("This window's editor and tours (the editor and tour tools agents are offered).")
const ATTACHED = shell('A file the person attached or opens on this computer.')
const SERVER_PROCESS = shell("It supervises this computer's Studio server process.")
const CONNECTION = shell("It brokers this window's connection to its Studio server.")
const ENVIRONMENTS = shell(
  "The machines this desktop knows and how each stands: this client's own saved list, kept like its windows.",
)
const SSH_SETUP = shell('It sets up an SSH machine from this computer.')
const ACCOUNT = shell(
  "This install's account sign-in: its tokens in this computer's keychain, through the system browser.",
)
const DIAGNOSTICS = shell("This app's own logs and processes.")
const CHAT_LINK = shell("A chat link from the operating system, opened in one of this app's windows.")

/** Moves to the protocol: chats and what hangs off them: sessions, providers, secrets, import, held and scheduled messages, usage limits, export, pull request creation. */
/** Moves to the protocol: terminals and the agents that run in them. */
const terminals = server('terminals')
/** Moves to the protocol: a chat or a canvas on a paired desktop. */
const pairedMachines = server('paired-machines')
/** Moves to the protocol: projects and their chats, the backlog, scheduled agents and the machines a project runs on. */
const workspaces = server('workspaces')
/** Moves to the protocol: what a browser tab asks its server for: folders, previews, local servers. */
const webTab = server('web-tab')

export const IPC_INVENTORY: Readonly<Record<string, IpcInventoryRow>> = {
  // ── The shell: stays on IPC ──
  'appearance:set-color-scheme': WINDOW('invoke'),
  'appearance:set-window-material': WINDOW('invoke'),
  'aux:retarget': WINDOW('push'),
  'pane-popout:act': WINDOW('send'),
  'pane-popout:action': WINDOW('push'),
  'pane-popout:close': WINDOW('invoke'),
  'pane-popout:closed': WINDOW('push'),
  'pane-popout:focus': WINDOW('invoke'),
  'pane-popout:get-state': WINDOW('invoke'),
  'pane-popout:open': WINDOW('invoke'),
  'pane-popout:push': WINDOW('send'),
  'pane-popout:state': WINDOW('push'),
  // A notification about a pairing was clicked: main brought this window forward, which opens Remote.
  'remote:open-requested': WINDOW('push'),
  'window:close': WINDOW('invoke'),
  'window:close-requested': WINDOW('push'),
  'window:confirm-close': WINDOW('invoke'),
  'window:create-workspace-window': WINDOW('invoke'),
  'window:diff-to-chat': WINDOW('invoke'),
  'window:diff-to-chat-ack': WINDOW('send'),
  'window:dock-diff': WINDOW('invoke'),
  'window:dock-diff-ack': WINDOW('send'),
  'window:dock-file': WINDOW('invoke'),
  'window:get-placement': WINDOW('invoke'),
  'window:get-state': WINDOW('invoke'),
  'window:hidden-changed': WINDOW('push'),
  'window:minimize': WINDOW('invoke'),
  'window:open-aux-window': WINDOW('invoke'),
  'window:open-external': WINDOW('invoke'),
  'window:placement-changed': WINDOW('push'),
  'window:state-changed': WINDOW('push'),
  'window:toggle-maximize': WINDOW('invoke'),
  'workspace:diff-to-chat': WINDOW('push'),
  'workspace:dock-diff': WINDOW('push'),
  'workspace:dock-file': WINDOW('push'),
  'app-menu:command': DESKTOP('push'),
  'app-menu:update-accelerators': DESKTOP('invoke'),
  'app:show-menubar-menu': DESKTOP('invoke'),
  'clipboard:read-text': DESKTOP('invoke'),
  'clipboard:write-rich': DESKTOP('invoke'),
  'clipboard:write-text': DESKTOP('invoke'),
  // Export chat's writing: the chat itself is read from its Studio (`conversation.exportPage`).
  'chat-export:save': shell(
    "This computer's save dialog, print window, clipboard and disk, writing a chat its Studio read.",
  )('invoke'),
  'fs:dialog:open-project-icon': DESKTOP('invoke'),
  'fs:dialog:opendir': DESKTOP('invoke'),
  'git:save-patch': DESKTOP('invoke'),
  'fs:folder-open-targets': DESKTOP('invoke'),
  'fs:open-folder-in-target': DESKTOP('invoke'),
  'fs:open-html-file-in-browser': DESKTOP('invoke'),
  'fs:open-image-attachment': DESKTOP('invoke'),
  'fs:show-item-in-folder': DESKTOP('invoke'),
  'modules:third-party:reveal': DESKTOP('invoke'),
  'app:restart': UPDATE('invoke'),
  'update:check': UPDATE('invoke'),
  'update:dismiss-install-outcome': UPDATE('invoke'),
  'update:download': UPDATE('invoke'),
  'update:get-channel': UPDATE('invoke'),
  'update:get-state': UPDATE('invoke'),
  'update:open-release-notes': UPDATE('invoke'),
  'update:quit-and-install': UPDATE('invoke'),
  'update:set-auto-download': UPDATE('invoke'),
  'update:set-channel': UPDATE('invoke'),
  'update:state-changed': UPDATE('push'),
  'app:get-agent-browser-tools': PREFERENCE('invoke'),
  'app:get-agent-notifications': PREFERENCE('invoke'),
  'app:get-keep-awake': PREFERENCE('invoke'),
  'app:get-quit-confirmation': PREFERENCE('invoke'),
  'app:set-agent-browser-tools': PREFERENCE('invoke'),
  'app:set-agent-notifications': PREFERENCE('invoke'),
  'app:set-background-mode': PREFERENCE('invoke'),
  'app:set-keep-awake': PREFERENCE('invoke'),
  'app:set-quit-confirmation': PREFERENCE('invoke'),
  'app:set-telemetry-enabled': PREFERENCE('invoke'),
  'app:boot-complete': BOOT('send'),
  'app:build-stamp': BOOT('send'),
  'app:startup-mark': BOOT('send'),
  'splash:progress': BOOT('push'),
  'browser:back': BROWSER_PANE('invoke'),
  'browser:capture': BROWSER_PANE('invoke'),
  'browser:clear-cache': BROWSER_PANE('invoke'),
  'browser:clear-cookies': BROWSER_PANE('invoke'),
  'browser:config': BROWSER_PANE('invoke'),
  'browser:copy-screenshot': BROWSER_PANE('invoke'),
  'browser:focus-url': BROWSER_PANE('push'),
  'browser:forward': BROWSER_PANE('invoke'),
  'browser:host-key': BROWSER_PANE('push'),
  'browser:navigate': BROWSER_PANE('invoke'),
  'browser:note-active': BROWSER_PANE('invoke'),
  'browser:open-devtools': BROWSER_PANE('invoke'),
  'browser:open-external': BROWSER_PANE('invoke'),
  'browser:open-request': BROWSER_PANE('push'),
  'browser:open-window': BROWSER_PANE('invoke'),
  'browser:pointer': BROWSER_PANE('push'),
  'browser:recording-chunk': BROWSER_PANE('send'),
  'browser:recording-ended': BROWSER_PANE('send'),
  'browser:recording-start': BROWSER_PANE('push'),
  'browser:recording-started': BROWSER_PANE('send'),
  'browser:recording-stop': BROWSER_PANE('push'),
  'browser:recording-stop-request': BROWSER_PANE('invoke'),
  'browser:register': BROWSER_PANE('invoke'),
  'browser:reload': BROWSER_PANE('invoke'),
  'browser:set-color-scheme': BROWSER_PANE('invoke'),
  'browser:state': BROWSER_PANE('push'),
  'browser:stop': BROWSER_PANE('invoke'),
  'browser:unregister': BROWSER_PANE('invoke'),
  'browser:viewport-request': BROWSER_PANE('push'),
  'browser:zoom-step': BROWSER_PANE('invoke'),
  'canvas-worker:ready': CANVAS('send'),
  'canvas-worker:request': CANVAS('push'),
  'canvas-worker:response': CANVAS('send'),
  'canvas:close-board': CANVAS('invoke'),
  'canvas:commit-scene': CANVAS('invoke'),
  'canvas:continue-in-new-chat': CANVAS('invoke'),
  'canvas:export-board': CANVAS('invoke'),
  'canvas:export-scene': CANVAS('invoke'),
  'canvas:list-all-boards': CANVAS('invoke'),
  'canvas:list-boards': CANVAS('invoke'),
  'canvas:note-human-input': CANVAS('send'),
  'canvas:open-board': CANVAS('invoke'),
  'canvas:open-request': CANVAS('push'),
  'canvas:presence': CANVAS('push'),
  'canvas:reveal-board': CANVAS('invoke'),
  'canvas:scene': CANVAS('push'),
  'editor-reveal:ack': EDITOR('send'),
  'editor-reveal:claim': EDITOR('invoke'),
  'editor-reveal:list-pending': EDITOR('invoke'),
  'editor-reveal:pending': EDITOR('push'),
  'editor-reveal:request': EDITOR('push'),
  'editor-reveal:state-query': EDITOR('push'),
  'editor-reveal:state-reply': EDITOR('send'),
  'tours:ask': EDITOR('invoke'),
  'tours:ask-new-agent': EDITOR('invoke'),
  'tours:cancel-ask': EDITOR('invoke'),
  'tours:changed': EDITOR('push'),
  'tours:goto-answer': EDITOR('send'),
  'tours:goto-request': EDITOR('push'),
  'tours:list': EDITOR('invoke'),
  'tours:playback': EDITOR('invoke'),
  'tours:read': EDITOR('invoke'),
  'tours:reveal-ack': EDITOR('send'),
  'tours:reveal-request': EDITOR('push'),
  'attached-files:open': ATTACHED('invoke'),
  'attached-files:preview': ATTACHED('invoke'),
  'attached-files:register': ATTACHED('invoke'),
  'studio-server:info': SERVER_PROCESS('invoke'),
  'studio-server:open-log': SERVER_PROCESS('invoke'),
  'studio-server:port': SERVER_PROCESS('push'),
  'studio-server:relaunch': SERVER_PROCESS('invoke'),
  'studio-server:restart': SERVER_PROCESS('invoke'),
  'studio-server:retry': SERVER_PROCESS('invoke'),
  'studio-server:set-mode': SERVER_PROCESS('invoke'),
  'studio-server:status': SERVER_PROCESS('invoke'),
  'studio-server:status-changed': SERVER_PROCESS('push'),
  'studio:window-ticket': CONNECTION('invoke'),
  'environments:changed': ENVIRONMENTS('push'),
  'environments:list': ENVIRONMENTS('invoke'),
  'environments:retry': ENVIRONMENTS('invoke'),
  'environments:ticket': ENVIRONMENTS('invoke'),
  'environments:ssh:add': SSH_SETUP('invoke'),
  'environments:ssh:changed': SSH_SETUP('push'),
  'environments:ssh:connect': SSH_SETUP('invoke'),
  'environments:ssh:diagnostics': SSH_SETUP('invoke'),
  'environments:ssh:disconnect': SSH_SETUP('invoke'),
  'environments:ssh:forget': SSH_SETUP('invoke'),
  'environments:ssh:list': SSH_SETUP('invoke'),
  'environments:ssh:preview:get': SSH_SETUP('invoke'),
  'environments:ssh:preview:set': SSH_SETUP('invoke'),
  'environments:ssh:prompt': SSH_SETUP('push'),
  'environments:ssh:prompt-answer': SSH_SETUP('send'),
  'environments:ssh:prompt-closed': SSH_SETUP('push'),
  'environments:ssh:resolve': SSH_SETUP('invoke'),
  'environments:ssh:sign-in': SSH_SETUP('invoke'),
  'environments:ssh:stop-server': SSH_SETUP('invoke'),
  'environments:ssh:suggestions': SSH_SETUP('invoke'),
  'environments:ssh:update': SSH_SETUP('invoke'),
  'environments:ssh:upgrade-server': SSH_SETUP('invoke'),
  'auth:callback-error': ACCOUNT('push'),
  'auth:get-state': ACCOUNT('invoke'),
  'auth:login': ACCOUNT('invoke'),
  'auth:logout': ACCOUNT('invoke'),
  'auth:refresh-account': ACCOUNT('invoke'),
  'auth:state-changed': ACCOUNT('push'),
  'diagnostics:get-process-metrics': DIAGNOSTICS('invoke'),
  'diagnostics:log': DIAGNOSTICS('invoke'),
  'diagnostics:open-logs-folder': DIAGNOSTICS('invoke'),
  'diagnostics:open-window': DIAGNOSTICS('invoke'),
  'chat-link:ack': CHAT_LINK('send'),
  'chat-link:open': CHAT_LINK('push'),
  'chat-link:ready': CHAT_LINK('send'),
  'chat-link:unready': CHAT_LINK('send'),

  // ── The server: moves to the Studio protocol ──
  'agent:compact': terminals('invoke'),
  'conversation-peek:read': terminals('invoke'),
  'pullRequest:refreshForSession': terminals('invoke'),
  'mesh:conversation-attachment': pairedMachines('invoke'),
  'mesh:conversation-cancel-side-question': pairedMachines('invoke'),
  'mesh:conversation-changed-file': pairedMachines('invoke'),
  'mesh:conversation-changes-diff': pairedMachines('invoke'),
  'mesh:conversation-command': pairedMachines('invoke'),
  'mesh:conversation-commands': pairedMachines('invoke'),
  'mesh:conversation-context-breakdown': pairedMachines('invoke'),
  'mesh:conversation-earlier': pairedMachines('invoke'),
  'mesh:conversation-event': pairedMachines('invoke'),
  'mesh:conversation-file-search': pairedMachines('invoke'),
  'mesh:conversation-follow': pairedMachines('invoke'),
  'mesh:conversation-list': pairedMachines('invoke'),
  'mesh:conversation-pull-request-create': pairedMachines('invoke'),
  'mesh:conversation-pull-request-draft': pairedMachines('invoke'),
  'mesh:conversation-pull-request-draft-cancel': pairedMachines('invoke'),
  'mesh:conversation-pull-request-push': pairedMachines('invoke'),
  'mesh:conversation-pull-request-state': pairedMachines('invoke'),
  'mesh:conversation-send': pairedMachines('invoke'),
  'mesh:conversation-side-question': pairedMachines('invoke'),
  'mesh:conversation-tool-detail': pairedMachines('invoke'),
  'mesh:conversation-tool-image': pairedMachines('invoke'),
  'mesh:conversation-turn-diff': pairedMachines('invoke'),
  'mesh:conversation-unfollow': pairedMachines('invoke'),
  'mesh:conversation-watch-changes': pairedMachines('invoke'),
  'mesh:conversation:*': pairedMachines('push'),
  'hosts:changed': workspaces('push'),
  'hosts:home': workspaces('invoke'),
  'hosts:list': workspaces('invoke'),
  'browser:local-servers': webTab('invoke'),
  'web:browse-folders': webTab('invoke'),
  'web:previews:changed': webTab('push'),
  'web:previews:close': webTab('invoke'),
  'web:previews:list': webTab('invoke'),
  'web:previews:open': webTab('invoke'),
}

/** The row a channel falls under: its own, or the `:*` row whose prefix it begins with. */
export function ipcInventoryRow(channel: string): IpcInventoryRow | undefined {
  const exact = IPC_INVENTORY[channel]
  if (exact) return exact
  for (let end = channel.lastIndexOf(':'); end > 0; end = channel.lastIndexOf(':', end - 1)) {
    const row = IPC_INVENTORY[`${channel.slice(0, end)}:*`]
    if (row) return row
  }
  return undefined
}

/** Whether main may register a handler or listener on a channel: it is listed, as a renderer's to send. */
export function mayRegisterIpcChannel(channel: string): boolean {
  const row = ipcInventoryRow(channel)
  return row !== undefined && row.dir !== 'push'
}
