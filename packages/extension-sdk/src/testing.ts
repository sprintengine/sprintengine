// `@sprintengine/extension-sdk/testing` — fake hosts for testing a module in Node,
// without the app.
//
// - `createFakeMainHost` is a `MainHost` with stateful fakes of every service
//   the SDK publishes (storage, chats, scheduled agents, companions, secrets,
//   GitHub, workspaces, the Backlog, usage, activity), held to the host's
//   rules: the same storage key pattern, root rule and 1 MB cap, the same
//   `not_permitted` refusals of a call the extension's permissions do not
//   cover (the host's gate, read from the same table), the same refusals of a
//   declared method's call. The fakes play the person at this machine as the
//   invoker, who holds every permission. `methods.read` / `methods.operate`
//   call the module's declared methods the way its renderer would and
//   `tools.call` calls its MCP tools the way an agent would.
// - `createFakeFrameStudio` is the `studio` a surface's `mount` is handed in
//   its frame, with a fake Studio behind `host.call`: each call checked as
//   Studio checks it (the extension's permissions, and what whoever opened
//   the surface holds) and carried out against the same fakes. Its worker
//   methods, events, Settings values, storage, Backlog and usage reach a fake
//   main host when given one.
// - `renderToHtml` renders a React tree in Node, for an extension whose
//   surfaces draw with React.
//
// A host method or service added to the SDK lands here too: the method on the
// fake host (its row in services.ts, its capability in KNOWN_CAPABILITIES), a
// service's fake in SERVICE_FAKES (testing-services.ts). The typecheck fails
// until the fake hosts implement every method, and a test fails until every
// capability is known.
//
// Node only; never import it from extension code.

import { existsSync, rmSync } from 'node:fs'
import { EXTENSION_COMMAND_ACTIONS } from './extension-manifest.js'
import { dirname, resolve as resolvePath } from 'node:path'

import { jsonValueProblem } from './json-value.js'
import { isModuleMethodName, MODULE_METHOD_MAX_CHARS } from './methods.js'
import type { HostCapability } from './host-api.js'
import type {
  ExtensionEditorContent,
  ExtensionEditorDocument,
  ExtensionEditorDocumentApi,
  ExtensionEditorEdit,
  ExtensionFrameError,
  ExtensionFrameErrorCode,
  ExtensionFrameMethod,
  ExtensionMountStudio,
  ExtensionSurface,
} from './frame.js'
import { EXTENSION_EDITOR_FLUSH_TIMEOUT_MS } from './custom-editors.js'
import {
  chainExtensionHookHandlers,
  isExtensionHookPoint,
  readExtensionHookAnswer,
  type ExtensionHookEvents,
  type ExtensionHookPoint,
  type ExtensionHookVerdict,
} from './hooks.js'
import { EDITOR_DOCUMENT_SCRIPT, type EditorDocumentPort } from './editor-document-script.js'
import type {
  MainHost,
  McpConnectionMetadata,
  McpToolRegistration,
  McpToolResult,
  ModuleCallAnswer,
  ModuleMethodAccess,
  ModuleMethodContract,
  ModuleMethodRegistration,
  ModuleMethodsClient,
  ModuleNotificationTarget,
  ModuleNotifyInput,
  ModuleSkillStatus,
  ModuleSkillStatusResult,
  ModuleToastTone,
  ModuleWorkspaceView,
  ServiceToken,
  SidecarSpec,
} from './index.js'
import type { ModuleChatRuntimeOption } from './conversation.js'
import {
  EXTENSION_HOST_REFUSALS,
  EXTENSION_MAIN_HOST_METHODS,
  extensionFrameMethod,
  extensionHostService,
  type ExtensionHostRequirement,
} from './services.js'
import {
  createFakeWorkspaces,
  SERVICE_FAKES,
  type FakeBacklog,
  type FakeBacklogItemInput,
  type FakeServiceContext,
  type FakeServices,
  type FakeUsage,
  type FakeWorkspaces,
} from './testing-services.js'
import {
  EXTENSION_EVENT_SPECS,
  isExtensionEventName,
  isExtensionFrameEventName,
  type ExtensionEventName,
  type ExtensionEventPayloads,
  type ExtensionFrameEventName,
} from './events.js'
import type { ReactNode } from 'react'

export type {
  FakeActivity,
  FakeBacklog,
  FakeBacklogItemInput,
  FakeCompanionApprovalRequest,
  FakeCompanions,
  FakeCompanionTurn,
  FakeConversationEventInput,
  FakeConversationRecord,
  FakeConversations,
  FakeRestoredConversation,
  FakeGitHub,
  FakeGitHubAnswer,
  FakeGitHubDownloadAnswer,
  FakeGitHubDownloadReply,
  FakeGitHubGraphqlAnswer,
  FakeGitHubReply,
  FakeScheduledAgents,
  FakeSecretRequest,
  FakeSecrets,
  FakeServiceContext,
  FakeServices,
  FakeStorage,
  FakeTextGeneration,
  FakeTextGenerationCall,
  FakeTextGenerationReply,
  FakeUsage,
  FakeUsageRecord,
  FakeWorkspaceGitInfo,
  FakeWorkspaces,
} from './testing-services.js'
export { MODULE_STORAGE_VALUE_LIMIT_BYTES } from './testing-services.js'
// A components panel under test: mounted on the real runtime, drawn as Studio draws it.
export { defineCheck, mountPanel, stored } from './testing-components.js'
export type {
  CheckScenario,
  MountPanelOptions,
  MountedPanel,
  PanelElement,
  PanelError,
  PanelQuery,
  PanelRefusal,
  PanelTarget,
  PanelTreeNode,
  PersistedSeed,
  StoredAtomValue,
} from './testing-components.js'

// ── Shared pieces ────────────────────────────────────────────────────────────

/** The workspace every fake starts with when a test names none. */
export const DEFAULT_FAKE_WORKSPACES: readonly ModuleWorkspaceView[] = [
  { id: 'ws-app', name: 'App', folderPath: '/Users/dev/projects/app', mode: 'standard' },
]

// Every capability this SDK knows. A fake answers `supports` with these unless
// told otherwise, so a module's "older host" branch is opt-in to test. A test
// fails when HostCapability (host-api.ts) names one this list does not.
const KNOWN_CAPABILITIES: readonly HostCapability[] = [
  'terminals',
  'events',
  'conversations',
  'conversation-controls',
  'conversation-streams',
  'conversation-requests',
  'conversation-permissions',
  'companion-agents',
  // Agents, conversations and scheduled agents.
  'companion-tools',
  'conversation-replies',
  'text-generation',
  'conversation-worktrees',
  'chat-runtimes',
  'scheduled-agent-runs',
  'scheduled-agents',
  'secrets',
  'github',
  'storage',
  'mcp-tools',
  'notifications',
  // Backlog, usage and activity services.
  'backlog-write',
  'usage',
  'activity',
  'module-id',
  'chart-tokens',
  // Main-host plumbing: settings, workspaces, storage, GitHub, skills, MCP.
  'skill-status',
  'mcp-verified-identity',
  'github-headers',
  'github-graphql',
  'github-download',
  'storage-query',
  'storage-watch',
  'module-data-dir',
  'main-asset-path',
  'workspace-git-info',
  'workspace-history',
  'main-app-state',
]

/** The parts of extension.json a fake host reads. */
export type FakeExtensionManifest = {
  id: string
  permissions?: readonly string[]
  contributes?: {
    doors?: ReadonlyArray<{ id: string }>
    mcpTools?: ReadonlyArray<{ name: string; description: string; access: 'read' | 'operate' }>
    hooks?: ReadonlyArray<{ point: string; onError?: 'pass' | 'deny' }>
    events?: ReadonlyArray<{ on: string }>
  }
}

/** What a fake host is told about the extension: its install key and the permissions its manifest declares. */
export type FakeModuleIdentity = {
  /** The install key. Default: `local.<manifest id>`, as a folder install names it. */
  moduleId?: string
  permissions?: readonly string[]
  /** The extension's manifest (`extension.json`, parsed) to read the id, permissions and contributions from. */
  manifest?: FakeExtensionManifest
}

function identityOf(options: FakeModuleIdentity): { moduleId: string; permissions: Set<string> } {
  const moduleId = options.moduleId ?? (options.manifest ? `local.${options.manifest.id}` : undefined)
  if (!moduleId) throw new Error('A fake host needs a moduleId (or a manifest with an id).')
  return { moduleId, permissions: new Set(options.permissions ?? options.manifest?.permissions ?? []) }
}

/** A call the host refused because the manifest does not ask for what it needs. */
export type FakeUndeclaredUse = {
  /** The host method, or the service method (`<service key>.<method>`). */
  what: string
  /** Any one of these would cover it. */
  needs: readonly string[]
}

/** The host's refusal of a call the extension's permissions do not cover, as its row says to tell it. */
function refuseUndeclared(
  moduleId: string,
  what: string,
  requirement: ExtensionHostRequirement,
): Promise<{ ok: false; code: 'not_permitted'; message: string }> {
  const message = `Extension "${moduleId}" was not approved for "${requirement.extension}", which "${what}" needs.`
  if (requirement.refusal === 'answer')
    return Promise.resolve({ ok: false, code: EXTENSION_HOST_REFUSALS.notPermitted, message })
  if (requirement.refusal === 'reject') return Promise.reject(new Error(message))
  throw new Error(message)
}

