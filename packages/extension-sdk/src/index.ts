// @sprintengine/extension-sdk — the published contract surface external authors
// compile against when building SprintEngine Studio capability modules.
//
// The repository is the consumer-of-record: a drift guard inside the studio
// repo (packages/extension-sdk/drift/sdk-drift-guard.ts) type-checks that these
// declarations stay equivalent to (or sound narrowings of) the in-app
// contracts, and that mirrored value exports stay identical. The SDK never
// imports application code, so the published tarball is self-contained.
//
// Some shapes are deliberately narrowed for external publication (for
// example, run-glyph providers receive a minimal input view rather than the
// shell's internal workspace shape). Every narrowing is listed in README.md.

import type { UsageQuery, UsageQueryResult } from './activity.js'
import type {
  BacklogWatchOptions,
  ModuleBacklogCreated,
  ModuleBacklogCreateInput,
  ModuleBacklogLinkInput,
  ModuleBacklogLocation,
  ModuleBacklogResult,
  ModuleBacklogTriageInput,
} from './backlog.js'
import type { ModuleChatRuntimeOption, ModuleOpenChatInput, ModuleOpenChatResult } from './conversation.js'
import type { HostCapability } from './host-api.js'

// ── Manifest ─────────────────────────────────────────────────────────────────

export type CapabilityCategory =
  'core' | 'dev-tools' | 'vcs' | 'orchestration' | 'insight' | 'connectivity' | (string & {})

export type ModuleSource = 'bundled' | 'third-party'

/** Detached ed25519 signature over the canonical manifest (signature field excluded). */
export type ModuleSignature = {
  algorithm: 'ed25519'
  publicKey: string
  signature: string
}

/**
 * sha256 digests of an extension's own files: POSIX path relative to its root
 * → lowercase hex. Covers every regular file under the root but
 * `extension.sig`, and nothing else — a file on disk that is not listed is as
 * much a mismatch as a listed file whose bytes changed.
 */
export type ModuleFileDigests = Record<string, string>

/** A plugin bundle's base manifest (`plugin.json`). An extension's own is `ExtensionManifest`. */
export type CapabilityManifest = {
  id: string
  displayName: string
  version: number
  publisher?: string
  category?: CapabilityCategory
  summary?: string
  /** Whether the module loads when the user has expressed no preference. */
  defaultEnabled: boolean
  /** Core modules are always enabled. Third-party modules must not set this. */
  core?: boolean
  /** Capability ids this module needs loaded (and enabled) before it can load. */
  dependsOn?: string[]
  /** Capability ids that must not be enabled at the same time as this one. */
  conflictsWith?: string[]
  /** Provenance. Absent ⇒ bundled first-party. Installed modules are 'third-party'. */
  source?: ModuleSource
  /** Permission scopes requested (install-time disclosure, not runtime enforcement). */
  permissions?: string[]
  signature?: ModuleSignature
}

/** Trust classification: only 'trusted' modules are eligible to execute code. */
export type ModuleTrustStatus = 'trusted' | 'signed' | 'unsigned' | 'invalid'

// ── Permissions (install-time disclosure vocabulary) ─────────────────────────

export { KNOWN_CAPABILITY_PERMISSIONS, type CapabilityPermission } from './permissions.js'

// ── Notifications ────────────────────────────────────────────────────────────

export type ModuleNotificationSeverity = 'info' | 'warning' | 'error'

/**
 * The door a bell row opens: one of YOUR global surfaces (the id you passed
 * `registerGlobalSurface`), and optionally one of its `views` to land on. The
 * host refuses a surface another module registered, so a row can only ever
 * open its own module's door.
 */
export type ModuleNotificationTarget = {
  surfaceId: string
  viewId?: string
}

/** What a module passes to `host.notify(...)`; identity and time are stamped by the host. */
export type ModuleNotifyInput = {
  severity: ModuleNotificationSeverity
  /** One line. Non-empty; clipped at 200 characters. */
  title: string
  /** Clipped at 2000 characters. */
  body?: string
  /**
   * Make the row open your door: clicking its Open lands the person on
   * `surfaceId` (and `viewId`, given). The row is also counted on that door's
   * Extensions drawer row and read when the door is opened.
   */
  target?: ModuleNotificationTarget
}

export type ModuleNotification = {
  /** Stamped by the host kernel from the emitting module's scope. */
  sourceModuleId: string
  severity: ModuleNotificationSeverity
  title: string
  body?: string
  /** The door the row opens, when the module named one. */
  target?: ModuleNotificationTarget
  /** Epoch ms at emission, assigned by the kernel. */
  emittedAt: number
}

// ── Module events (main → renderer) ──────────────────────────────────────────

/**
 * The wire shape of one event, as `MainHost.emit` stamps it and the host
 * delivers it. Your module never constructs or receives this directly —
 * `emit(topic, payload)` builds it and `RendererHost.subscribe(topic, cb)`
 * hands `cb` the payload alone — but it is published so the routing contract is
 * inspectable: identity and time are the host's, topic and payload are yours.
 */
export type ModuleEventEnvelope = {
  /** Stamped by the host kernel from the emitting module's scope. */
  sourceModuleId: string
  /** Module-chosen event name. Scoped to the module, so it needs no prefix. */
  topic: string
  /** Structured-cloneable payload; absent for a bare signal. */
  payload?: unknown
  /** Epoch ms at emission, assigned by the kernel. */
  emittedAt: number
}

// ── The worker's studio (`main`, `activate(studio)`) ─────────────────────────

// ── Declared methods ─────────────────────────────────────────────────────────
// What your worker serves your window code (and any client the person
// granted it) over the Studio protocol: a typed contract per method, a
// validator for its params and a handler (`MainHost.registerMethods`), called
// through `RendererHost.methods<Contract>()`. Host API 2 replaced host API 1's
// IPC channels (`registerIpc` / `invoke`) with these.
//
//   type Board = {
//     'cards.list': { access: 'read'; params: { column: string }; result: Card[] }
//     'cards.add': { access: 'operate'; params: { title: string }; result: Card; errors: 'duplicate' }
//   }
//   host.registerMethods<Board>({ 'cards.list': { access: 'read', params: readColumn, handler: list }, … })
//   const board = rendererHost.methods<Board>()
//   const answer = await board.operate('cards.add', { title: 'Ship it' })
//   if (!answer.ok) rendererHost.toast({ title: answer.message, tone: 'error' })

export type {
  ModuleCallAnswer,
  ModuleCallRefusalCode,
  ModuleMethodAccess,
  ModuleMethodAnswer,
  ModuleMethodContext,
  ModuleMethodContract,
  ModuleMethodContracts,
  ModuleMethodErrorCode,
  ModuleMethodParsed,
  ModuleMethodRegistration,
  ModuleMethodRegistrations,
  ModuleMethodsClient,
  ModuleOperateMethod,
  ModuleReadMethod,
} from './methods.js'
import type { ModuleMethodContracts, ModuleMethodRegistrations, ModuleMethodsClient } from './methods.js'
export { MODULE_METHOD_MAX_CHARS, isModuleMethodName } from './methods.js'

export type StartupHook = () => void | Promise<void>
export type ShutdownBeginHook = () => void | Promise<void>
export type ShutdownHook = () => void | Promise<void>

/** Typed handle for a service one module provides and others require. */
export type ServiceToken<T> = { readonly key: string; readonly __type?: T }

export function createServiceToken<T>(key: string): ServiceToken<T> {
  return { key }
}

export type SidecarSpec = {
  id: string
  /** e.g. 'process'. Free-form; the host interprets it. */
  kind: string
  /** Entry point or executable, depending on kind. */
  module?: string
  description?: string
  /**
   * When the host spawns the sidecar: 'startup' (default) starts it during
   * app startup in registration order; 'demand' leaves spawning to the owner
   * (for lazily-started daemons). Only meaningful when the host manages the
   * sidecar's lifecycle.
   */
  startOn?: 'startup' | 'demand'
}

export type SidecarRunState = 'declared' | 'stopped' | 'starting' | 'running' | 'failed'

export type SidecarStartOptions = {
  /** Merged into the child env for this start only (e.g. a per-start token). */
  env?: Record<string, string>
}

export type SidecarRuntimeStatus = {
  id: string
  moduleId: string
  kind: string
  description?: string
  state: SidecarRunState
  error?: string
}

/**
 * Handle returned by `registerSidecar`. The host does not spawn a module's
 * sidecar: a registration is a declaration, so `start` refuses it and
 * `status()` reports `'declared'`.
 */
export type SidecarHandle = {
  start(options?: SidecarStartOptions): Promise<void>
  stop(): Promise<void>
  status(): SidecarRuntimeStatus
}

// ── MCP tools on the Studio gateway ─────────────────────────────────

