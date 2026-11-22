import { isPathOrChild } from './paths'

type EditorBufferListener = () => void

const buffers = new Map<string, string>()
const listeners = new Map<string, Set<EditorBufferListener>>()
// What each open file held on disk when the editor last read or wrote it. The
// buffer is compared against it when the file changes on disk, to tell an
// agent's edit from the editor's own save (utils/editorDiskSync.ts). Kept
// beside the buffers so it follows them through a rename, a move and a close.
const diskBaselines = new Map<string, string>()
// A binary file's bytes, for an extension's editor that edits bytes
// (`contentKind: "bytes"`), and what was last read from or written to disk:
// the text buffers' counterparts, kept here so they outlive the editor's frame
// and follow the file through a rename, a move and a close as the text does.
const byteBuffers = new Map<string, Uint8Array>()
const byteBaselines = new Map<string, Uint8Array>()
const stores: Array<Map<string, unknown>> = [buffers, diskBaselines, byteBuffers, byteBaselines]

function keysOf(workspaceId: string, matches: (path: string) => boolean): string[] {
  const keys = new Set<string>()
  for (const store of stores)
    for (const key of store.keys()) {
      const [owner, path] = key.split('\u0000')
      if (owner === workspaceId && path && matches(path)) keys.add(key)
    }
  return [...keys]
}

function moveKey(fromKey: string, toKey: string): void {
  for (const store of stores) {
    if (!store.has(fromKey)) continue
    const value = store.get(fromKey)
    store.delete(fromKey)
    store.set(toKey, value)
  }
}

function bufferKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`
}

function emit(workspaceId: string, path: string): void {
  listeners.get(bufferKey(workspaceId, path))?.forEach((listener) => listener())
}

export function getEditorBuffer(workspaceId: string, path: string, fallback = ''): string {
  return buffers.get(bufferKey(workspaceId, path)) ?? fallback
}

export function hasEditorBuffer(workspaceId: string, path: string): boolean {
  return buffers.has(bufferKey(workspaceId, path))
}

export function setEditorBuffer(workspaceId: string, path: string, content: string): void {
  const key = bufferKey(workspaceId, path)
  if (buffers.get(key) === content) return
  buffers.set(key, content)
  emit(workspaceId, path)
}

export function getEditorDiskBaseline(workspaceId: string, path: string): string | undefined {
  return diskBaselines.get(bufferKey(workspaceId, path))
}

export function setEditorDiskBaseline(workspaceId: string, path: string, content: string): void {
  diskBaselines.set(bufferKey(workspaceId, path), content)
}

export function deleteEditorBuffer(workspaceId: string, path: string): void {
  const key = bufferKey(workspaceId, path)
  const had = buffers.has(key) || byteBuffers.has(key)
  for (const store of stores) store.delete(key)
  if (had) emit(workspaceId, path)
}

export function remapEditorBuffers(workspaceId: string, fromPath: string, toPath: string): void {
  const separator = fromPath.includes('\\') && !fromPath.includes('/') ? '\\' : '/'
  const fromPrefix = `${fromPath}${separator}`
  for (const key of keysOf(workspaceId, (path) => path === fromPath || path.startsWith(fromPrefix))) {
    const path = key.split('\u0000')[1]!
    const nextPath = `${toPath}${path === fromPath ? '' : path.slice(fromPath.length)}`
    moveKey(key, bufferKey(workspaceId, nextPath))
    emit(workspaceId, path)
    emit(workspaceId, nextPath)
  }
}

export function moveEditorBuffer(sourceWorkspaceId: string, destWorkspaceId: string, path: string): void {
  if (sourceWorkspaceId === destWorkspaceId) return
  const sourceKey = bufferKey(sourceWorkspaceId, path)
  if (!buffers.has(sourceKey) && !byteBuffers.has(sourceKey)) return
  moveKey(sourceKey, bufferKey(destWorkspaceId, path))
  emit(sourceWorkspaceId, path)
  emit(destWorkspaceId, path)
}

export function removeEditorBuffersForPath(workspaceId: string, path: string): void {
  for (const key of keysOf(workspaceId, (bufferPath) => isPathOrChild(bufferPath, path))) {
    for (const store of stores) store.delete(key)
    emit(workspaceId, key.split('\u0000')[1]!)
  }
}

/** A binary file's bytes as an extension's editor left them, or undefined. */
export function getEditorBytes(workspaceId: string, path: string): Uint8Array | undefined {
  return byteBuffers.get(bufferKey(workspaceId, path))
}

export function setEditorBytes(workspaceId: string, path: string, bytes: Uint8Array): void {
  byteBuffers.set(bufferKey(workspaceId, path), bytes)
  emit(workspaceId, path)
}

export function getEditorBytesBaseline(workspaceId: string, path: string): Uint8Array | undefined {
  return byteBaselines.get(bufferKey(workspaceId, path))
}

export function setEditorBytesBaseline(workspaceId: string, path: string, bytes: Uint8Array): void {
  byteBaselines.set(bufferKey(workspaceId, path), bytes)
}

export function subscribeEditorBuffer(workspaceId: string, path: string, listener: EditorBufferListener): () => void {
  const key = bufferKey(workspaceId, path)
  const bucket = listeners.get(key) ?? new Set<EditorBufferListener>()
  bucket.add(listener)
  listeners.set(key, bucket)

  return () => {
    bucket.delete(listener)
    if (bucket.size === 0) listeners.delete(key)
  }
}
