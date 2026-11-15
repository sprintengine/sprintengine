// Types for files.mjs: a directory tree written whole, replaced atomically.

export const MAX_TREE_BYTES: number
export function checkTreePath(path: unknown): boolean
export function ensureTree(options: {
  base: string
  name: string
  digest: string
  files?: Array<{ path: string; b64: string; executable?: boolean }>
}): { root: string; current: boolean }
