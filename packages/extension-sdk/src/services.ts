// Every host method an extension can call, and what a call needs.
//
// Studio checks each call an extension's code makes into it at the host, and a
// call goes through only when both of these hold:
//
// - `extension`: the permission the extension's approved grant must hold
//   (`extension.json`'s `permissions`), or null for what is the extension's own
//   and needs none (its own methods, its own files, its own events);
// - `invoker`: what whoever set the call off must hold themselves, in the
//   Studio protocol's permission names: the person at this machine holds every
//   one; a paired device, another app or a browser holds what it was granted;
//   an agent on this machine holds what the person holds. `owner` is the person
//   alone. null where the call needs nothing of anyone (a registration made
//   while the extension starts).
//
// So an extension never lets a paired device or an agent do what that device
// or agent could not do itself. Work an extension does on its own (a startup
// hook, a timer it set while starting, a sidecar) runs as the person who
// approved it.
//
// `refusal` is how a refused call is told: `answer`, the method's own failure
// shape (`{ ok: false, code, message }`) with code `not_permitted` or
// `approval_required`; `reject`, a rejected promise, for an async method with
// no failure shape; `throw`, an error, for a synchronous one.
//
// What a method hands back that can be called (a companion's handle, the
// function that stops a watch) is a host method too, with a row of its own
// under `returns`: by the method, then the member (`attach` → `send`), with
// `()` for a function (`watch` → `()`, `attach` → `onStatus.()`). It is
// checked at each call, as whoever set that call off, while the extension is
// approved; a callable without a row is refused.
//
// This table is the one source: Studio's gate reads it, and so do the fake
// hosts in `@sprintengine/extension-sdk/testing`. A test fails when a service
// key or a method the SDK reaches has no row, so nothing can ship unchecked.

import type { ExtensionPermission } from './permissions.js'

/** What whoever set a call off must hold: a Studio protocol permission, or `owner`. */
export type ExtensionInvokerRequirement =
  | 'workspace:read'
  | 'workspace:operate'
  | 'conversation:read'
  | 'conversation:operate'
  | 'conversation:create'
  | 'backlog:read'
  | 'backlog:operate'
  | 'providers:read'
  | 'extension:read'
  | 'extension:operate'
  | 'owner'

export type ExtensionHostRequirement = {
  readonly extension: ExtensionPermission | null
  readonly invoker: ExtensionInvokerRequirement | null
  readonly refusal: 'answer' | 'reject' | 'throw'
}

export type ExtensionHostService = {
  /** The key the SDK helper resolves with `host.requireService`. */
  key: string
  /** The SDK helper or token an extension reaches it through. */
  via: string
  /**
   * The part of Studio that provides it. Studio starts its own parts ahead of
   * every extension's worker, so `activate` may resolve the service at once.
   */
  providedBy: string
  /** Every method of it an extension may call, and what each needs. */
  methods: Readonly<Record<string, ExtensionHostRequirement>>
  /** What a method hands back that can be called, by the method and the member's path, and what each needs. */
  returns?: Readonly<Record<string, Readonly<Record<string, ExtensionHostRequirement>>>>
}

const need = (
  extension: ExtensionPermission | null,
  invoker: ExtensionInvokerRequirement | null,
  refusal: 'answer' | 'reject' | 'throw',
): ExtensionHostRequirement => ({ extension, invoker, refusal })

function each(
  names: readonly string[],
  requirement: ExtensionHostRequirement,
): Record<string, ExtensionHostRequirement> {
  return Object.fromEntries(names.map((name) => [name, requirement]))
}