// ── Notifications and events: the host's validation ─────────────────────────

const NOTIFY_SEVERITIES = ['info', 'warning', 'error']
const MAX_TOPIC_LENGTH = 128
const MAX_NOTIFY_TITLE_LENGTH = 200
const MAX_NOTIFY_BODY_LENGTH = 2000
const MAX_NOTIFY_TARGET_ID_LENGTH = 200

function notifyTargetId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_NOTIFY_TARGET_ID_LENGTH ? trimmed : null
}

// The host's validation (shared/modules/notifications.ts in the app): what a
// bell row would carry, trimmed and clipped, or the throw the module would get.
function validateNotify(moduleId: string, input: unknown): ModuleNotifyInput {
  const { severity, title, body, target } = (input ?? {}) as Record<string, unknown>
  const fail = (message: string): never => {
    throw new Error(`Extension "${moduleId}" notify(...) ${message}`)
  }
  if (typeof input !== 'object' || input === null) fail('requires a payload object.')
  if (typeof severity !== 'string' || !NOTIFY_SEVERITIES.includes(severity)) {
    fail('severity must be "info", "warning", or "error".')
  }
  if (typeof title !== 'string' || !title.trim()) fail('requires a non-empty title.')
  if (body !== undefined && typeof body !== 'string') fail('body must be a string when provided.')
  let validTarget: ModuleNotificationTarget | undefined
  if (target !== undefined) {
    if (!target || typeof target !== 'object') fail('target must be { surfaceId, viewId? } when provided.')
    const { surfaceId, viewId } = target as Record<string, unknown>
    const validSurfaceId = notifyTargetId(surfaceId) ?? fail('target.surfaceId must be a non-empty string.')
    const validViewId = viewId === undefined ? undefined : notifyTargetId(viewId)
    if (validViewId === null) fail('target.viewId must be a non-empty string when provided.')
    validTarget = { surfaceId: validSurfaceId, ...(validViewId ? { viewId: validViewId } : {}) }
  }
  const trimmed = (body as string | undefined)?.trim()
  return {
    severity: severity as ModuleNotifyInput['severity'],
    title: (title as string).trim().slice(0, MAX_NOTIFY_TITLE_LENGTH),
    ...(trimmed ? { body: trimmed.slice(0, MAX_NOTIFY_BODY_LENGTH) } : {}),
    ...(validTarget ? { target: validTarget } : {}),
  }
}

// ── Chat runtimes ────────────────────────────────────────────────────────────

/** What `listChatRuntimes` answers unless a test says otherwise: Claude Code (last chosen) and Codex, both installed. */
export const DEFAULT_FAKE_CHAT_RUNTIMES: readonly ModuleChatRuntimeOption[] = [
  { id: 'claude-code', label: 'Claude Code', available: true, models: [], lastSelected: true },
  { id: 'codex', label: 'Codex', available: true, models: [], lastSelected: false },
]

// ── Module app state ─────────────────────────────────────────────────────────

// The module's app-level state (its Settings values): one namespace the
// renderer reads and writes and the worker reads, so a fake renderer given a
// fake main host shares it, as the windows and main do.
type AppStateStore = {
  get(key: string): unknown
  all(): Record<string, unknown>
  set(key: string, value: unknown): void
  subscribe(cb: (values: Readonly<Record<string, unknown>>) => void): () => void
}

