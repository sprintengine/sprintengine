// Types for sessions.mjs: the private directory a WSL terminal's launch files
// are written into inside the distribution.

export const MAX_SESSION_WRITE_BYTES: number
export function ensureSessionDir(options: { home: string; uid?: number; profile: string }): string
export function writeSessionFiles(dir: string, files: Array<{ path: string; b64: string }>): string[]
export function removeSessionEntries(dir: string, names: string[]): void
export function clearSessionDir(dir: string): void
