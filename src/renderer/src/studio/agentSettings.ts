import {
  STUDIO_AGENT_RUNTIMES_CAPABILITY,
  STUDIO_AGENT_SETTINGS_CAPABILITY,
  type StudioCapability,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
} from '../../../../packages/studio-protocol/src/public'
import type {
  AgentCli,
  AgentLaunchSettings,
  AgentLaunchSettingsPatch,
  AgentLaunchSettingsRecord,
  AgentLaunchSettingsSnapshot,
  AgentLaunchSettingsWriteAck,
  ChatTitleRequest,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliModelDiscoveryInput,
  CliModelDiscoveryResult,
  CliRuntimeSettings,
  CliUpdateAllItem,
  CliUpdateAllResult,
  CliVersionAdvisoriesInput,
  CliVersionAdvisoriesResult,
  CommitMessageDraftRequest,
  CommitMessageResult,
  CliRuntimeTarget,
  ExecutionHostId,
  TextGenerationResult,
  TextGenerationSettings,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to its Studio's agent CLIs and launch settings: the
// Studio protocol's `cliRuntimes.*`, `cliVersions.*`, `cliModels.*`,
// `launchSettings.*`, `textGeneration.*` and `commitMessage.*`, over the
// window's own connection, as every other client reaches them. The members
// keep the names the window has always called them by, so a caller changes
// only where it imports them from. A follow (`on…`) is kept across the
// window's reconnects and returns its unsubscriber.

type Runtime = Partial<CliRuntimeSettings> | undefined

export type AgentSettingsApi = {
  cliDetect(cli: AgentCli, runtime?: Runtime): Promise<CliDetectResult>
  cliInstallMethods(cli: AgentCli, runtime?: Runtime): Promise<CliInstallMethodInfo[]>
  cliInstall(input: CliInstallInput, runtime?: Runtime): Promise<CliInstallResult>
  cliUpdate(cli: AgentCli, runtime?: Runtime): Promise<CliInstallResult>
  /** Update every CLI with a newer version published, on this machine and each WSL distribution turned on. */
  cliUpdateAll(): Promise<CliUpdateAllResult>
  /** Every item of a running Update everything, each time one moves. */
  onCliUpdateAllProgress(cb: (items: CliUpdateAllItem[]) => void): () => void
  /** An install's or update's output, for the CLI on the machine `hostId` names (absent: this one). */
  onCliInstallOutput(cli: AgentCli, cb: (chunk: string) => void, hostId?: string): () => void
  /** Installed versions against the registry's newest. Never rejects: a failure is `{ ok: false }`. */
  cliVersionAdvisories(input?: CliVersionAdvisoriesInput): Promise<CliVersionAdvisoriesResult>
  /** The Settings switch for the background version check. */
  cliVersionChecksSetEnabled(enabled: boolean): Promise<{ enabled: boolean }>
  onCliVersionAdvisoriesChanged(cb: (result: CliVersionAdvisoriesResult) => void): () => void
  /** Ask the installed CLIs which models they accept; every catalog a probe produced is told to `onCliModelsChanged` too. */
  cliModelsDiscover(input?: CliModelDiscoveryInput): Promise<CliModelDiscoveryResult>
  onCliModelsChanged(cb: (result: CliModelDiscoveryResult) => void): () => void
  /** The Studio's launch settings: the record (null before any write) and the settings in force. */
  launchSettingsGet(): Promise<AgentLaunchSettingsSnapshot>
  /** A partial write; the answer carries the record the Studio now holds. */
  launchSettingsUpdate(patch: AgentLaunchSettingsPatch): Promise<AgentLaunchSettingsWriteAck>
  /** Offer this window's old local values once; `changed: false` is a refusal. */
  launchSettingsMigrate(settings: AgentLaunchSettings): Promise<AgentLaunchSettingsWriteAck>
  /** Every change to the launch settings, as the new record. */
  onLaunchSettingsChanged(cb: (record: AgentLaunchSettingsRecord) => void): () => void
  /** A chat's title from its first prompt. Never rejects: a failure is `{ ok: false }`, and the caller keeps what it had. */
  generateChatTitle(request: ChatTitleRequest): Promise<TextGenerationResult>
  /** The window's titles setting, which the Studio titles its chats by. */
  setTextGenerationSettings(settings: TextGenerationSettings): Promise<void>
  /** A commit message for what is staged in `repoRoot`. Never rejects. */
  draftCommitMessage(request: CommitMessageDraftRequest): Promise<CommitMessageResult>
  /** Stop a draft this window started. */
  cancelCommitMessageDraft(draftId: string): Promise<void>
}

const UNSERVED: Record<string, string> = {
  [STUDIO_AGENT_RUNTIMES_CAPABILITY]:
    'This Studio does not manage its CLIs while it runs in its own process (a preview setting). Turn that off in Settings to use them.',
  [STUDIO_AGENT_SETTINGS_CAPABILITY]: 'This Studio does not serve its launch settings.',
}

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function call<M extends StudioMethod>(
  capability: StudioCapability,
  method: M,
  params: StudioMethodParams<M>,
): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(capability)) throw new Error(UNSERVED[capability] ?? `This Studio does not serve ${method}.`)
  return client.request(method, params)
}

