// Drift guard between the published SDK surface and the in-app contracts.
//
// The SDK (packages/extension-sdk/src/index.ts) re-declares the public module
// contracts so the published tarball is self-contained. This file is the
// single source-of-truth enforcement: it fails `tsc -p tsconfig.drift.json`
// (wired into the repo verify pipeline) whenever the SDK and the app diverge,
// and fails at runtime (test:sdk:drift) when mirrored value exports drift.
//
// Two assertion strengths are used deliberately:
// - `IsExact` (type identity) for shapes the SDK mirrors exactly. Mutual
//   assignability is not enough here: `{a?: string}` and `{a?: string, b?: string}`
//   are mutually assignable, so optional-property drift — the most likely real
//   drift on these mostly-optional contracts — would pass silently.
// - One-directional `Extends` for sound narrowings: every SDK-typed module
//   must remain registrable against the app (SDK ≤ app), and every app host
//   handed to module code must satisfy the SDK view (app ≤ SDK).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  CapabilityManifest as AppCapabilityManifest,
  ExtensionManifestView as AppExtensionManifestView,
  ModuleFileDigests as AppModuleFileDigests,
  ModuleSignature as AppModuleSignature,
  ModuleSource as AppModuleSource,
  ModuleTrustStatus as AppModuleTrustStatus,
} from '../../../src/shared/modules/manifest'
import type {
  ScheduledAgent as AppScheduledAgent,
  ScheduledAgentAttachment as AppScheduledAgentAttachment,
  ScheduledAgentDraft as AppScheduledAgentDraft,
  ScheduledAgentLastRun as AppScheduledAgentLastRun,
  ScheduledAgentRun as AppScheduledAgentRun,
  ScheduledAgentSchedule as AppScheduledAgentSchedule,
  ScheduledAgentView as AppScheduledAgentView,
  ScheduledAgentWriteResult as AppScheduledAgentWriteResult,
} from '../../../src/shared/scheduled-agents'
import type { ScheduledAgentsModuleRegistry as AppScheduledAgentsModuleRegistry } from '../../../src/main/scheduled-agents/service'
import type { CapabilityPermission as AppCapabilityPermission } from '../../../src/shared/modules/permissions'
import { isStudioModuleMethodName } from '../../studio-protocol/src/modules'
import type { ModuleEventEnvelope as AppModuleEventEnvelope } from '../../../src/shared/modules/events'
import type { FileDropPayload as AppFileDropPayload } from '../../../src/renderer/src/utils/terminalDrop'
import { SPRINTENGINE_FILE_DROP_MIME as APP_FILE_DROP_MIME } from '../../../src/renderer/src/utils/terminalDrop'
import type {
  ModuleNotification as AppModuleNotification,
  ModuleNotificationSeverity as AppModuleNotificationSeverity,
  ModuleNotifyInput as AppModuleNotifyInput,
} from '../../../src/shared/modules/notifications'
import type {
  MainHost as AppMainHost,
  SidecarHandle as AppSidecarHandle,
  SidecarRunState as AppSidecarRunState,
  SidecarRuntimeStatus as AppSidecarRuntimeStatus,
  SidecarSpec as AppSidecarSpec,
  SidecarStartOptions as AppSidecarStartOptions,
} from '../../../src/main/module-host/main-host'
import type {
  McpConnectionContext as AppMcpConnectionContext,
  McpConnectionMetadata as AppMcpConnectionMetadata,
  McpToolRegistration as AppMcpToolRegistration,
  McpToolResult as AppMcpToolResult,
} from '../../../src/shared/modules/mcp-tools'
import type {
  EnsureSkillInstalledResult as AppEnsureSkillInstalledResult,
  ModuleSkillStatus as AppModuleSkillStatus,
  ModuleSkillStatusResult as AppModuleSkillStatusResult,
} from '../../../src/shared/modules/skills'
import type { ModuleWorkspaceContextService as AppModuleWorkspaceContextService } from '../../../src/main/modules/module-workspace-service'
import type {
  ModuleStorageChange as AppModuleStorageChange,
  ModuleStorageErrorCode as AppModuleStorageErrorCode,
  ModuleStorageRegistry as AppModuleStorageRegistry,
  ModuleStorageResult as AppModuleStorageResult,
} from '../../../src/main/module-host/module-storage'
// Every token the host exports, read as one namespace so the key check below
// does not depend on what each token is called.
import * as appServiceTokens from '../../../src/main/module-host/service-tokens'
import {
  ConversationModuleServiceToken as AppConversationModuleServiceToken,
  GitHubModuleServiceToken as AppGitHubModuleServiceToken,
  ModuleSecretsServiceToken as AppModuleSecretsServiceToken,
} from '../../../src/main/module-host/service-tokens'
// Backlog, usage and activity service tokens.
import {
  ActivityModuleServiceToken as AppActivityModuleServiceToken,
  BacklogModuleServiceToken as AppBacklogModuleServiceToken,
  UsageModuleServiceToken as AppUsageModuleServiceToken,
} from '../../../src/main/module-host/service-tokens'
// The host-internal chat tokens, provided by agent-runtime-module.
import {
  ConversationLaunchServiceToken as AppConversationLaunchServiceToken,
  ConversationRuntimeToken as AppConversationRuntimeToken,
} from '../../../src/main/module-host/service-tokens'
import { THIRD_PARTY_SERVICE_KEYS as APP_THIRD_PARTY_SERVICE_KEYS } from '../../../src/main/module-host/main-host'
import type { CapabilityModule as AppCapabilityModule } from '../../../src/main/module-host/load-modules'
import type { CompanionAgentsModuleRegistry as AppCompanionAgentsModuleRegistry } from '../../../src/main/companion-agent-service'
import type {
  ModuleWorkspaceGitInfoResult as AppModuleWorkspaceGitInfoResult,
  ModuleWorkspaceGitRemote as AppModuleWorkspaceGitRemote,
  ModuleWorkspaceListEntry as AppModuleWorkspaceListEntry,
  ModuleWorkspaceListOptions as AppModuleWorkspaceListOptions,
  ModuleWorkspaceView as AppModuleWorkspaceView,
} from '../../../src/shared/modules/workspace-view'
import type {
  BacklogItemLink as AppBacklogItemLink,
  BacklogItemStatus as AppBacklogItemStatus,
  BacklogResolvedLink as AppBacklogResolvedLink,
} from '../../../src/renderer/src/utils/backlog'

