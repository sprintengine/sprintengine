// Typed handles on the plain-Node modules a WSL distribution's Studio runs for
// the desktop (`src/server/wsl/distribution/`), for the tests that exercise
// them by path, as they run inside Linux.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type ProcRowLike = { pid: number; ppid: number; ticks: number; command: string }

export type ProcModule = {
  parseProcStat(text: string): { pid: number; ppid: number; ticks: number } | null
  parseListeningInodes(text: string): Set<string>
  socketInode(link: string): string | null
  readProcessTable(procRoot: string): ProcRowLike[] | null
  subtreeLiveReason(
    root: number,
    rows: ProcRowLike[],
    listening: Set<number>,
    cpuByPid: Map<number, number>,
  ): string | null
  snapshot(options: {
    procRoot: string
    pidDir: string
    keys: string[]
    sampleMs?: number
    uid?: number
  }): Promise<Record<string, string | null>>
  survivorPids(options: {
    procRoot: string
    pidDir: string
    cliSessionId: string
    key: string
    uid?: number
    selfPid: number
  }): number[]
  endAllSessions(options: {
    procRoot: string
    pidDir: string | null
    uid?: number
    selfPid: number
    kill?: (pid: number, signal: string) => void
  }): number[]
}

export type SessionsModule = {
  MAX_SESSION_WRITE_BYTES: number
  ensureSessionDir(options: { home: string; uid?: number; profile: string }): string
  writeSessionFiles(dir: string, files: unknown): string[]
  removeSessionEntries(dir: string, names: unknown): void
  clearSessionDir(dir: string): void
}

export type LoginEnvModule = {
  keepVariable(name: string): boolean
  parseEnvDump(bytes: Buffer | string, keep?: (name: string) => boolean): Record<string, string> | null
  loginShell(uid: number, passwd?: () => string): string
}

export type RunModule = {
  checkRunRequest(request: Record<string, unknown>): string | null
  decodeStdin(stdinB64: unknown): Buffer | null | undefined
  runArgv(request: {
    argv: string[]
    cwd?: string
    env?: Record<string, string>
    timeoutMs: number | null
    stdin?: Buffer
  }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>
}

export type SocketsModule = {
  ensureSocketDir(options: {
    env: Record<string, string | undefined>
    uid: number
    profile: string
    base?: string
  }): string
  runtimeBase(options: { env: Record<string, string | undefined>; uid: number }): string
}

export type CliDetectModule = {
  resolveBinary(binary: string, env: Record<string, string>): { path: string } | null
}

/** Where those modules live. */
export const DISTRIBUTION_DIR = join(process.cwd(), 'src', 'server', 'wsl', 'distribution')

export async function loadDistributionModule<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(join(DISTRIBUTION_DIR, name)).href)) as T
}