const runtimes = <M extends StudioMethod>(method: M, params: StudioMethodParams<M>) =>
  call(STUDIO_AGENT_RUNTIMES_CAPABILITY, method, params)
const settings = <M extends StudioMethod>(method: M, params: StudioMethodParams<M>) =>
  call(STUDIO_AGENT_SETTINGS_CAPABILITY, method, params)

/** The program and machine a probe runs against; the models a person keeps are not the probe's to know. */
function target(runtime: Runtime): { runtime?: CliRuntimeTarget } {
  if (!runtime) return {}
  const picked: CliRuntimeTarget = {
    ...(runtime.command === undefined ? {} : { command: runtime.command }),
    ...(runtime.hostId === undefined ? {} : { hostId: runtime.hostId }),
  }
  return Object.keys(picked).length > 0 ? { runtime: picked } : {}
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether this page reaches a Studio at all: a desktop window or a web tab does. */
export function windowHasStudio(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.studioWindowTicket === 'function'
}

export const agentSettingsApi: AgentSettingsApi = {
  cliDetect: (cli, runtime) => runtimes('cliRuntimes.detect', { cli, ...target(runtime) }),
  cliInstallMethods: async (cli, runtime) =>
    (await runtimes('cliRuntimes.installMethods', { cli, ...target(runtime) })).methods,
  cliInstall: (input, runtime) =>
    runtimes('cliRuntimes.install', {
      commandId: randomId(),
      cli: input.cli,
      methodId: input.methodId,
      ...target(runtime),
    }),
  cliUpdate: (cli, runtime) => runtimes('cliRuntimes.update', { commandId: randomId(), cli, ...target(runtime) }),
  cliUpdateAll: () => runtimes('cliRuntimes.updateAll', { commandId: randomId() }),
  onCliUpdateAllProgress: (cb) =>
    followWindowStudioPush({
      topic: 'cliRuntimes.updateAllProgress',
      params: {},
      capability: STUDIO_AGENT_RUNTIMES_CAPABILITY,
      onPayload: ({ items }) => cb(items),
    }),
  onCliInstallOutput: (cli, cb, hostId) =>
    followWindowStudioPush({
      topic: 'cliRuntimes.output',
      params: { cli, ...(hostId && hostId !== 'local' ? { hostId: hostId as ExecutionHostId } : {}) },
      capability: STUDIO_AGENT_RUNTIMES_CAPABILITY,
      onPayload: ({ chunk }) => cb(chunk),
    }),
  cliVersionAdvisories: async (input = {}) => {
    try {
      return await runtimes('cliVersions.advisories', input)
    } catch (error) {
      return { ok: false, message: words(error) }
    }
  },
  cliVersionChecksSetEnabled: (enabled) => runtimes('cliVersions.setEnabled', { commandId: randomId(), enabled }),
  onCliVersionAdvisoriesChanged: (cb) =>
    followWindowStudioPush({
      topic: 'cliVersions.changed',
      params: {},
      capability: STUDIO_AGENT_RUNTIMES_CAPABILITY,
      onPayload: cb,
    }),
  cliModelsDiscover: (input = {}) => settings('cliModels.discover', input),
  onCliModelsChanged: (cb) =>
    followWindowStudioPush({
      topic: 'cliModels.changed',
      params: {},
      capability: STUDIO_AGENT_SETTINGS_CAPABILITY,
      onPayload: cb,
    }),
  launchSettingsGet: () => settings('launchSettings.get', {}),
  launchSettingsUpdate: (patch) => settings('launchSettings.update', { commandId: randomId(), patch }),
  launchSettingsMigrate: (offered) => settings('launchSettings.migrate', { commandId: randomId(), settings: offered }),
  onLaunchSettingsChanged: (cb) =>
    followWindowStudioPush({
      topic: 'launchSettings.changed',
      params: {},
      capability: STUDIO_AGENT_SETTINGS_CAPABILITY,
      onPayload: cb,
    }),
  generateChatTitle: async (request) => {
    try {
      return await settings('textGeneration.chatTitle', request)
    } catch (error) {
      return { ok: false, code: 'unavailable', message: words(error) }
    }
  },
  setTextGenerationSettings: async (chosen) => {
    await settings('textGeneration.setSettings', { commandId: randomId(), settings: chosen })
  },
  draftCommitMessage: async (request) => {
    try {
      return await settings('commitMessage.draft', request)
    } catch (error) {
      return { ok: false, code: 'unavailable', message: words(error) }
    }
  },
  cancelCommitMessageDraft: async (draftId) => {
    await settings('commitMessage.cancel', { draftId })
  },
}