/** A normal MCP tool result; `isError: true` marks a tool-domain failure. */
export type McpToolResult = {
  // Text, or an image part (a browser snapshot, base64 PNG/JPEG) the client
  // renders inline — the MCP `image` content shape.
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/**
 * Who is calling over the gateway.
 *
 * `studio-agent`/`external-local` arrive on the owner-only local socket.
 * There the identity is a claim — whatever has filesystem access can declare
 * an agent of its choosing — unless the connection presented the launch token
 * Studio issued that agent's launch, which proves it (`verified: true`). `remote-tailnet`
 * arrives on the opt-in tailnet listener, where the transport proved which
 * paired device is calling before dispatch — `deviceId`, `deviceName`, and
 * `peerNode` are set by the app, not by the caller.
 *
 * A chat Studio launched always connects with its launch token, so its calls
 * arrive as `kind: 'studio-agent'`, `verified: true`, with `workspaceId` and
 * `agentId` always set. `agentName` (the chat's display name) and `cliId` (the
 * runtime id, the same ids `listChatRuntimes()` lists) are set whenever the
 * launch recorded them, which a chat started from the app always does; an
 * agent from a plain terminal declares whatever it likes and stays
 * `verified: false`.
 */
export type McpConnectionMetadata = {
  kind: 'studio-agent' | 'external-local' | 'remote-tailnet'
  workspaceId?: string
  agentId?: string
  agentName?: string
  cliId?: string
  deviceId?: string
  deviceName?: string
  peerNode?: string
  /**
   * True when a launch token or the tailnet transport PROVED the identity
   * above; false when it is only declared. The host sets it on every call to
   * your tool (`host.supports('mcp-verified-identity')`); a host older than
   * this field leaves it out, so read a missing value as false. Label
   * authorship as verified only on `true`.
   */
  verified?: boolean
}

export type McpConnectionContext = {
  metadata: McpConnectionMetadata
}

/**
 * One MCP tool contributed to the always-on Studio gateway. `inputSchema` is a
 * JSON Schema object; array-typed fields must stay arrays end to end. Tool
 * names are a public contract for agents — pick stable names of your own, in a
 * family named for your module (`decisions.record`, `decisions_list`).
 *
 * The gateway serves the name verbatim. MCP clients that take no dot write
 * `a_b` for `a.b`, so names are compared in that form: a name that matches a
 * core gateway tool (`backlog_list` vs the core's `backlog.list`), falls in one
 * of the shell's families (`browser`, `canvas`, `editor`, `tour`, `terminal`),
 * or matches another module's tool is a registration error that names the
 * conflict. The core families (`agent`, `backlog`, `conversation`, `schedule`,
 * `workspace`, `worktree`, `module`, `marketplace`, `tailnet`, `studio`,
 * `sprintengine`, `app`, …) are reserved: new core tools land in them, so keep
 * out of them even where no tool collides today.
 */
export type McpToolRegistration = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /**
   * Declares that the tool CHANGES state. The Studio gateway reads it for two
   * decisions: a remote (tailnet) caller must hold `<family>:operate` rather
   * than the read-only `<family>:read` to invoke it, and every call — including
   * one refused for want of that scope — is written to the gateway audit with
   * the calling device. `false` means a read: advertised to every paired
   * device on the read scope and not audited.
   *
   * Omitted counts as a change: a tool from an installed module is treated as
   * `mutates: true` unless it says `mutates: false`. Declare `false` only on a
   * tool that genuinely reads — never on one that writes to disk, spawns a
   * process, or reconfigures the machine.
   */
  mutates?: boolean
  handler: (args: Record<string, unknown>, context?: McpConnectionContext) => Promise<McpToolResult>
}

// ── Skills in a workspace ────────────────────────────────────────────────────

/**
 * Every status the host's skill installer answers with, so you can switch on
 * it exhaustively:
 *
 * - `installed` — present and current (written by the app, or nothing to write).
 * - `updated` — `ensureSkillInstalled` replaced an older copy it had written.
 * - `missing` — not in the workspace yet (`getSkillStatus` only; `ensure…` installs it).
 * - `update-available` — present, but older than the copy your module ships
 *   (`getSkillStatus` only; `ensure…` updates it).
 * - `local` — a copy the app did not write is in the way; it is left alone.
 * - `modified` — the app's copy was edited by hand; it is left alone.
 * - `delivered-at-launch` — nothing is written to the workspace: a launch that
 *   asks for this skill is handed it as a plugin of its own (a built-in skill
 *   on a CLI whose launch carries the app's plugin directories).
 * - `missing-source` — the skill's own files are gone from the module or app.
 * - `missing-workspace` — no workspace root was given.
 * - `unknown-skill` — no built-in or registered module skill has that id.
 * - `install-failed` — the write itself failed; `message` says why.
 */
export type ModuleSkillStatus =
  | 'installed'
  | 'updated'
  | 'missing'
  | 'update-available'
  | 'local'
  | 'modified'
  | 'delivered-at-launch'
  | 'missing-source'
  | 'missing-workspace'
  | 'unknown-skill'
  | 'install-failed'

/**
 * The answer to "is this skill present in that workspace now?".
 *
 * `ok` is "an agent launched in that workspace now would find the skill":
 * true for `installed`, `updated`, `update-available`, `local`, `modified` and
 * `delivered-at-launch`; false for `missing` and every failure. `status` tells
 * "we wrote it" from "a hand-made copy is in the way" from "nobody has ever
 * heard of this skill".
 */
export type EnsureSkillInstalledResult = {
  ok: boolean
  status: ModuleSkillStatus
  message?: string
}

/** What `getSkillStatus` answers: the same shape, read without writing anything. */
export type ModuleSkillStatusResult = EnsureSkillInstalledResult

/**
 * The `studio` object the worker's `activate` is handed: what it may ask of
 * Studio, and the two things it registers at runtime, its methods and the
 * handlers of the MCP tools its extension.json declares.
 */
export type MainHost = {
  /** Your install key (`<publisher>.<id>`); stamped by the host. */
  readonly moduleId: string
  /**
   * Whether the running host provides `capability` now. False for names it
   * does not know, so a module may probe for capabilities newer than its SDK.
   */
  supports(capability: HostCapability): boolean
  /**
   * The agent runtimes a chat can run on, as `RendererHost.listChatRuntimes`
   * lists them for your window half: each runtime's id (what a conversation's
   * and a scheduled agent's `cli`, and a companion's `engine.cli`, take), its
   * label, its models and whether it is the person's last choice. A runtime
   * this machine does not have is listed with `available: false`. Reading it
   * may probe which CLIs are installed (cached for a minute), so read it when
   * you need it rather than in a loop. Needs no permission. Check
   * `host.supports('chat-runtimes')`: an older host has no such method.
   */
  listChatRuntimes(): Promise<ModuleChatRuntimeOption[]>
  /**
   * Declare the methods your window code (and each client the person granted
   * `extensions:read` / `extensions:operate`) calls: each with its access (`read`
   * or `operate`, the only way it is called), a validator for its params and
   * a handler answering `{ ok: true, result }` (JSON) or its own
   * `{ ok: false, code, message }`. Names are a lower-case letter, then
   * letters, digits, dots and dashes; your module id is their namespace. The
   * whole batch is validated before one of it lands; a name you already
   * declared, a missing validator or a bad name throws. Unloading your module
   * takes its methods with it. Declare the `module:bridge` permission.
   * Replaces host API 1's `registerIpc`.
   */
  registerMethods<Cs extends ModuleMethodContracts = ModuleMethodContracts>(
    methods: ModuleMethodRegistrations<Cs>,
  ): void
  /**
   * Serve the MCP tools your extension.json declares (`contributes.mcpTools`)
   * on Studio's MCP server. A tool your manifest does not declare is refused,
   * and the manifest's `description` and `access` are what agents see, whatever
   * the registration says. A tool name another extension already registered,
   * or one that collides with a core gateway tool (see `McpToolRegistration`
   * for the rule), is a registration error naming the conflict (the whole
   * batch is rejected). Availability follows the extension's enablement live:
   * a disabled extension's tools stay listed and answer calls with an
   * actionable enable error instead of running.
   */
  registerMcpTools(tools: McpToolRegistration[]): void
  /**
   * Make a skill present in a workspace now, rather than at the next agent
   * launch — how you pre-install the skill an agent will be told to invoke.
   * Works for the app's own skills. Never throws; an unknown id
   * answers `{ ok: false, status: 'unknown-skill' }`.
   */
  ensureSkillInstalled(workspaceRoot: string, skillId: string): Promise<EnsureSkillInstalledResult>
  /**
   * Whether a skill is present in a workspace, WITHOUT writing anything — the
   * read half of `ensureSkillInstalled`, for a door that shows "installed in
   * this project" before the person asks for the install. Same vocabulary:
   * `missing` and `update-available` are the two states `ensure…` would act on.
   * Never throws. Check `host.supports('skill-status')` first.
   */
  getSkillStatus(workspaceRoot: string, skillId: string): Promise<ModuleSkillStatusResult>
  /**
   * Your module's private directory under the app's per-user data
   * (`<userData>/module-data/<moduleId>`), created on demand and removed when
   * the module is uninstalled. For data past module storage's 1 MB value
   * limit — caches, indexes, downloaded blobs — laid out however you like.
   * It is per user and per machine, never synced, and outside every project.
   * Disclosed under the `storage` permission. Throws when the host has no
   * storage service (check `host.supports('module-data-dir')`).
   */
  getModuleDataDir(): string
  /**
   * The absolute path of a file packaged inside your module — the main-side
   * twin of `RendererHost.getAssetUrl`, for what Node wants a path for:
   * `new Worker(host.getAssetPath('dist/worker.cjs'))`, a WASM file, a data
   * table. Only a file the module was verified with resolves, and only while
   * its bytes still match: anything else (an unlisted file, traversal, a
   * leading slash, a file changed since install) throws. Worker threads
   * loaded this way are supported; list every file they load in the build so
   * it is signed with the rest. Check `host.supports('main-asset-path')`.
   */
  getAssetPath(relativePath: string): string
  /**
   * A workspace's checked-out branch and remotes, each remote with
   * `owner/repo` when it is on GitHub — so a VCS-aware module stops parsing
   * `.git` → gitdir → commondir → config itself, and needs no
   * `filesystem:read-workspace` to do it. Declare `ipc:workspace-read`
   * (checked: `permission_missing` without it). Never throws. The renderer
   * twin is `RendererHost.getWorkspaceGitInfo`. Check
   * `host.supports('workspace-git-info')` first.
   */
  getWorkspaceGitInfo(workspaceId: string): Promise<ModuleWorkspaceGitInfoResult>
  /**
   * Read one key of your module's APP-level state from the worker — the
   * same namespace your Settings section's `setValue` and
   * `RendererHost.setModuleAppState` write, as the windows last pushed it.
   * Persisted, so it reads with no window open: a scheduler in the worker
   * sees the run time the person chose without a second store and an IPC
   * sync. Read-only (main never writes it back); a value set while no window
   * was open arrives with the next window. `undefined` when the key has never
   * been set. Never put a secret here — use the secrets service.
   * Check `host.supports('main-app-state')` first.
   */
  getModuleAppState<T = unknown>(key: string): T | undefined
  /**
   * Hear your module's whole app-state namespace whenever it changes — a
   * Settings change in whichever window — not on subscribe (read the current value
   * with `getModuleAppState`). Returns the unsubscriber; unloading your module
   * drops it too. The worker's twin of `RendererHost.watchModuleAppState`.
   */
  watchModuleAppState(cb: (values: Readonly<Record<string, unknown>>) => void): () => void
  provideService<T>(token: ServiceToken<T>, factory: (host: MainHost) => T): T
  getService<T>(token: ServiceToken<T>): T | undefined
  requireService<T>(token: ServiceToken<T>): T
  onStartup(hook: StartupHook): void
  /**
   * Run early, before the host tears down shared infrastructure. Use it to stop
   * self-scheduled loops and flip a shutting-down flag so no new work is
   * dispatched during teardown; defer awaiting in-flight work to `onShutdown`.
   * Begin hooks run in registration order, opposite `onShutdown`.
   */
  onShutdownBegin(hook: ShutdownBeginHook): void
  onShutdown(hook: ShutdownHook): void
  /**
   * Declare a sidecar this module owns. The registration is a declaration:
   * the host lists it but does not spawn it (only first-party modules hand the
   * host a lifecycle).
   */
  registerSidecar(spec: SidecarSpec): SidecarHandle
  /**
   * Put a row in the notification bell of every open window, under your
   * module's display name (stamped by the host — never taken from you). The
   * bell is for what went wrong: only `warning` and `error` reach it, and an
   * `info` notify files nothing (say routine news with a renderer `toast`). Give
   * it a `target` and its Open lands on your door; add more actions with a
   * renderer `registerNotificationActionProvider({ source: <your module id> })`.
   * Invalid input throws. Flood-bounded per module: an identical repeat within
   * 10 s, or more than 20 rows in 10 s, is dropped — fold a burst into one row.
   * A row sent while no window is open is kept (the last 50) and filed when
   * one opens. `supports('notifications')` is false where nothing would show it.
   */
  notify(input: ModuleNotifyInput): void
  /**
   * Push an event to your module's renderer half — the subscribe verb your
   * declared methods do not have. The receiving end is
   * `RendererHost.subscribe(topic, cb)`.
   *
   * Identity is stamped from this host's scope, so only your module's
   * subscribers receive it and you can never emit as another module. An empty
   * or over-128-character topic throws. The payload rides the Studio
   * protocol's `extension.events` stream and must be a JSON value (plain objects,
   * arrays, strings, finite numbers, booleans, null); anything else (a Date, a
   * Map, NaN, a cycle) throws here, naming where.
   *
   * Delivery contract:
   * - **Fan-out** — one emit reaches every client following the stream; it has
   *   no addressing, so per-window state is yours to key on.
   * - **Ordering** — FIFO per module: a `started` never lands after its `done`.
   * - **No replay** — an event emitted with no window open is dropped, and a
   *   window opened later sees nothing earlier. Events are signals, not state:
   *   keep the durable answer readable through an IPC channel and let events
   *   say "read it again". A subscriber must be correct having missed every
   *   event before it subscribed.
   * - **No flood bound** — unlike `notify`, nothing is dropped for rate;
   *   emitting sanely is your module's responsibility.
   */
  emit(topic: string, payload?: unknown): void
}

