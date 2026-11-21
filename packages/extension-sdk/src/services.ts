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
// `approval_required`; `throw`, an error, for a method with no failure shape.
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
  readonly refusal: 'answer' | 'throw'
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
}

const need = (
  extension: ExtensionPermission | null,
  invoker: ExtensionInvokerRequirement | null,
  refusal: 'answer' | 'throw',
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
    methods: each(['get', 'list'], need('workspace:read', 'workspace:read', 'throw')),
  },
  {
    key: 'core.module-storage',
    via: 'getModuleStorage',
    providedBy: 'agent-runtime',
    methods: {
      ...each(['get', 'getMany', 'list', 'watch'], need('storage:own', 'extension:read', 'throw')),
      ...each(['set', 'delete'], need('storage:own', 'extension:operate', 'throw')),
    },
  },
  {
    key: 'scheduled-agents.module-service',
    via: 'getScheduledAgentsService',
    providedBy: 'scheduled-agents',
    methods: {
      ...each(['create', 'update', 'remove', 'runNow'], need('schedules:own', 'workspace:operate', 'answer')),
      ...each(['list', 'onChanged', 'onRun'], need('schedules:own', 'workspace:read', 'throw')),
    },
  },
  {
    key: 'companion-agents.module-service',
    via: 'getCompanionAgentsService',
    providedBy: 'agent-runtime',
    methods: { attach: need('agents:companion', 'conversation:create', 'throw') },
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
      reply: need('conversation:own', 'conversation:read', 'answer'),
      ...each(
        ['subscribe', 'follow', 'transcript', 'list', 'watch'],
        need('conversation:own', 'conversation:read', 'throw'),
      ),
    },
  },
  {
    key: 'module-secrets.module-service',
    via: 'getSecretsService',
    providedBy: 'agent-runtime',
    methods: {
      ...each(['set', 'delete', 'fetchWithSecret'], need('secrets:own', 'extension:operate', 'answer')),
      has: need('secrets:own', 'extension:operate', 'throw'),
    },
  },
  {
    key: 'github.module-service',
    via: 'getGitHubService',
    providedBy: 'agent-runtime',
    methods: {
      ...each(['request', 'graphql', 'download'], need('github:api', 'owner', 'answer')),
      status: need('github:api', 'owner', 'throw'),
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
  listChatRuntimes: need('providers:read', 'providers:read', 'throw'),
  registerMethods: need(null, null, 'throw'),
  registerMcpTools: need('tools:contribute', null, 'throw'),
  ensureSkillInstalled: need('workspace:operate', 'workspace:operate', 'throw'),
  getSkillStatus: need('workspace:read', 'workspace:read', 'throw'),
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

/**
 * The window's host methods an extension's surface calls, and the permission
 * each needs of the extension (any one of those listed). The window that runs
 * a surface is the person's own, so the person is always the invoker.
 */
export const EXTENSION_RENDERER_METHODS: Readonly<Record<string, readonly ExtensionPermission[]>> = {
  getWorkspace: ['workspace:read'],
  listWorkspaces: ['workspace:read'],
  watchWorkspaces: ['workspace:read'],
  getWorkingRoot: ['workspace:read'],
  getWorkspaceGitInfo: ['workspace:read'],
  getWorkspaceModuleState: ['storage:own'],
  setWorkspaceModuleState: ['storage:own'],
  getModuleAppState: ['settings:own'],
  setModuleAppState: ['settings:own'],
  watchModuleAppState: ['settings:own'],
  listBacklogItems: ['backlog:read'],
  watchBacklogItems: ['backlog:read'],
  getBacklogLocation: ['backlog:read'],
  createBacklogItem: ['backlog:operate'],
  updateBacklogStatus: ['backlog:operate'],
  updateBacklogTriage: ['backlog:operate'],
  addBacklogLink: ['backlog:operate'],
  updateBacklogModuleMetadata: ['backlog:operate'],
  queryUsage: ['usage:read'],
  watchWorkspaceFile: ['workspace:read'],
  openChat: ['chat:draft', 'conversation:own'],
}

/** The codes a refused host call answers with. */
export const EXTENSION_HOST_REFUSALS = {
  /** The extension's grant, or whoever set the call off, lacks what the method needs. */
  notPermitted: 'not_permitted',
  /** The extension is not approved as it is now (or not installed, or switched off): indistinguishable on purpose. */
  approvalRequired: 'approval_required',
} as const

export type ExtensionHostRefusalCode = (typeof EXTENSION_HOST_REFUSALS)[keyof typeof EXTENSION_HOST_REFUSALS]
