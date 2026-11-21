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
// - `createFakeRendererHost` is the window's `studio` (a `RendererHost`) that
//   records every toast and opened link; `studio(surface)` is what one
//   `mount` is handed, and `mount` runs a ui entry against a root you give
//   it. `methods`, `subscribe`, the extension's app state, the Backlog and
//   usage reach a fake main host when given one.
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
import { dirname, resolve as resolvePath } from 'node:path'

import { jsonValueProblem } from './json-value.js'
import { isModuleMethodName, MODULE_METHOD_MAX_CHARS } from './methods.js'
import type { HostCapability } from './host-api.js'
import type {
  BacklogItemView,
  ExtensionMountStudio,
  ExtensionSurface,
  MainHost,
  McpConnectionMetadata,
  McpToolRegistration,
  McpToolResult,
  ModuleCallAnswer,
  ModuleColorScheme,
  ModuleMethodAccess,
  ModuleMethodContract,
  ModuleMethodContracts,
  ModuleMethodRegistration,
  ModuleMethodsClient,
  ModuleFocusTabInput,
  ModuleNotificationTarget,
  ModuleNotifyInput,
  ModuleOpenExternalResult,
  ModuleSkillStatus,
  ModuleSkillStatusResult,
  ModuleToastInput,
  ModuleToastTone,
  ModuleWorkspaceView,
  RendererHost,
  ServiceToken,
  SidecarSpec,
  WorkspaceFileWatchEvent,
} from './index.js'
import type { ModuleChatRuntimeOption, ModuleOpenChatInput, ModuleOpenChatResult } from './conversation.js'
import {
  EXTENSION_HOST_REFUSALS,
  EXTENSION_MAIN_HOST_METHODS,
  EXTENSION_RENDERER_METHODS,
  extensionHostService,
  type ExtensionHostRequirement,
} from './services.js'
import type { UsageQuery, UsageQueryResult } from './activity.js'
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

// ── Shared pieces ────────────────────────────────────────────────────────────

/** The workspace every fake starts with when a test names none. */
export const DEFAULT_FAKE_WORKSPACES: readonly ModuleWorkspaceView[] = [
  { id: 'ws-app', name: 'App', folderPath: '/Users/dev/projects/app', mode: 'standard' },
]