export const EXTENSION_HOST_SERVICES: readonly ExtensionHostService[] = [
  {
    key: 'core.workspace',
    via: 'WorkspaceServiceToken',
    providedBy: 'agent-runtime',
    methods: { create: need('workspace:operate', 'workspace:operate', 'answer') },
  },
  {
    key: 'core.workspace-context',
    via: 'WorkspaceContextToken',
    providedBy: 'agent-runtime',
    methods: each(['get', 'list'], need('workspace:read', 'workspace:read', 'reject')),
  },
  {
    key: 'core.module-storage',
    via: 'getModuleStorage',
    providedBy: 'agent-runtime',
    methods: {
      ...each(['get', 'getMany', 'list'], need('storage:own', 'extension:read', 'answer')),
      watch: need('storage:own', 'extension:read', 'throw'),
      ...each(['set', 'delete'], need('storage:own', 'extension:operate', 'answer')),
    },
    // Stopping a watch needs nothing of whoever stops it.
    returns: { watch: { '()': need('storage:own', null, 'throw') } },
  },
  {
    key: 'scheduled-agents.module-service',
    via: 'getScheduledAgentsService',
    providedBy: 'scheduled-agents',
    methods: {
      ...each(['create', 'update', 'remove', 'runNow'], need('schedules:own', 'workspace:operate', 'answer')),
      list: need('schedules:own', 'workspace:read', 'reject'),
      ...each(['onChanged', 'onRun'], need('schedules:own', 'workspace:read', 'throw')),
    },
    returns: {
      onChanged: { '()': need('schedules:own', null, 'throw') },
      onRun: { '()': need('schedules:own', null, 'throw') },
    },
  },
  {
    key: 'companion-agents.module-service',
    via: 'getCompanionAgentsService',
    providedBy: 'agent-runtime',
    methods: { attach: need('agents:companion', 'conversation:create', 'throw') },
    // The handle drives an agent as `attach` starts one: whoever drives it
    // must be able to start a chat; whoever watches it, to read one.
    returns: {
      attach: {
        ...each(['status', 'onStatus', 'onEvent'], need('agents:companion', 'conversation:read', 'throw')),
        ...each(['onStatus.()', 'onEvent.()', 'dispose'], need('agents:companion', null, 'throw')),
        ...each(['runStructured', 'send'], need('agents:companion', 'conversation:create', 'reject')),
        respondToApproval: need('agents:companion', 'conversation:create', 'answer'),
        interrupt: need('agents:companion', 'conversation:create', 'throw'),
      },
    },
  },
  {
    key: 'conversation.module-service',
    via: 'getConversationService',
    providedBy: 'agent-runtime',
    methods: {
      create: need('conversation:own', 'conversation:create', 'answer'),
      ...each(
        [
          'send',
          'interrupt',
          'respondToApproval',
          'answerQuestion',
          'resolvePlan',
          'setPermissionPreset',
          'setModel',
          'stop',
        ],
        need('conversation:own', 'conversation:operate', 'answer'),
      ),
      ...each(['reply', 'transcript'], need('conversation:own', 'conversation:read', 'answer')),
      ...each(['subscribe', 'follow', 'list', 'watch'], need('conversation:own', 'conversation:read', 'throw')),
    },
    returns: {
      subscribe: { '()': need('conversation:own', null, 'throw') },
      follow: { '()': need('conversation:own', null, 'throw') },
      watch: { '()': need('conversation:own', null, 'throw') },
    },
  },
  {
    key: 'module-secrets.module-service',
    via: 'getSecretsService',
    providedBy: 'agent-runtime',
    methods: {
      ...each(['set', 'delete', 'fetchWithSecret'], need('secrets:own', 'extension:operate', 'answer')),
      has: need('secrets:own', 'extension:operate', 'reject'),
    },
  },
  {
    key: 'github.module-service',
    via: 'getGitHubService',
    providedBy: 'agent-runtime',
    methods: {
      ...each(['request', 'graphql', 'download'], need('github:api', 'owner', 'answer')),
      status: need('github:api', 'owner', 'reject'),
    },
  },
  {
    key: 'backlog.module-service',
    via: 'getBacklogService',
    providedBy: 'agent-runtime',
    methods: {
      ...each(['list', 'getLocation'], need('backlog:read', 'backlog:read', 'answer')),
      ...each(
        ['create', 'updateStatus', 'updateTriage', 'addLink', 'updateModuleMetadata'],
        need('backlog:operate', 'backlog:operate', 'answer'),
      ),
    },
  },
  {
    key: 'usage.module-service',
    via: 'getUsageService',
    providedBy: 'agent-runtime',
    methods: {
      query: need('usage:read', 'workspace:read', 'answer'),
      onChanged: need('usage:read', 'workspace:read', 'throw'),
    },
    returns: { onChanged: { '()': need('usage:read', null, 'throw') } },
  },
  {
    key: 'activity.module-service',
    via: 'getActivityService',
    providedBy: 'agent-runtime',
    methods: each(['listChats', 'prompts'], need('conversation:read', 'conversation:read', 'answer')),
  },
  {
    key: 'text-generation.module-service',
    via: 'getTextGenerationService',
    providedBy: 'agent-runtime',
    methods: { generate: need('agents:generate', 'conversation:create', 'answer') },
  },
]

/** The service for `key`, or undefined for a key the SDK does not publish. */
export function extensionHostService(key: string): ExtensionHostService | undefined {
  return EXTENSION_HOST_SERVICES.find((service) => service.key === key)
}

/**
 * The `MainHost` methods an extension's worker calls, and what each needs.
 * Registrations (`registerMethods`, `onStartup`, …) are made while it starts
 * and need nothing of an invoker; the extension column still applies.
 */