import type {
  BacklogItemLink as SdkBacklogItemLink,
  BacklogItemStatus as SdkBacklogItemStatus,
  BacklogResolvedLink as SdkBacklogResolvedLink,
  CapabilityManifest as SdkCapabilityManifest,
  ExtensionActivate as SdkExtensionActivate,
  ExtensionManifest as SdkExtensionManifest,
  ExtensionMount as SdkExtensionMount,
  CapabilityPermission as SdkCapabilityPermission,
  CompanionAgentEvent as SdkCompanionAgentEvent,
  CompanionAgentHandle as SdkCompanionAgentHandle,
  CompanionAgentSpec as SdkCompanionAgentSpec,
  CompanionAgentStatus as SdkCompanionAgentStatus,
  CompanionAgentsService as SdkCompanionAgentsService,
  CompanionRunStructuredOptions as SdkCompanionRunStructuredOptions,
  ScheduledAgent as SdkScheduledAgent,
  ScheduledAgentAttachment as SdkScheduledAgentAttachment,
  ScheduledAgentDraft as SdkScheduledAgentDraft,
  ScheduledAgentLastRun as SdkScheduledAgentLastRun,
  ScheduledAgentRun as SdkScheduledAgentRun,
  ModuleScheduledAgentsService as SdkModuleScheduledAgentsService,
  ScheduledAgentSchedule as SdkScheduledAgentSchedule,
  ScheduledAgentView as SdkScheduledAgentView,
  ScheduledAgentWriteResult as SdkScheduledAgentWriteResult,
  FileDropPayload as SdkFileDropPayload,
  MainHost as SdkMainHost,
  McpConnectionContext as SdkMcpConnectionContext,
  McpConnectionMetadata as SdkMcpConnectionMetadata,
  McpToolRegistration as SdkMcpToolRegistration,
  EnsureSkillInstalledResult as SdkEnsureSkillInstalledResult,
  ModuleSkillStatus as SdkModuleSkillStatus,
  ModuleSkillStatusResult as SdkModuleSkillStatusResult,
  McpToolResult as SdkMcpToolResult,
  ModuleEventEnvelope as SdkModuleEventEnvelope,
  ModuleNotification as SdkModuleNotification,
  ModuleNotificationSeverity as SdkModuleNotificationSeverity,
  ModuleNotifyInput as SdkModuleNotifyInput,
  ModuleFileDigests as SdkModuleFileDigests,
  ModuleSignature as SdkModuleSignature,
  ModuleSource as SdkModuleSource,
  ModuleStorageChange as SdkModuleStorageChange,
  ModuleStorageErrorCode as SdkModuleStorageErrorCode,
  ModuleStorageResult as SdkModuleStorageResult,
  ModuleStorageService as SdkModuleStorageService,
  ModuleTrustStatus as SdkModuleTrustStatus,
  ModuleWorkspaceGitInfoResult as SdkModuleWorkspaceGitInfoResult,
  ModuleWorkspaceGitRemote as SdkModuleWorkspaceGitRemote,
  ModuleWorkspaceListEntry as SdkModuleWorkspaceListEntry,
  ModuleWorkspaceListOptions as SdkModuleWorkspaceListOptions,
  ModuleWorkspaceView as SdkModuleWorkspaceView,
  WorkspaceContextService as SdkWorkspaceContextService,
  SidecarHandle as SdkSidecarHandle,
  SidecarRunState as SdkSidecarRunState,
  SidecarRuntimeStatus as SdkSidecarRuntimeStatus,
  SidecarSpec as SdkSidecarSpec,
  SidecarStartOptions as SdkSidecarStartOptions,
} from '../src/index'
import {
  SPRINTENGINE_FILE_DROP_MIME as SDK_FILE_DROP_MIME,
  WorkspaceContextToken as SdkWorkspaceContextToken,
  WorkspaceServiceToken as SdkWorkspaceServiceToken,
} from '../src/index'

