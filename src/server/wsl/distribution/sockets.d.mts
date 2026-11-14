// Types for sockets.mjs: the private runtime directory a WSL terminal's shell
// records its pid in.

export function ensurePrivateDir(path: string, uid?: number): string
export function runtimeBase(options: { env: Record<string, string | undefined>; uid?: number }): string
export function ensureSocketDir(options: {
  env: Record<string, string | undefined>
  uid?: number
  profile: string
  base?: string
}): string
