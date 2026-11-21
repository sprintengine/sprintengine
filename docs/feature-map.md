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

**New chat**: `src/renderer/src/components/workspace/agentComposer/NewAgentPanel.tsx`; the launch
in `src/main/conversation-launch-service.ts`. Wire: `conversation.create` (capability `conversation-create`).
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
card in `src/renderer/src/components/panels/agentChat/fileView/FileViewCard.tsx`. Wire: `fileViews.*`
(capability `file-views`, `packages/studio-protocol/src/file-views.ts`). Doc: `docs/conversations.md`
("Files shown in the chat"). Tests: `src/server/file-views/file-views.test.ts`,
`src/renderer/src/components/panels/agentChat/fileView/FileViewCard.test.tsx`.

**Sub-agents** (a chat's agents as chats of their own): `src/main/subagent-lifecycle.ts`,
`src/main/automation/subagent-tools.ts`; in the view `src/renderer/src/components/panels/agentChat/SubagentChatHost.tsx`
and `subagentStatus.tsx`; the list's rows in `chatSubagents.tsx`. A finished one is given another
task in its same CLI session with `subagent.resume`, and its row counts the rounds. Doc: `docs/conversations.md`
("Subagents as full chats"). Tests: `src/main/automation/subagent-tools.test.ts`,
`src/server/core/subagent-resume.test.ts` (a resume end to end, through the host and the runtime).

**Plugin offers in a chat** (`plugin.offer`): `src/main/automation/plugin-tools.ts`,
`src/renderer/src/components/panels/agentChat/pluginOffer/PluginOfferCard.tsx`.
Tests: `src/main/automation/plugin-tools.test.ts`.

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

**Scheduled agents**: `src/main/scheduled-agents/` (`scheduler.ts`, `service.ts`), `src/server/schedules/schedules-domain.ts`.
Wire: `schedules.*`. Tests: `src/main/scheduled-agents/scheduled-agents.test.ts`.

## Extending Studio

**Extensions and modules**: `src/main/modules/`, `src/main/module-host/`, `src/server/extensions/extensions-domain.ts`,
the door `src/renderer/src/components/workspace/globalSurface/extensions/ExtensionsGlobalSurface.tsx`;
the SDK in `packages/module-sdk/`. Doc: `docs/module-authors/`, `docs/compatibility.md` ("The module
host API").

**Skills and plugins**: `src/main/skills/`, `src/server/agent-setup/`. Doc: `docs/plugin-authors/README.md`.

**Artifacts** (published pages): `src/main/artifacts/`. Doc: `docs/design/artifacts.md`.

## The app around it

**Settings**: `src/renderer/src/components/settings/SettingsPanel.tsx`, one tab per file beside it.

**Usage**: `src/main/usage/usage-service.ts`, `src/renderer/src/components/usage/UsageDashboard.tsx`.

**Design system** (every visual change): `design-system/` (`design-system/USAGE.md`, one
`component.md` per component), the app's tokens in `src/renderer/src/assets/index.css`, primitives in
`src/renderer/src/components/ui/`. Lints: `scripts/lint-design-tokens.mjs` and the others `npm run lint` runs.

**Words the app shows**: `src/shared/copy/en.ts` (`npm run report:copy`).