// Host capabilities, conversations and brokered credentials: the SDK side is
// read off the public index, the app side off its shared twins.
import type * as sdk from '../src/index'
import type * as appHostApi from '../../../src/shared/modules/host-api'
import type * as appConversation from '../../../src/shared/modules/conversation-service'
// The conversation contract itself. The SDK restates it rather than depending
// on the package, so its published tarball stays self-contained; these pins
// are what keep the restatement the contract.
import type * as protocol from '../../conversation-protocol/src/public'
import type * as appBrokers from '../../../src/shared/modules/brokers'
// Backlog, usage and activity services.
import type * as appBacklogService from '../../../src/shared/modules/backlog-service'
import type * as appActivity from '../../../src/shared/modules/activity-service'
import type { BacklogItem as AppBacklogItem } from '../../../src/shared/backlog/scan'
import type * as appNotifications from '../../../src/shared/modules/notifications'
// The published service table and the testing kit (see the end of this file).
import {
  EXTENSION_HOST_SERVICES as SDK_EXTENSION_HOST_SERVICES,
  EXTENSION_MAIN_HOST_METHODS as SDK_EXTENSION_MAIN_HOST_METHODS,
} from '../src/services'
import { EXTENSION_PERMISSIONS as SDK_EXTENSION_PERMISSIONS } from '../src/permissions'
import { isStudioPermission } from '../../studio-protocol/src/permissions'
import {
  MODULE_METHOD_MAX_CHARS as SDK_MODULE_METHOD_MAX_CHARS,
  isModuleMethodName as sdkIsModuleMethodName,
} from '../src/methods'

type Extends<A, B> = [A] extends [B] ? true : false
// Type identity via the generic-function-identity trick: detects added/removed
// optional properties, which mutual assignability cannot.
type IsExact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// A failing assertion surfaces as `false is not assignable to true` on the
// exact line naming the drifted contract.
function expectType<_T extends true>(): void {}

// Exact mirrors (any structural difference, including optional-property
// drift, is a failure).
// A plugin bundle's base manifest is one the Studio protocol can list: the
// protocol's view adds only that an extension's version is a semver string.
expectType<IsExact<Omit<AppCapabilityManifest, 'version'>, Omit<SdkCapabilityManifest, 'version'>>>()
expectType<Extends<SdkCapabilityManifest, AppCapabilityManifest>>()
// extension.json as the protocol carries it is the SDK's validated manifest,
// with its closed vocabularies (icons, actions, permissions) read as strings.
expectType<Extends<SdkExtensionManifest, AppExtensionManifestView>>()
expectType<IsExact<keyof SdkExtensionManifest, keyof AppExtensionManifestView>>()
expectType<IsExact<keyof SdkExtensionManifest['contributes'], keyof AppExtensionManifestView['contributes']>>()
expectType<IsExact<AppModuleSignature, SdkModuleSignature>>()
expectType<IsExact<AppModuleFileDigests, SdkModuleFileDigests>>()
expectType<IsExact<AppModuleSource, SdkModuleSource>>()
expectType<IsExact<AppModuleTrustStatus, SdkModuleTrustStatus>>()
expectType<IsExact<AppCapabilityPermission, SdkCapabilityPermission>>()
// Declared methods' types are the SDK's own (src/methods.ts), imported by the
// app; the host members that take and give them are held equal below.
expectType<IsExact<AppFileDropPayload, SdkFileDropPayload>>()
expectType<IsExact<AppModuleNotification, SdkModuleNotification>>()
expectType<IsExact<AppModuleNotifyInput, SdkModuleNotifyInput>>()
expectType<IsExact<AppModuleNotificationSeverity, SdkModuleNotificationSeverity>>()
expectType<IsExact<AppSidecarSpec, SdkSidecarSpec>>()
expectType<IsExact<AppSidecarHandle, SdkSidecarHandle>>()
expectType<IsExact<AppSidecarRunState, SdkSidecarRunState>>()
expectType<IsExact<AppSidecarRuntimeStatus, SdkSidecarRuntimeStatus>>()
expectType<IsExact<AppSidecarStartOptions, SdkSidecarStartOptions>>()
expectType<IsExact<AppBacklogItemStatus, SdkBacklogItemStatus>>()
expectType<IsExact<AppBacklogItemLink, SdkBacklogItemLink>>()
expectType<IsExact<AppBacklogResolvedLink, SdkBacklogResolvedLink>>()
// One app-side declaration (shared/modules/workspace-view) backs both process
// surfaces; the SDK mirror must match it exactly, and the main-side service
// provided under WorkspaceContextToken must match the SDK's contract.
expectType<IsExact<AppModuleWorkspaceView, SdkModuleWorkspaceView>>()
expectType<IsExact<AppModuleWorkspaceContextService, SdkWorkspaceContextService>>()
// Module storage: the SDK publishes the scoped service (getModuleStorage);
// the app provides the moduleId-first registry under 'core.module-storage'.
// The registry the app serves must accept exactly what the SDK helper
// forwards, and the shared result/error shapes must mirror exactly.
expectType<IsExact<AppModuleStorageErrorCode, SdkModuleStorageErrorCode>>()
expectType<IsExact<AppModuleStorageResult<{ found: boolean }>, SdkModuleStorageResult<{ found: boolean }>>>()
type SdkExpectedStorageRegistry = {
  [K in keyof SdkModuleStorageService]: (
    moduleId: string,
    ...args: Parameters<SdkModuleStorageService[K]>
  ) => ReturnType<SdkModuleStorageService[K]>
}
expectType<Extends<AppModuleStorageRegistry, SdkExpectedStorageRegistry>>()
// Scheduled agents: the records an extension's scoped service hands back and
// takes are the app's own, field for field.
expectType<IsExact<AppScheduledAgentSchedule, SdkScheduledAgentSchedule>>()
expectType<IsExact<AppScheduledAgentAttachment, SdkScheduledAgentAttachment>>()
expectType<IsExact<AppScheduledAgentLastRun, SdkScheduledAgentLastRun>>()
expectType<IsExact<AppScheduledAgent, SdkScheduledAgent>>()
expectType<IsExact<AppScheduledAgentDraft, SdkScheduledAgentDraft>>()
expectType<IsExact<AppScheduledAgentView, SdkScheduledAgentView>>()
expectType<IsExact<AppScheduledAgentWriteResult, SdkScheduledAgentWriteResult>>()
expectType<IsExact<AppScheduledAgentRun, SdkScheduledAgentRun>>()
// What the app's registry hands a module's `onRun` listener is the SDK's view.
expectType<
  IsExact<
    Parameters<Parameters<AppScheduledAgentsModuleRegistry['onRun']>[1]>,
    Parameters<Parameters<SdkModuleScheduledAgentsService['onRun']>[0]>
  >