// ── Workspace service (host-provided, consumed via the service bridge) ────────

export type WorkspaceCreateInput = {
  /** Workspace display name. */
  name?: string
  /** Absolute folder to open in the workspace. */
  folderPath?: string
  /** Layout template id; defaults to the standard template when omitted. */
  templateId?: string
}

export type WorkspaceCreateResult = { ok: true; workspaceId: string } | { ok: false; code: string; message: string }

/**
 * Programmatic workspace creation, provided by the app core. A creation runs
 * the same renderer flow the UI uses and is confirmed on the workspace-sync bus
 * before it resolves, so the returned id is always a real, observed workspace.
 */
export type WorkspaceService = {
  create(input: WorkspaceCreateInput): Promise<WorkspaceCreateResult>
}

/**
 * Resolve with `studio.requireService(WorkspaceServiceToken)` from the
 * worker. Provided by Studio's agent runtime, which starts
 * ahead of every extension's worker, so `activate` may resolve it at once.
 */
export const WorkspaceServiceToken: ServiceToken<WorkspaceService> =
  createServiceToken<WorkspaceService>('core.workspace')

/**
 * Read-only workspace snapshot: the id → root/name/mode resolution modules
 * need for per-workspace persistence keys and scoped services. A snapshot,
 * not a subscription — live session/workspace observation is a separate
 * surface.
 */
export type ModuleWorkspaceView = {
  id: string
  name: string
  /**
   * Absolute folder the workspace opened (its primary checkout); null for
   * folderless workspaces. Note for worktree-backed workspaces (a scheduled
   * agent's run on a worktree, and whatever else a module opens): the agents work
   * in a git worktree under this folder — this snapshot deliberately reports the
   * durable project root (the right base for persistence and scoped services),
   * not the transient worktree.
   */
  folderPath: string | null
  /** Workspace type id ('standard' or a module-registered type). */
  mode: string
}

/**
 * One workspace as `WorkspaceContextService.list` reports it: the view, plus
 * whether it is open now. With `includeClosed`, workspaces closed on this
 * machine are listed after the open ones, newest first, as they were when
 * they closed; their folders may since have moved or gone.
 */
export type ModuleWorkspaceListEntry = ModuleWorkspaceView & {
  open: boolean
  /** When a closed workspace was closed (epoch ms); absent while it is open. */
  closedAt?: number
}

export type ModuleWorkspaceListOptions = {
  /**
   * Also list the workspaces closed on this machine (the most recent 500),
   * so a module can tie what it kept — a transcript in the project's store,
   * its own storage — back to a project no longer open.
   * Check `host.supports('workspace-history')` first.
   */
  includeClosed?: boolean
}

/** A git remote of a workspace's repository, as `git remote -v` names it (fetch URL). */
export type ModuleWorkspaceGitRemote = {
  name: string
  /** The fetch URL, with credentials (a token in the userinfo) removed. */
  url: string
  /** `owner/repo` when the remote is a GitHub repository, SSH host aliases resolved. */
  github?: string
}

export type ModuleWorkspaceGitInfoErrorCode =
  | 'permission_missing'
  | 'unknown_workspace'
  | 'no_folder'
  | 'not_a_repository'
  // The folder is on another machine, or the host has no git reader wired yet.
  | 'unavailable'
  | 'git_failed'

/**
 * A workspace's checked-out branch (null on a detached HEAD) and its remotes,
 * read by git from the workspace's own folder — so a worktree reports its own
 * branch and a submodule its own repository, and a remote whose SSH host is an
 * alias for github.com in ~/.ssh/config still carries `github`. (`Match`
 * blocks and `Include`d files are not followed when resolving an alias.)
 */
export type ModuleWorkspaceGitInfoResult =
  | { ok: true; branch: string | null; remotes: ModuleWorkspaceGitRemote[] }
  | { ok: false; code: ModuleWorkspaceGitInfoErrorCode; message: string }

/**
 * Resolve a workspace id to its read-only view from the worker. A null
 * resolution means "not currently resolvable" — an unknown id, or workspace
 * state that has not re-hydrated yet (e.g. right after app launch). Never a
 * throw, and never a deletion signal: retry later instead of discarding
 * per-workspace state. Declare the `ipc:workspace-read` permission
 * (install-time disclosure). The renderer twin is `RendererHost.getWorkspace`.
 */
export type WorkspaceContextService = {
  get(workspaceId: string): Promise<ModuleWorkspaceView | null>
  /**
   * Every workspace currently open, in registry order. The main-side twin of
   * `RendererHost.listWorkspaces`, and the only way the worker can answer
   * "which project roots are open" — an MCP tool your module contributes runs
   * with no window and no renderer to ask. Each entry says `open: true`;
   * with `includeClosed`, the workspaces closed on this machine follow, newest
   * first, with `open: false` and `closedAt`.
   */
  list(options?: ModuleWorkspaceListOptions): Promise<ModuleWorkspaceListEntry[]>
}

/**
 * Resolve with `studio.requireService(WorkspaceContextToken)` from the
 * worker. Provided by Studio's agent runtime, which starts
 * ahead of every extension's worker, so `activate` may resolve it at once.
 */
export const WorkspaceContextToken: ServiceToken<WorkspaceContextService> =
  createServiceToken<WorkspaceContextService>('core.workspace-context')

// ── Scheduled agents (host-provided, consumed via the service bridge) ────────

/** The machine a scheduled agent runs on: this computer, or one of its WSL distributions. */
export type ScheduledAgentHostId = 'local' | `wsl:${string}`

export type ScheduledAgentSchedule = {
  /** Five-field cron; several expressions separated by `;`. */
  cron: string
  /** The IANA zone the cron's wall-clock is read in. */
  timezone: string
  /**
   * One run, at this instant (epoch ms), instead of the cron's repeats. The
   * cron then names the same minute. Once its run has started a chat, the
   * scheduled agent is closed.
   */
  once?: number
}

/** A skill or an installed MCP server, by id, with the name its chip shows. */
export type ScheduledAgentAttachment = { id: string; name: string }

/**
 * Whether the last run started its chat. `workspaceId` and `agentId` name that
 * chat (a conversation ref your conversation service reaches); `agentId` is
 * absent on a run recorded by a host from before it was kept.
 */
export type ScheduledAgentLastRun =
  { at: number; ok: true; workspaceId: string; agentId?: string } | { at: number; ok: false; message: string }

/** A run whose chat started: when, and the chat (a conversation ref) it started. */
export type ScheduledAgentRun = { at: number; workspaceId: string; agentId: string }