function createAppStateStore(initial: Record<string, unknown> | undefined): AppStateStore {
  const values: Record<string, unknown> = structuredClone(initial ?? {})
  const listeners = new Set<(values: Readonly<Record<string, unknown>>) => void>()
  return {
    get: (key) => structuredClone(values[key]),
    all: () => structuredClone(values),
    set(key, value) {
      if (value === undefined) delete values[key]
      else values[key] = structuredClone(value)
      for (const listener of [...listeners]) listener(structuredClone(values))
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}

function validateTopic(moduleId: string, topic: unknown): string {
  if (typeof topic !== 'string' || !topic.trim() || topic.length > MAX_TOPIC_LENGTH) {
    throw new Error(`Extension "${moduleId}" emit(...) needs a topic of 1-${MAX_TOPIC_LENGTH} characters.`)
  }
  return topic
}

// ── The main host ────────────────────────────────────────────────────────────

export type FakeMainHostOptions = FakeModuleIdentity & {
  /** The workspaces the host knows. Default: one, `ws-app` at `/Users/dev/projects/app`. */
  workspaces?: readonly ModuleWorkspaceView[]
  /** Values already stored, as an earlier run would have left them: the global store, and per workspace root. */
  storage?: { global?: Record<string, unknown>; workspaces?: Record<string, Record<string, unknown>> }
  /** What `supports` answers true for. Default: every capability this SDK knows. */
  capabilities?: readonly string[]
  /**
   * Replace a service: a moduleId-first registry object to answer with in
   * place of the built-in fake, or null for a service no enabled module
   * provides (`requireService` throws, `getService` answers undefined).
   */
  services?: Record<string, object | null>
  /** Skill ids the app ships, which `ensureSkillInstalled` answers for. */
  builtinSkills?: readonly string[]
  /** The clock every fake stamps with. Default: `Date.now`. */
  now?: () => number
  /** Module app state (Settings values) a window already pushed, for `getModuleAppState`. */
  appState?: Record<string, unknown>
  /** What `listChatRuntimes` answers. Default: Claude Code (last chosen) and Codex. A fake renderer given this host lists the same. */
  chatRuntimes?: readonly ModuleChatRuntimeOption[]
  /** What `getModuleDataDir` answers. Default: a fresh temporary folder, made on first use (`dispose` removes it). */
  dataDir?: string
  /** The module's folder, which `getAssetPath` resolves under. Default: the working directory (the project root under `npm test`). */
  moduleRoot?: string
  /**
   * The files the module was verified with (every file of the extension's folder),
   * module-relative. Given, `getAssetPath` resolves only these, as the host
   * does; absent, any file that exists under `moduleRoot`.
   */
  verifiedFiles?: readonly string[]
}

export type FakeMainHost = {
  /** Hand this to the worker's `activate`. */
  host: MainHost
  /** The module's declared permissions. Live: add or remove one to test the other branch. */
  permissions: Set<string>
  /**
   * The module's declared methods, called as its renderer (or a client) would
   * through `RendererHost.methods`: refused as the host refuses
   * (`extension_method_unknown` for a name not declared under that access,
   * `invalid_params` for params its validator refuses), params and result
   * passed as JSON, an operate carried out once per command id and told it
   * under the caller's namespace (`owner:<id>`). A handler that throws, or
   * answers a result that is not JSON, rejects, as the host would answer
   * `unavailable`.
   */
  methods: ModuleMethodsClient & {
    /** The methods declared so far, in order. */
    declared(): Array<{ name: string; access: ModuleMethodAccess }>
  }
  /** The gateway's side of the module's MCP tools. */
  tools: {
    /** Call a registered tool as an agent would. `metadata` defaults to a Studio agent in the first workspace. */
    call(name: string, args?: Record<string, unknown>, metadata?: McpConnectionMetadata): Promise<McpToolResult>
    list(): McpToolRegistration[]
  }
  /** Studio's side of the worker's hooks (`registerHooks`). */
  hooks: {
    /**
     * Run the worker's hook for `point` on `event`, as Studio would for this
     * extension alone, and say what it decided: `pass`, `deny` with its
     * reason, `change` with the event as changed, `ignored` (a change the
     * point does not allow, which passes) or `invalid`. A handler that
     * throws rejects. A point extension.json does not list, or one the
     * worker did not register, throws.
     */
    fire<P extends ExtensionHookPoint>(point: P, event: ExtensionHookEvents[P]): Promise<ExtensionHookVerdict>
    /** The points the worker registered, in order. */
    registered(): ExtensionHookPoint[]
  }
  /** Studio's side of the worker's events (`studio.events.on`). */
  events: {
    /**
     * Deliver `event` to the worker's handlers, one after another, as Studio
     * would: an event extension.json does not list throws, and one whose
     * permission the manifest does not ask for is delivered to nobody and
     * recorded in `undeclared`, as Studio drops it. A handler that throws rejects.
     */
    fire<E extends ExtensionEventName>(event: E, payload: ExtensionEventPayloads[E]): Promise<void>
    /** The events the worker has a handler for now. */
    heard(): ExtensionEventName[]
  }
  /** Every `emit`, in order. */
  emitted: Array<{ topic: string; payload?: unknown }>
  /** Every `notify`, validated as the host validates it. */
  notifications: ModuleNotifyInput[]
  /** Every `runCommand`, by the Studio action it asked the window to run. */
  commandRuns: string[]
  skills: {
    ensured: Array<{ workspaceRoot: string; skillId: string }>
    /**
     * Put a skill in a state in a workspace, for `getSkillStatus` and
     * `ensureSkillInstalled` to find: `local` or `modified` (a copy the app
     * leaves alone), `update-available` (`ensure…` answers `updated`),
     * `install-failed`, …. Unset, a known skill is `missing` until
     * `ensureSkillInstalled` installs it.
     */
    setStatus(workspaceRoot: string, skillId: string, status: ModuleSkillStatus): void
  }
  sidecars: SidecarSpec[]
  /** The stateful service fakes, to arrange the world and read what the module did to it. */
  services: FakeServices
  /** Service keys the module resolved, in order (a key resolved twice appears once). */
  resolved: string[]
  /** Calls refused because the manifest does not ask for what they need. A clean module leaves this empty. */
  undeclared: FakeUndeclaredUse[]
  /** Run every `onStartup` hook, in order. Rejects with the first hook's error after running them all. */
  startup(): Promise<void>
  /** Run `onShutdownBegin` hooks in order, then `onShutdown` hooks in reverse. */
  shutdown(): Promise<void>
  /** Hear every `emit` (a fake renderer host subscribes this way). */
  onEmit(listener: (topic: string, payload: unknown) => void): () => void
  /** The module app state now, as `getModuleAppState` reads it. */
  appState(): Record<string, unknown>
  /**
   * Change one key of the module app state, as a window's Settings section
   * would push it (`undefined` removes it); `watchModuleAppState` listeners
   * hear the whole namespace. A fake renderer given this host shares it.
   */
  setAppState(key: string, value: unknown): void
  /** Remove the temporary data directory `getModuleDataDir` made (never a `dataDir` the test passed). */
  dispose(): void
  /** Change what `listChatRuntimes` answers (a CLI installed, another chosen). */
  setChatRuntimes(runtimes: readonly ModuleChatRuntimeOption[]): void
}

type MainInternals = {
  moduleId: string
  workspaces: ReturnType<typeof createFakeWorkspaces>
  appState: AppStateStore
  chatRuntimes(): ModuleChatRuntimeOption[]
  registry(key: string): object | undefined
}

// The skill states an agent launched in the workspace would find the skill in.
const SKILL_PRESENT: ReadonlySet<ModuleSkillStatus> = new Set<ModuleSkillStatus>([
  'installed',
  'updated',
  'update-available',
  'local',
  'modified',
  'delivered-at-launch',
])

// The host's rule for a module-relative file path (an asset).
function validateAssetPath(relativePath: string, moduleId: string): string[] {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.startsWith('/') ||
    /[\\\0?#]/.test(relativePath)
  ) {
    throw new Error(`Extension "${moduleId}" asset path must be a module-relative file path, got "${relativePath}".`)
  }
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Extension "${moduleId}" asset path must be a module-relative file path, got "${relativePath}".`)
  }
  return parts
}
const mainInternals = new WeakMap<FakeMainHost, MainInternals>()

export function createFakeMainHost(options: FakeMainHostOptions): FakeMainHost {
  const { moduleId, permissions } = identityOf(options)
  const now = options.now ?? Date.now
  const workspaces = createFakeWorkspaces(options.workspaces ?? DEFAULT_FAKE_WORKSPACES, now)
  const capabilities = new Set<string>(options.capabilities ?? KNOWN_CAPABILITIES)
  const context: FakeServiceContext = {
    moduleId,
    permissions,
    now,
    workspaces,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    peer: (name) => (services as Partial<FakeServices>)[name] as never,
  }
  const appState = createAppStateStore(options.appState)
  let chatRuntimes = structuredClone([...(options.chatRuntimes ?? DEFAULT_FAKE_CHAT_RUNTIMES)])
  const skillStatuses = new Map<string, ModuleSkillStatus>()
  const skillKey = (workspaceRoot: string, skillId: string): string => `${workspaceRoot}\u0000${skillId}`

  // Every built-in fake is made up front, so a test can arrange its state
  // before the module resolves it.
  const registries = new Map<string, object>()
  const services = { workspaces } as Partial<FakeServices> & { workspaces: FakeWorkspaces }
  for (const [key, definition] of Object.entries(SERVICE_FAKES)) {
    const made = definition.create(context)
    registries.set(key, made.registry)
    if (definition.name && definition.name !== 'workspaces') {
      ;(services as Record<string, unknown>)[definition.name] = made.handle
    }
  }
  const fakes = services as FakeServices
  for (const [key, value] of Object.entries(options.storage?.global ?? {})) fakes.storage.seed(key, value)
  for (const [root, values] of Object.entries(options.storage?.workspaces ?? {})) {
    for (const [key, value] of Object.entries(values)) fakes.storage.seed(key, value, root)
  }

  const declared = new Map<string, ModuleMethodRegistration>()
  const operated = new Map<string, Promise<ModuleCallAnswer<ModuleMethodContract>>>()
  let operateSeq = 0
  async function callMethod(
    access: ModuleMethodAccess,
    method: string,
    params: unknown,
    commandId?: string,
  ): Promise<ModuleCallAnswer<ModuleMethodContract>> {
    const registration = declared.get(method)
    if (!registration) {
      return {
        ok: false,
        code: 'extension_method_unknown',
        message: `Extension "${moduleId}" declares no method "${method}".`,
      }
    }
    if (registration.access !== access) {
      return {
        ok: false,
        code: 'extension_method_unknown',
        message: `Extension "${moduleId}" declares "${method}" as ${registration.access === 'operate' ? 'an operate' : 'a read'} method: call it with extension.${registration.access}.`,
      }
    }
    const problem = params === undefined ? null : jsonValueProblem(params, 'params')
    if (problem) throw new Error(`The params of "${method}" are not JSON: ${problem}`)
    const parsed = registration.params(params === undefined ? undefined : structuredClone(params))
    if (!parsed.ok) return { ok: false, code: 'invalid_params', message: parsed.message }
    const answer = await registration.handler(parsed.params, {
      clientId: 'owner',
      ...(commandId === undefined ? {} : { commandId: `owner:${commandId}` }),
    })
    if (answer?.ok === true) {
      const resultProblem = answer.result === undefined ? null : jsonValueProblem(answer.result, 'result')
      if (resultProblem)
        throw new Error(
          `Extension "${moduleId}" method "${method}" answered a result that is not JSON: ${resultProblem}`,
        )
      return { ok: true, result: answer.result === undefined ? null : structuredClone(answer.result) }
    }
    if (answer?.ok === false && typeof answer.code === 'string' && typeof answer.message === 'string')
      return { ok: false, code: answer.code, message: answer.message }
    throw new Error(
      `Extension "${moduleId}" method "${method}" answered neither { ok: true, result } nor { ok: false, code, message }.`,
    )
  }
  const tools = new Map<string, McpToolRegistration>()
  // Each point's handlers, in the order registered.
  const hookHandlers = new Map<ExtensionHookPoint, Array<(event: unknown) => unknown>>()
  // One registration each, as Studio keeps them: the same function twice is called twice.
  const eventHandlers = new Map<ExtensionEventName, Array<{ handler: (payload: unknown) => unknown }>>()
  const startupHooks: Array<() => unknown> = []
  const shutdownBeginHooks: Array<() => unknown> = []
  const shutdownHooks: Array<() => unknown> = []
  const emitListeners = new Set<(topic: string, payload: unknown) => void>()
  const builtinSkills = new Set(options.builtinSkills ?? [])

  const fake: FakeMainHost = {
    host: undefined as unknown as MainHost,
    permissions,
    methods: {
      read: (method, params) => callMethod('read', method, params) as never,
      operate: (method, params, options) => {
        // As the window does: a call is its own command unless it names one,
        // and a retry under the same id is answered with the first answer.
        const commandId = options?.commandId ?? `fake-${(operateSeq += 1)}`
        const known = operated.get(commandId)
        if (known) return known as never
        const answer = callMethod('operate', method, params, commandId)
        operated.set(commandId, answer)
        void answer.then(
          (settled) => {
            if (!settled.ok && ['extension_method_unknown', 'invalid_params'].includes(settled.code))
              operated.delete(commandId)
          },
          () => operated.delete(commandId),
        )
        return answer as never
      },
      declared: () => [...declared].map(([name, registration]) => ({ name, access: registration.access })),
    },
    hooks: {
      async fire(point, event) {
        const listed = options.manifest?.contributes?.hooks
        if (listed && !listed.some((entry) => entry.point === point))
          throw new Error(`extension.json lists no hook for "${point}" (contributes.hooks).`)
        const handlers = hookHandlers.get(point)
        if (!handlers) throw new Error(`The worker registered no hook for "${point}".`)
        const answer = await chainExtensionHookHandlers(handlers, structuredClone(event))
        return readExtensionHookAnswer(point, event as unknown as Record<string, unknown>, answer)
      },
      registered: () => [...hookHandlers.keys()],
    },
    events: {
      async fire(event, payload) {
        const listed = options.manifest?.contributes?.events
        if (listed && !listed.some((entry) => entry.on === event))
          throw new Error(`extension.json lists no event "${event}" (contributes.events).`)
        const needed = EXTENSION_EVENT_SPECS[event].permission
        if (
          !covered(
            `events.${event}`,
            needed === null ? undefined : { extension: needed, invoker: null, refusal: 'throw' },
          )
        )
          return
        for (const { handler } of [...(eventHandlers.get(event) ?? [])]) await handler(structuredClone(payload))
      },
      heard: () => [...eventHandlers].filter(([, handlers]) => handlers.length > 0).map(([event]) => event),
    },
    tools: {
      async call(name, args = {}, metadata) {
        const tool = tools.get(name)
        if (!tool)
          throw new Error(
            `No MCP tool "${name}" is registered; the module registered ${[...tools.keys()].join(', ') || 'none'}.`,
          )
        const first = workspaces.all()[0]
        const connection: McpConnectionMetadata = metadata ?? {
          kind: 'studio-agent',
          ...(first ? { workspaceId: first.id } : {}),
          agentId: 'agent-1',
          agentName: 'Test agent',
          cliId: 'claude',
        }
        const result = await tool.handler(structuredClone(args), { metadata: connection })
        if (!result || !Array.isArray(result.content)) {
          throw new Error(`MCP tool "${name}" answered without a content array; the gateway would refuse the result.`)
        }
        return structuredClone(result)
      },
      list: () => [...tools.values()],
    },
    emitted: [],
    notifications: [],
    commandRuns: [],
    skills: {
      ensured: [],
      setStatus(workspaceRoot, skillId, status) {
        skillStatuses.set(skillKey(workspaceRoot, skillId), status)
      },
    },
    sidecars: [],
    services: fakes,
    resolved: [],
    undeclared: [],
    async startup() {
      await runAll(startupHooks)
    },
    async shutdown() {
      await runAll(shutdownBeginHooks)
      await runAll([...shutdownHooks].reverse())
    },
    onEmit(listener) {
      emitListeners.add(listener)
      return () => {
        emitListeners.delete(listener)
      }
    },
    appState: () => appState.all(),
    setAppState(key, value) {
      appState.set(key, value)
    },
    dispose() {
      const made = fakes.storage.dataDir()
      if (made && !options.dataDir) rmSync(dirname(made), { recursive: true, force: true })
    },
    setChatRuntimes(runtimes) {
      chatRuntimes = structuredClone([...runtimes])
    },
  }

  // The host's gate, for the extension's side: whether its permissions cover
  // `what`. A refusal is recorded, once per method.
  function covered(what: string, requirement: ExtensionHostRequirement | undefined): boolean {
    if (!requirement || requirement.extension === null || permissions.has(requirement.extension)) return true
    if (!fake.undeclared.some((entry) => entry.what === what))
      fake.undeclared.push({ what, needs: [requirement.extension] })
    return false
  }
  // A host method, through the gate; throws as the host does.
  function use(method: keyof typeof EXTENSION_MAIN_HOST_METHODS): void {
    const requirement = EXTENSION_MAIN_HOST_METHODS[method]
    // Every caller of `use` throws its refusal (an async method's becomes its rejection).
    if (!covered(method, requirement)) void refuseUndeclared(moduleId, method, { ...requirement, refusal: 'throw' })
  }
  // A service as the host hands it to an extension: each method through the
  // gate, and what a method hands back that can be called too (its row under
  // `returns`), as the host does.
  function gated<T>(key: string, registry: T): T {
    const service = extensionHostService(key)
    if (!service || registry === null || typeof registry !== 'object') return registry
    const call =
      (fn: unknown, self: unknown, path: string, requirement: ExtensionHostRequirement | undefined) =>
      (...args: unknown[]) => {
        const what = `${key}.${path}`
        if (!requirement) throw new Error(`"${what}" is not a host method an extension may call.`)
        if (!covered(what, requirement)) return refuseUndeclared(moduleId, what, requirement)
        return handBack((fn as (...given: unknown[]) => unknown).apply(self, args), path)
      }
    const rowOf = (path: string): ExtensionHostRequirement | undefined => {
      const [method, ...rest] = path.split('.')
      return method ? service.returns?.[method]?.[rest.join('.')] : undefined
    }
    // One stand-in per thing handed back, so a handle handed back twice is the same one.
    const handedBack = new WeakMap<object, Map<string, unknown>>()
    function handBack(result: unknown, path: string): unknown {
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        !(result instanceof Promise)
      ) {
        const known = handedBack.get(result)?.get(path)
        if (known !== undefined) return known
        const made = handBackOnce(result, path)
        if (made !== result) {
          if (!handedBack.has(result)) handedBack.set(result, new Map())
          handedBack.get(result)!.set(path, made)
        }
        return made
      }
      return handBackOnce(result, path)
    }
    function handBackOnce(result: unknown, path: string): unknown {
      if (result instanceof Promise) return result.then((settled) => handBack(settled, path))
      if (typeof result === 'function') return call(result, undefined, `${path}.()`, rowOf(`${path}.()`))
      if (result === null || typeof result !== 'object' || Array.isArray(result)) return result
      if (!Object.values(result).some((value) => typeof value === 'function')) return result
      const handle: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(result))
        handle[name] =
          typeof value === 'function' ? call(value, result, `${path}.${name}`, rowOf(`${path}.${name}`)) : value
      return handle
    }
    const facade: Record<string, unknown> = {}
    for (const [name, requirement] of Object.entries(service.methods)) {
      const member = (registry as Record<string, unknown>)[name]
      if (typeof member === 'function') facade[name] = call(member, registry, name, requirement)
    }
    return facade as T
  }
  const knownSkill = (skillId: string): boolean => builtinSkills.has(skillId)
  // What the installer would find, without writing anything.
  function skillStatus(workspaceRoot: string, skillId: string): ModuleSkillStatusResult {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      return { ok: false, status: 'missing-workspace', message: 'No workspace root was given.' }
    }
    if (!knownSkill(skillId)) {
      return { ok: false, status: 'unknown-skill', message: `No skill "${skillId}" is registered.` }
    }
    const status = skillStatuses.get(skillKey(workspaceRoot, skillId)) ?? 'missing'
    return { ok: SKILL_PRESENT.has(status), status }
  }

  function resolve<T>(token: ServiceToken<T>, required: boolean): T | undefined {
    const key = token?.key
    const override = options.services && Object.hasOwn(options.services, key) ? options.services[key] : undefined
    if (override === undefined && !registries.has(key)) {
      throw new Error(`Service "${key}" is not available to third-party modules.`)
    }
    if (override === null) {
      if (required)
        throw new Error(`Extension "${moduleId}" requires service "${key}", which no enabled module provides.`)
      return undefined
    }
    if (!fake.resolved.includes(key)) fake.resolved.push(key)
    return gated(key, (override ?? registries.get(key)) as T)
  }

  const host: MainHost = {
    moduleId,
    supports: (capability) => capabilities.has(capability),
    async listChatRuntimes() {
      use('listChatRuntimes')
      return structuredClone(chatRuntimes)
    },
    registerMethods(batch) {
      if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
        throw new Error(`Extension "${moduleId}" declares its methods as an object of name to method.`)
      }
      const entries = Object.entries(batch as unknown as Record<string, ModuleMethodRegistration>)
      for (const [name, registration] of entries) {
        if (!isModuleMethodName(name)) {
          throw new Error(
            `Extension "${moduleId}" method "${name}" is not a method name: a lower-case letter, then letters, digits, dots and dashes, at most ${MODULE_METHOD_MAX_CHARS}.`,
          )
        }
        if (declared.has(name)) throw new Error(`Extension "${moduleId}" already declares "${name}".`)
        const access = (registration as { access?: unknown } | null)?.access
        if (access !== 'read' && access !== 'operate') {
          throw new Error(`Extension "${moduleId}" method "${name}" must say its access: "read" or "operate".`)
        }
        if (typeof registration.params !== 'function') {
          throw new Error(
            `Extension "${moduleId}" method "${name}" has no params validator; every method reads its params.`,
          )
        }
        if (typeof registration.handler !== 'function') {
          throw new Error(`Extension "${moduleId}" method "${name}" has no handler.`)
        }
      }
      for (const [name, registration] of entries) declared.set(name, registration)
    },
    registerMcpTools(batch) {
      use('registerMcpTools')
      const names = new Set<string>()
      for (const tool of batch) {
        if (tools.has(tool.name))
          throw new Error(`MCP tool "${tool.name}" is already registered by module "${moduleId}".`)
        if (names.has(tool.name))
          throw new Error(`MCP tool "${tool.name}" is registered twice by module "${moduleId}".`)
        names.add(tool.name)
      }
      // The manifest declares every tool, and its words and access are what agents see.
      const declared = options.manifest?.contributes?.mcpTools
      for (const tool of batch) {
        if (declared && !declared.some((entry) => entry.name === tool.name)) {
          throw new Error(`MCP tool "${tool.name}" is not declared in extension.json (contributes.mcpTools).`)
        }
      }
      for (const tool of batch) {
        const entry = declared?.find((candidate) => candidate.name === tool.name)
        tools.set(
          tool.name,
          entry
            ? { ...tool, description: entry.description, mutates: entry.access === 'operate' }
            : { ...tool, mutates: tool.mutates !== false },
        )
      }
    },
    registerHooks(handlers) {
      use('registerHooks')
      if (handlers === null || typeof handlers !== 'object' || Array.isArray(handlers))
        throw new Error(`Extension "${moduleId}" registers its hooks as an object of point to handler.`)
      const listed = options.manifest?.contributes?.hooks
      const entries = Object.entries(handlers)
      for (const [point, handler] of entries) {
        if (!isExtensionHookPoint(point)) throw new Error(`"${point}" is not a hook point Studio has.`)
        if (listed && !listed.some((entry) => entry.point === point))
          throw new Error(
            `Hook "${point}" from extension "${moduleId}" is not listed in its extension.json (contributes.hooks).`,
          )
        if (typeof handler !== 'function')
          throw new Error(`Hook "${point}" from extension "${moduleId}" has no handler.`)
      }
      const added = entries as Array<[ExtensionHookPoint, (event: unknown) => unknown]>
      for (const [point, handler] of added) hookHandlers.set(point, [...(hookHandlers.get(point) ?? []), handler])
      return () => {
        for (const [point, handler] of added) {
          const left = hookHandlers.get(point)?.filter((each) => each !== handler)
          if (left) hookHandlers.set(point, left)
        }
      }
    },
    events: Object.freeze({
      on(event: unknown, handler: unknown) {
        const listed = options.manifest?.contributes?.events
        if (!isExtensionEventName(event) || (listed && !listed.some((entry) => entry.on === event)))
          throw new Error(
            `Event "${String(event)}" is not listed in extension "${moduleId}"'s extension.json (contributes.events).`,
          )
        if (typeof handler !== 'function') throw new Error(`The handler for event "${event}" is not a function.`)
        const registration = { handler: handler as (payload: unknown) => unknown }
        let list = eventHandlers.get(event)
        if (!list) eventHandlers.set(event, (list = []))
        list.push(registration)
        return {
          dispose: () => {
            const now = eventHandlers.get(event)
            const at = now?.indexOf(registration) ?? -1
            if (at >= 0) now!.splice(at, 1)
          },
        }
      },
    }) as MainHost['events'],
    async ensureSkillInstalled(workspaceRoot, skillId) {
      use('ensureSkillInstalled')
      fake.skills.ensured.push({ workspaceRoot, skillId })
      const found = skillStatus(workspaceRoot, skillId)
      if (found.status === 'missing') {
        skillStatuses.set(skillKey(workspaceRoot, skillId), 'installed')
        return { ok: true, status: 'installed' }
      }
      if (found.status === 'update-available') {
        skillStatuses.set(skillKey(workspaceRoot, skillId), 'installed')
        return { ok: true, status: 'updated' }
      }
      return found
    },
    async getSkillStatus(workspaceRoot, skillId) {
      use('getSkillStatus')
      return skillStatus(workspaceRoot, skillId)
    },
    getModuleDataDir() {
      use('getModuleDataDir')
      const key = 'core.module-storage'
      const storage = (
        options.services && Object.hasOwn(options.services, key) ? options.services[key] : registries.get(key)
      ) as { dataDir?: (moduleId: string) => string } | null | undefined
      if (typeof storage?.dataDir !== 'function') {
        throw new Error(`Extension "${moduleId}" asked for its data directory, and no storage service is provided.`)
      }
      return storage.dataDir(moduleId)
    },
    getAssetPath(relativePath) {
      validateAssetPath(relativePath, moduleId)
      const root = options.moduleRoot ?? process.cwd()
      const listed = options.verifiedFiles ? options.verifiedFiles.includes(relativePath) : true
      const path = resolvePath(root, relativePath)
      if (!listed || !existsSync(path)) {
        throw new Error(`"${relativePath}" is not among module "${moduleId}"'s verified files.`)
      }
      return path
    },
    async getWorkspaceGitInfo(workspaceId) {
      const requirement = EXTENSION_MAIN_HOST_METHODS.getWorkspaceGitInfo
      if (!covered('getWorkspaceGitInfo', requirement))
        return refuseUndeclared(moduleId, 'getWorkspaceGitInfo', requirement)
      return workspaces.gitInfo(workspaceId)
    },
    async getModuleAppState<T = unknown>(key: string): Promise<T | undefined> {
      use('getModuleAppState')
      if (typeof key !== 'string' || key.trim().length === 0) return undefined
      return appState.get(key) as T | undefined
    },
    watchModuleAppState(cb) {
      use('watchModuleAppState')
      // Heard on change only, not on subscribe, as the host's main half is.
      return appState.subscribe(cb)
    },
    getService: (token) => resolve(token, false),
    requireService: (token) => resolve(token, true) as never,
    onStartup(hook) {
      startupHooks.push(hook)
    },
    onShutdownBegin(hook) {
      shutdownBeginHooks.push(hook)
    },
    onShutdown(hook) {
      shutdownHooks.push(hook)
    },
    registerSidecar(spec) {
      fake.sidecars.push({ ...spec })
      return {
        start: async () => {
          throw new Error(`Sidecar "${spec.id}" was registered without a lifecycle and cannot be started.`)
        },
        stop: async () => {},
        status: () => ({ id: spec.id, moduleId, kind: spec.kind, description: spec.description, state: 'declared' }),
      }
    },
    notify(input) {
      use('notify')
      fake.notifications.push(validateNotify(moduleId, input))
    },
    async runCommand(action) {
      use('runCommand')
      if (!(EXTENSION_COMMAND_ACTIONS as readonly string[]).includes(action))
        throw new Error(`"${String(action)}" is not one of Studio's actions an extension may run.`)
      fake.commandRuns.push(action)
    },
    emit(topic, payload) {
      const valid = validateTopic(moduleId, topic)
      // The payload crosses the Studio protocol: one that is not JSON throws here as it would there.
      const problem = payload === undefined ? null : jsonValueProblem(payload)
      if (problem)
        throw new Error(
          `Extension "${moduleId}" emitted a "${valid}" payload that cannot be sent to a client: ${problem}.`,
        )
      const cloned = payload === undefined ? undefined : structuredClone(payload)
      fake.emitted.push(cloned === undefined ? { topic: valid } : { topic: valid, payload: cloned })
      for (const listener of emitListeners) listener(valid, structuredClone(cloned))
    },
  }
  fake.host = host
  mainInternals.set(fake, {
    moduleId,
    workspaces,
    appState,
    chatRuntimes: () => structuredClone(chatRuntimes),
    registry: (key) => registries.get(key),
  })
  return fake
}