>()

// MCP tool contributions: the wire shapes mirror exactly — an
// optional-property drift on a tool registration would silently change what
// external modules can put on the gateway — and the contribution method is
// pinned exactly (the one-directional host assertion below would let a
// parameter widening ride through unnoticed).
expectType<IsExact<AppMcpToolResult, SdkMcpToolResult>>()
expectType<IsExact<AppMcpToolRegistration, SdkMcpToolRegistration>>()
expectType<IsExact<AppMcpConnectionMetadata, SdkMcpConnectionMetadata>>()
expectType<IsExact<AppMcpConnectionContext, SdkMcpConnectionContext>>()
expectType<IsExact<AppMainHost['registerMcpTools'], SdkMainHost['registerMcpTools']>>()
expectType<IsExact<AppMainHost['registerMethods'], SdkMainHost['registerMethods']>>()

// The app's skills in a workspace: the result shape and the host method,
// pinned exactly because the one-directional host assertion below would let a
// parameter widening through.
expectType<IsExact<AppEnsureSkillInstalledResult, SdkEnsureSkillInstalledResult>>()
expectType<IsExact<AppMainHost['ensureSkillInstalled'], SdkMainHost['ensureSkillInstalled']>>()

// ── Main-host plumbing (settings, workspaces, storage, GitHub, skills, MCP) ──
// Each addition pinned exactly, for the reason the whole file gives.
// Skills: the exhaustive status vocabulary and the read-only check.
expectType<IsExact<AppModuleSkillStatus, SdkModuleSkillStatus>>()
expectType<IsExact<AppModuleSkillStatusResult, SdkModuleSkillStatusResult>>()
expectType<IsExact<AppMainHost['getSkillStatus'], SdkMainHost['getSkillStatus']>>()
// Storage: the change signal a watch delivers, and the module's own directory
// and asset paths on the host.
expectType<IsExact<AppModuleStorageChange, SdkModuleStorageChange>>()
expectType<IsExact<AppMainHost['getModuleDataDir'], SdkMainHost['getModuleDataDir']>>()
expectType<IsExact<AppMainHost['getAssetPath'], SdkMainHost['getAssetPath']>>()
// Workspaces: closed history on the main-side list, and the git read on both hosts.
expectType<IsExact<AppModuleWorkspaceListEntry, SdkModuleWorkspaceListEntry>>()
expectType<IsExact<AppModuleWorkspaceListOptions, SdkModuleWorkspaceListOptions>>()
expectType<IsExact<AppModuleWorkspaceGitRemote, SdkModuleWorkspaceGitRemote>>()
expectType<IsExact<AppModuleWorkspaceGitInfoResult, SdkModuleWorkspaceGitInfoResult>>()
expectType<IsExact<AppMainHost['getWorkspaceGitInfo'], SdkMainHost['getWorkspaceGitInfo']>>()
// Settings in the worker: the app-state pair on MainHost.
expectType<IsExact<AppMainHost['getModuleAppState'], SdkMainHost['getModuleAppState']>>()
expectType<IsExact<AppMainHost['watchModuleAppState'], SdkMainHost['watchModuleAppState']>>()

// Host soundness: the app host handed to module code satisfies the SDK view.
expectType<Extends<AppMainHost, SdkMainHost>>()
// Host parity: the worker's host carries exactly the members the SDK
// publishes, no more. A surface's `studio` is built in its frame
// (server/extensions/frames/frame-bootstrap.ts), from EXTENSION_FRAME_METHODS.
expectType<IsExact<keyof AppMainHost, keyof SdkMainHost>>()
// The module-owned event channel: the emit half on MainHost, the envelope a
// surface hears as `push`.
expectType<IsExact<AppModuleEventEnvelope, SdkModuleEventEnvelope>>()
expectType<IsExact<AppMainHost['emit'], SdkMainHost['emit']>>()

// The entry contracts may be async: the loader awaits what `activate` returns,
// and the window what `mount` returns, so the SDK's contracts must be exactly
// what they accept.
expectType<IsExact<ReturnType<NonNullable<AppCapabilityModule['registerMain']>>, ReturnType<SdkExtensionActivate>>>()
expectType<IsExact<Parameters<SdkExtensionActivate>, [studio: SdkMainHost]>>()
expectType<IsExact<Parameters<SdkExtensionMount>[0], HTMLElement>>()

// ── Notifications ───────────────────────────────────────────────────────────

// A module's notify reaches the bell: the target it may name, on the input
// and on the published notification.
expectType<IsExact<appNotifications.ModuleNotificationTarget, sdk.ModuleNotificationTarget>>()
expectType<IsExact<AppMainHost['notify'], SdkMainHost['notify']>>()