/**
 * A scheduled agent: a prompt and a schedule. Each time the schedule comes
 * round, a new chat starts in `folderPath` with `prompt` as its first message,
 * on the machine, CLI, model, permissions, skills, MCP servers and worktree
 * setting recorded here. Nothing carries from one run to the next.
 *
 * When a time is missed:
 * - **The app was closed.** A repeating schedule's missed times are not
 *   replayed; the next run is counted from when the app starts. A one-time
 *   schedule whose time passed while the app was closed runs once, as soon as
 *   the app is open again.
 * - **The computer slept, with the app open.** The schedule runs once on
 *   waking, however many of its times passed in the sleep.
 * - **The previous run is still working** (a turn open, or waiting on an
 *   approval), or still starting. The time is skipped, not queued: the next
 *   one counts on from it.
 * - **The person paused it** (`pausedAt`), or paused every scheduled agent
 *   for a while. Its times pass without a run, and are not made up when it
 *   resumes: it runs next at its first time after that. `nextRunAt` is null
 *   while it is paused.
 *
 * Each run's chat is owned by the module that created the scheduled agent, so
 * its conversation service reaches it (`onRun` names the chat), and its
 * summary carries `scheduledAgentId` and `scheduledAgentTag`.
 */
export type ScheduledAgent = {
  id: string
  /**
   * Its title in the person's sidebar and editor (up to 120 characters).
   * Absent, the prompt's first line is. Check
   * `host.supports('scheduled-agent-runs')`.
   */
  name?: string
  /**
   * Your own label for it (up to 200 characters; the item, task or record it
   * belongs to), never shown to the person. Each run's chat carries it as
   * `ModuleConversationSummary.scheduledAgentTag`, so you can tell which of
   * your schedules a chat came from without putting markers in the prompt.
   * Check `host.supports('scheduled-agent-runs')`.
   */
  tag?: string
  prompt: string
  schedule: ScheduledAgentSchedule
  folderPath: string
  hostId: ScheduledAgentHostId | null
  cli: string
  cliModel: string | null
  /**
   * `bypass` skips every prompt; `auto` lets edits in the project through and
   * asks before commands and anything outside it; `manual` asks before every
   * edit, command and outside call; `none` passes no flag, so the CLI's own
   * configuration decides. Null follows the preset the person chose for that
   * CLI, read at run time.
   */
  permissionPreset: 'none' | 'manual' | 'auto' | 'bypass' | null
  skills: ScheduledAgentAttachment[]
  mcpServers: ScheduledAgentAttachment[]
  /** A fresh worktree per run, named from this; null runs in the project's checkout. */
  worktree: { name: string } | null
  /** The module that created it; the SDK service stamps it and only that module reaches it. */
  ownerModuleId: string | null
  createdAt: number
  updatedAt: number
  lastRun: ScheduledAgentLastRun | null
  lastFailureSeenAt: number | null
  /**
   * When the person paused it in the app; absent while it runs on its
   * schedule. A run already going when it was paused carries on, and
   * `runNow` still starts one. Absent on a host older than pausing.
   */
  pausedAt?: number
}

/**
 * What a module writes: everything but the bookkeeping. On `update`, a draft
 * without `name` or `tag` keeps the ones the scheduled agent has, and an empty
 * string clears it.
 */
export type ScheduledAgentDraft = Pick<
  ScheduledAgent,
  | 'name'
  | 'tag'
  | 'prompt'
  | 'schedule'
  | 'folderPath'
  | 'hostId'
  | 'cli'
  | 'cliModel'
  | 'permissionPreset'
  | 'skills'
  | 'mcpServers'
  | 'worktree'
>

/** A scheduled agent as listed: the record plus when it runs next (epoch ms). */
export type ScheduledAgentView = ScheduledAgent & {
  nextRunAt: number | null
  /**
   * Why the machine it lives on cannot run it now, in words: its times pass
   * without a run, which is not a failure, until the machine has what it
   * lacks. Absent when it can run.
   */
  waiting?: string
}

export type ScheduledAgentWriteResult = { ok: true; agent: ScheduledAgentView } | { ok: false; message: string }

/**
 * Scheduled agents for an extension's worker, obtained via
 * `getScheduledAgentsService(host)`. Every method is pre-scoped to your
 * module: `create` stamps it as the owner, `list` returns only the ones it
 * owns, and every other call refuses an id it does not own as if the id did
 * not exist. Declare the `scheduled-agents.manage` permission (install-time
 * disclosure). Studio starts the service ahead of every extension's worker.
 */
