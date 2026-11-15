// Types for proc.mjs: the process reads a WSL distribution's Studio makes for
// the desktop's WSL terminals (the idle reaper's verdicts, the survivor kill).

export type SubtreeLiveReason = 'listening_port' | 'busy_cpu' | 'tool_shell'

export function snapshot(options: {
  procRoot?: string
  pidDir: string
  keys: string[]
  sampleMs?: number
  uid?: number
}): Promise<Record<string, SubtreeLiveReason | null>>
export function survivorPids(options: {
  procRoot?: string
  pidDir: string
  cliSessionId: string
  key: string
  uid?: number
  selfPid?: number
}): number[]
export function endAllSessions(options: {
  procRoot?: string
  pidDir: string
  uid?: number
  selfPid?: number
  kill?: (pid: number, signal: string) => void
}): number[]