// ── Host capabilities, conversations, brokered credentials ─────────────────
// Every shape exact. The event, status and attachment types are the app's own
// conversation-runtime types on the app side, so these pin the SDK's hand
// restatement to what the chat runtime actually emits.
expectType<IsExact<appHostApi.HostCapability, sdk.HostCapability>>()
expectType<IsExact<AppMainHost['supports'], SdkMainHost['supports']>>()
expectType<IsExact<AppMainHost['listChatRuntimes'], SdkMainHost['listChatRuntimes']>>()

expectType<IsExact<appConversation.ModuleConversationEventType, sdk.ModuleConversationEventType>>()
expectType<IsExact<appConversation.ModuleConversationEvent, sdk.ModuleConversationEvent>>()
expectType<IsExact<appConversation.ModuleConversationStatus, sdk.ModuleConversationStatus>>()
expectType<IsExact<appConversation.ModuleConversationRef, sdk.ModuleConversationRef>>()
expectType<IsExact<appConversation.ModuleConversationSummary, sdk.ModuleConversationSummary>>()
expectType<IsExact<appConversation.ModuleConversationImageAttachment, sdk.ModuleConversationImageAttachment>>()
expectType<IsExact<appConversation.ModuleConversationPermissionPreset, sdk.ModuleConversationPermissionPreset>>()
expectType<IsExact<appConversation.ModuleConversationApprovalDecision, sdk.ModuleConversationApprovalDecision>>()
expectType<IsExact<appConversation.ModuleConversationErrorCode, sdk.ModuleConversationErrorCode>>()
expectType<IsExact<appConversation.ModuleConversationCreateInput, sdk.ModuleConversationCreateInput>>()
expectType<
  IsExact<
    appConversation.ModuleConversationResult<{ events: appConversation.ModuleConversationEvent[] }>,
    sdk.ModuleConversationResult<{ events: sdk.ModuleConversationEvent[] }>
  >
>()
expectType<IsExact<appConversation.ModuleConversationService, sdk.ModuleConversationService>>()
expectType<IsExact<appConversation.ModuleOpenChatInput, sdk.ModuleOpenChatInput>>()
expectType<IsExact<appConversation.ModuleOpenChatResult, sdk.ModuleOpenChatResult>>()
expectType<IsExact<appConversation.ModuleChatRuntimeOption, sdk.ModuleChatRuntimeOption>>()
expectType<IsExact<appConversation.ModuleConversationPlanDecision, sdk.ModuleConversationPlanDecision>>()
expectType<IsExact<appConversation.ModuleConversationPage, sdk.ModuleConversationPage>>()
expectType<IsExact<appConversation.ModuleConversationStreamFrame, sdk.ModuleConversationStreamFrame>>()
expectType<IsExact<appConversation.ModuleConversationFollowOptions, sdk.ModuleConversationFollowOptions>>()
expectType<IsExact<appConversation.ModuleConversationCommandOptions, sdk.ModuleConversationCommandOptions>>()
// Agents, conversations and scheduled agents: what `turn_completed` documents
// (the reply text and the usage other services count from) is the protocol's.
expectType<IsExact<appConversation.ModuleConversationTurnUsage, sdk.ModuleConversationTurnUsage>>()
expectType<
  IsExact<appConversation.ModuleConversationTurnCompletedPayload, sdk.ModuleConversationTurnCompletedPayload>
>()
expectType<IsExact<protocol.ConversationTurnUsage, sdk.ModuleConversationTurnUsage>>()
expectType<IsExact<protocol.ConversationTurnCompletedPayload, sdk.ModuleConversationTurnCompletedPayload>>()
// Headless text generation: the service a module calls, and the registry the
// host provides under 'text-generation.module-service'.
expectType<IsExact<appConversation.ModuleTextGenerationInput, sdk.ModuleTextGenerationInput>>()
expectType<IsExact<appConversation.ModuleTextGenerationErrorCode, sdk.ModuleTextGenerationErrorCode>>()
expectType<IsExact<appConversation.ModuleTextGenerationResult, sdk.ModuleTextGenerationResult>>()
expectType<IsExact<appConversation.ModuleTextGenerationService, sdk.ModuleTextGenerationService>>()

// Against the protocol package directly, so a change there fails here even
// where the app's module contract would let it through.
expectType<IsExact<protocol.ConversationEventType, sdk.ModuleConversationEventType>>()
expectType<IsExact<protocol.ConversationEvent, sdk.ModuleConversationEvent>>()
expectType<IsExact<protocol.ConversationSessionStatus, sdk.ModuleConversationStatus>>()
expectType<IsExact<protocol.ConversationWirePermissionPreset, sdk.ModuleConversationPermissionPreset>>()
expectType<IsExact<protocol.ConversationRequestDecision, sdk.ModuleConversationApprovalDecision>>()
expectType<IsExact<protocol.ConversationPlanDecision, sdk.ModuleConversationPlanDecision>>()
expectType<IsExact<protocol.ConversationPage, sdk.ModuleConversationPage>>()
expectType<IsExact<protocol.ConversationStreamFrame, sdk.ModuleConversationStreamFrame>>()
// What a module's create shares with the contract's create means the same.
expectType<
  IsExact<
    Pick<protocol.ConversationCreateRequest, keyof protocol.ConversationCreateRequest>,
    Pick<sdk.ModuleConversationCreateInput, keyof protocol.ConversationCreateRequest>
  >
>()