export type ModuleScheduledAgentsService = {
  create(draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  update(id: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  remove(id: string): Promise<{ ok: true } | { ok: false; message: string }>
  list(): Promise<ScheduledAgentView[]>
  /** Start a run now, without waiting for the schedule. */
  runNow(id: string): Promise<{ ok: true; run: ScheduledAgentLastRun } | { ok: false; message: string }>
  /** Called with this module's scheduled agents whenever one of them changes. Returns the unsubscriber; call it in `onShutdown`. */
  onChanged(listener: (agents: ScheduledAgentView[]) => void): () => void
  /**
   * Called each time one of this module's scheduled agents starts a chat, on
   * its schedule or by `runNow`, with the scheduled agent as it ran and the
   * chat (`run.workspaceId`, `run.agentId`: follow it with the conversation
   * service). A one-time schedule is told before it closes itself, so its run
   * is heard although `onChanged` never lists it again. A run that failed to
   * start is not a run; `lastRun` says why. Returns the unsubscriber; call it
   * in `onShutdown`. Check `host.supports('scheduled-agent-runs')`: an older
   * host never calls it.
   */
  onRun(listener: (agent: ScheduledAgentView, run: ScheduledAgentRun) => void): () => void
}

type ScheduledAgentsModuleRegistry = {
  create(moduleId: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  update(moduleId: string, id: string, draft: ScheduledAgentDraft): Promise<ScheduledAgentWriteResult>
  remove(moduleId: string, id: string): Promise<{ ok: true } | { ok: false; message: string }>
  list(moduleId: string): Promise<ScheduledAgentView[]>
  runNow(
    moduleId: string,
    id: string,
  ): Promise<{ ok: true; run: ScheduledAgentLastRun } | { ok: false; message: string }>
  onChanged(moduleId: string, listener: (agents: ScheduledAgentView[]) => void): () => void
  // Absent on a host from before scheduled-agent-runs.
  onRun?(moduleId: string, listener: (agent: ScheduledAgentView, run: ScheduledAgentRun) => void): () => void
}

const scheduledAgentsModuleServiceToken: ServiceToken<ScheduledAgentsModuleRegistry> =
  createServiceToken<ScheduledAgentsModuleRegistry>('scheduled-agents.module-service')

/**
 * The scoped scheduled agents service for `host`'s module. The raw host
 * registry is moduleId-first; this binds `host.moduleId` so a module cannot
 * reach another's scheduled agents or the person's own.
 */
export function getScheduledAgentsService(host: MainHost): ModuleScheduledAgentsService {
  const registry = host.requireService(scheduledAgentsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    create: (draft) => registry.create(moduleId, draft),
    update: (id, draft) => registry.update(moduleId, id, draft),
    remove: (id) => registry.remove(moduleId, id),
    list: () => registry.list(moduleId),
    runNow: (id) => registry.runNow(moduleId, id),
    onChanged: (listener) => registry.onChanged(moduleId, listener),
    onRun: (listener) => (registry.onRun ? registry.onRun(moduleId, listener) : () => {}),
  }
}

// ── Companion agents (host-provided, consumed via the service bridge) ─────────

/**
 * A companion agent's status: the conversation-session vocabulary plus
 * `absent` — never spawned, or already disposed (not present in the projection).
 */
export type CompanionAgentStatus =
  'starting' | 'ready' | 'active' | 'awaiting_approval' | 'stopped' | 'failed' | 'absent'

/**
 * A canonical conversation event as delivered to a companion's `onEvent`.
 * Secret-shaped payload keys are redacted before delivery. `type` is widened to
 * `string` so new app event kinds never break compiled modules.
 */
export type CompanionAgentEvent = {
  id: string
  /** Order within the session; absent only on events recorded before the host stamped one. */
  seq?: number
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  type: string
  createdAt: number
  payload?: Record<string, unknown>
}

export type CompanionAgentSpec = {
  workspaceId: string
  /** Stable, module-chosen id (e.g. 'review-guide'); the projection key. */
  agentId: string
  /** Display name in the Sessions popover. */
  name: string
  /** Absolute workspace folder (the main process has no id → folder registry). */
  workspaceRoot: string
  /**
   * Engine selection. `cli` takes the chat runtime id a conversation's `cli`
   * takes and `listChatRuntimes()` lists (`claude-code`, `codex`, `cursor`,
   * `opencode`, `grok`, `kimi-code`), or the conversation provider id behind it
   * (`claude-agent`, `codex-agent`, …): both name the same engine, so one id
   * space covers chats and companions. Absent, Claude Code on `sonnet`; another
   * engine without a `model` runs its own default model. A runtime id needs
   * `host.supports('companion-tools')`; an older host takes provider ids only.
   */
  engine?: { cli?: string; model?: string }
  /** Advisory context roots; the provider resolves knowledge from workspaceRoot. */
  contextRoots?: { knowledge?: boolean }
  /** Standing instructions, delivered as a preamble on the first turn. */
  systemPrompt: string
}

export type CompanionValidateResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export type CompanionRunStructuredOptions<T> = {
  prompt: string
  validate: (raw: unknown) => CompanionValidateResult<T>
  /** Validator errors are fed back to the agent and the turn retried. Default 1. */
  retries?: number
  onPhase?: (phase: string) => void
  /**
   * What the run does when its agent asks to use a tool (an edit, a command,
   * a web request, an MCP tool; a companion session asks before every one):
   *
   * - `none` (the default): the host denies every request, and tells the
   *   agent before your prompt that it has no tools for this task. Use it for
   *   anything fed text you did not write (logs, PR comments, transcripts):
   *   whatever that text says, the agent can only answer.
   * - `ask`: requests stay open for the person. They arrive in `onEvent` as
   *   `approval_requested`; show them, and relay the person's answer with
   *   `respondToApproval`. The run waits until each is answered (or you
   *   `interrupt`).
   * - `auto`: the host approves every request, which is as loose as a chat on
   *   `bypass`. Needs the `conversation:bypass` permission: without it the run
   *   is refused (the promise rejects, naming the permission), and it is
   *   refused too while your module serves an MCP tool call from an agent that
   *   asks before acting.
   *
   * Check `host.supports('companion-tools')`: an older host ignores `tools`
   * and approves every request.
   */
  tools?: 'none' | 'ask' | 'auto'
}

/**
 * An answer to one approval request the companion's agent raised: allow it
 * once, or deny it. A rule that outlives the request is the person's to make.
 */
export type CompanionApprovalAnswer = { requestId: string; decision: 'once' | 'deny' }

export type CompanionAgentHandle = {
  readonly workspaceId: string
  readonly agentId: string
  /** Folds from the same conversation-session projection the Sessions popover reads. */
  status(): CompanionAgentStatus
  onStatus(cb: (status: CompanionAgentStatus) => void): () => void
  /** Run a structured JSON task: extract final JSON, validate, retry-once, return typed. */
  runStructured<T>(opts: CompanionRunStructuredOptions<T>): Promise<T>
  /**
   * A chat turn on the session's own transport. Its approvals are left open,
   * as a structured run's with `tools: 'ask'` are.
   */
  send(message: string): Promise<void>
  /**
   * Relay the person's answer to an approval request that is still open (an
   * `approval_requested` event's `requestId`): one from a `tools: 'ask'` run
   * or from a `send` turn. Never answer on the person's behalf. Allowing
   * (`once`) needs the `conversation:operate` permission, as answering an
   * approval in a chat does; without it a request can only be denied.
   * Answers `{ ok: false }` for a request that is not open. Check
   * `host.supports('companion-tools')`.
   */
  respondToApproval(input: CompanionApprovalAnswer): Promise<{ ok: true } | { ok: false; message: string }>
  onEvent(cb: (event: CompanionAgentEvent) => void): () => void
  interrupt(): void
  /** Ends the session; the handle becomes inert. Re-attach spawns a fresh one. */
  dispose(): void
}

/**
 * Workspace-bound background agents for an extension's worker, obtained via
 * `getCompanionAgentsService(host)`. `attach` NEVER spawns — it returns a handle
 * in `absent` status; the first `runStructured`/`send` (a live user intent)
 * spawns, so reopening a workspace never auto-starts a companion. A second
 * `attach` with the same (workspaceId, agentId) returns the SAME handle.
 *
 * Declare the `agents:companion` permission (the service checks it at attach
 * time and throws if absent). Studio starts the service ahead of every
 * extension's worker.
 */
export type CompanionAgentsService = {
  attach(spec: CompanionAgentSpec): CompanionAgentHandle
}

type CompanionAgentsRegistry = {
  attach(moduleId: string, spec: CompanionAgentSpec): CompanionAgentHandle
}

const companionAgentsModuleServiceToken: ServiceToken<CompanionAgentsRegistry> =
  createServiceToken<CompanionAgentsRegistry>('companion-agents.module-service')

/**
 * The scoped Companion Agents service for `host`'s module. The raw host registry
 * takes a module id on every call; this helper closes over `host.moduleId`
 * exactly like `getScheduledAgentsService`.
 */
export function getCompanionAgentsService(host: MainHost): CompanionAgentsService {
  const registry = host.requireService(companionAgentsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    attach: (spec) => {
      const handle: Omit<CompanionAgentHandle, 'respondToApproval'> &
        Partial<Pick<CompanionAgentHandle, 'respondToApproval'>> = registry.attach(moduleId, spec)
      if (handle.respondToApproval) return handle as CompanionAgentHandle
      // A host older than `companion-tools` has no answer to give; say so
      // rather than leave the module a TypeError.
      return Object.assign(handle, {
        respondToApproval: () =>
          Promise.resolve({
            ok: false as const,
            message: `This version of the app has no "respondToApproval"; check host.supports('companion-tools').`,
          }),
      })
    },
  }
}

// ── Module storage (host-provided, consumed via the service bridge) ──────────

export type ModuleStorageErrorCode =
  'invalid_key' | 'invalid_value' | 'value_too_large' | 'invalid_workspace_root' | 'io_error'

export type ModuleStorageResult<T> = ({ ok: true } & T) | { ok: false; code: ModuleStorageErrorCode; message: string }

/**
 * Per-module, per-workspace JSON storage, scoped to your module by
 * `getModuleStorage(host)`. The host owns file placement — workspace-scoped
 * keys live in the project's store in the person's home
 * (`~/.sprintengine/workspaces/<project>/modules/<moduleId>/`, one per project
 * whichever checkout asks), global keys under the app's per-user data — so modules stop inventing
 * locations (home-dir files, raw localStorage). Keys match
 * `^[a-z0-9][a-z0-9._-]{0,63}$`; values must be JSON-serializable and at most
 * 1 MB; writes are atomic (write-then-rename). Pass `workspaceRoot` (absolute;
 * resolve it via the workspace context) for workspace-scoped keys, omit it for
 * the module's global store. Declare the `storage` permission (install-time
 * disclosure). Renderer panels reach storage through the module's own
 * declared methods (`MainHost.registerMethods`).
 *
 * Workspace-scoped keys are not in the project's folder, so they never show
 * in its `git status` and do not travel with a clone; data that belongs to
 * the project is a file the module writes where the person asks. (Builds
 * before the store kept them in `<project>/.sprintengine/modules/<moduleId>/`;
 * the host moves them out once, leaving each file git tracks where it is.)
 * Data past the 1 MB value limit — caches, blobs, indexes — belongs
 * in `MainHost.getModuleDataDir()` instead.
 */
export type ModuleStorageService = {
  /** `found: false` (with `value: undefined`) when the key has never been set. */
  get(input: { key: string; workspaceRoot?: string }): Promise<ModuleStorageResult<{ value: unknown; found: boolean }>>
  set(input: { key: string; value: unknown; workspaceRoot?: string }): Promise<ModuleStorageResult<object>>
  delete(input: { key: string; workspaceRoot?: string }): Promise<ModuleStorageResult<{ deleted: boolean }>>
  /**
   * Keys in the scope, sorted; an empty store lists `[]`, never an error.
   * With `prefix`, only the keys that start with it (`decision.` lists one
   * record family). `prefix` needs `host.supports('storage-query')`.
   */
  list(input?: { workspaceRoot?: string; prefix?: string }): Promise<ModuleStorageResult<{ keys: string[] }>>
  /**
   * Read up to 1000 keys in one call. `values` holds the keys that are set; a
   * key never set is simply absent. A corrupt record fails the whole call
   * (`io_error` naming the key), exactly as `get` would.
   * Check `host.supports('storage-query')` first.
   */
  getMany(input: {
    keys: string[]
    workspaceRoot?: string
  }): Promise<ModuleStorageResult<{ values: Record<string, unknown> }>>
  /**
   * Hear which keys of a scope changed — set or deleted — as
   * `{ keys: string[] }`. Your own writes are reported at once; a change made
   * by other means (another Studio window, a file edited by hand) within a
   * couple of seconds. Like a module event it
   * is a signal, not state: read the keys again. Returns the unsubscriber —
   * call it in `onShutdown`. Throws for an invalid `workspaceRoot`.
   * Check `host.supports('storage-watch')` first.
   */
  watch(input: { workspaceRoot?: string }, listener: (change: ModuleStorageChange) => void): () => void
}

/** Which keys of a watched scope changed (were set or deleted), sorted. */
export type ModuleStorageChange = { keys: string[] }

// The moduleId-first registry the app provides; derived from the published
// service so the two shapes cannot drift.
type ModuleStorageRegistry = {
  [K in keyof ModuleStorageService]: (
    moduleId: string,
    ...args: Parameters<ModuleStorageService[K]>
  ) => ReturnType<ModuleStorageService[K]>
}

const moduleStorageToken: ServiceToken<ModuleStorageRegistry> =
  createServiceToken<ModuleStorageRegistry>('core.module-storage')

/**
 * The scoped storage service for `host`'s module. The raw host registry takes
 * a module id on every call; this helper closes over `host.moduleId` exactly
 * like `getScheduledAgentsService`. Provided by Studio's agent runtime, which
 * starts ahead of every extension's worker, so `activate` may resolve it at once.
 */
export function getModuleStorage(host: MainHost): ModuleStorageService {
  const registry = host.requireService(moduleStorageToken)
  const moduleId = host.moduleId
  return {
    get: (input) => registry.get(moduleId, input),
    set: (input) => registry.set(moduleId, input),
    delete: (input) => registry.delete(moduleId, input),
    list: (input) => registry.list(moduleId, input),
    getMany: (input) => registry.getMany(moduleId, input),
    watch: (input, listener) => registry.watch(moduleId, input, listener),
  }
}

// ── The window's studio (a ui entry's `mount`) ──────────────────────────────

// ── Backlog views ────────────────────────────────────────────────────────────

export type BacklogItemStatus = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
// `pending` is lifecycle-neutral: the work is recorded but has not started.
export type BacklogItemLinkStatus = 'pending' | 'active' | 'completed' | 'canceled' | 'failed' | 'unknown'

export type BacklogItemLink = {
  id: string
  moduleId: string
  type: 'execution' | 'issue' | 'review' | 'artifact' | 'external' | 'agent'
  label: string
  target: {
    kind: string
    id: string
    path?: string
    url?: string
  }
  status?: BacklogItemLinkStatus
  updatedAt?: string
}

export type BacklogResolvedLink = BacklogItemLink & {
  status: BacklogItemLinkStatus
  unavailableReason?: string
  canOpen?: boolean
}

/**
 * Read view of a Backlog item as handed to module callbacks. Enumerated app
 * internals (triage axes) are widened to `string` so new app values
 * never break compiled modules.
 */
export type BacklogItemView = {
  id: string
  path: string
  relativePath: string
  title: string
  status: BacklogItemStatus
  type?: string
  difficulty?: string
  criticality?: string
  metadata: Record<string, unknown>
  links: BacklogItemLink[]
  excerpt: string
  sourceContent: string
  /** The item's number (frontmatter `id:`), once the app has allocated one. */
  numericId?: number
  /** The id people read, `<workspace key>-<numericId>` (e.g. `MC-240`), when the item has a number. */
  displayId?: string
  /** The slug of the epic the item belongs to (frontmatter `epic:`). */
  epic?: string
  /** When the item last changed (epoch ms): its frontmatter `updated:` instant, else the file's mtime. */
  modifiedAt: number
}

// ── Live runtime surfaces (renderer) ─────────────────────────────────────────

export type WorkspaceFileWatchEvent = {
  relativePath: string
  /** File content after the change; null when the file does not exist. */
  content: string | null
}

/** The resolved surface of the app's active theme (`watchColorScheme`). */
export type ModuleColorScheme = 'light' | 'dark'

export type ModuleFocusTabInput = {
  workspaceId: string
  kind: 'chat' | 'file'
  /** A chat's agent id (from `openChat` or the conversation service), or a workspace-relative file path. */
  id: string
}

// ── Toasts, links and window context (renderer) ──────────────────────────────

/** A toast's tone. `good` for done, `warn`/`error` for trouble, `neutral`/`accent` for plain news. */
export type ModuleToastTone = 'neutral' | 'accent' | 'good' | 'warn' | 'error'

/**
 * Transient feedback — the answer to "did it work?" after a command or a click
 * in your door. Shown in the app's toast region with your module's name under
 * your message; leaves on its own (5 s, or 10 s for warn and error, held while
 * hovered). Anything the person must be able to find again belongs in the bell
 * (`MainHost.notify`), not here.
 */
export type ModuleToastInput = {
  tone: ModuleToastTone
  /** One line, sentence case. Non-empty; clipped at 200 characters. */
  message: string
  /** An optional second line; clipped at 500 characters. */
  detail?: string
  /** At most one button. Pressing it dismisses the toast and runs `run`. */
  action?: { label: string; run: () => void | Promise<void> }
}

/**
 * `RendererHost.openExternal`'s answer: `invalid_url` for anything but an
 * absolute http(s) URL, `unavailable` while your module is off or before the
 * window can open links, `failed` when the system refused.
 */
export type ModuleOpenExternalResult =
  { ok: true } | { ok: false; code: 'invalid_url' | 'unavailable' | 'failed'; message: string }

// ── Renderer host registration contract ──────────────────────────────────────

/**
 * The `studio` object an extension's window code is handed: what its
 * panels, doors and settings sections may ask of Studio. What it adds to Studio
 * is declared in extension.json, not registered here.
 */
export type RendererHost = {
  /** Your install key (`<publisher>.<id>`): the extension your `methods` calls reach and your bell rows are filed under. */
  readonly moduleId: string
  /**
   * Whether the running host provides `capability` now. False for names it
   * does not know, so an extension may probe for capabilities newer than its SDK.
   */
  supports(capability: HostCapability): boolean
  /**
   * Stable URL for a file packaged inside this trusted extension (e.g. runtime/index.html).
   * Inside packaged HTML, relative resources, WebAssembly, workers and IndexedDB share a stable,
   * separate origin. No leading slash, traversal, query or fragment in the path.
   * Trust and enablement are checked on every request. Assets must be files
   * under the installed extension's folder (128 MiB max).
   */
  getAssetUrl(relativePath: string): string
  /**
   * Open one of your doors (`contributes.doors`) as if it had been picked in
   * the Extensions drawer. False for an id that is not one of yours, or while
   * your extension is off.
   */
  openGlobalSurface(id: string): boolean
  /**
   * The workspace's Backlog items as read-only views. Declare the
   * `backlog.read` permission; the host checks it. Change items with the
   * Backlog write methods below (or `getBacklogService` in the worker) —
   * never by writing an item's file. Rejects when the backlog module is
   * disabled.
   */
  listBacklogItems(workspaceId: string): Promise<BacklogItemView[]>
  /**
   * Observe the workspace's Backlog: `cb` fires once with the current
   * snapshot, then on every change (scans are debounced ~300ms behind file
   * edits). Returns the unsubscriber — call it when your panel unmounts.
   * `options.onError` hears why a snapshot could not be delivered (no project
   * folder, an unreadable Backlog); the watch stays open and a later readable
   * scan calls `cb` again. Throws when the backlog module is disabled or
   * `backlog.read` is not declared.
   */
  watchBacklogItems(
    workspaceId: string,
    cb: (items: BacklogItemView[]) => void,
    options?: BacklogWatchOptions,
  ): () => void
  // ── Backlog writes (renderer twin of `getBacklogService`) ──
  // Each goes through the app's own Backlog service in main and answers a
  // result, never a throw. `itemId` is a `BacklogItemView.id`. Reads need
  // `backlog.read`, writes `backlog.write`; `supports('backlog-write')` says
  // whether the host has them.
  /** Where the workspace's Backlog lives. */
  getBacklogLocation(workspaceId: string): Promise<ModuleBacklogResult<{ location: ModuleBacklogLocation }>>
  /** Create an item the way the app does: its id, file name and frontmatter follow the app's rules. */
  createBacklogItem(
    workspaceId: string,
    input: ModuleBacklogCreateInput,
  ): Promise<ModuleBacklogResult<ModuleBacklogCreated>>
  updateBacklogStatus(workspaceId: string, itemId: string, status: BacklogItemStatus): Promise<ModuleBacklogResult>
  updateBacklogTriage(
    workspaceId: string,
    itemId: string,
    triage: ModuleBacklogTriageInput,
  ): Promise<ModuleBacklogResult>
  addBacklogLink(workspaceId: string, itemId: string, link: ModuleBacklogLinkInput): Promise<ModuleBacklogResult>
  updateBacklogModuleMetadata(workspaceId: string, itemId: string, value: unknown): Promise<ModuleBacklogResult>
  /**
   * Token usage of every agent session on this machine — the renderer twin of
   * `getUsageService(host).query`. Declare `usage:read`;
   * `supports('usage')` says whether the host has it. For live updates, call
   * it again when your worker hears `onChanged`.
   */
  queryUsage(query: UsageQuery): Promise<UsageQueryResult>
  /**
   * Resolve a workspace id (e.g. from `WorkspacePanelProps.workspaceId`) to
   * its read-only view — the supported way to get a workspace's folder root,
   * name, and mode. A null resolution means "not currently resolvable" (an
   * unknown id, or the shell hasn't wired workspace state yet at early
   * boot) — never a throw, and never a deletion signal: retry later instead
   * of discarding per-workspace state. Declare the `ipc:workspace-read`
   * permission (install-time disclosure). The worker's twin is
   * `WorkspaceContextToken`.
   */
  getWorkspace(workspaceId: string): Promise<ModuleWorkspaceView | null>
  /**
   * Every open workspace as a read-only view, in the order the shell lists
   * them — for a surface that is not mounted inside one workspace (a modal
   * floating over the window, a settings section) and so has no id to
   * resolve. Empty before the shell wires workspace state (early boot);
   * never a throw. Declare the `ipc:workspace-read` permission (install-time
   * disclosure).
   */
  listWorkspaces(): Promise<ModuleWorkspaceView[]>
  /**
   * A workspace's checked-out branch (null when detached) and its remotes,
   * each with `owner/repo` when it is on GitHub — SSH host aliases from
   * ~/.ssh/config resolved. Read by git from the workspace's working root, so
   * a worktree reports its own branch. The worker's twin is
   * `MainHost.getWorkspaceGitInfo`. Declare `ipc:workspace-read` (checked:
   * `permission_missing` without it). Never throws. Check
   * `host.supports('workspace-git-info')` first.
   */
  getWorkspaceGitInfo(workspaceId: string): Promise<ModuleWorkspaceGitInfoResult>
  /**
   * Observe the open workspaces: `cb` fires once with the current list, then
   * on every change (deduped by value, so an unrelated store write does not
   * wake it). Returns the unsubscriber — call it on unmount. Before the shell
   * wires workspace state the first call reports an empty list. Declare
   * `ipc:workspace-read`.
   */
  watchWorkspaces(cb: (workspaces: ModuleWorkspaceView[]) => void): () => void
  /**
   * Observe the app's resolved light/dark surface: `cb` fires immediately
   * with the current scheme, then whenever it changes — an explicit theme
   * switch, or an OS switch while the preference follows the system. Returns
   * the unsubscriber; call it on unmount.
   *
   * This is for a themed runtime you HOST (Monaco's base theme, a chart
   * library's palette) — something that needs a concrete 'light' | 'dark'
   * rather than a CSS variable. Ordinary module UI should read THEME_TOKENS
   * instead and re-skin without JavaScript.
   */
  watchColorScheme(cb: (scheme: ModuleColorScheme) => void): () => void
  /**
   * Your module's entry in the workspace's per-module state bag — durable
   * state your module keeps on a workspace (view choices, selection, panel
   * config), persisted with the workspace and synced across windows. Scoped
   * to your module: one module can never read another's entry. `undefined`
   * means no state is recorded, the workspace id is unknown, or the shell
   * hasn't wired workspace state yet (early boot) — never a throw and never
   * a deletion signal; retry later instead of discarding state. Declare the
   * `storage` permission (install-time disclosure).
   */
  getWorkspaceModuleState<T = unknown>(workspaceId: string): T | undefined
  /**
   * Replace your module's entry in the workspace's per-module state bag;
   * null/undefined removes it. Keep entries JSON-serializable — they persist
   * into the workspace registry verbatim. False means the write was NOT
   * stored (unknown workspace id, or the shell hasn't wired workspace state
   * yet) — surface it or retry; never assume success. Declare the `storage`
   * permission (install-time disclosure).
   */
  setWorkspaceModuleState(workspaceId: string, state: unknown): boolean
  /**
   * Read one key from your module's APP-level state — the scope above
   * `getWorkspaceModuleState`, for state that belongs to your module rather
   * than to a single workspace: remembered defaults, the last thing the user
   * opened. Synchronous and store-backed, so a renderer selector can derive
   * from it without an IPC round trip changing render timing (which is why
   * this exists alongside the worker's `ModuleStorageService`).
   * `undefined` means the key has never been set, or the shell has not wired
   * the store yet (early boot) — never a throw and never a deletion signal.
   * Scoped to your module: one module can never read another's. Persists with
   * app settings and survives a disable/enable cycle. It shares a keyspace with
   * your contributed Settings section's values, which are app-level module
   * state by another name. Declare the `storage` permission.
   */
  getModuleAppState<T = unknown>(key: string): T | undefined
  /**
   * Write one key in your module's app-level state; `undefined` deletes it.
   * Keep values JSON-serializable — they persist into app settings verbatim.
   * False means the write was NOT stored (empty key, or the shell has not
   * wired the store yet) — surface it or retry; never assume success. Declare
   * the `storage` permission.
   */
  setModuleAppState(key: string, value: unknown): boolean
  /**
   * Observe your module's app-level state: `cb` fires with the whole namespace
   * on every change (not on subscribe — read the current value with
   * `getModuleAppState`). Returns the unsubscriber; call it on unmount. Pair
   * the two with `useSyncExternalStore` for a reactive read.
   */
  watchModuleAppState(cb: (values: Readonly<Record<string, unknown>>) => void): () => void
  /**
   * Subscribe to events your worker pushed with `MainHost.emit` — the
   * subscribe verb `methods` does not have. Scoped to your module: another
   * module's events never reach you, and yours never reach it. `cb` receives
   * the emitted payload. Returns the unsubscriber; call it on unmount.
   *
   * Nothing is replayed, so a subscriber must be correct having missed every
   * event emitted before it subscribed — read current state through
   * a `read` method and let events tell you when to read it again. Delivery stops
   * while your module is disabled and resumes when it is re-enabled.
   */
  subscribe(topic: string, cb: (payload: unknown) => void): () => void
  /**
   * The workspace's *effective working root*: where its live work happens.
   * `ModuleWorkspaceView.folderPath` deliberately reports the durable primary
   * checkout; a worktree-backed workspace (a scheduled agent's run on a
   * worktree, for one) does live work under a worktree, and this
   * resolves that root. The live-runtime methods below
   * resolve workspace-relative paths against it. Null means "not currently
   * resolvable" — never a throw. Declare `ipc:workspace-read`.
   */
  getWorkingRoot(workspaceId: string): Promise<string | null>
  /**
   * Watch one workspace-relative file (resolved against the effective working
   * root): `cb` fires once with the current content (null when the file
   * doesn't exist), then debounced (~300ms) on every change. Rejects with a
   * named cause for absolute/escaping paths, unknown/folderless workspaces,
   * or a disabled Agent Runtime module. Keep the resolved closure and call it
   * on unmount. Declare `filesystem:read-workspace`.
   */
  watchWorkspaceFile(
    workspaceId: string,
    relativePath: string,
    cb: (event: WorkspaceFileWatchEvent) => void,
  ): Promise<() => void>
  /**
   * Focus a workspace tab: a chat by its agent id (added if missing) or a
   * file tab by workspace-relative path. False when not focusable; throws
   * with a named cause when agent runtime is unavailable.
   */
  focusTab(input: ModuleFocusTabInput): boolean
  /**
   * Open a chat in a workspace and focus it. By default the prompt lands in the
   * composer as a draft the user sends themselves; `send: true` sends it as the
   * first turn. `name` titles the chat, and `dedupeKey` focuses the chat this
   * module already opened under that key instead of opening another (check
   * `supports('chat.open-options')`). Expected failures come back as a
   * result, never a throw (`unavailable` when this window cannot open chats).
   * Declare `chat:draft` to open drafts, or `conversation:operate`, which
   * `send: true` needs.
   */
  openChat(input: ModuleOpenChatInput): Promise<ModuleOpenChatResult>
  /**
   * The agent runtimes a chat can run on, from the same catalog the shell's
   * own chat picker reads, with the one the user last chose marked.
   */
  listChatRuntimes(): ModuleChatRuntimeOption[]
  /**
   * Show a toast: transient feedback in the app's toast region, under your
   * module's name. Returns its dismisser. An empty message, an unknown tone or
   * a malformed action throws; while your module is disabled, or in a window
   * with no toast region (`supports('toast')` is false), nothing shows and the
   * dismisser does nothing.
   */
  toast(input: ModuleToastInput): () => void
  /**
   * The workspace this window is showing, or null — none is open. The same id
   * a command's `ModuleCommandContext.activeWorkspaceId` carries
   * (`supports('active-workspace')`).
   */
  getActiveWorkspaceId(): string | null
  /**
   * Observe the workspace this window is showing: `cb` fires once with the
   * current id (null for none), then whenever it changes. Returns the
   * unsubscriber; call it on unmount.
   */
  watchActiveWorkspace(cb: (workspaceId: string | null) => void): () => void
  /**
   * Open an http(s) URL in the system browser through the app's own link
   * path — never in the app's window. Anything but an absolute http(s) URL
   * (no credentials) is refused as `invalid_url` before it leaves your code.
   * Expected failures come back as a result, never a throw.
   */
  openExternal(url: string): Promise<ModuleOpenExternalResult>
  /**
   * Call the methods your worker (`main`) declared with
   * `MainHost.registerMethods`, typed by your contract:
   * `host.methods<Board>().read('cards.list', { column: 'todo' })`. `read`
   * offers the methods declared `read`, `operate` the ones declared
   * `operate`; a call never names another module. Calls travel over the
   * window's Studio connection to the server your module runs on, and never
   * throw: your handler's refusals and the host's (`extension_unavailable`,
   * `extension_method_unknown`, `invalid_params`, …) are answers.
   */
  methods<Cs extends ModuleMethodContracts = ModuleMethodContracts>(): ModuleMethodsClient<Cs>
}

// ── Entry contract ───────────────────────────────────────────────────────────
// What an extension's code exports. A ui contribution's `entry` exports
// `mount`; the worker's `main` exports `activate`. Studio calls them; an
// extension never registers its panels, doors, commands or menus itself, it
// declares them in extension.json.

/** Which contribution a `mount` draws, and where. */
export type ExtensionSurface = {
  point: 'panels' | 'doors' | 'settingsSections'
  /** The contribution's id in extension.json. */
  id: string
  /** The workspace a panel was opened in; absent for doors and settings sections. */
  workspaceId?: string
}

/** The `studio` a `mount` is handed: the window's API, and this one surface. */
export type ExtensionMountStudio = RendererHost & {
  readonly surface: ExtensionSurface
  /**
   * Say the surface has drawn its content. Studio measures how long a surface
   * takes from being opened to this call; call it once, after the first
   * meaningful paint of your content.
   */
  ready(): void
}

/** What `mount` may hand back: a function Studio calls when the surface closes. */
export type ExtensionMountCleanup = () => void

/**
 * A ui `entry`'s export: draw into `root`, which Studio owns, and return a
 * cleanup function if anything outlives the DOM you drew.
 */
export type ExtensionMount = (
  root: HTMLElement,
  studio: ExtensionMountStudio,
) => void | ExtensionMountCleanup | Promise<void | ExtensionMountCleanup>

/**
 * The worker's export (`main`), as its default export or a named `activate`:
 * register the methods and MCP tools the extension serves.
 */
export type ExtensionActivate = (studio: MainHost) => void | Promise<void>

/**
 * What a command without an `action` is called with: it runs the worker
 * method named by the command's id (`registerMethods`, access `operate`),
 * with this as its params. `where` says how it was run; the menu it was
 * picked from adds what it was picked on.
 */
export type ExtensionCommandContext = {
  where: 'palette' | 'topBar' | 'backlog.item' | 'file' | 'notification'
  /** The workspace the window was showing, or the one the item or file belongs to. */
  workspaceId: string | null
  /** `backlog.item`: the items the menu was opened on, the anchor row first. */
  backlogItemIds?: string[]
  /** `file`: the files and folders the menu was opened on, relative to the workspace's folder. */
  filePaths?: string[]
  /** `notification`: the bell row the menu was opened on. */
  notification?: { title: string; body?: string; emittedAt: number }
}

/** A ui `entry` module's shape. */
export type ExtensionUiEntry = { mount: ExtensionMount }

/** The worker module's shape. */
export type ExtensionWorkerEntry = { activate: ExtensionActivate } | { default: ExtensionActivate }

// ── File-drop drag-and-drop contract ─────────────────────────────────────────
// The payload the Backlog panel and Files tree put on a drag (and the terminal
// accepts). Published so a module can accept those drags — or originate
// compatible ones — against a drift-guarded contract instead of an internal
// MIME string. Self-contained mirror of the app's terminalDrop contract.

export const SPRINTENGINE_FILE_DROP_MIME = 'application/x-sprintengine-file-drop'

export type FileDropPayload = {
  version: 1
  workspaceId: string | null
  rootPath: string
  files: Array<{
    path: string
    name: string
    isDir?: boolean
  }>
}

/** Put a file-drop payload on a drag the app's drop targets (terminals) accept. */
export function setFileDropData(dataTransfer: DataTransfer, payload: FileDropPayload): void {
  const fileText = payload.files.map((file) => file.path).join('\n')
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(SPRINTENGINE_FILE_DROP_MIME, JSON.stringify(payload))
  dataTransfer.setData('text/plain', fileText)
}

/**
 * Whether a drag carries the studio's file-drop payload (or native OS files).
 * Use this during `dragover` — the HTML DnD protected mode blanks `getData`
 * there, so `readFileDropPayload` only works inside the `drop` handler.
 */
export function hasFileDropData(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(SPRINTENGINE_FILE_DROP_MIME) || types.includes('Files')
}

/**
 * Read the studio's file-drop payload off a drop event's dataTransfer. Returns
 * null — never throws — when the MIME entry is absent, the JSON is
 * unparseable, the version is unknown (future versions ⇒ null; handle it), or
 * the shape is invalid. A Backlog-item drag carries the item's markdown file
 * path in `files[0].path`, resolvable back to the item.
 */
export function readFileDropPayload(dataTransfer: DataTransfer): FileDropPayload | null {
  const raw = dataTransfer.getData(SPRINTENGINE_FILE_DROP_MIME)
  if (!raw) return null

  try {
    const value = JSON.parse(raw) as Partial<FileDropPayload>
    if (
      value.version !== 1 ||
      (value.workspaceId !== null && typeof value.workspaceId !== 'string') ||
      typeof value.rootPath !== 'string'
    ) {
      return null
    }
    if (!Array.isArray(value.files)) return null

    // Entries are rebuilt, never passed through: an invalid or non-boolean
    // isDir is skipped, and unknown extra properties are dropped.
    const files: FileDropPayload['files'] = []
    for (const file of value.files) {
      if (
        !file ||
        typeof file.path !== 'string' ||
        file.path.trim().length === 0 ||
        typeof file.name !== 'string' ||
        (file.isDir !== undefined && typeof file.isDir !== 'boolean')
      ) {
        continue
      }
      files.push({
        path: file.path,
        name: file.name,
        ...(file.isDir === undefined ? {} : { isDir: file.isDir }),
      })
    }

    if (!files.length) return null
    return {
      version: 1,
      workspaceId: value.workspaceId,
      rootPath: value.rootPath,
      files,
    }
  } catch {
    return null
  }
}

// ── Theme tokens ─────────────────────────────────────────────────────────────

/**
 * The theme CSS custom properties guaranteed present in every app theme.
 * Consume them as CSS variables — Tailwind arbitrary values
 * (`bg-[var(--bg-surface)]`) or plain `var()` — so module UI re-skins with the
 * active theme automatically. Only the NAMES are contract: values differ per
 * theme and may be retuned in each release; never read or cache resolved values
 * in JS, and never hard-code a hex. `--focus-ring` is a full box-shadow value,
 * not a color. Presence is enforced per theme by a repo gate
 * (test:sdk:theme-tokens).
 */
export const THEME_TOKENS = [
  // Chrome (backgrounds)
  '--bg-app',
  '--bg-surface',
  '--bg-surface-raised',
  '--bg-hover',
  '--bg-selected',
  // Borders
  '--border-subtle',
  '--border-default',
  '--border-strong',
  // Text
  '--text-strong',
  '--text-default',
  '--text-muted',
  '--text-subtle',
  '--text-disabled',
  '--text-on-accent',
  // Accent + focus
  '--accent-primary',
  '--accent-primary-soft',
  '--focus-ring',
  // Semantic tones
  '--tone-neutral',
  '--tone-accent',
  '--tone-warn',
  '--tone-good',
  '--tone-error',
  '--tone-merged',
  // Categorical chart series, in ORDER: series N takes `--chart-N`, never
  // cycled and never re-assigned by rank — the order is what keeps neighbours
  // apart under colour-vision deficiency. A ninth series folds into the
  // neutral `--chart-other`. They are never status: a series that means good
  // or bad wears `--tone-good` / `--tone-warn` / `--tone-error` instead. Each
  // clears 3:1 against `--bg-surface` on every theme.
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--chart-6',
  '--chart-7',
  '--chart-8',
  '--chart-other',
  // Motion. `--motion-normal` is a duration, `--motion-ease` a timing
  // function: use them together on a transition or animation so module UI
  // moves at the app's pace instead of inventing its own.
  '--motion-normal',
  '--motion-ease',
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

// ── Host capabilities, conversations, brokered credentials ───────────────────

export { type HostCapability } from './host-api.js'

export {
  getConversationService,
  type ModuleChatRuntimeOption,
  type ModuleConversationApprovalDecision,
  type ModuleConversationCommandOptions,
  type ModuleConversationCreateInput,
  type ModuleConversationErrorCode,
  type ModuleConversationEvent,
  type ModuleConversationEventType,
  type ModuleConversationFollowOptions,
  type ModuleConversationImageAttachment,
  type ModuleConversationPage,
  type ModuleConversationPermissionPreset,
  type ModuleConversationPlanDecision,
  type ModuleConversationRef,
  type ModuleConversationResult,
  type ModuleConversationService,
  type ModuleConversationStatus,
  type ModuleConversationStreamFrame,
  type ModuleConversationSummary,
  type ModuleOpenChatInput,
  type ModuleOpenChatResult,
} from './conversation.js'

// ── Backlog, usage and activity services ─────────────────────────────────────

export {
  getBacklogService,
  type BacklogWatchError,
  type BacklogWatchOptions,
  type ModuleBacklogCreated,
  type ModuleBacklogCreateInput,
  type ModuleBacklogErrorCode,
  type ModuleBacklogLinkInput,
  type ModuleBacklogLocation,
  type ModuleBacklogResult,
  type ModuleBacklogService,
  type ModuleBacklogTriageInput,
} from './backlog.js'

export {
  getActivityService,
  getUsageService,
  type ActivityChatSummary,
  type ActivityListChatsInput,
  type ActivityPrompt,
  type ActivityPromptsInput,
  type ModuleActivityErrorCode,
  type ModuleActivityResult,
  type ModuleActivityService,
  type ModuleUsageErrorCode,
  type ModuleUsageResult,
  type ModuleUsageService,
  type UsageGroupBy,
  type UsageQuery,
  type UsageQueryResult,
  type UsageRow,
  type UsageSource,
  type UsageTokens,
} from './activity.js'

// Agents, conversations and scheduled agents: turn replies and usage, and
// headless text generation.
export {
  getTextGenerationService,
  type ModuleConversationTurnCompletedPayload,
  type ModuleConversationTurnUsage,
  type ModuleTextGenerationErrorCode,
  type ModuleTextGenerationInput,
  type ModuleTextGenerationResult,
  type ModuleTextGenerationService,
} from './conversation.js'

export {
  getGitHubService,
  getSecretsService,
  type ModuleGitHubDownloadRequest,
  type ModuleGitHubDownloadResponse,
  type ModuleGitHubErrorCode,
  type ModuleGitHubMediaType,
  type ModuleGitHubRequest,
  type ModuleGitHubResponse,
  type ModuleGitHubService,
  type ModuleSecretFetchInit,
  type ModuleSecretFetchResult,
  type ModuleSecretsError,
  type ModuleSecretsService,
} from './brokers.js'

// ── extension.json ───────────────────────────────────────────────────────────
// Pure (no Node APIs) and safe in any runtime. The ed25519 sign/verify of
// extension.sig, and the walk that digests an extension's folder, need
// node:crypto and node:fs and live behind the `./signing` subpath export.

export {
  EXTENSION_COMMAND_ACTIONS,
  EXTENSION_ICONS,
  EXTENSION_MANIFEST_FIELDS,
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_MANIFEST_SINCE,
  EXTENSION_MENU_PLACES,
  EXTENSION_RESERVED_POINTS,
  EXTENSION_SIGNATURE_FILENAME,
  EXTENSION_SURFACE_POINTS,
  EXTENSION_TIERS,
  LOCAL_EXTENSION_PUBLISHER,
  STUDIO_EXTENSION_VERSION,
  compareStudioVersions,
  extensionInstallKey,
  extensionManifestJsonSchema,
  extensionManifestReference,
  isExtensionInstallKey,
  isReservedExtensionId,
  isReservedExtensionPublisher,
  isSafeExtensionPath,
  parseExtensionInstallKey,
  parseExtensionManifest,
  requiredExtensionTier,
  studioReadsManifest,
  validateExtensionManifest,
  type ExtensionCommandAction,
  type ExtensionCommandContribution,
  type ExtensionContributions,
  type ExtensionIcon,
  type ExtensionManifest,
  type ExtensionManifestResult,
  type ExtensionManifestValidationOptions,
  type ExtensionMcpToolContribution,
  type ExtensionMenuContribution,
  type ExtensionMenuPlace,
  type ExtensionSurfaceContribution,
  type ExtensionSurfacePoint,
  type ExtensionTier,
  type ExtensionTopBarItemContribution,
  type ManifestIssue,
} from './extension-manifest.js'

// The base of a plugin bundle's plugin.json, and the path rules every package
// format shares.
export {
  canonicalManifestPayload,
  compareModuleFileDigests,
  isPackExcludedPath,
  parseBundleBaseManifest,
  validateBundleBaseManifest,
  validateCapabilityPermissions,
  type PermissionValidationIssue,
  type PermissionValidationResult,
  type ThirdPartyManifestIssue,
  type ThirdPartyManifestResult,
} from './manifest-validate.js'

// ── Marketplace plugin bundle authoring ─────────────────────────────────────
// A marketplace plugin is a signed bundle manifest (`plugin.json`) that points
// at existing primitives: MCP configs and skill directories. An extension
// ships as an extension.json of its own, never inside a bundle. The app re-exports these helpers from its shared
// marketplace module, so SDK authors and the studio verify the same shape.

export {
  MARKETPLACE_COMPONENT_KINDS,
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  validateMarketplacePluginAuthoringManifest,
  validateMarketplacePluginManifest,
  type MarketplaceComponent,
  type MarketplaceComponentFileDigest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
  type MarketplacePluginAuthoringManifestResult,
  type MarketplacePluginComponents,
  type MarketplacePluginManifest,
  type MarketplacePluginManifestResult,
} from './plugin-manifest.js'

// ── Published host services and what each needs ─────────────────────────────
// The table a scaffolded project's smoke test and the `/testing` fakes read,
// so neither keeps a copy of the host's rules that can go stale.

export { MODULE_SERVICE_REQUIREMENTS, moduleServiceRequirement, type ModuleServiceRequirement } from './services.js'
