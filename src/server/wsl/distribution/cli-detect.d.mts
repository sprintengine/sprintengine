// Types for cli-detect.mjs: finding agent CLIs on the login PATH, with their versions.

export type CliProbeAsk = { binary: string; versionArgs?: string[] }
export type CliProbeAnswer =
  { found: false } | { found: true; path: string; output: string; timedOut: boolean } | { error: string }
export function createCliDetector(options: {
  getEnv: () => Promise<Record<string, string | undefined>> | Record<string, string | undefined>
  onPathsChanged?: () => void
}): {
  detect(requests: CliProbeAsk[], options?: { force?: boolean }): Promise<CliProbeAnswer[]>
  close(): void
}