expectType<IsExact<appBrokers.ModuleSecretsError, sdk.ModuleSecretsError>>()
expectType<IsExact<appBrokers.ModuleSecretFetchInit, sdk.ModuleSecretFetchInit>>()
expectType<IsExact<appBrokers.ModuleSecretFetchResult, sdk.ModuleSecretFetchResult>>()
expectType<IsExact<appBrokers.ModuleSecretsService, sdk.ModuleSecretsService>>()
expectType<IsExact<appBrokers.ModuleGitHubRequest, sdk.ModuleGitHubRequest>>()
expectType<IsExact<appBrokers.ModuleGitHubResponse, sdk.ModuleGitHubResponse>>()
expectType<IsExact<appBrokers.ModuleGitHubService, sdk.ModuleGitHubService>>()
// GitHub broker additions (headers, conditional requests, read-only GraphQL, download).
expectType<IsExact<appBrokers.ModuleGitHubMediaType, sdk.ModuleGitHubMediaType>>()
expectType<IsExact<appBrokers.ModuleGitHubErrorCode, sdk.ModuleGitHubErrorCode>>()
expectType<IsExact<appBrokers.ModuleGitHubDownloadRequest, sdk.ModuleGitHubDownloadRequest>>()
expectType<IsExact<appBrokers.ModuleGitHubDownloadResponse, sdk.ModuleGitHubDownloadResponse>>()

// The moduleId-first registries the app provides must accept exactly what the
// SDK helpers forward (the same derivation the storage registry is pinned by).
type SdkExpectedRegistry<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => infer R ? (moduleId: string, ...args: A) => R : never
}
expectType<IsExact<appConversation.ModuleConversationRegistry, SdkExpectedRegistry<sdk.ModuleConversationService>>>()
expectType<IsExact<appBrokers.ModuleSecretsRegistry, SdkExpectedRegistry<sdk.ModuleSecretsService>>>()
expectType<IsExact<appBrokers.ModuleGitHubRegistry, SdkExpectedRegistry<sdk.ModuleGitHubService>>>()
expectType<
  IsExact<appConversation.ModuleTextGenerationRegistry, SdkExpectedRegistry<sdk.ModuleTextGenerationService>>
>()

// ── Backlog, usage and activity services ────────────────────────────────────
// Every shape exact, except where the app hands out its own Backlog item: the
// scan's item carries more than the published view, so it must satisfy it and
// agree exactly on the fields the view names.
expectType<IsExact<appBacklogService.ModuleBacklogErrorCode, sdk.ModuleBacklogErrorCode>>()
expectType<IsExact<appBacklogService.ModuleBacklogResult, sdk.ModuleBacklogResult>>()
expectType<IsExact<appBacklogService.ModuleBacklogLocation, sdk.ModuleBacklogLocation>>()
expectType<IsExact<appBacklogService.ModuleBacklogTriageInput, sdk.ModuleBacklogTriageInput>>()
expectType<IsExact<appBacklogService.ModuleBacklogCreateInput, sdk.ModuleBacklogCreateInput>>()
expectType<IsExact<appBacklogService.ModuleBacklogCreated, sdk.ModuleBacklogCreated>>()
expectType<IsExact<appBacklogService.ModuleBacklogLinkInput, sdk.ModuleBacklogLinkInput>>()
expectType<IsExact<appBacklogService.BacklogWatchError, sdk.BacklogWatchError>>()
expectType<IsExact<appBacklogService.BacklogWatchOptions, sdk.BacklogWatchOptions>>()
type SdkBacklogItemView = sdk.BacklogItemView
expectType<Extends<AppBacklogItem, SdkBacklogItemView>>()
expectType<
  IsExact<
    Pick<AppBacklogItem, 'numericId' | 'displayId' | 'epic' | 'modifiedAt'>,
    Pick<SdkBacklogItemView, 'numericId' | 'displayId' | 'epic' | 'modifiedAt'>
  >
>()
expectType<Extends<appBacklogService.ModuleBacklogService, sdk.ModuleBacklogService>>()
expectType<IsExact<keyof appBacklogService.ModuleBacklogService, keyof sdk.ModuleBacklogService>>()
expectType<IsExact<Omit<appBacklogService.ModuleBacklogService, 'list'>, Omit<sdk.ModuleBacklogService, 'list'>>>()
expectType<Extends<appBacklogService.ModuleBacklogRegistry, SdkExpectedRegistry<sdk.ModuleBacklogService>>>()

expectType<IsExact<appActivity.UsageGroupBy, sdk.UsageGroupBy>>()
expectType<IsExact<appActivity.UsageQuery, sdk.UsageQuery>>()
expectType<IsExact<appActivity.UsageTokens, sdk.UsageTokens>>()
expectType<IsExact<appActivity.UsageRow, sdk.UsageRow>>()
expectType<IsExact<appActivity.UsageSource, sdk.UsageSource>>()
expectType<IsExact<appActivity.ModuleUsageErrorCode, sdk.ModuleUsageErrorCode>>()
expectType<IsExact<appActivity.ModuleUsageResult, sdk.ModuleUsageResult>>()
expectType<IsExact<appActivity.UsageQueryResult, sdk.UsageQueryResult>>()
expectType<IsExact<appActivity.ModuleUsageService, sdk.ModuleUsageService>>()
expectType<IsExact<appActivity.ModuleUsageRegistry, SdkExpectedRegistry<sdk.ModuleUsageService>>>()
expectType<IsExact<appActivity.ActivityChatSummary, sdk.ActivityChatSummary>>()
expectType<IsExact<appActivity.ActivityListChatsInput, sdk.ActivityListChatsInput>>()
expectType<IsExact<appActivity.ActivityPrompt, sdk.ActivityPrompt>>()
expectType<IsExact<appActivity.ActivityPromptsInput, sdk.ActivityPromptsInput>>()
expectType<IsExact<appActivity.ModuleActivityErrorCode, sdk.ModuleActivityErrorCode>>()
expectType<IsExact<appActivity.ModuleActivityResult, sdk.ModuleActivityResult>>()
expectType<IsExact<appActivity.ModuleActivityService, sdk.ModuleActivityService>>()
expectType<IsExact<appActivity.ModuleActivityRegistry, SdkExpectedRegistry<sdk.ModuleActivityService>>>()

