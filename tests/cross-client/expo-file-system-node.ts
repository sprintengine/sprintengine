import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// What the phone's upload reaches for in `expo-file-system/legacy`, under
// Node: the file at `uri` streamed as the body of one request, answered as
// the native module answers (status and body). The cross-client gate aliases
// the module to this file when it bundles the phone's client; it is the only
// part of the phone's protocol code the gate stands in for.

export const FileSystemUploadType = { BINARY_CONTENT: 0, MULTIPART: 1 } as const

export function createUploadTask(
  url: string,
  uri: string,
  options: { httpMethod?: string; headers?: Record<string, string> },
): { uploadAsync(): Promise<{ status: number; body: string; headers: Record<string, string> }> } {
  return {
    async uploadAsync() {
      const path = uri.startsWith('file:') ? fileURLToPath(uri) : uri
      const response = await fetch(url, {
        method: options.httpMethod ?? 'POST',
        headers: options.headers ?? {},
        body: readFileSync(path),
      })
      return { status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers) }
    },
  }
}