async function runAll(hooks: ReadonlyArray<() => unknown>): Promise<void> {
  const errors: unknown[] = []
  for (const hook of hooks) {
    try {
      await hook()
    } catch (error) {
      errors.push(error)
    }
  }
  // The host logs a failing hook and carries on; a test should hear about it.
  if (errors.length > 0) throw errors[0]
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render a React tree to HTML in Node, waiting for `lazy` components and
 * Suspense to settle. Rejects with the error when a component throws, so a
 * door that cannot render fails its test. Needs `react` and `react-dom`
 * installed beside the test.
 *
 * The comments a server render puts between adjacent text nodes (`<!-- -->`)
 * are dropped, so `Preview: {greeting}` reads as `Preview: Hello` to a
 * text assertion, as it does on screen.
 */
export async function renderToHtml(node: ReactNode): Promise<string> {
  const { prerender } = await import('react-dom/static')
  const errors: unknown[] = []
  const { prelude } = await prerender(node, {
    onError(error: unknown) {
      errors.push(error)
    },
  })
  const chunks: string[] = []
  const decoder = new TextDecoder()
  const reader = prelude.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value, { stream: true }))
  }
  chunks.push(decoder.decode())
  if (errors.length > 0) throw errors[0]
  return chunks.join('').replaceAll('<!-- -->', '')
}