// Every capability this SDK knows. A fake answers `supports` with these unless
// told otherwise, so a module's "older host" branch is opt-in to test. A test
// fails when HostCapability (host-api.ts) names one this list does not.
const KNOWN_CAPABILITIES: readonly HostCapability[] = [
  'conversations',
  'conversation-controls',
  'conversation-streams',
  'conversation-requests',
  'conversation-permissions',
  'chat.open',
  'companion-agents',
  // Agents, conversations and scheduled agents.
  'companion-tools',
  'conversation-replies',
  'text-generation',
  'conversation-worktrees',
  'chat.open-options',
  'chat-runtimes',
  'scheduled-agent-runs',
  'scheduled-agents',
  'secrets',
  'github',
  'storage',
  'mcp-tools',
  'module-assets',
  'notifications',
  // Backlog, usage and activity services.
  'backlog-write',
  'usage',
  'activity',
  // The window's studio.
  'toast',
  'module-id',
  'active-workspace',
  'open-external',
  'chart-tokens',
  'electron-main',
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
  /** Every `emit`, in order. */
  emitted: Array<{ topic: string; payload?: unknown }>
  /** Every `notify`, validated as the host validates it. */
  notifications: ModuleNotifyInput[]
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
  const provided = new Map<string, unknown>()
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
    if (!covered(method, requirement)) void refuseUndeclared(moduleId, method, requirement)
  }
  // A service as the host hands it to an extension: each method through the gate.
  function gated<T>(key: string, registry: T): T {
    const methods = extensionHostService(key)?.methods
    if (!methods || registry === null || typeof registry !== 'object') return registry
    const facade: Record<string, unknown> = {}
    for (const [name, requirement] of Object.entries(methods)) {
      const member = (registry as Record<string, unknown>)[name]
      if (typeof member !== 'function') continue
      facade[name] = (...args: unknown[]) =>
        covered(`${key}.${name}`, requirement)
          ? (member as (...given: unknown[]) => unknown).apply(registry, args)
          : refuseUndeclared(moduleId, `${key}.${name}`, requirement)
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
    if (provided.has(key)) return provided.get(key) as T
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
    getModuleAppState<T = unknown>(key: string): T | undefined {
      use('getModuleAppState')
      if (typeof key !== 'string' || key.trim().length === 0) return undefined
      return appState.get(key) as T | undefined
    },
    watchModuleAppState(cb) {
      use('watchModuleAppState')
      // Heard on change only, not on subscribe, as the host's main half is.
      return appState.subscribe(cb)
    },
    provideService(token, factory) {
      if (provided.has(token.key) || registries.has(token.key)) {
        throw new Error(`Service "${token.key}" is already provided; module "${moduleId}" tried to provide it again.`)
      }
      const instance = factory(host)
      provided.set(token.key, instance)
      return instance
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

// ── The renderer host ────────────────────────────────────────────────────────

export type FakeRendererHostOptions = FakeModuleIdentity & {
  /**
   * The module's main half: `methods` reaches its declared methods, `subscribe` hears
   * its `emit`, and the module app state, the Backlog, usage and workspace
   * git info are its.
   */
  main?: FakeMainHost
  /** The open workspaces. Default: the main fake's, or one `ws-app`. */
  workspaces?: readonly ModuleWorkspaceView[]
  /** The workspace this window shows (`getActiveWorkspaceId`). Default: the first workspace, or null. */
  activeWorkspaceId?: string | null
  /** Backlog items per workspace id, seeded into the Backlog (`services.backlog`). */
  backlogItems?: Record<string, readonly FakeBacklogItemInput[]>
  /** Module app state already saved (added to the main fake's, given one). */
  appState?: Record<string, unknown>
  /** Workspace module state already saved, per workspace id. */
  workspaceState?: Record<string, unknown>
  colorScheme?: ModuleColorScheme
  /** What `listChatRuntimes` answers. Default: the main fake's, or Claude Code (last chosen) and Codex. */
  chatRuntimes?: ModuleChatRuntimeOption[]
  /** What `supports` answers true for. Default: every capability this SDK knows. */
  capabilities?: readonly string[]
  /** The clock the renderer's own Backlog and usage fakes stamp with. Default: `Date.now`. */
  now?: () => number
}

/** A toast the module showed, as the toast region got it (trimmed and clipped). */
export type FakeToast = {
  tone: ModuleToastTone
  message: string
  detail?: string
  /** Its button: call `run()` to press it, as the person would. */
  action?: ModuleToastInput['action']
  /** Whether the module called the dismisser `toast` returned. */
  dismissed: boolean
}

export type FakeRendererHost = {
  /** The window's studio, as every surface of the extension shares it. */
  host: RendererHost
  permissions: Set<string>
  /** Every host method called, with its arguments, in order. */
  calls: Array<{ method: string; args: unknown[] }>
  openedChats: ModuleOpenChatInput[]
  focusedTabs: ModuleFocusTabInput[]
  /** The doors `openGlobalSurface` opened, by id. */
  openedDoors: string[]
  /** Every surface that called `ready()`, in order. */
  readied: ExtensionSurface[]
  /** Every toast shown, in order (none while `supports('toast')` is false). */
  toasts: FakeToast[]
  /** Every URL `openExternal` handed to the system browser, normalised. */
  openedUrls: string[]
  /** Host methods used without a permission that covers them. A clean module leaves this empty. */
  undeclared: FakeUndeclaredUse[]
  /**
   * The world the renderer reads and writes: the main fake's when given one.
   * `workspaces.setGitInfo` scripts `getWorkspaceGitInfo`, `backlog` holds the
   * Backlog, `usage` the token usage `queryUsage` sums.
   */
  services: Pick<FakeServices, 'workspaces' | 'backlog' | 'usage'>
  /** Module app state as saved. */
  appState(): Record<string, unknown>
  /** Workspace module state as saved for a workspace. */
  workspaceState(workspaceId: string): unknown
  /** Deliver an event to `subscribe` listeners, as the module's main half would. */
  emit(topic: string, payload?: unknown): void
  /** Change the open workspaces; `watchWorkspaces` listeners hear it. */
  setWorkspaces(workspaces: readonly ModuleWorkspaceView[]): void
  /** Show another workspace in this window (null for none); `watchActiveWorkspace` listeners hear it. */
  setActiveWorkspace(workspaceId: string | null): void
  /** Replace the Backlog of a workspace (`services.backlog.seed`); `watchBacklogItems` listeners hear it. */
  setBacklogItems(workspaceId: string, items: readonly FakeBacklogItemInput[]): void
  setColorScheme(scheme: ModuleColorScheme): void
  /** Deliver a change to a `watchWorkspaceFile` watch. */
  changeWorkspaceFile(workspaceId: string, relativePath: string, event: WorkspaceFileWatchEvent): void
  /** The studio one surface's `mount` is handed: the window's, with that surface and its `ready()`. */
  studio(surface: ExtensionSurface): ExtensionMountStudio
  /**
   * Run a ui entry's `mount` into `root` (from your DOM of choice) as Studio
   * does when the surface opens. Resolves to what closing it runs.
   */
  mount(
    entry: { mount: (root: HTMLElement, studio: ExtensionMountStudio) => unknown },
    surface: ExtensionSurface,
    root: HTMLElement,
  ): Promise<() => void>
}

// The window's host methods an extension's surface calls need a permission of
// the extension (EXTENSION_RENDERER_METHODS). The window's host refuses the
// ones in CHECKED_RENDERER_METHODS without it (an answer or a throw, as the
// host does); the rest are listed for the person and recorded here.
const CHECKED_RENDERER_METHODS = new Set([
  'openChat',
  'getWorkspaceGitInfo',
  'listBacklogItems',
  'watchBacklogItems',
  'getBacklogLocation',
  'createBacklogItem',
  'updateBacklogStatus',
  'updateBacklogTriage',
  'addBacklogLink',
  'updateBacklogModuleMetadata',
  'queryUsage',
])

// A chat's title fits a tab and a sidebar row; a key is an id, not a document.
const MAX_CHAT_NAME_CHARS = 120
const MAX_CHAT_DEDUPE_KEY_CHARS = 200

const TOAST_TONES: ReadonlySet<string> = new Set<ModuleToastTone>(['neutral', 'accent', 'good', 'warn', 'error'])
const MAX_TOAST_MESSAGE_LENGTH = 200
const MAX_TOAST_DETAIL_LENGTH = 500

// What `openExternal` takes: an absolute http(s) URL with no credentials.
function externalHttpUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim().length === 0) return null
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

type BacklogRegistry = {
  list(moduleId: string, workspaceId: string): Promise<{ ok: boolean; items?: BacklogItemView[]; message?: string }>
} & Record<string, (moduleId: string, ...args: never[]) => Promise<unknown>>
type UsageRegistry = { query(moduleId: string, query: UsageQuery): Promise<UsageQueryResult> }

export function createFakeRendererHost(options: FakeRendererHostOptions): FakeRendererHost {
  const main = options.main
  // Given only the main half, the renderer is the same module with the same
  // (live) permissions.
  const { moduleId, permissions } =
    !options.moduleId && !options.manifest && main
      ? { moduleId: main.host.moduleId, permissions: main.permissions }
      : identityOf(options)
  const internals = main ? mainInternals.get(main) : undefined
  const capabilities = new Set<string>(options.capabilities ?? KNOWN_CAPABILITIES)
  let workspaces: ModuleWorkspaceView[] = (
    options.workspaces ??
    internals?.workspaces.all() ??
    DEFAULT_FAKE_WORKSPACES
  ).map((workspace) => ({ ...workspace }))

  // The services behind the renderer's Backlog, usage and git-info methods:
  // the main fake's (the host bridges to main's registries), or the
  // renderer's own when it is tested alone.
  const world = ((): {
    workspaces: ReturnType<typeof createFakeWorkspaces>
    backlog: { registry: BacklogRegistry; handle: FakeBacklog }
    usage: { registry: UsageRegistry; handle: FakeUsage }
    appState: AppStateStore
  } => {
    if (main && internals) {
      return {
        workspaces: internals.workspaces,
        backlog: {
          registry: internals.registry('backlog.module-service') as BacklogRegistry,
          handle: main.services.backlog,
        },
        usage: { registry: internals.registry('usage.module-service') as UsageRegistry, handle: main.services.usage },
        appState: internals.appState,
      }
    }
    const own = createFakeWorkspaces(workspaces, options.now)
    const context: FakeServiceContext = { moduleId, permissions, now: options.now ?? Date.now, workspaces: own }
    const backlog = SERVICE_FAKES['backlog.module-service']!.create(context)
    const usage = SERVICE_FAKES['usage.module-service']!.create(context)
    return {
      workspaces: own,
      backlog: { registry: backlog.registry as BacklogRegistry, handle: backlog.handle as FakeBacklog },
      usage: { registry: usage.registry as UsageRegistry, handle: usage.handle as FakeUsage },
      appState: createAppStateStore(undefined),
    }
  })()
  for (const [key, value] of Object.entries(options.appState ?? {})) world.appState.set(key, value)
  for (const [workspaceId, items] of Object.entries(options.backlogItems ?? {})) {
    world.backlog.handle.seed(workspaceId, items)
  }

  const workspaceState = new Map(Object.entries(structuredClone(options.workspaceState ?? {})))
  let colorScheme: ModuleColorScheme = options.colorScheme ?? 'light'
  let activeWorkspaceId: string | null =
    options.activeWorkspaceId !== undefined ? options.activeWorkspaceId : (workspaces[0]?.id ?? null)
  const chatRuntimes = (): ModuleChatRuntimeOption[] =>
    structuredClone(options.chatRuntimes ?? internals?.chatRuntimes() ?? [...DEFAULT_FAKE_CHAT_RUNTIMES])
  // The chats this window opened under a `dedupeKey`, by workspace and key.
  const keyedChats = new Map<string, string>()

  const subscribers = new Set<{ topic: string; cb: (payload: unknown) => void }>()
  const workspaceWatchers = new Set<(list: ModuleWorkspaceView[]) => void>()
  const activeWorkspaceWatchers = new Set<(workspaceId: string | null) => void>()
  const schemeWatchers = new Set<(scheme: ModuleColorScheme) => void>()
  const fileWatchers = new Set<{ key: string; cb: (event: WorkspaceFileWatchEvent) => void }>()
  let nextChat = 1

  const fake: FakeRendererHost = {
    host: undefined as unknown as RendererHost,
    permissions,
    calls: [],
    openedChats: [],
    focusedTabs: [],
    openedDoors: [],
    readied: [],
    toasts: [],
    openedUrls: [],
    undeclared: [],
    services: { workspaces: world.workspaces, backlog: world.backlog.handle, usage: world.usage.handle },
    appState: () => world.appState.all(),
    workspaceState: (workspaceId) => structuredClone(workspaceState.get(workspaceId)),
    emit(topic, payload) {
      for (const subscriber of subscribers) {
        if (subscriber.topic === topic) subscriber.cb(structuredClone(payload))
      }
    },
    setWorkspaces(next) {
      workspaces = next.map((workspace) => ({ ...workspace }))
      if (!main) {
        for (const workspace of world.workspaces.all()) world.workspaces.remove(workspace.id)
        for (const workspace of workspaces) world.workspaces.add(workspace)
      }
      for (const cb of workspaceWatchers) cb(workspaces.map((workspace) => ({ ...workspace })))
    },
    setActiveWorkspace(workspaceId) {
      if (workspaceId === activeWorkspaceId) return
      activeWorkspaceId = workspaceId
      for (const cb of [...activeWorkspaceWatchers]) cb(workspaceId)
    },
    setBacklogItems(workspaceId, items) {
      world.backlog.handle.seed(workspaceId, items)
    },
    setColorScheme(scheme) {
      colorScheme = scheme
      for (const cb of schemeWatchers) cb(scheme)
    },
    changeWorkspaceFile(workspaceId, relativePath, event) {
      for (const watcher of fileWatchers) {
        if (watcher.key === `${workspaceId}\u0000${relativePath}`) watcher.cb(event)
      }
    },
    studio(surface) {
      let readied = false
      return {
        ...fake.host,
        surface: { ...surface },
        ready() {
          if (readied) return
          readied = true
          fake.readied.push({ ...surface })
        },
      }
    },
    async mount(entry, surface, root) {
      if (typeof entry?.mount !== 'function') throw new Error('A ui entry must export mount(root, studio).')
      const cleanup = await entry.mount(root, fake.studio(surface))
      return typeof cleanup === 'function' ? (cleanup as () => void) : () => {}
    },
  }

  // Records the call, and answers whether the extension's permissions cover it.
  function record(method: string, args: unknown[], needsOverride?: readonly string[]): boolean {
    fake.calls.push({ method, args })
    const needs = needsOverride ?? EXTENSION_RENDERER_METHODS[method]
    if (!needs || needs.some((permission) => permissions.has(permission))) return true
    if (!fake.undeclared.some((use) => use.what === method)) fake.undeclared.push({ what: method, needs })
    return !CHECKED_RENDERER_METHODS.has(method)
  }
  const refusedAnswer = (method: string) =>
    Promise.resolve({
      ok: false as const,
      code: EXTENSION_HOST_REFUSALS.notPermitted,
      message: `Extension "${moduleId}" was not approved for "${(EXTENSION_RENDERER_METHODS[method] ?? []).join('" or "')}", which "${method}" needs.`,
    })
  const resolveWorkspace = (id: string): ModuleWorkspaceView | null => {
    const found = workspaces.find((workspace) => workspace.id === id)
    return found ? { ...found } : null
  }
  // The renderer's Backlog reads throw without `backlog:read`, as the host's do.
  const requireBacklogRead = (covered: boolean): void => {
    if (covered) return
    throw new Error(`Extension "${moduleId}" was not approved for "backlog:read", so it cannot read the Backlog.`)
  }
  const backlogCall = <T>(method: string, args: unknown[]): Promise<T> =>
    (world.backlog.registry[method] as (moduleId: string, ...rest: unknown[]) => Promise<T>)(moduleId, ...args)

  const host: RendererHost = {
    moduleId,
    supports: (capability) => capabilities.has(capability),
    getAssetUrl(relativePath) {
      record('getAssetUrl', [relativePath])
      return `module-asset://${moduleId}/${validateAssetPath(relativePath, moduleId).map(encodeURIComponent).join('/')}`
    },
    openGlobalSurface(id) {
      record('openGlobalSurface', [id])
      const doors = options.manifest?.contributes?.doors
      if (doors && !doors.some((door) => door.id === id)) return false
      fake.openedDoors.push(id)
      return true
    },
    async listBacklogItems(workspaceId) {
      requireBacklogRead(record('listBacklogItems', [workspaceId]))
      const listed = await world.backlog.registry.list(moduleId, workspaceId)
      if (!listed.ok) throw new Error(listed.message)
      return listed.items ?? []
    },
    watchBacklogItems(workspaceId, cb, watchOptions) {
      requireBacklogRead(record('watchBacklogItems', [workspaceId, cb, watchOptions]))
      return world.backlog.handle.watch(workspaceId, cb, watchOptions?.onError)
    },
    getBacklogLocation(workspaceId) {
      if (!record('getBacklogLocation', [workspaceId])) return refusedAnswer('getBacklogLocation')
      return backlogCall('getLocation', [workspaceId])
    },
    createBacklogItem(workspaceId, input) {
      if (!record('createBacklogItem', [workspaceId, input])) return refusedAnswer('createBacklogItem')
      return backlogCall('create', [workspaceId, input])
    },
    updateBacklogStatus(workspaceId, itemId, status) {
      if (!record('updateBacklogStatus', [workspaceId, itemId, status])) return refusedAnswer('updateBacklogStatus')
      return backlogCall('updateStatus', [workspaceId, itemId, status])
    },
    updateBacklogTriage(workspaceId, itemId, triage) {
      if (!record('updateBacklogTriage', [workspaceId, itemId, triage])) return refusedAnswer('updateBacklogTriage')
      return backlogCall('updateTriage', [workspaceId, itemId, triage])
    },
    addBacklogLink(workspaceId, itemId, link) {
      if (!record('addBacklogLink', [workspaceId, itemId, link])) return refusedAnswer('addBacklogLink')
      return backlogCall('addLink', [workspaceId, itemId, link])
    },
    updateBacklogModuleMetadata(workspaceId, itemId, value) {
      if (!record('updateBacklogModuleMetadata', [workspaceId, itemId, value]))
        return refusedAnswer('updateBacklogModuleMetadata')
      return backlogCall('updateModuleMetadata', [workspaceId, itemId, value])
    },
    queryUsage(query) {
      if (!record('queryUsage', [query])) return refusedAnswer('queryUsage')
      return world.usage.registry.query(moduleId, query)
    },
    async getWorkspace(workspaceId) {
      record('getWorkspace', [workspaceId])
      return resolveWorkspace(workspaceId)
    },
    async listWorkspaces() {
      record('listWorkspaces', [])
      return workspaces.map((workspace) => ({ ...workspace }))
    },
    async getWorkspaceGitInfo(workspaceId) {
      if (!record('getWorkspaceGitInfo', [workspaceId])) return refusedAnswer('getWorkspaceGitInfo')
      return world.workspaces.gitInfo(workspaceId)
    },
    watchWorkspaces(cb) {
      record('watchWorkspaces', [cb])
      workspaceWatchers.add(cb)
      cb(workspaces.map((workspace) => ({ ...workspace })))
      return () => {
        workspaceWatchers.delete(cb)
      }
    },
    watchColorScheme(cb) {
      record('watchColorScheme', [cb])
      schemeWatchers.add(cb)
      cb(colorScheme)
      return () => {
        schemeWatchers.delete(cb)
      }
    },
    getWorkspaceModuleState<T = unknown>(workspaceId: string): T | undefined {
      record('getWorkspaceModuleState', [workspaceId])
      return resolveWorkspace(workspaceId)
        ? (structuredClone(workspaceState.get(workspaceId)) as T | undefined)
        : undefined
    },
    setWorkspaceModuleState(workspaceId, state) {
      record('setWorkspaceModuleState', [workspaceId, state])
      if (!resolveWorkspace(workspaceId)) return false
      workspaceState.set(workspaceId, structuredClone(state))
      return true
    },
    getModuleAppState<T = unknown>(key: string): T | undefined {
      record('getModuleAppState', [key])
      return world.appState.get(key) as T | undefined
    },
    setModuleAppState(key, value) {
      record('setModuleAppState', [key, value])
      world.appState.set(key, value)
      return true
    },
    watchModuleAppState(cb) {
      record('watchModuleAppState', [cb])
      const stop = world.appState.subscribe(cb)
      cb(world.appState.all())
      return stop
    },
    subscribe(topic, cb) {
      record('subscribe', [topic, cb])
      const subscriber = { topic, cb }
      subscribers.add(subscriber)
      return () => {
        subscribers.delete(subscriber)
      }
    },
    async getWorkingRoot(workspaceId) {
      record('getWorkingRoot', [workspaceId])
      return resolveWorkspace(workspaceId)?.folderPath ?? null
    },
    async watchWorkspaceFile(workspaceId, relativePath, cb) {
      record('watchWorkspaceFile', [workspaceId, relativePath, cb])
      const watcher = { key: `${workspaceId}\u0000${relativePath}`, cb }
      fileWatchers.add(watcher)
      return () => {
        fileWatchers.delete(watcher)
      }
    },
    focusTab(input) {
      record('focusTab', [input])
      fake.focusedTabs.push({ ...input })
      return true
    },
    async openChat(input): Promise<ModuleOpenChatResult> {
      // A draft the person reads and sends needs only `chat:draft`; a prompt
      // sent for them is driving the chat, which is `conversation:own`'s.
      const sends = input?.send === true
      if (!record('openChat', [input], sends ? ['conversation:own'] : ['chat:draft', 'conversation:own'])) {
        return {
          ok: false,
          code: 'not_permitted',
          message: sends
            ? `Extension "${moduleId}" was not approved for "conversation:own", so it cannot open a chat and send its prompt.`
            : `Extension "${moduleId}" was approved for neither "chat:draft" nor "conversation:own", so it cannot open a chat.`,
        }
      }
      const optionalText = (value: unknown, max: number): string | null | undefined => {
        if (value === undefined) return undefined
        if (typeof value !== 'string' || value.length > max) return null
        return value.trim() || undefined
      }
      const name = optionalText(input.name, MAX_CHAT_NAME_CHARS)
      if (name === null) {
        return {
          ok: false,
          code: 'invalid_input',
          message: `"name" must be a title of at most ${MAX_CHAT_NAME_CHARS} characters.`,
        }
      }
      const dedupeKey = optionalText(input.dedupeKey, MAX_CHAT_DEDUPE_KEY_CHARS)
      if (dedupeKey === null) {
        return {
          ok: false,
          code: 'invalid_input',
          message: `"dedupeKey" must be a string of at most ${MAX_CHAT_DEDUPE_KEY_CHARS} characters.`,
        }
      }
      const workspace = resolveWorkspace(input.workspaceId)
      if (!workspace) return { ok: false, code: 'unknown_workspace', message: `No workspace "${input.workspaceId}".` }
      // Asked again under the same key: that chat comes to the front, untouched.
      const keyed = dedupeKey ? keyedChats.get(`${input.workspaceId}\u0000${dedupeKey}`) : undefined
      if (keyed) return { ok: true, agentId: keyed, existing: true }
      if (!workspace.folderPath) {
        return {
          ok: false,
          code: 'workspace_folder_missing',
          message: `Workspace "${input.workspaceId}" has no project folder.`,
        }
      }
      fake.openedChats.push(structuredClone(input))
      // The chat belongs to the module, as one `openChat` opens does: the main
      // half's conversation service sees it (whichever permission opened it).
      const agentId = `chat-${nextChat++}`
      main?.services.conversations.restore({
        workspaceId: input.workspaceId,
        agentId,
        status: input.send ? 'active' : 'ready',
        ...(name ? { name } : {}),
        ...(input.cli ? { cli: input.cli } : {}),
        ...(input.model ? { modelId: input.model } : {}),
        events: [
          { type: 'session_started' },
          ...(input.send && input.prompt ? [{ type: 'user_message' as const, payload: { text: input.prompt } }] : []),
        ],
      })
      if (dedupeKey) keyedChats.set(`${input.workspaceId}\u0000${dedupeKey}`, agentId)
      return { ok: true, agentId }
    },
    listChatRuntimes() {
      record('listChatRuntimes', [])
      return chatRuntimes()
    },
    toast(input) {
      record('toast', [input])
      if (!input || typeof input !== 'object') throw new Error('toast(...) requires a payload object.')
      if (typeof input.tone !== 'string' || !TOAST_TONES.has(input.tone)) {
        throw new Error('toast(...) tone must be "neutral", "accent", "good", "warn" or "error".')
      }
      const message = typeof input.message === 'string' ? input.message.trim() : ''
      if (message.length === 0) throw new Error('toast(...) requires a non-empty message.')
      if (input.detail !== undefined && typeof input.detail !== 'string') {
        throw new Error('toast(...) detail must be a string when provided.')
      }
      const action = input.action
      if (
        action !== undefined &&
        (!action || typeof action.label !== 'string' || !action.label.trim() || typeof action.run !== 'function')
      ) {
        throw new Error('toast(...) action must be { label, run } with a non-empty label.')
      }
      // A window with no toast region shows nothing; the dismisser does nothing.
      if (!capabilities.has('toast')) return () => {}
      const detail = input.detail?.trim()
      const shown: FakeToast = {
        tone: input.tone,
        message: message.slice(0, MAX_TOAST_MESSAGE_LENGTH),
        ...(detail ? { detail: detail.slice(0, MAX_TOAST_DETAIL_LENGTH) } : {}),
        ...(action ? { action: { label: action.label.trim(), run: action.run } } : {}),
        dismissed: false,
      }
      fake.toasts.push(shown)
      return () => {
        shown.dismissed = true
      }
    },
    getActiveWorkspaceId() {
      record('getActiveWorkspaceId', [])
      return activeWorkspaceId
    },
    watchActiveWorkspace(cb) {
      record('watchActiveWorkspace', [cb])
      activeWorkspaceWatchers.add(cb)
      cb(activeWorkspaceId)
      return () => {
        activeWorkspaceWatchers.delete(cb)
      }
    },
    async openExternal(url): Promise<ModuleOpenExternalResult> {
      record('openExternal', [url])
      const safe = externalHttpUrl(url)
      if (!safe) return { ok: false, code: 'invalid_url', message: 'Only an absolute http(s) URL can be opened.' }
      if (!capabilities.has('open-external')) {
        return { ok: false, code: 'unavailable', message: 'This window cannot open links yet.' }
      }
      fake.openedUrls.push(safe)
      return { ok: true }
    },
    methods<Cs extends ModuleMethodContracts = ModuleMethodContracts>(): ModuleMethodsClient<Cs> {
      record('methods', [])
      const absent = (): Promise<ModuleCallAnswer<ModuleMethodContract>> =>
        Promise.resolve({
          ok: false,
          code: 'extension_unavailable',
          message: `Extension "${moduleId}" is not running: the fake renderer host was given no main.`,
        })
      return {
        read: (method, params) => (main ? main.methods.read(method, params) : absent()) as never,
        operate: (method, params, options) =>
          (main ? main.methods.operate(method, params, options) : absent()) as never,
      }
    },
  }
  fake.host = host
  main?.onEmit((topic, payload) => fake.emit(topic, payload))
  return fake
}
