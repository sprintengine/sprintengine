// Types for run.mjs: the argv runner a WSL distribution's Studio runs git and
// programs with for the desktop.

export function decodeStdin(stdinB64: unknown): Buffer | null | undefined
export function checkRunRequest(request: {
  argv: unknown
  cwd?: unknown
  timeoutMs: unknown
  env?: unknown
}): string | null
export function runArgv(request: {
  argv: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs: number | null
  stdin?: Buffer
}): Promise<{
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  spawnFailed?: boolean
  truncated?: boolean
}>
export function killAllChildren(): void