// ── A surface in its frame ──────────────────────────────────────────────────

export type FakeFrameStudioOptions = FakeModuleIdentity & {
  /**
   * The extension's worker: `methods` (`worker.read` / `worker.operate`)
   * reaches its declared methods, `on('push')` hears its `emit`, and the
   * Settings values, storage, Backlog and usage are its.
   */
  main?: FakeMainHost
  /** The open workspaces. Default: the main fake's, or one `ws-app`. */
  workspaces?: readonly ModuleWorkspaceView[]
  /** Backlog items per workspace id, seeded into the Backlog (`services.backlog`). */
  backlogItems?: Record<string, readonly FakeBacklogItemInput[]>
  /** Settings values already saved (added to the main fake's, given one). */
  settings?: Record<string, unknown>
  /** The files of each workspace's folder, by workspace id and path relative to it. */
  files?: Record<string, Record<string, string>>
  /**
   * What whoever opened the surface holds, in Studio protocol permission names.
   * Default: every one (the person at this machine). Give a paired device's to
   * see what it is refused.
   */
  invoker?: readonly string[]
  /** Default: `light`. */
  colorScheme?: 'light' | 'dark'
  /** The clock the fakes stamp with. Default: `Date.now`. */
  now?: () => number
  /**
   * The file a custom editor is open on (`studio.document`, for a surface whose
   * point is `customEditors`): its text, or its bytes, and whether Studio would
   * save it. Default: empty text.
   */
  document?: { text: string; readOnly?: boolean } | { bytes: Uint8Array; readOnly?: boolean }
  /** Secrets already set, by name (their values never reach a surface). */
  secrets?: Record<string, string>
  /**
   * Answers that stand in for Studio's, by host method: a value, or a function
   * of the params (which may throw `hostError(code)`). A call is still checked
   * against the permissions first, so a stub never admits what Studio refuses.
   */
  results?: Partial<Record<ExtensionFrameMethod, unknown>>
}

