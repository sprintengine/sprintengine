import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// What the phone's chats reach for in `expo-file-system/legacy`, under Node:
// a file's size, and its bytes read a piece at a time as base64, as an upload
// sends them (`uploads.append`); and a picture written to the cache. The
// cross-client gate aliases the module to this file when it bundles the
// phone's client; it is the only part of the phone's protocol code the gate
// stands in for.

const pathOf = (uri: string) => (uri.startsWith('file:') ? fileURLToPath(uri) : uri)

export const EncodingType = { Base64: 'base64', UTF8: 'utf8' } as const
export const cacheDirectory: string | null = null

export async function getInfoAsync(uri: string): Promise<{ exists: boolean; size?: number }> {
  try {
    return { exists: true, size: statSync(pathOf(uri)).size }
  } catch {
    return { exists: false }
  }
}

export async function readAsStringAsync(
  uri: string,
  options: { encoding?: string; position?: number; length?: number } = {},
): Promise<string> {
  const bytes = readFileSync(pathOf(uri))
  const start = options.position ?? 0
  const piece = bytes.subarray(start, options.length === undefined ? undefined : start + options.length)
  return options.encoding === 'base64' ? piece.toString('base64') : piece.toString('utf8')
}

export async function writeAsStringAsync(): Promise<void> {
  throw new Error('The gate keeps no picture cache.')
}

export async function makeDirectoryAsync(): Promise<void> {}
