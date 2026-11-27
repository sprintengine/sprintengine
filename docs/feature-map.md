# Feature map

Where each feature a person meets lives in the code: the main entry points
on the server side (the Studio core, in `src/server/` and `src/main/`), in
the window (`src/renderer/src/`), on the wire (`packages/studio-protocol`,
`packages/conversation-protocol`, and the capability a client asks for), and
the tests to start from. It points; it does not explain. Where a doc already
says how a feature works, the entry names it. A path here is the place to
start reading, not the whole of a feature.

When you add a feature, or move one, update its entry in the same change.
`node scripts/check-feature-map.mjs` checks that every path written here is
there.

How the pieces fit: every client (the desktop's own window, a paired desktop,
a browser tab, the phone) is a client of a Studio over the Studio protocol;
the window has IPC only for the desktop shell (`src/shared/ipc-inventory.ts`).
See `CONTRIBUTING.md` and `docs/compatibility.md` first.

## Chats and conversations

**Chat view** (the transcript of one chat): `src/renderer/src/components/panels/AgentChatView.tsx`,
the rows in `src/renderer/src/components/panels/agentChat/timelineRows.tsx`, the projection and
folds in `packages/conversation-timeline/src/` (`conversationProjection.ts`, `turnFolds.ts`). Runtime:
`src/main/conversation-runtime.ts`, providers in `src/main/providers/`. Transport (where the view's
calls go, for every machine): `src/renderer/src/components/panels/agentChat/conversationTransport.ts`
and `studioChat.ts`. Wire: `conversation.*`, `session.*` (`packages/studio-protocol/src/chat.ts`).
Doc: `docs/conversations.md`. Tests: `src/main/conversation-runtime.test.ts`,
`packages/conversation-timeline/test/`, `src/seams/studioRpcSeam.test.ts`.

**Composer** (the box a message is typed in): `src/renderer/src/components/panels/agentChat/ComposerField.tsx`,
`composerControls.tsx`, `composerContextPicker.tsx`; the slash commands in `src/main/conversation-commands/`.
Tests: `src/renderer/src/components/panels/agentChat/ComposerField.test.tsx`.

**New chat**: `src/renderer/src/components/workspace/agentComposer/NewAgentPanel.tsx`, its machine picker
over the one environment list (`src/renderer/src/hooks/useEnvironments.ts`), and the start on another
machine in `src/renderer/src/studio/environmentDiscovery.ts`; the launch in
`src/main/conversation-launch-service.ts`. Wire: `conversation.create` (capabilities `conversation-create`,
`new-chat-folder`).
Tests: `src/main/conversation-launch-service.test.ts`, `src/renderer/src/components/workspace/agentComposer/NewAgentPanel.test.tsx`.

**Chat list and a chat's rest** (sidebar, settle, snooze, mark unread, star): `src/renderer/src/components/workspace/WorkspaceSidebar.tsx`,
`src/renderer/src/components/workspace/sidebar/`; the decisions in `src/main/automation/conversation-lifecycle.ts`
and the rest sweep in `src/main/automation/workspace-settlement-sweep.ts`. Wire: `chat-lifecycle`
(`packages/studio-protocol/src/chat-lifecycle.ts`). Tests: `src/main/automation/conversation-lifecycle.test.ts`.

**Auto compact and self-compaction**: `src/main/conversation-auto-compact.ts` wired in
`src/server/core/studio-auto-compact.ts`; an agent's own `conversation.compact` in
`src/main/automation/conversation-self-compact.ts`. Tests: `src/main/conversation-auto-compact.test.ts`,
`src/main/automation/conversation-self-compact.test.ts`.

**Files shown in a chat** (`file.view`, the inline editor): tool and ledger in `src/server/file-views/`,
card in `src/renderer/src/components/panels/agentChat/fileView/FileViewCard.tsx`; the phone's read-only
card in `mobile/src/features/conversations/ShownStepCards.tsx`. Wire: `fileViews.*`
(capability `file-views`, `packages/studio-protocol/src/file-views.ts`). Doc: `docs/conversations.md`
("Files shown in the chat"). Tests: `src/server/file-views/file-views.test.ts`,
`src/renderer/src/components/panels/agentChat/fileView/FileViewCard.test.tsx`,
`mobile/src/features/conversations/shownSteps.regression.test.js`.

