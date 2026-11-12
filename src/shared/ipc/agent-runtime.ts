// Part of the IPC contract: how an agent runs, and detecting and installing its CLI.
// ../electron-api.ts re-exports everything here.

import type { AgentCli } from './conversations'
import type { ExecutionHostId } from '../execution-host'

export type {
  AgentExecutionMode,
  CliPermissionPreset,
  CliRuntimeSettings,
  McpClientTarget,
  McpTransport,
} from '../../../packages/studio-protocol/src/public'

// Result of probing whether an agent CLI binary is installed and runnable.
export type CliDetectResult = {
  cli: AgentCli
  binary: string
  installed: boolean
  version: string | null
  resolvedPath: string | null
  // The machine the probe ran on (`local`, or a WSL distribution).
  hostId: ExecutionHostId
  error: string | null
}

// One offered install path for a CLI on the current platform/runtime. The
// command string is authoritative in the main process; `commandPreview` is
// surfaced to the UI for transparency before the user consents to run it.
export type CliInstallMethodInfo = {
  id: string
  label: string
  // Whether the method's prerequisite (e.g. `npm`, `brew`) is present on PATH.
  available: boolean
  unavailableReason: string | null
  recommended: boolean
  commandPreview: string
  // The platform bucket this method was resolved from ('darwin' | 'linux' |
  // 'win32' | 'wsl').
  platform: string
}

export type CliInstallInput = {
  cli: AgentCli
  methodId: string
}

export type CliInstallResult = {
  ok: boolean
  cli: AgentCli
  installed: boolean
  version: string | null
  resolvedPath: string | null
  log: string
  error: string | null
}