export const EXTENSION_MAIN_HOST_METHODS: Readonly<Record<string, ExtensionHostRequirement>> = {
  moduleId: need(null, null, 'throw'),
  supports: need(null, null, 'throw'),
  listChatRuntimes: need('providers:read', 'providers:read', 'reject'),
  registerMethods: need(null, null, 'throw'),
  registerMcpTools: need('tools:contribute', null, 'throw'),
  ensureSkillInstalled: need('workspace:operate', 'workspace:operate', 'reject'),
  getSkillStatus: need('workspace:read', 'workspace:read', 'reject'),
  getModuleDataDir: need('storage:own', null, 'throw'),
  getAssetPath: need(null, null, 'throw'),
  getWorkspaceGitInfo: need('workspace:read', 'workspace:read', 'answer'),
  getModuleAppState: need('settings:own', 'extension:read', 'throw'),
  watchModuleAppState: need('settings:own', 'extension:read', 'throw'),
  provideService: need(null, null, 'throw'),
  getService: need(null, null, 'throw'),
  requireService: need(null, null, 'throw'),
  onStartup: need(null, null, 'throw'),
  onShutdownBegin: need(null, null, 'throw'),
  onShutdown: need(null, null, 'throw'),
  registerSidecar: need(null, null, 'throw'),
  notify: need('notifications:show', 'extension:operate', 'throw'),
  emit: need(null, null, 'throw'),
}

/** What one of the window's host methods needs of an extension: any one of `permissions`, and how a refusal is told. */
export type ExtensionRendererRequirement = {
  readonly permissions: readonly ExtensionPermission[]
  readonly refusal: 'answer' | 'reject' | 'throw'
}

const inWindow = (
  permissions: readonly ExtensionPermission[],
  refusal: ExtensionRendererRequirement['refusal'],
): ExtensionRendererRequirement => ({ permissions, refusal })

/**
 * The window's host methods an extension's surface calls, and what each needs
 * of the extension. The window that runs a surface is the person's own, so the
 * person is always the invoker; its calls to the server pass the host's gate
 * there as well. The window refuses a call the extension's approval does not
 * cover, and so do the fake hosts. `openChat` with `send: true` needs
 * `conversation:own` alone.
 */
export const EXTENSION_RENDERER_METHODS: Readonly<Record<string, ExtensionRendererRequirement>> = {
  getWorkspace: inWindow(['workspace:read'], 'reject'),
  listWorkspaces: inWindow(['workspace:read'], 'reject'),
  watchWorkspaces: inWindow(['workspace:read'], 'throw'),
  getWorkingRoot: inWindow(['workspace:read'], 'reject'),
  getWorkspaceGitInfo: inWindow(['workspace:read'], 'answer'),
  watchWorkspaceFile: inWindow(['workspace:read'], 'throw'),
  getWorkspaceModuleState: inWindow(['storage:own'], 'throw'),
  setWorkspaceModuleState: inWindow(['storage:own'], 'throw'),
  getModuleAppState: inWindow(['settings:own'], 'throw'),
  setModuleAppState: inWindow(['settings:own'], 'throw'),
  watchModuleAppState: inWindow(['settings:own'], 'throw'),
  listBacklogItems: inWindow(['backlog:read'], 'reject'),
  watchBacklogItems: inWindow(['backlog:read'], 'throw'),
  getBacklogLocation: inWindow(['backlog:read'], 'answer'),
  createBacklogItem: inWindow(['backlog:operate'], 'answer'),
  updateBacklogStatus: inWindow(['backlog:operate'], 'answer'),
  updateBacklogTriage: inWindow(['backlog:operate'], 'answer'),
  addBacklogLink: inWindow(['backlog:operate'], 'answer'),
  updateBacklogModuleMetadata: inWindow(['backlog:operate'], 'answer'),
  queryUsage: inWindow(['usage:read'], 'answer'),
  openChat: inWindow(['chat:draft', 'conversation:own'], 'answer'),
}

/** Why the window refused a call: the message the refusal carries. */
export function extensionRendererRefusalMessage(extensionId: string, method: string, needs: readonly string[]): string {
  return `Extension "${extensionId}" was not approved for ${needs.map((permission) => `"${permission}"`).join(' or ')}, which "${method}" needs.`
}

/** The codes a refused host call answers with. */
export const EXTENSION_HOST_REFUSALS = {
  /** The extension's grant, or whoever set the call off, lacks what the method needs. */
  notPermitted: 'not_permitted',
  /** The extension is not approved as it is now (or not installed, or switched off): indistinguishable on purpose. */
  approvalRequired: 'approval_required',
} as const

export type ExtensionHostRefusalCode = (typeof EXTENSION_HOST_REFUSALS)[keyof typeof EXTENSION_HOST_REFUSALS]