// Companion agents. The app declares these shapes inline on the registry it
// serves under 'companion-agents.module-service', so they are read off it: the
// spec `attach` takes, the handle it returns, and what the handle's methods
// take and give. Exact, except the event the handle streams: the SDK widens
// `type` to string so a new app event kind never breaks a compiled module, so
// the app's event must satisfy that view and carry exactly its fields.
type AppCompanionAttach = AppCompanionAgentsModuleRegistry['attach']
type AppCompanionAgentHandle = ReturnType<AppCompanionAttach>
type AppCompanionAgentEvent = Parameters<Parameters<AppCompanionAgentHandle['onEvent']>[0]>[0]
expectType<IsExact<Parameters<AppCompanionAttach>, [moduleId: string, spec: SdkCompanionAgentSpec]>>()
expectType<IsExact<keyof AppCompanionAgentsModuleRegistry, keyof SdkCompanionAgentsService>>()
expectType<IsExact<Omit<AppCompanionAgentHandle, 'onEvent'>, Omit<SdkCompanionAgentHandle, 'onEvent'>>>()
expectType<IsExact<keyof AppCompanionAgentHandle, keyof SdkCompanionAgentHandle>>()
expectType<IsExact<ReturnType<AppCompanionAgentHandle['status']>, SdkCompanionAgentStatus>>()
expectType<
  IsExact<Parameters<AppCompanionAgentHandle['runStructured']>[0], SdkCompanionRunStructuredOptions<unknown>>
>()
expectType<Extends<AppCompanionAgentEvent, SdkCompanionAgentEvent>>()
expectType<IsExact<keyof AppCompanionAgentEvent, keyof SdkCompanionAgentEvent>>()

// Mirrored value exports must stay identical (run via test:sdk:drift).
assert.equal(SDK_FILE_DROP_MIME, APP_FILE_DROP_MIME, 'SPRINTENGINE_FILE_DROP_MIME drifted between SDK and app')
// A method name the SDK lets a module declare is one the protocol carries, and no other.
assert.equal(SDK_MODULE_METHOD_MAX_CHARS, 100)
for (const name of [
  'list',
  'cards.add',
  'v2-get',
  'List',
  '1x',
  '.x',
  'a:b',
  'a b',
  '',
  `a${'b'.repeat(99)}`,
  `a${'b'.repeat(100)}`,
])
  assert.equal(
    sdkIsModuleMethodName(name),
    isStudioModuleMethodName(name),
    `method name "${name}" drifted between SDK and protocol`,
  )

// Service-token keys. The SDK resolves every host service by a string key it
// keeps private (or publishes as a token), so the two sides agree only if the
// host provides a token under each of those exact strings. Checked both ways:
// every key below must appear in the emitted SDK, and the host must export a
// token with it — an accidental key edit on either side fails here instead of
// silently unresolving every module's requireService at runtime.
const SDK_SERVICE_TOKEN_KEYS = [
  'core.workspace',
  'core.workspace-context',
  'core.module-storage',
  'scheduled-agents.module-service',
  'companion-agents.module-service',
  'conversation.module-service',
  'module-secrets.module-service',
  'github.module-service',
  // Backlog, usage and activity services.
  'backlog.module-service',
  'usage.module-service',
  'activity.module-service',
  'text-generation.module-service',
] as const
const sdkRuntime = ['index.js', 'conversation.js', 'brokers.js', 'backlog.js', 'activity.js']
  .map((file) => readFileSync(join(process.cwd(), 'packages', 'extension-sdk', 'dist', file), 'utf8'))
  .join('\n')
