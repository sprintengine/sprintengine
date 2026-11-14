// Types for run.mjs, which the Studio server inside a WSL distribution bundles
// too: the same argv runner, shared rather than copied.

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