/** The document behind a custom editor's `studio.document`, as Studio holds it. */
export type FakeEditorDocument = {
  /** The document as it is now, at its version. */
  current(): ExtensionEditorDocument
  /** Its text, for a text document. */
  readonly text: string | undefined
  /** Its bytes, for a bytes document. */
  readonly bytes: Uint8Array | undefined
  /** Every edit Studio accepted, in order. */
  edits: ExtensionEditorEdit[]
  /** Every edit Studio refused, with the code it was refused with. */
  refused: Array<{ edit: ExtensionEditorEdit; code: string }>
  /** The file changed outside the editor (on disk, in the text editor): a new version is handed over. */
  replace(content: string | Uint8Array): void
  /**
   * Save, as Studio does: ask the editor to hand over what it holds back
   * (`onWillSave`), and wait for it. Resolves false when the editor did not
   * answer within Studio's deadline or its listener failed.
   */
  save(): Promise<boolean>
}

export type FakeFrameStudio = {
  /** Every host call, with its params, in order (refused ones too). */
  calls: Array<{ method: string; params: unknown }>
  /** Calls the manifest's permissions do not cover. A clean extension leaves this empty. */
  undeclared: FakeUndeclaredUse[]
  /** Toasts shown, in order. */
  toasts: Array<{ tone: ModuleToastTone; message: string; detail?: string }>
  /** Chats opened with a drafted message. */
  drafts: Array<{ workspaceId: string; prompt: string; name?: string }>
  /** Doors opened, by id. */
  openedDoors: string[]
  /** Chats and files brought to the front. */
  focusedTabs: Array<{ workspaceId: string; kind: 'chat' | 'file'; id: string }>
  /** Bell rows raised with `notify`. */
  notifications: ModuleNotifyInput[]
  /** Lines written to its log (`log.write`), in order. */
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }>
  /** Every surface that called `ready()`, in order. */
  readied: ExtensionSurface[]
  /** URLs opened with `shell.openExternal`, in order. */
  openedUrls: string[]
  /**
   * Grant one gesture: the next `shell.openExternal` within a second is
   * admitted, as a press on a still Studio control grants one in a
   * components panel. Without one it is `not_permitted`.
   */
  grantGesture(): void
  /** A components panel's persisted atoms as stored: the extension's, and each workspace's. */
  atoms(): {
    plugin: Record<string, { version: number; value: unknown }>
    workspace: Record<string, Record<string, { version: number; value: unknown }>>
  }
  /** Seed persisted atoms, as an earlier run (or an older version, to test `migrate`) stored them. */
  seedAtoms(
    scope: 'plugin' | 'workspace',
    values: Record<string, { version: number; value: unknown }>,
    workspaceId?: string,
  ): void
  /** The names of the secrets set (their values never reach a surface). */
  secretNames(): string[]
  /** The world the surface reads and writes: the main fake's when given one. */
  services: Pick<FakeServices, 'workspaces' | 'backlog' | 'usage' | 'storage'>
  /** The Settings values as saved. */
  settings(): Record<string, unknown>
  /** A workspace's file as it is now, or undefined. */
  file(workspaceId: string, path: string): string | undefined
  /** Deliver a worker event to `on('push')` listeners. */
  emit(topic: string, payload?: unknown): void
  /**
   * Deliver one of Studio's events to the `studio.on(event)` listeners whose
   * subscription was admitted (the extension's permissions and the invoker's
   * hold what the event needs), as Studio would.
   */
  studioEvent<E extends ExtensionFrameEventName>(event: E, payload: ExtensionEventPayloads[E]): void
  /** Change the theme; `on('theme')` listeners hear it. */
  setColorScheme(scheme: 'light' | 'dark'): void
  /** The `studio` one surface's `mount` is handed. */
  studio(surface: ExtensionSurface): ExtensionMountStudio
  /** The document a custom editor's `studio.document` is open on. */
  document: FakeEditorDocument
  /** Run a ui entry's `mount` into `root` as Studio does in the frame. Resolves to what closing it runs. */
  mount(
    entry: { mount: (root: HTMLElement, studio: ExtensionMountStudio) => unknown },
    surface: ExtensionSurface,
    root: HTMLElement,
  ): Promise<() => void>
}

const TOAST_TONES: ReadonlySet<string> = new Set<ModuleToastTone>(['neutral', 'accent', 'good', 'warn', 'error'])

type Registry = Record<string, (moduleId: string, ...args: never[]) => Promise<unknown>>

function frameError(code: ExtensionFrameErrorCode, message: string): ExtensionFrameError {
  return Object.assign(new Error(message), { code, retryable: false })
}

/** A refusal as Studio makes it, for a stubbed answer (`results`) to throw. */
export function hostError(code: ExtensionFrameErrorCode, message?: string): ExtensionFrameError {
  return frameError(code, message ?? `Studio refused the call (${code}).`)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The window's side of a custom editor's document, as Studio keeps it: it
 * numbers each document it hands over, refuses an edit made against an older
 * one with `conflict`, and asks the editor to flush before a save. The frame's
 * side is Studio's own `studio.document` (EDITOR_DOCUMENT_SCRIPT), run here as
 * it runs in the frame.
 */
function createFakeEditor(initial: NonNullable<FakeFrameStudioOptions['document']>): {
  controller: FakeEditorDocument
  api(): ExtensionEditorDocumentApi
} {
  const toContent = (value: string | Uint8Array): ExtensionEditorContent =>
    typeof value === 'string' ? { kind: 'text', text: value } : { kind: 'bytes', bytes: value.slice().buffer }
  let document: ExtensionEditorDocument = {
    version: 1,
    readOnly: initial.readOnly === true,
    content: toContent('text' in initial ? initial.text : initial.bytes),
  }
  const ports = new Set<{ hear: (event: string, payload: unknown) => void }>()
  const clone = (doc: ExtensionEditorDocument): ExtensionEditorDocument => structuredClone(doc)
  const handOver = () => {
    for (const port of ports) port.hear('document', clone(document))
  }
  let nextFlush = 1
  const flushes = new Map<number, (ok: boolean) => void>()
  const controller: FakeEditorDocument = {
    current: () => clone(document),
    get text() {
      return document.content.kind === 'text' ? document.content.text : undefined
    },
    get bytes() {
      return document.content.kind === 'bytes' ? new Uint8Array(document.content.bytes.slice(0)) : undefined
    },
    edits: [],
    refused: [],
    replace(value) {
      document = { ...document, version: document.version + 1, content: toContent(value) }
      handOver()
    },
    save() {
      if (ports.size === 0) return Promise.resolve(true)
      const id = nextFlush++
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), EXTENSION_EDITOR_FLUSH_TIMEOUT_MS)
        const settle = (ok: boolean) => {
          clearTimeout(timer)
          flushes.delete(id)
          resolve(ok)
        }
        flushes.set(id, settle)
        for (const port of ports) port.hear('document.flush', { id })
      })
    },
  }
  const factory = new Function(`return (${EDITOR_DOCUMENT_SCRIPT})`)() as (port: EditorDocumentPort) => unknown
  return {
    controller,
    api() {
      const listeners = new Map<string, Set<(payload: unknown) => void>>()
      const port = {
        hear(event: string, payload: unknown) {
          for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
        },
      }
      ports.add(port)
      const api = factory({
        async call(_method, params) {
          await Promise.resolve()
          const edit = structuredClone(params) as ExtensionEditorEdit
          const refuse = (code: ExtensionFrameErrorCode, message: string, current?: ExtensionEditorDocument) => {
            controller.refused.push({ edit, code })
            throw Object.assign(frameError(code, message), current ? { document: current } : {})
          }
          if (document.readOnly) refuse('not_permitted', 'This document is read only.')
          if (edit.content.kind !== document.content.kind)
            refuse('invalid_params', `This editor edits ${document.content.kind}.`)
          if (edit.baseVersion !== document.version)
            refuse('conflict', 'The file changed outside this editor; edit the latest document.', clone(document))
          document = { ...document, content: edit.content }
          controller.edits.push(structuredClone(edit))
          return null
        },
        on(event, listener) {
          let set = listeners.get(event)
          if (!set) listeners.set(event, (set = new Set()))
          set.add(listener)
          return () => set.delete(listener)
        },
        post(_event, payload) {
          const { id, ok } = (payload ?? {}) as { id?: number; ok?: boolean }
          if (typeof id === 'number') flushes.get(id)?.(ok === true)
        },
      }) as ExtensionEditorDocumentApi
      queueMicrotask(() => port.hear('document', clone(document)))
      return api
    },
  }
}

function filePathParts(path: unknown): string[] | null {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\\0]/.test(path)) return null
  const parts = path.split('/')
  return parts.some((part) => !part || part === '.' || part === '..') ? null : parts
}

/**
 * The `studio` a surface's `mount` is handed in its frame, with a fake Studio
 * behind `host.call`: every call is checked as Studio checks it, against the
 * manifest's permissions and against what whoever opened the surface holds
 * (`invoker`), and carried out against stateful fakes.
 */