const sdkKeysInRuntime = new Set(
  [...sdkRuntime.matchAll(/createServiceToken\(['"]([^'"]+)['"]\)|\{\s*key:\s*['"]([^'"]+)['"],?\s*\}/g)].map(
    (match) => match[1] ?? match[2],
  ),
)
assert.deepEqual(
  [...sdkKeysInRuntime].sort(),
  [...SDK_SERVICE_TOKEN_KEYS].sort(),
  'the SDK resolves a different set of host service keys than the drift guard pins',
)
const appServiceTokenKeys = new Set(
  Object.values(appServiceTokens as Record<string, unknown>)
    .filter((value): value is { key: string } => typeof (value as { key?: unknown } | null)?.key === 'string')
    .map((token) => token.key),
)
for (const key of SDK_SERVICE_TOKEN_KEYS) {
  assert.ok(appServiceTokenKeys.has(key), `the host provides no service token under the SDK key "${key}"`)
}
// The two tokens the SDK publishes by value are the same strings.
assert.equal(SdkWorkspaceServiceToken.key, 'core.workspace', 'WorkspaceServiceToken key drifted')
assert.equal(SdkWorkspaceContextToken.key, 'core.workspace-context', 'WorkspaceContextToken key drifted')
// The host tokens behind the SDK's conversation and broker helpers, by name,
// so a rename or a key edit on the host side fails here.
assert.equal(
  AppConversationModuleServiceToken.key,
  'conversation.module-service',
  'ConversationModuleServiceToken key drifted',
)
assert.equal(AppModuleSecretsServiceToken.key, 'module-secrets.module-service', 'ModuleSecretsServiceToken key drifted')
assert.equal(AppGitHubModuleServiceToken.key, 'github.module-service', 'GitHubModuleServiceToken key drifted')
assert.equal(AppBacklogModuleServiceToken.key, 'backlog.module-service', 'BacklogModuleServiceToken key drifted')
assert.equal(AppUsageModuleServiceToken.key, 'usage.module-service', 'UsageModuleServiceToken key drifted')
assert.equal(AppActivityModuleServiceToken.key, 'activity.module-service', 'ActivityModuleServiceToken key drifted')
// A third-party module may resolve exactly the keys the SDK resolves — every
// one of them, and nothing app-internal. The chat launch and the conversation
// runtime are first-party only: a module reaches chats through its own
// moduleId-scoped conversation service, never the unscoped host services.
assert.deepEqual(
  [...APP_THIRD_PARTY_SERVICE_KEYS].sort(),
  [...SDK_SERVICE_TOKEN_KEYS].sort(),
  'the third-party service allow-list differs from the keys the SDK resolves',
)
assert.equal(AppConversationLaunchServiceToken.key, 'core.conversation-launch')
assert.equal(AppConversationRuntimeToken.key, 'core.conversation-runtime')
for (const firstPartyOnly of [AppConversationLaunchServiceToken.key, AppConversationRuntimeToken.key]) {
  assert.equal(
    APP_THIRD_PARTY_SERVICE_KEYS.has(firstPartyOnly),
    false,
    `"${firstPartyOnly}" is first-party only and must not be on the third-party service allow-list`,
  )
}

// The published surface must not contain `any` (the source is also compiled
// with strict settings; this guards the emitted declarations the tarball ships).
// test:sdk:drift runs from the repo root (the script builds dist first).
const publicTypes = readFileSync(join(process.cwd(), 'packages', 'extension-sdk', 'dist', 'index.d.ts'), 'utf8')
assert.equal((publicTypes.match(/\bany\b/g) ?? []).length, 0, 'SDK public declaration surface must not contain `any`')
assert.equal(
  publicTypes.includes('ScheduledAgentsModuleRegistry'),
  false,
  'SDK public surface must not expose the raw moduleId-first scheduled agents registry',
)
assert.equal(
  publicTypes.includes('ModuleStorageRegistry'),
  false,
  'SDK public surface must not expose the raw moduleId-first storage registry',
)
assert.equal(
  publicTypes.includes('moduleStorageToken'),
  false,
  'SDK public surface must not expose the raw storage registry token',
)
// The conversation and broker helpers keep their moduleId-first registries and
// tokens private the same way; their declarations ship as separate files.
for (const file of ['conversation.d.ts', 'brokers.d.ts', 'host-api.d.ts', 'backlog.d.ts', 'activity.d.ts']) {
  const declarations = readFileSync(join(process.cwd(), 'packages', 'extension-sdk', 'dist', file), 'utf8')
  assert.equal((declarations.match(/\bany\b/g) ?? []).length, 0, `SDK ${file} must not contain \`any\``)
  assert.equal(
    /Registry\b|ServiceToken\b/.test(declarations),
    false,
    `SDK ${file} must not expose a raw moduleId-first registry or its token`,
  )
}

const sdkPackageJson = JSON.parse(
  readFileSync(join(process.cwd(), 'packages', 'extension-sdk', 'package.json'), 'utf8'),
) as { exports: Record<string, unknown> }

// ── The service table and the testing kit ────────────────────────────────────
//
// EXTENSION_HOST_SERVICES is what the host's gate checks every call against,
// and what the `/testing` fakes apply: one row per service an extension may
// resolve. It must cover the host's allow-list exactly, and name only
// permissions extension.json may ask for, and of an invoker only the Studio
// protocol's permissions (or `owner`).
assert.deepEqual(
  SDK_EXTENSION_HOST_SERVICES.map((service) => service.key).sort(),
  [...APP_THIRD_PARTY_SERVICE_KEYS].sort(),
  'EXTENSION_HOST_SERVICES must have one row per service on the host’s third-party allow-list',
)
const allRequirements = [
  ...SDK_EXTENSION_HOST_SERVICES.flatMap((service) =>
    Object.entries(service.methods).map(([name, requirement]) => [`${service.key}.${name}`, requirement] as const),
  ),
  ...Object.entries(SDK_EXTENSION_MAIN_HOST_METHODS),
]
for (const [name, requirement] of allRequirements) {
  if (requirement.extension !== null)
    assert.ok(
      (SDK_EXTENSION_PERMISSIONS as readonly string[]).includes(requirement.extension),
      `${name} needs "${requirement.extension}" of an extension, which extension.json cannot ask for`,
    )
  if (requirement.invoker !== null && requirement.invoker !== 'owner')
    assert.ok(
      isStudioPermission(requirement.invoker),
      `${name} needs "${requirement.invoker}" of an invoker, which no principal holds`,
    )
}
for (const subpath of ['./testing', './extension.schema.json']) {
  assert.ok(sdkPackageJson.exports[subpath], `@sprintengine/extension-sdk is missing the "${subpath}" export`)
}

console.log('extension-sdk drift guard passed')