**Sub-agents** (a chat's agents as chats of their own): `src/main/subagent-lifecycle.ts`,
`src/main/automation/subagent-tools.ts`; in the view `src/renderer/src/components/panels/agentChat/SubagentChatHost.tsx`
and `subagentStatus.tsx`; the list's rows in `chatSubagents.tsx`. A finished one is given another
task in its same CLI session with `subagent.resume`, and its row counts the rounds. Doc: `docs/conversations.md`
("Subagents as full chats"). Tests: `src/main/automation/subagent-tools.test.ts`,
`src/server/core/subagent-resume.test.ts` (a resume end to end, through the host and the runtime).

**Plugin offers in a chat** (`plugin.offer`): `src/main/automation/plugin-tools.ts`,
`src/renderer/src/components/panels/agentChat/pluginOffer/PluginOfferCard.tsx`; the phone's card, which
says to install it on the desktop, in `mobile/src/features/conversations/ShownStepCards.tsx`.
Tests: `src/main/automation/plugin-tools.test.ts`, `mobile/src/features/conversations/shownSteps.regression.test.js`.

**Scheduled messages and usage-limit resumes**: `src/main/scheduled-messages/scheduled-messages.ts`,
`src/server/core/studio-scheduled-messages.ts`, `src/main/usage-limits/`.

**Importing CLI sessions**: `src/main/conversation-import/conversation-import-service.ts`,
`src/renderer/src/components/onboarding/ConversationImportPicker.tsx`.
Tests: `src/main/conversation-import/conversation-import-service.test.ts`.

**Chat export**: `src/main/chat-export/`.

## Agents in terminals

**Terminal agents and terminals**: `src/server/terminals/studio-terminals.ts`, `src/main/agent-launch-service.ts`,
the view `src/renderer/src/components/panels/TerminalView.tsx`. Wire: `terminals.*` (owners only,
`packages/studio-protocol/src/terminals.ts`). Tests: `src/main/agent-launch-service.test.ts`.

**Project knowledge folder** (Settings ▸ Knowledge; the folder a launch points its agent at): the setting
`projectKnowledgeRoots` in `src/renderer/src/store/slices/knowledgeSlice.ts` and
`src/renderer/src/components/settings/ProjectKnowledgeList.tsx`; resolved by `src/main/knowledge-root.ts`
and `src/shared/project-knowledge.ts`, and named to the agent in the host-context document's knowledge
section (`src/shared/host-context/document.ts`). Wire: `knowledge.resolveRoot` (`agent-setup`,
`packages/studio-protocol/src/agent-setup.ts`). Tests: `src/shared/host-context/document.test.ts`,
`src/renderer/src/store/slices/knowledgeSlice.test.ts`.

## The MCP gateway (agents' tools)

**Studio's MCP server**: dispatch in `src/main/automation/mcp-dispatch.ts`, the socket in
`src/main/automation/mcp-socket-server.ts`, the core's tools composed in `src/server/core/studio-gateway.ts`,
the desktop's in `src/main/automation/desktop-gateway-tools.ts`; mutation classes in
`src/main/automation/studio-gateway-tools.ts`, what a paired device may call in
`src/main/automation/tailnet/tailnet-scopes.ts`. The listed tools are recorded in
`src/main/automation/__fixtures__/gateway-tools-list.json` (`UPDATE_GATEWAY_TOOLS_FIXTURE=1`). Doc:
`docs/connecting-an-mcp-client.md`. Tests: `src/main/automation/gateway-tools-parity.test.ts`,
`src/main/automation/tailnet/tailnet-device-mcp-reach.test.ts`.

**Agent-to-chat tools** (`conversation.send`, `.read`, `.wait`, `.interrupt`): `src/main/automation/conversation-chat-tools.ts`;
`conversation.create`, `.settle` and the rest in `src/main/automation/conversation-tools.ts`.
Tests: `src/main/automation/conversation-chat-tools.test.ts`, `src/main/automation/conversation-tools.test.ts`.

## Worktrees

**Worktree pool** (`worktree.lease`, Settings ▸ Worktrees): `src/main/worktree-pool/worktree-pool-service.ts`
(lease `pool-lease.ts`, return `pool-return.ts`, give-back `pool-idle.ts`), wired in
`src/server/core/studio-worktree-pool.ts`; the agent worktree cleanup in `src/main/agent-worktree-cleanup.ts`,
scheduled by `src/renderer/src/hooks/useAgentWorktreeCleanup.ts`; Settings in
`src/renderer/src/components/settings/WorktreesSettingsTab.tsx`. Wire: `worktrees.*`
(`packages/studio-protocol/src/worktrees.ts`). Doc: `docs/design/worktree-pool.md`.
Tests: `src/main/worktree-pool/worktree-pool-service.test.ts`, `src/main/agent-worktree-cleanup.test.ts`.

## Other machines

**Paired machines and devices over the tailnet**: `src/main/automation/tailnet/` (gateway server, devices,
mesh), the window's side in `src/renderer/src/components/remote/` and
`src/renderer/src/components/settings/RemoteTailnetSettingsTab.tsx`; a paired desktop's chats through
`src/renderer/src/components/panels/agentChat/pairedChat.ts`. Doc: `docs/conversations.md` ("Remote
connection over the tailnet"), `docs/compatibility.md`. Tests: `src/main/automation/tailnet/tailnet-device-reach.test.ts`,
`tests/cross-client/`.

**SSH machines**: `src/main/environments/ssh/` (`ssh-environments.ts`, `ssh-connect-script.ts`), Settings in
`src/renderer/src/components/settings/SshMachinesSection.tsx`. Doc: `docs/ssh-machines-checklist.md`.

**WSL distributions**: `src/main/hosts/` (`wsl-host.ts`, `wsl-install.ts`), `src/server/wsl/`. Doc:
`docs/wsl-server-checklist.md`, `docs/conversations.md` ("Chats on a WSL machine").

**Environments** (another Studio's chats shown here): `src/main/environments/environment-registry.ts`,
`src/server/environment/`. Tests: `tests/cross-client/`.

**The phone app**: its own package in `mobile/` (`mobile/README.md`), chats in
`mobile/src/features/conversations/`, the protocol client in `mobile/src/api/`. Gate: `npm run ci` inside `mobile/`.

**Web client** (a browser tab on a Studio): served by `src/server/web/` (`web-front-door.ts`, `web-listener.ts`),
the browser build's shims in `src/renderer/src/web/`; embedded chats in `src/renderer/src/web/embed/`
(doc `docs/embedding-a-conversation.md`).

## The Studio server and protocol

**Studio core and server**: `src/server/core/studio-core.ts` (what a Studio holds), `src/server/core/studio-rpc.ts`
(what it serves), the router `src/server/rpc/studio-rpc-router.ts` and welcome `src/server/rpc/studio-rpc-server.ts`;
methods, scopes and capabilities in `packages/studio-protocol/src/` (`methods.ts`, `handshake.ts`, `scopes.ts`).
Doc: `docs/design/studio-server.md`, `docs/compatibility.md`. Tests: `src/seams/studioRpcSeam.test.ts`,
`src/server/studio-server.smoke.test.ts`, the cross-client gate (`scripts/cross-client-gate.mjs`).

**Files by path** (Files pane, editor, palette): `src/server/files/studio-file-system.ts`,
`src/server/rpc/studio-file-system.ts`, the window's client `src/renderer/src/studio/files.ts`.
Wire: `files.*` (`packages/studio-protocol/src/file-system.ts`).

**Git and pull requests**: `src/server/git/studio-git.ts`, `src/server/pull-requests/`, the panel
`src/renderer/src/components/panels/GitPanel.tsx`. Doc: `docs/design/agent-changes.md`.

**The data folder's database** (`studio.sqlite` in each data folder): opening, the worker connections and the damaged-file and
folder errors in `src/server/db/database.ts`, chat history (logs, receipts, the one-time import of old transcripts) in
`src/server/db/chat-logs.ts`, the chat records (the workspace registry's rows) in `src/main/workspace-registry-store.ts`,
stores kept whole as one row (schedules, scheduled messages, usage-limit resumes) in `src/server/db/snapshot-storage.ts`,
the layout in `src/server/db/migrations.ts`, the one copy in
`src/server/db/copies.ts`, the format steps and their imports in `src/server/environment/data-format.ts` and
`src/server/db/import-files.ts`. Doc: `docs/data-folder.md`. Tests: `src/server/db/database.test.ts`,
`src/server/db/import-files.test.ts`, `src/server/db/chat-logs.test.ts`, `src/server/environment/data-format.test.ts`.

## Panes beside the chat

**Editor pane** (and `editor.open`): `src/renderer/src/components/panels/EditorPanel.tsx`,
`src/main/automation/editor-tools.ts`. Tests: `src/renderer/src/components/panels/EditorPanel.diskSync.test.tsx`,
`src/main/automation/editor-tools.test.ts`.

**Workspace pane** (tabs, browser, canvas, documents): `src/renderer/src/components/workspace/pane/WorkspacePane.tsx`.

**Browser pane**: `src/main/browser/`, agents' tools in `src/main/automation/browser-tools.ts`.
Doc: `docs/design/browser-recording.md`.

**Canvas boards**: `src/main/canvas/canvas-service.ts`, `src/server/canvas/canvas-domain.ts`,
`src/main/automation/canvas-tools.ts`. Doc: `docs/design/canvas-pane.md`.

**Backlog**: `src/main/backlog-service.ts`, `src/server/backlog/backlog-domain.ts`, the panel
`src/renderer/src/components/panels/BacklogPanel.tsx`. Doc: `docs/backlog-item-schema.md`.

## Running on its own

**Processes agents started** (dev servers, headless browsers, anything left running): read from the machine's
processes by the identity agents pass down, in `src/server/processes/` (`agent-process-scan.ts` says what is a row,
`agent-process-reader.ts` reads `ps` and `lsof`, or the proc filesystem on Linux, `agent-process-domain.ts` lists and stops). Wire:
`processes.*` (`packages/studio-protocol/src/processes.ts`). Tests: `src/server/processes/agent-process-scan.test.ts`,
`src/server/processes/agent-process-domain.test.ts`, `src/server/rpc/studio-processes.test.ts`.
Built-in browser tabs in the same list (`browserTabs.*`): listed and closed by `src/main/browser/browser-manager.ts`
(`listAllTabs`, `requestClose`), served through `src/server/processes/browser-tabs.ts`; tabs unused for a day are closed
by `src/main/browser/browser-tab-auto-close.ts`. Tests: `src/main/browser/browser-tab-auto-close.test.ts`,
`src/main/browser/browser-manager-tab-list.test.ts`.

**Scheduled agents**: `src/main/scheduled-agents/` (`scheduler.ts`, `service.ts`), `src/server/schedules/schedules-domain.ts`.
Wire: `schedules.*`. Tests: `src/main/scheduled-agents/scheduled-agents.test.ts`.

## Extending Studio

**Extensions** (installing, switching on, the door): `src/main/modules/`, `src/main/module-host/`,
`src/server/extensions/extensions-domain.ts`, the door
`src/renderer/src/components/workspace/globalSurface/extensions/ExtensionsGlobalSurface.tsx`; the SDK in
`packages/extension-sdk/` (CLI, templates, guide). Wire: `extension.*` (`packages/studio-protocol/src/modules.ts`,
capability `extension-host`). Doc: `docs/extension-authors/`, `docs/compatibility.md` ("The extension host API").

**The manifest** (`extension.json`: id, tier, permissions, `main`, `contributes`): the one validator
`packages/extension-sdk/src/extension-manifest.ts` (the field table, tiers in `manifest-schema.ts`), the
shipped `packages/extension-sdk/extension.schema.json`, the guide's `packages/extension-sdk/guide/manifest.md`;
Studio reads it through `src/shared/modules/third-party-manifest.ts`. Tests:
`packages/extension-sdk/test/extension-manifest.test.ts`.

**Approvals and the host gate** (what an extension may call, and who for): every call an extension makes
into Studio passes `src/main/module-host/extension-host-gate.ts`, against the table in
`packages/extension-sdk/src/services.ts` (permissions in `permissions.ts`) and the invoker in
`src/main/module-host/extension-invocation.ts`. Approvals: `src/main/modules/extension-approvals.ts` (an installed extension's bound to its files, a development folder's to
its folder and access), the review `src/renderer/src/components/settings/ApprovalReviewDialog.tsx`. Wire: `extension.approve`. Doc:
`docs/extension-authors/permissions.md`. Tests: `src/main/module-host/main-host.gate.test.ts`,
`src/main/modules/extension-approvals.test.ts`.

**Extension frames** (a panel, door, settings section or custom editor drawn in a sandboxed frame, on every client): the
document in `src/server/extensions/frames/` (`frame-document.ts`, `frame-bootstrap.ts`, the web listener's
`frame-route.ts`), the desktop shell's `src/main/extension-frames/extension-frame-shell.ts`, the window's bridge
`src/renderer/src/modules/extension-frame-host.ts` and mount
`src/renderer/src/components/extensions/ExtensionSurfaceMount.tsx`; a frame's host calls in
`src/main/module-host/extension-frame-calls.ts`; the entry contract in `packages/extension-sdk/src/frame.ts`.
Wire: `extension.frame`, `extension.call`, `extension.contributions` (capability `extension-frames`). Tests:
`src/server/extensions/frames/frame-document.test.ts`, `src/renderer/src/modules/extension-frame-host.test.ts`,
`src/main/module-host/extension-frame-calls.test.ts`.

**Components panels** (a panel with `"ui": "components"`: its module renders a tree of Studio's components, which the
window checks and draws with its own controls, on every client but the phone): the module a panel imports,
`packages/extension-sdk/src/components/` (atoms, `setup`, the host facades, the catalogue and its limits in
`catalog.ts`, the tree check in `tree.ts`, the guest's `ui.*` messages in `messages.ts`); bundled for the frame by
`scripts/build-components-runtime.mjs` into `src/server/extensions/frames/components-runtime.generated.ts` and booted
by `src/server/extensions/frames/frame-bootstrap.ts`; drawn by the window's
`src/renderer/src/components/extensions/components/` (`ComponentsPanelHost.tsx`, the run in
`componentsPanelSession.ts`, the edit protocol in `componentValue.ts`, the stationary rule in `componentGestures.ts`);
persisted atoms kept by `src/main/module-host/extension-panel-atoms.ts` behind the frame methods `atoms.read`,
`atoms.write` (`src/main/module-host/extension-frame-calls.ts`). The testing kit
`packages/extension-sdk/src/testing-components.ts` (`mountPanel`, `defineCheck`), `check`'s child
`packages/extension-sdk/src/check-panel.ts`, and a shot drawn by `src/main/extension-frames/extension-shot.ts`
(the window's side of the run in `components-shot-exchange.ts`, the tree drawn by
`src/renderer/src/components/extensions/components/ComponentsShotApp.tsx`). Wire:
`extension.frame`, `extension.call` (capability `extension-frames`). Guide
`packages/extension-sdk/guide/components.md`; template `packages/extension-sdk/templates/components/`; sample
`packages/extension-sdk/examples/components-sample/`. Tests: `packages/extension-sdk/test/components-runtime.test.ts`,
`packages/extension-sdk/test/components-tree.test.ts`, `packages/extension-sdk/test/components-testing.test.ts`,
`packages/extension-sdk/test/components-sample.test.ts`, `src/server/extensions/frames/components-frame.test.ts`,
`src/main/module-host/extension-panel-atoms.test.ts`,
`src/renderer/src/components/extensions/components/componentsPanelSession.test.ts`,
`src/renderer/src/components/extensions/components/componentGestures.test.ts`.

**Custom editors** (an extension's editor for files of a type, in the file's tab, with a document session): the
contribution in `packages/extension-sdk/src/extension-manifest.ts` and which editor takes a file in
`packages/extension-sdk/src/custom-editors.ts`; the frame's `studio.document` in
`packages/extension-sdk/src/editor-document-script.ts` (inlined by `src/server/extensions/frames/frame-bootstrap.ts`);
the window's choice of editor `src/renderer/src/modules/extension-editors.ts`, its document session
`src/renderer/src/modules/extension-editor-session.ts`, drawn by
`src/renderer/src/components/extensions/ExtensionEditorView.tsx` and
`src/renderer/src/components/extensions/EditorViewPicker.tsx` from
`src/renderer/src/components/panels/EditorPanel.tsx`; reads and saves through `files.*` in
`src/main/module-host/extension-files.ts`. Wire: `extension.frame` (`point: customEditors`), `extension.call`
(capability `extension-editors`). Sample: `packages/extension-sdk/examples/todo-editor/`; template
`packages/extension-sdk/templates/editor/`. Tests: `packages/extension-sdk/test/custom-editors.test.ts`,
`src/renderer/src/modules/extension-editor-session.test.ts`, `src/renderer/src/modules/extension-editors.test.ts`.

**What extensions hand agents** (an extension's skills, MCP servers and model providers, `contributes.skills`,
`.mcpServers`, `.providers`): the points and their shared rules in `packages/extension-sdk/src/extension-manifest.ts`
and `packages/extension-sdk/src/agent-contributions.ts`; checked at install in
`src/server/extensions/agent-contributions/install-checks.ts`; projected (skill copies, servers, providers, restart-safe)
by `src/server/extensions/agent-contributions/projection.ts`, reconciled from `src/main/modules/module-lifecycle.ts`
after every install, approval, switch and uninstall and at every start; what a local server or a provider asks for in
`src/main/modules/extension-approvals.ts`. Reach: terminal launches in `src/main/integrations/launch-integration.ts`,
Claude Code and Codex chats in `src/main/providers/claude-agent-provider.ts` and
`src/main/providers/codex-conversation-provider.ts` (through `src/main/conversation-runtime.ts`), providers in
`src/main/plugin-registry.ts` and `src/main/plugin-registry-instance.ts`, their keys in `src/main/secret-store.ts`, their
requests held to the base URL's origin in `src/main/providers/openai-compatible-provider.ts`. Review:
`src/renderer/src/components/settings/ApprovalReviewDialog.tsx` and `ExtensionRow.tsx`, through
`src/renderer/src/components/settings/extensionContributions.ts`. Template `packages/extension-sdk/templates/agent-kit/`.
Tests: `src/server/extensions/agent-contributions/projection.test.ts`, `packages/extension-sdk/test/agent-contributions.test.ts`,
`src/main/integrations/launch-integration.test.ts`, `src/main/providers/extension-provider-key.test.ts`,
`src/main/modules/extension-approvals.test.ts`.

**Extension workers** (an extension's `main`, in a process of its own): `src/server/extensions/workers/`
(`worker-manager.ts`, `worker-process.ts`, the fork's own `worker-entry.ts`, its environment in
`worker-env.ts`; its TypeScript loaded as written by `packages/extension-sdk/src/source-hooks.ts`). Tests: `src/server/extensions/workers/worker-lifecycle.test.ts`,
`src/server/extensions/workers/worker-invocations.test.ts`.

**Studio's events for extensions** (a worker's `contributes.events` and `studio.events.on`, a surface's `studio.on`):
the events, their permissions and payloads in `packages/extension-sdk/src/events.ts` (the manifest field in
`packages/extension-sdk/src/extension-manifest.ts`); read off Studio's workspaces, terminals and agents by
`src/server/extensions/events/studio-events.ts` and carried by `src/server/extensions/events/extension-events.ts`
(wired in `src/server/core/studio-core.ts`, bound to the workers in `src/server/desktop/server-modules.ts` and
`src/main/app-main.ts`); delivered to a worker by `src/server/extensions/workers/worker-manager.ts` (`deliverEvent`)
and `worker-entry.ts`; to a surface through the frame method `events.subscribe`
(`src/main/module-host/extension-frame-calls.ts`), the window's `src/renderer/src/modules/extension-frame-host.ts`
and `src/renderer/src/components/extensions/ExtensionSurfaceMount.tsx`, and the connection's
`extension.studioEvents` (`src/server/rpc/studio-rpc-connection.ts`); the window's own typography in
`src/renderer/src/modules/extension-editor-typography.ts`. Wire: `extension.studioEvents`
(`packages/studio-protocol/src/modules.ts`); the dev loop fires one at a development folder's extension with
`extension.dev.studioEvent` (`src/main/automation/extension-dev-tools.ts`). Guide
`packages/extension-sdk/guide/events.md`. Tests:
`src/server/extensions/events/extension-events.test.ts`, `src/server/rpc/studio-modules.test.ts`,
`src/main/module-host/main-host.gate.test.ts`, `src/renderer/src/modules/extension-frame-host.test.ts`.

**Terminals for extensions** (`terminals:send`, `terminals:read`, a worker's `getTerminalService`): the SDK's
`packages/extension-sdk/src/terminals.ts`; the host's `src/main/module-host/extension-terminals.ts` (built over the
core's terminals in `src/server/core/studio-core.ts`, provided by `src/main/modules/agent-runtime-module.ts`), its
gate rows in `packages/extension-sdk/src/services.ts`; closed on uninstall and kill by
`src/main/modules/module-lifecycle.ts` (`removing`), let go on switch-off by the workers' `released`. Guide
`packages/extension-sdk/guide/events.md`. Tests: `src/main/module-host/extension-terminals.test.ts`,
`src/main/module-host/main-host.gate.test.ts`, `src/server/extensions/worker-revocation.test.ts`,
`src/server/rpc/studio-extension-browser.test.ts` (an owner's browser tab is refused them).

**The extension dev loop** (no build step; a development folder loaded where it is and again on every save; the
`sprintengine-extension` CLI): source as written in `packages/extension-sdk/src/source-modules.ts` (a surface's
types, JSX and relative imports, gathered by `src/main/modules/extension-surface-entries.ts` `readSurfaceModules`
into the frame document of `src/server/extensions/frames/frame-bootstrap.ts`) and
`packages/extension-sdk/src/source-hooks.ts` (a worker's types, installed by
`src/server/extensions/workers/worker-entry.ts`). Development folders in `src/main/modules/extension-dev-folders.ts`,
loaded after the installed extensions by `src/main/modules/user-module-registry.ts` and registered through
`src/main/modules/module-lifecycle.ts` (`devLoad`, `devUnload`, `devFolders`); a save heard by
`src/server/extensions/dev/dev-folder-watch.ts`, read once per change by
`src/server/extensions/extension-discovery.ts` (that folder alone on a save), and loaded live, as an install or an
approval is, by `src/server/extensions/extension-reload.ts`; what happened kept in `src/server/extensions/dev/dev-events.ts`. Their
approval: `devFolderApprovalFingerprint` in `src/main/modules/extension-approvals.ts` and
`classifyDevelopmentExtension` in `src/main/modules/module-signature.ts`; asked of the person by the window's
`src/renderer/src/components/settings/DevFolderApprovalHost.tsx` and shown by
`src/renderer/src/components/settings/ThirdPartyModuleList.tsx` and
`src/renderer/src/components/settings/ApprovalReviewDialog.tsx`, added from
`src/renderer/src/components/settings/addThirdPartyModuleFromFolder.ts`; surfaces redrawn on a `revision` by
`src/renderer/src/modules/extension-contributions.tsx`. The CLI: `packages/extension-sdk/src/cli.ts` (usage),
`cli-commands.ts`, `cli-authoring.ts` (`validate`, `inspect`, `test`, `check`, with `check-worker.ts`), `cli-dev.ts`
(`dev …`, `shot`), `cli-output.ts` (`--json`, error and exit codes) and `cli-studio.ts` (the gateway's local socket).
Installing, updating and opening a published extension from outside the window: the CLI's
`packages/extension-sdk/src/cli-install.ts` (`install`, `update`, `open`), sources read by
`packages/extension-sdk/src/install-source.ts`, the tools in `src/main/automation/extension-install-tools.ts`
(`extension.install`, `extension.update`, `extension.open`) over the catalogue's `installKey`, `installFrom` and
`updateNow` (`src/server/extensions/catalogue/extension-catalogue.ts`); a waiting install asked of the person by
`DevFolderApprovalHost.tsx` (`reviewAsked`); a panel or an editor shown in a window (`src/shared/extension-open.ts`)
by `src/main/extension-open-broker.ts` (one window at a time, never raised), over the control channel out of
process (`src/server/extensions/extension-open-bridge.ts`), and in the window by
`src/renderer/src/hooks/useExtensionOpenRequests.ts` (`src/renderer/src/modules/extension-open-plan.ts`). Tests:
`src/main/extension-open-broker.test.ts`, `src/server/extensions/extension-open-bridge.test.ts`,
`src/renderer/src/modules/extension-open-plan.test.ts`, `packages/extension-sdk/test/cli-install.test.ts`,
`packages/extension-sdk/test/install-source.test.ts`, `src/main/automation/extension-install-tools.test.ts`,
`src/server/extensions/catalogue/extension-catalogue.test.ts`.
Agents' tools: `src/main/automation/extension-dev-tools.ts` (`extension.dev.*`, held to their caller by
`bindDevToolsToCaller`, bound in `src/server/core/studio-gateway.ts`) and
`src/main/automation/extension-shot-tool.ts` (`visual.extension_shot`), drawn by
`src/main/extension-frames/extension-shot.ts`. Wire: `extension.devFolders`, `extension.devLoad`,
`extension.devUnload` (an owner's), a contribution's `revision`, an installed view's `development`
(`packages/studio-protocol/src/modules.ts`). Templates `packages/extension-sdk/templates/`; guide
`packages/extension-sdk/guide/dev-loop.md` and `packages/extension-sdk/guide/start.md`; the agents' skill
`resources/studio-plugin/sprintengine-studio/skills/studio-extensions/SKILL.md`. Tests:
`packages/extension-sdk/test/source-modules.test.ts`, `packages/extension-sdk/test/cli-authoring.test.ts`,
`packages/extension-sdk/test/cli-dev.test.ts`, `src/server/extensions/extension-discovery.test.ts`,
`src/main/modules/extension-dev-folders.test.ts`, `src/server/extensions/extension-reload.test.ts`,
`src/main/automation/extension-dev-tools.test.ts`, `src/main/modules/extension-surface-entries.test.ts`,
`src/server/extensions/workers/worker-entry.test.ts`.

**The extension catalogue** (browsing, installing from a catalogue entry or a git URL, updates, the kill
list, install links): the format, its schema and the release entry in
`packages/extension-sdk/src/catalogue.ts` (`catalogue.schema.json`, guide `packages/extension-sdk/guide/catalogue.md`),
a commit's folder written out in `packages/extension-sdk/src/git-source.ts`, the CLI's
`packages/extension-sdk/src/release-entry.ts`. Studio's side in `src/server/extensions/catalogue/`:
`extension-catalogue.ts` (the checks, installs, updates and views, hung off the lifecycle in
`src/main/modules/module-lifecycle.ts`), `catalogue-checkout.ts`, `catalogue-fetch.ts` (the addresses Studio
reads, `EXTENSION_CATALOGUE_BASE`), `catalogue-files.ts` (what it keeps in the data folder), `kill-list.ts`
and `claude-plugin-extension.ts`; a killed version is held back in `src/main/modules/module-signature.ts`. The
page: `src/renderer/src/components/settings/ExtensionCatalogueBrowse.tsx` and the git URL dialog
`src/renderer/src/components/settings/GitInstallDialog.tsx`, from
`src/renderer/src/components/settings/ModulesSettingsTab.tsx`, over `windowCatalogueLifecycle` in
`src/renderer/src/studio/moduleLifecycle.ts` (a browser tab too); notices kept for a client that was away in
`src/server/rpc/studio-modules.ts`; install links in
`src/shared/extension-install-link.ts` and `src/main/extension-link-router.ts`. Wire: `extension.catalogues`,
`extension.catalogueEntry`, `extension.catalogueImage`, `extension.catalogueAdd`, `extension.catalogueRemove`,
`extension.installFrom`, `extension.update` (`packages/studio-protocol/src/modules.ts`). Tests:
`packages/extension-sdk/test/catalogue.test.ts`, `src/server/extensions/catalogue/extension-catalogue.test.ts`,
`src/shared/extension-install-link.test.ts`, `src/main/extension-link-router.test.ts`,
`src/renderer/src/components/settings/ModulesSettingsTab.test.tsx`, `src/renderer/src/studio/moduleLifecycle.test.ts`.

**Agent hooks** (an extension's worker checks, changes or refuses what agents and Studio are about to do): the
points in `packages/extension-sdk/src/hooks.ts`, the chain in `src/server/extensions/hooks/extension-hooks.ts`
(who each runs as in `hook-invokers.ts`), served by `src/server/extensions/workers/worker-manager.ts` (`runHook`);
wired at a Claude Code chat's tool calls (`src/main/providers/claude-agent-provider.ts`, through
`src/main/conversation-runtime.ts`), launches at one door per runtime (a chat's first session in
`src/main/conversation-runtime.ts`, a terminal's spawn in `src/server/extensions/hooks/launch-hooks.ts`), every
message nobody typed at the runtime's `sendTurn` (`hookAs`, set by each of Studio's own senders), terminal agents'
prompts and raw writes (`src/server/extensions/hooks/control-plane-hooks.ts`) and a tour's prompt
(`src/main/tours/tour-service.ts`), new workspaces (`src/main/conversation-launch-service.ts`, before a new chat's
worktree is cut, and `src/server/extensions/hooks/workspace-hooks.ts`) and editor saves
(`src/server/rpc/studio-file-system.ts`). Wire: `files.writeText` `save`. Sample:
`packages/extension-sdk/examples/tool-guard/`; template `packages/extension-sdk/templates/hook-guard/`; guide
`packages/extension-sdk/guide/hooks.md`. Tests: `src/server/extensions/hooks/extension-hooks.test.ts`,
`src/server/extensions/hooks/launch-hooks.test.ts`, `src/main/conversation-runtime-hooks.test.ts`,
`src/main/providers/claude-agent-provider-extension-hooks.test.ts` (and its opt-in `.live.test.ts` against the real
CLI).

**Content contributions** (syntaxes, keybindings, status bar items, settings; no approval needed): checked by
`packages/extension-sdk/src/content-syntaxes.ts`, served by `src/main/modules/extension-content.ts` and
`src/main/modules/extension-declared-settings.ts`; drawn by `src/renderer/src/lib/highlight/contributedSyntaxes.ts`,
`src/renderer/src/modules/extension-contributions.tsx` (keybindings, status bar items) and
`src/renderer/src/components/extensions/ExtensionSettingsForm.tsx`. Wire: `extension.content`,
`extension.settings`, `extension.setSetting`. Sample: `packages/extension-sdk/examples/content-sample/`. Tests:
`packages/extension-sdk/test/content-contributions.test.ts`, `src/main/modules/extension-content.test.ts`.

**A command that takes over a Studio action** (`replaces` in `contributes.commands`): the field and its action list
in `packages/extension-sdk/src/extension-manifest.ts`; counted as access in `src/main/modules/extension-approvals.ts`;
which extension wins, and the loser's log line, in `src/main/modules/extension-replacement-log.ts`; run in the window,
with Studio's own after 2 s or a failure, by `src/renderer/src/modules/extension-replacements.ts`, from the command
paths of `src/renderer/src/components/workspace/WorkspaceManager.tsx`; shown in
`src/renderer/src/components/settings/ApprovalReviewDialog.tsx`. Tests:
`src/renderer/src/modules/extension-replacements.test.ts`, `src/main/modules/extension-replacement-log.test.ts`,
`src/main/modules/extension-approvals.test.ts`, `packages/extension-sdk/test/extension-manifest.test.ts`.

**Skills and plugins**: `src/main/skills/`, `src/server/agent-setup/`, `src/main/marketplace/` (Claude Code
plugins from the marketplace). Doc: `resources/marketplace/README.md`.

**Artifacts** (published pages): `src/main/artifacts/`. Doc: `docs/design/artifacts.md`.

## The app around it

**Settings**: `src/renderer/src/components/settings/SettingsPanel.tsx`, one tab per file beside it.

**Usage**: `src/main/usage/usage-service.ts`, `src/renderer/src/components/usage/UsageDashboard.tsx`.

**Design system** (every visual change): `design-system/` (`design-system/USAGE.md`, one
`component.md` per component), the app's tokens in `src/renderer/src/assets/index.css`, primitives in
`src/renderer/src/components/ui/`. Lints: `scripts/lint-design-tokens.mjs` and the others `npm run lint` runs.

**Words the app shows**: `src/shared/copy/en.ts` (`npm run report:copy`).
