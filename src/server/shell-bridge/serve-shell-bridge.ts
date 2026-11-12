import type { TerminalLaunchPreparation } from '../terminals/terminal-launch-preparation'
import type { ControlRpc } from '../bootstrap/control-rpc'
import {
  SHELL_BRIDGE_EVENTS,
  SHELL_BRIDGE_METHODS,
  type ShellAnalyticsEvent,
  type ShellBridge,
  type ShellNotice,
  type ShellRevealTarget,
} from './shell-bridge'
import { isChatAddress } from '../../../packages/studio-protocol/src/environment'
import { isRecord } from '../../shared/records'

// The shell's side of the bridge: what a server out of process asks on the
// control channel, answered by the shell's own in-process bridge. One
// implementation answers both paths, so the server sees the same behaviour
// whichever side of the channel it runs on.
//
// Every request is checked for shape here: the channel is process-private, but
// a server built from another commit (a dev rebuild) is still a peer whose
// frames are read, not trusted to be well formed.

export function serveShellBridge(rpc: ControlRpc, bridge: ShellBridge): () => void {
  const stops = [
    rpc.handle(SHELL_BRIDGE_METHODS.cipherAvailable, () => bridge.cipher.available()),
    rpc.handle(SHELL_BRIDGE_METHODS.cipherSeal, (params) => bridge.cipher.seal(bytesParam(params))),
    rpc.handle(SHELL_BRIDGE_METHODS.cipherOpen, (params) => bridge.cipher.open(bytesParam(params))),
    // The shell's part of a terminal agent's launch. The inputs are the
    // runtime's own, passed through: each step is the shell writing into a
    // folder its own launches write into too.
    rpc.handle(SHELL_BRIDGE_METHODS.launchIntegration, (params) =>
      bridge.launches.prepareLaunchIntegration(launchInput<'prepareLaunchIntegration'>(params, 'workspaceRoot')),
    ),
    rpc.handle(SHELL_BRIDGE_METHODS.launchMcpSync, (params) =>
      bridge.launches.syncMcpConfig(launchInput<'syncMcpConfig'>(params, 'workspaceRoot')),
    ),
    rpc.handle(SHELL_BRIDGE_METHODS.launchSkill, async (params) => {
      const input = record(params, 'workspaceRoot')
      if (typeof input.skillId !== 'string') throw new Error('A skill to install names its id.')
      const launch = isRecord(input.launch) ? (input.launch as { hostId: string; integration: null }) : undefined
      await bridge.launches.ensureBuiltinSkillInstalled(
        input.workspaceRoot as string,
        input.skillId,
        typeof input.cli === 'string' ? input.cli : undefined,
        launch,
      )
      return true
    }),
    rpc.handle(SHELL_BRIDGE_METHODS.launchExcludeMcpConfig, async (params) => {
      await bridge.launches.excludeWorktreeMcpConfig(record(params, 'worktreePath').worktreePath as string)
      return true
    }),
    rpc.handle(SHELL_BRIDGE_METHODS.launchAgentStateHook, async (params) => {
      const input = record(params, 'workspaceRoot')
      if (typeof input.cli !== 'string') throw new Error('A hook to install names its CLI.')
      await bridge.launches.prepareAgentStateHook(
        input.workspaceRoot as string,
        input.cli,
        isRecord(input.execution) ? (input.execution as Parameters<TerminalLaunchPreparation['prepareAgentStateHook']>[2]) : undefined,
      )
      return true
    }),
    rpc.handle(SHELL_BRIDGE_METHODS.revealTab, (params) => {
      const target = revealTarget(params)
      return target ? bridge.reveal.tab(target) : false
    }),
    rpc.handle(SHELL_BRIDGE_METHODS.imageDownscale, (params) => {
      if (!isRecord(params) || !(params.bytes instanceof Uint8Array) || typeof params.mediaType !== 'string') {
        throw new Error('A picture to shrink is its bytes and its media type.')
      }
      return bridge.images.downscale(params.bytes, params.mediaType)
    }),
    rpc.handle(SHELL_BRIDGE_METHODS.integrationsReady, async () => {
      await bridge.integrationsReady()
      return true
    }),
    rpc.on(SHELL_BRIDGE_EVENTS.notify, (payload) => {
      const notice = shellNotice(payload)
      if (notice) bridge.notify(notice)
    }),
    rpc.on(SHELL_BRIDGE_EVENTS.analytics, (payload) => {
      if (isRecord(payload) && typeof payload.name === 'string' && isRecord(payload.properties)) {
        bridge.analytics(payload as ShellAnalyticsEvent)
      }
    }),
  ]
  return () => {
    for (const stop of stops) stop()
  }
}

/** A request whose `field` is a folder path: the one thing every launch step is about. */
function record(params: unknown, field: string): Record<string, unknown> {
  if (!isRecord(params) || typeof params[field] !== 'string' || !params[field]) {
    throw new Error(`A launch step names its ${field}.`)
  }
  return params
}

function launchInput<K extends 'prepareLaunchIntegration' | 'syncMcpConfig'>(
  params: unknown,
  field: string,
): Parameters<TerminalLaunchPreparation[K]>[0] {
  return record(params, field) as Parameters<TerminalLaunchPreparation[K]>[0]
}

function bytesParam(params: unknown): Uint8Array {
  if (params instanceof Uint8Array) return params
  throw new Error('The cipher takes bytes.')
}

function revealTarget(value: unknown): ShellRevealTarget | null {
  if (!isRecord(value)) return null
  if (value.kind === 'remote') return { kind: 'remote' }
  if (value.kind === 'app') return { kind: 'app' }
  if (value.kind === 'chat') {
    // A chat by its address only: a target that names no environment is not one.
    const address = { environmentId: value.environmentId, chatId: value.chatId }
    if (!isChatAddress(address)) return null
    return {
      kind: 'chat',
      environmentId: address.environmentId,
      chatId: address.chatId,
      ...(typeof value.agentId === 'string' && value.agentId ? { agentId: value.agentId } : {}),
    }
  }
  return null
}

function shellNotice(value: unknown): ShellNotice | null {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.title !== 'string') return null
  const activate = value.activate === undefined ? undefined : revealTarget(value.activate)
  return {
    key: value.key,
    title: value.title,
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
    ...(typeof value.silent === 'boolean' ? { silent: value.silent } : {}),
    ...(activate ? { activate } : {}),
  }
}