export function createFakeFrameStudio(options: FakeFrameStudioOptions): FakeFrameStudio {
  const main = options.main
  const { moduleId, permissions } =
    !options.moduleId && !options.manifest && main
      ? { moduleId: main.host.moduleId, permissions: main.permissions }
      : identityOf(options)
  const internals = main ? mainInternals.get(main) : undefined
  const invoker = options.invoker ? new Set(options.invoker) : null
  const doors = new Set((options.manifest?.contributes?.doors ?? []).map((door) => door.id))

  const world = ((): {
    workspaces: FakeWorkspaces
    registry: (key: string) => Registry
    handles: Pick<FakeServices, 'backlog' | 'usage' | 'storage'>
    settings: AppStateStore
  } => {
    if (main && internals) {
      return {
        workspaces: internals.workspaces,
        registry: (key) => internals.registry(key) as Registry,
        handles: { backlog: main.services.backlog, usage: main.services.usage, storage: main.services.storage },
        settings: internals.appState,
      }
    }
    const own = createFakeWorkspaces(options.workspaces ?? DEFAULT_FAKE_WORKSPACES, options.now)
    const context: FakeServiceContext = { moduleId, permissions, now: options.now ?? Date.now, workspaces: own }
    const made = new Map<string, { registry: unknown; handle?: unknown }>()
    for (const key of ['backlog.module-service', 'usage.module-service', 'core.module-storage']) {
      made.set(key, SERVICE_FAKES[key]!.create(context))
    }
    return {
      workspaces: own,
      registry: (key) => made.get(key)!.registry as Registry,
      handles: {
        backlog: made.get('backlog.module-service')!.handle as FakeBacklog,
        usage: made.get('usage.module-service')!.handle as FakeUsage,
        storage: made.get('core.module-storage')!.handle as FakeServices['storage'],
      },
      settings: createAppStateStore(undefined),
    }
  })()
  for (const [key, value] of Object.entries(options.settings ?? {})) world.settings.set(key, value)
  for (const [workspaceId, items] of Object.entries(options.backlogItems ?? {})) {
    world.handles.backlog.seed(workspaceId, items)
  }
  const files = new Map<string, Map<string, string>>(
    Object.entries(options.files ?? {}).map(([id, byPath]) => [id, new Map(Object.entries(byPath))]),
  )

  let colorScheme: 'light' | 'dark' = options.colorScheme ?? 'light'
  const listeners = { theme: new Set<(payload: unknown) => void>(), push: new Set<(payload: unknown) => void>() }
  const hear = (event: 'theme' | 'push', payload: unknown) => {
    for (const listener of [...listeners[event]]) listener(structuredClone(payload))
  }
  // Studio's events: each one's listeners, and the ones whose subscription was admitted.
  const studioListeners = new Map<ExtensionFrameEventName, Set<(payload: unknown) => void>>()
  const admittedEvents = new Set<ExtensionFrameEventName>()

  const workspace = (workspaceId: unknown): ModuleWorkspaceView => {
    const found = world.workspaces.all().find((candidate) => candidate.id === workspaceId)
    if (!found?.folderPath) throw frameError('invalid_params', `No workspace "${String(workspaceId)}" with a folder.`)
    return found
  }
  const fileOf = (workspaceId: unknown, path: unknown): { byPath: Map<string, string>; key: string } => {
    const id = workspace(workspaceId).id
    const parts = filePathParts(path)
    if (!parts) throw frameError('invalid_params', '"path" is a path inside the workspace, relative to its folder.')
    let byPath = files.get(id)
    if (!byPath) files.set(id, (byPath = new Map()))
    return { byPath, key: parts.join('/') }
  }
  const storageRoot = (workspaceId: unknown) =>
    workspaceId === undefined ? {} : { workspaceRoot: workspace(workspaceId).folderPath! }

  type Stored = Record<string, { version: number; value: unknown }>
  const pluginAtoms: Stored = {}
  const workspaceAtoms = new Map<string, Stored>()
  const atomScope = (scope: unknown, workspaceId: unknown): Stored => {
    if (scope === 'plugin') return pluginAtoms
    if (scope !== 'workspace' || typeof workspaceId !== 'string')
      throw frameError('invalid_params', 'A workspace atom is stored for the workspace its panel was opened in.')
    let stored = workspaceAtoms.get(workspaceId)
    if (!stored) workspaceAtoms.set(workspaceId, (stored = {}))
    return stored
  }
  const secrets = new Map<string, string>(Object.entries(options.secrets ?? {}))
  let gestureUntil = 0
  const clock = options.now ?? Date.now

  type Params = Record<string, unknown>
  const serve: Record<ExtensionFrameMethod, (params: Params) => unknown> = {
    'atoms.read': (p) => ({
      plugin: structuredClone(pluginAtoms),
      workspace: typeof p.workspaceId === 'string' ? structuredClone(workspaceAtoms.get(p.workspaceId) ?? {}) : {},
    }),
    'atoms.write': (p) => {
      if (!Array.isArray(p.entries)) throw frameError('invalid_params', '"entries" lists the atoms that changed.')
      for (const entry of p.entries as Array<Record<string, unknown>>) {
        if (typeof entry.key !== 'string' || typeof entry.version !== 'number')
          throw frameError('invalid_params', 'Each atom has a key and a version.')
        atomScope(entry.scope, p.workspaceId)[entry.key] = {
          version: entry.version,
          value: structuredClone(entry.value),
        }
      }
      return { ok: true as const }
    },
    'assets.image': () => null,
    'secrets.has': (p) => ({ has: typeof p.key === 'string' && secrets.has(p.key) }),
    'secrets.set': (p) => {
      if (typeof p.key !== 'string' || typeof p.value !== 'string' || !p.value)
        throw frameError('invalid_params', 'A secret has a name and a value.')
      if (!Array.isArray(p.allowedOrigins) || p.allowedOrigins.length === 0)
        return { ok: false, code: 'origin_not_allowed', message: 'A secret names the https origins it may be sent to.' }
      secrets.set(p.key, p.value)
      return { ok: true as const }
    },
    'secrets.delete': (p) => {
      if (typeof p.key === 'string') secrets.delete(p.key)
      return { ok: true as const }
    },
    'shell.openExternal': (p) => {
      const url = String(p.url ?? '')
      if (!/^(https?:\/\/|mailto:)/iu.test(url))
        throw frameError('invalid_params', 'Only an https:, http: or mailto: URL opens.')
      if (clock() > gestureUntil)
        throw frameError('not_permitted', 'Opening a URL needs a press on one of Studio’s controls first.')
      gestureUntil = 0
      fake.openedUrls.push(url)
      return { opened: true }
    },
    'workspace.list': () => world.workspaces.all(),
    'workspace.get': (p) => world.workspaces.all().find((candidate) => candidate.id === p.workspaceId) ?? null,
    'backlog.list': (p) => world.registry('backlog.module-service').list(moduleId, p.workspaceId as never),
    'backlog.location': (p) => world.registry('backlog.module-service').getLocation(moduleId, p.workspaceId as never),
    'backlog.create': (p) =>
      world.registry('backlog.module-service').create(moduleId, p.workspaceId as never, p.input as never),
    'backlog.updateStatus': (p) =>
      world
        .registry('backlog.module-service')
        .updateStatus(moduleId, p.workspaceId as never, p.itemId as never, p.status as never),
    'backlog.updateTriage': (p) =>
      world
        .registry('backlog.module-service')
        .updateTriage(moduleId, p.workspaceId as never, p.itemId as never, p.triage as never),
    'backlog.addLink': (p) =>
      world
        .registry('backlog.module-service')
        .addLink(moduleId, p.workspaceId as never, p.itemId as never, p.link as never),
    'backlog.updateModuleMetadata': (p) =>
      world
        .registry('backlog.module-service')
        .updateModuleMetadata(moduleId, p.workspaceId as never, p.itemId as never, p.value as never),
    'usage.query': (p) => world.registry('usage.module-service').query(moduleId, p.query as never),
    'storage.get': (p) =>
      world.registry('core.module-storage').get(moduleId, { key: p.key, ...storageRoot(p.workspaceId) } as never),
    'storage.set': (p) =>
      world
        .registry('core.module-storage')
        .set(moduleId, { key: p.key, value: p.value, ...storageRoot(p.workspaceId) } as never),
    'storage.delete': (p) =>
      world.registry('core.module-storage').delete(moduleId, { key: p.key, ...storageRoot(p.workspaceId) } as never),
    'storage.list': (p) =>
      world.registry('core.module-storage').list(moduleId, {
        ...(p.prefix === undefined ? {} : { prefix: p.prefix }),
        ...storageRoot(p.workspaceId),
      } as never),
    'settings.get': () => world.settings.all(),
    'settings.set': (p) => {
      if (typeof p.key !== 'string' || !p.key) throw frameError('invalid_params', '"key" is the setting\'s name.')
      world.settings.set(p.key, p.value === null ? undefined : p.value)
      return { ok: true }
    },
    'files.read': async (p) => {
      const { byPath, key } = fileOf(p.workspaceId, p.path)
      const content = byPath.get(key)
      if (content === undefined) throw frameError('missing', `${key} does not exist.`)
      const bytes = new TextEncoder().encode(content)
      return {
        content: p.encoding === 'base64' ? Buffer.from(bytes).toString('base64') : content,
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      }
    },
    'files.stat': (p) => {
      const { byPath, key } = fileOf(p.workspaceId, p.path)
      const content = byPath.get(key)
      if (content !== undefined)
        return { type: 'file', size: new TextEncoder().encode(content).byteLength, modifiedAt: 0 }
      if ([...byPath.keys()].some((path) => path.startsWith(`${key}/`)))
        return { type: 'directory', size: 0, modifiedAt: 0 }
      throw frameError('missing', `${key} does not exist.`)
    },
    'files.search': (p) => {
      const id = workspace(p.workspaceId).id
      const query = String(p.query ?? '').toLowerCase()
      const limit = typeof p.limit === 'number' ? p.limit : 200
      const paths = [...(files.get(id)?.keys() ?? [])]
        .filter((path) => (path.split('/').at(-1) ?? '').toLowerCase().includes(query))
        .sort()
      return { paths: paths.slice(0, limit), truncated: paths.length > limit }
    },
    'files.write': async (p) => {
      const { byPath, key } = fileOf(p.workspaceId, p.path)
      if (typeof p.content !== 'string') throw frameError('invalid_params', '"content" is the text to write.')
      const exists = byPath.has(key)
      if (p.create === true && exists) throw frameError('conflict', `${key} already exists.`)
      if (typeof p.expectedSha256 === 'string') {
        const now = byPath.get(key)
        if (now === undefined || (await sha256Hex(new TextEncoder().encode(now))) !== p.expectedSha256)
          throw frameError('conflict', `${key} changed since it was read, so it was not written.`)
      }
      const text = p.encoding === 'base64' ? Buffer.from(p.content, 'base64').toString('utf8') : p.content
      byPath.set(key, text)
      const bytes = new TextEncoder().encode(text)
      return { size: bytes.byteLength, created: !exists, sha256: await sha256Hex(bytes) }
    },
    notify: (p) => {
      fake.notifications.push(validateNotify(moduleId, p))
      return { ok: true }
    },
    'worker.read': (p) =>
      main
        ? main.methods.read(p.method as never, p.params as never)
        : { ok: false, code: 'extension_unavailable', message: 'No worker in this test.' },
    'worker.operate': (p) =>
      main
        ? main.methods.operate(p.method as never, p.params as never)
        : { ok: false, code: 'extension_unavailable', message: 'No worker in this test.' },
    toast: (p) => {
      if (!TOAST_TONES.has(String(p.tone)) || typeof p.message !== 'string' || !p.message.trim())
        throw frameError('invalid_params', 'A toast needs a tone and a message.')
      fake.toasts.push({
        tone: p.tone as ModuleToastTone,
        message: p.message.trim(),
        ...(typeof p.detail === 'string' ? { detail: p.detail } : {}),
      })
      return { ok: true }
    },
    'chat.draft': (p) => {
      workspace(p.workspaceId)
      fake.drafts.push({
        workspaceId: String(p.workspaceId),
        prompt: String(p.prompt ?? ''),
        ...(typeof p.name === 'string' ? { name: p.name } : {}),
      })
      return { ok: true }
    },
    'tabs.focus': (p) => {
      if (p.kind !== 'chat' && p.kind !== 'file') throw frameError('invalid_params', '"kind" is chat or file.')
      fake.focusedTabs.push({ workspaceId: String(p.workspaceId), kind: p.kind, id: String(p.id) })
      return { focused: true }
    },
    'doors.open': (p) => {
      const opened = typeof p.id === 'string' && doors.has(p.id)
      if (opened) fake.openedDoors.push(p.id as string)
      return { opened }
    },
    'events.subscribe': (p) => {
      const event = p.event
      if (!isExtensionFrameEventName(event))
        throw frameError('invalid_params', '"event" names one of Studio\'s events.')
      const spec = EXTENSION_EVENT_SPECS[event]
      if (spec.permission !== null && !permissions.has(spec.permission)) {
        fake.undeclared.push({ what: `events.subscribe ${event}`, needs: [spec.permission] })
        throw frameError(
          'not_permitted',
          `Extension "${moduleId}" was not approved for "${spec.permission}", which the event ${event} needs.`,
        )
      }
      if (invoker && spec.invoker !== null && !invoker.has(spec.invoker))
        throw frameError(
          'not_permitted',
          `The event ${event} needs "${spec.invoker}", which whoever opened the surface does not hold.`,
        )
      admittedEvents.add(event)
      return { ok: true as const }
    },
    'log.write': (p) => {
      if (typeof p.message !== 'string' || p.message.length === 0)
        throw frameError('invalid_params', '"message" is a string.')
      const level = p.level === 'info' || p.level === 'warn' ? p.level : 'error'
      fake.logs.push({ level, message: p.message })
      return { ok: true as const }
    },
  }

  async function call(method: string, params: unknown): Promise<unknown> {
    fake.calls.push({ method, params: structuredClone(params) })
    const requirement = extensionFrameMethod(method)
    if (!requirement) throw frameError('unknown_method', `"${method}" is not a host method a frame may call.`)
    if (requirement.extension !== null && !permissions.has(requirement.extension)) {
      fake.undeclared.push({ what: method, needs: [requirement.extension] })
      throw frameError(
        'not_permitted',
        `Extension "${moduleId}" was not approved for "${requirement.extension}", which "${method}" needs.`,
      )
    }
    if (invoker && requirement.invoker !== null && !invoker.has(requirement.invoker))
      throw frameError(
        'not_permitted',
        `"${method}" needs "${requirement.invoker}", which whoever opened it does not hold.`,
      )
    const given = (params ?? {}) as Params
    if (typeof given !== 'object' || Array.isArray(given)) throw frameError('invalid_params', 'Params are an object.')
    const stub = options.results?.[method as ExtensionFrameMethod]
    if (stub !== undefined)
      return structuredClone(await (typeof stub === 'function' ? (stub as (params: Params) => unknown)(given) : stub))
    return structuredClone(await serve[method as ExtensionFrameMethod](given))
  }

  const editor = createFakeEditor(options.document ?? { text: '' })

  const fake: FakeFrameStudio = {
    document: editor.controller,
    calls: [],
    undeclared: [],
    toasts: [],
    drafts: [],
    openedDoors: [],
    focusedTabs: [],
    notifications: [],
    logs: [],
    readied: [],
    openedUrls: [],
    grantGesture() {
      gestureUntil = clock() + 1000
    },
    atoms: () => ({
      plugin: structuredClone(pluginAtoms),
      workspace: Object.fromEntries([...workspaceAtoms].map(([id, stored]) => [id, structuredClone(stored)])),
    }),
    seedAtoms(scope, values, workspaceId) {
      Object.assign(
        atomScope(scope, workspaceId ?? (scope === 'workspace' ? 'ws-app' : undefined)),
        structuredClone(values),
      )
    },
    secretNames: () => [...secrets.keys()].sort(),
    services: { workspaces: world.workspaces, ...world.handles },
    settings: () => world.settings.all(),
    file: (workspaceId, path) => files.get(workspaceId)?.get(path),
    emit: (topic, payload) => hear('push', payload === undefined ? { topic } : { topic, payload }),
    studioEvent(event, payload) {
      if (!admittedEvents.has(event)) return
      for (const listener of [...(studioListeners.get(event) ?? [])]) listener(structuredClone(payload))
    },
    setColorScheme(scheme) {
      colorScheme = scheme
      hear('theme', { colorScheme })
    },
    studio(surface) {
      let readied = false
      const methods = (): ModuleMethodsClient => {
        const answered = (method: 'worker.read' | 'worker.operate', name: string, params: unknown) =>
          call(method, { method: name, params }).catch((error: { code?: string; message?: string }) => ({
            ok: false,
            code: error?.code ?? 'unavailable',
            message: error?.message ?? String(error),
          }))
        return {
          read: (name, params) => answered('worker.read', name, params) as never,
          operate: (name, params) => answered('worker.operate', name, params) as never,
        }
      }
      return Object.freeze({
        api: Object.freeze({ version: 1 as const }),
        surface: Object.freeze({ ...surface }),
        ...(surface.point === 'customEditors' ? { document: editor.api() } : {}),
        host: Object.freeze({
          call: (method: string, params: unknown) => call(method, params),
          has: (method: string) => extensionFrameMethod(method) !== undefined,
        }),
        methods,
        get theme() {
          return { colorScheme }
        },
        on(event: string, listener: (payload: never) => void) {
          if (isExtensionFrameEventName(event)) {
            let heard = studioListeners.get(event)
            if (!heard) studioListeners.set(event, (heard = new Set()))
            const entry = (payload: unknown) => listener(payload as never)
            // The first listener subscribes; a refusal is the frame's console's, and so its log's.
            if (heard.size === 0)
              call('events.subscribe', { event }).catch((error: { message?: string }) =>
                fake.logs.push({ level: 'error', message: String(error?.message ?? error) }),
              )
            heard.add(entry)
            const set = heard
            return { dispose: () => set.delete(entry) }
          }
          const set = listeners[event as 'theme' | 'push']
          if (!set) throw new TypeError(`No frame event "${String(event)}".`)
          const entry = (payload: unknown) => listener(payload as never)
          set.add(entry)
          return { dispose: () => set.delete(entry) }
        },
        ready() {
          if (readied) return
          readied = true
          fake.readied.push({ ...surface })
        },
      }) as ExtensionMountStudio
    },
    async mount(entry, surface, root) {
      const cleanup = await entry.mount(root, fake.studio(surface))
      return () => {
        if (typeof cleanup === 'function') (cleanup as () => void)()
      }
    },
  }
  main?.onEmit((topic, payload) => fake.emit(topic, payload))
  return fake
}
