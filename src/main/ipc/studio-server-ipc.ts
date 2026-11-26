import type { IpcMain } from 'electron'

import { SERVER_METHODS, type ServerInfo } from '../../server/desktop/server-methods'
import {
  STUDIO_SERVER_CHANNELS,
  type StudioServerInfo,
  type StudioServerPhase,
  type StudioServerStatus,
} from '../../shared/studio-server-status'
import type { ServerSupervisor, SupervisorState } from '../server-supervisor/supervisor'

// The Studio server, as the windows ask about it: shell-owned, so every
// channel answers whether or not the server is running. A server that could
// not start is said in words (`stopped`, with its reason), with Retry and Open
// log; there is no other mode to fall back to.

export type StudioServerIpcDeps = {
  supervisor: Pick<ServerSupervisor, 'state' | 'health' | 'onState' | 'retry' | 'restart' | 'call'>
  openLog: () => Promise<boolean>
  /** Every window, told the status changed. */
  publish: (status: StudioServerStatus) => void
}

export function studioServerPhase(state: SupervisorState): StudioServerPhase {
  switch (state.kind) {
    case 'idle':
    case 'starting':
      return 'starting'
    case 'ready':
      return 'running'
    case 'backoff':
      return 'reconnecting'
    case 'failed':
    case 'stopped':
      return 'stopped'
    case 'stopping':
      return 'stopping'
  }
}

export function registerStudioServerIpc(ipcMain: IpcMain, deps: StudioServerIpcDeps): void {
  const { supervisor } = deps
  const status = (): StudioServerStatus => {
    const state = supervisor.state
    return {
      phase: studioServerPhase(state),
      reason: state.kind === 'failed' ? state.reason : null,
      pid: supervisor.health.pid,
      restarts: supervisor.health.restarts,
      startedAt: supervisor.health.startedAt,
    }
  }
  supervisor.onState(() => deps.publish(status()))

  ipcMain.handle(STUDIO_SERVER_CHANNELS.status, () => status())
  ipcMain.handle(STUDIO_SERVER_CHANNELS.info, async (): Promise<StudioServerInfo | null> => {
    if (supervisor.state.kind !== 'ready') return null
    const info = await supervisor.call<ServerInfo>(SERVER_METHODS.info, undefined, { timeoutMs: 5_000 })
    return {
      pid: info.pid,
      uptimeMs: info.uptimeMs,
      version: info.version,
      gatewaySocket: info.gatewaySocket,
      cipher: info.cipher,
      rssMb: info.rssMb,
      loopLagMs: supervisor.health.loopLagMs,
    }
  })
  ipcMain.handle(STUDIO_SERVER_CHANNELS.retry, () => supervisor.retry())
  ipcMain.handle(STUDIO_SERVER_CHANNELS.restart, () => supervisor.restart('Restart server, asked for in Settings'))
  ipcMain.handle(STUDIO_SERVER_CHANNELS.openLog, () => deps.openLog())
}
