import { useSyncExternalStore } from 'react'

import type { ConversationCheckoutFileChange } from '../../../../packages/conversation-protocol/src/checkoutFiles'
import type { FileSearchResult, FileWatchEvent } from '../../../shared/ipc/filesystem'
import { parseMeshConversationSessionId, type MeshConversationKey } from '../../../shared/tailnet-mesh'
import type { Workspace } from '../types/workspace'

// A chat's folder on a paired machine, as this window's Files tab and editor
// read and change it (`conversation-checkout-files`). The folder is that
// machine's, so nothing here touches this disk: every read and write is asked
// of the machine, over the chat's own conversation lane, by a path relative to
// the folder the chat works in there.
//
// The tree and the editor key everything by path, so the far folder is given
// one of its own that no folder on this disk can have, `paired:<machine>/
// <workspace>/<chat>`, and a file in it is that root and its relative path.
// The rest of the app passes those paths around as it passes any other; the
// few places that read or write a file ask `checkoutFs` (checkoutFs.ts), which
// sends a paired path here and every other path to this disk.

const SCHEME = 'paired:'

/** Whether a path names something in a paired machine's chat folder rather than on this disk. */
export function isPairedCheckoutPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(SCHEME)
}

/** The root a paired chat's folder is kept under here. Names no folder of this disk. */
export function pairedCheckoutRoot(key: MeshConversationKey): string {
  return `${SCHEME}${[key.connectionId, key.workspaceId, key.agentId].map(encodeURIComponent).join('/')}`
}

/** The chat a paired path is in, its root here, and the path relative to the chat's folder (`''` the folder). */
export function parsePairedCheckoutPath(
  path: string,
): { key: MeshConversationKey; root: string; relative: string } | null {
  if (!isPairedCheckoutPath(path)) return null
  const segments = path.slice(SCHEME.length).split('/')
  if (segments.length < 3) return null
  const [connectionId, workspaceId, agentId] = segments.slice(0, 3).map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return ''
    }
  })
  if (!connectionId || !workspaceId || !agentId) return null
  const key = { connectionId, workspaceId, agentId }
  return { key, root: pairedCheckoutRoot(key), relative: segments.slice(3).filter(Boolean).join('/') }
}

/** A path under a paired root, from its path relative to the chat's folder. */
export function pairedCheckoutPath(root: string, relative: string): string {
  return relative ? `${root}/${relative}` : root
}

/**
 * The chat a workspace here shows from a paired machine, or null for one of
 * this machine's own. A row born before the session id was stamped names no
 * chat, so it has no folder to read either.
 */
export function pairedCheckoutOf(
  workspace: Pick<Workspace, 'remoteOrigin'> | null | undefined,
): { key: MeshConversationKey; root: string; machineName: string } | null {
  const origin = workspace?.remoteOrigin
  const chat = origin?.sessionId ? parseMeshConversationSessionId(origin.sessionId) : null
  if (!origin || !chat) return null
  const key = { connectionId: origin.connectionId, workspaceId: chat.workspaceId, agentId: chat.agentId }
  return { key, root: pairedCheckoutRoot(key), machineName: origin.machineName || 'the other machine' }
}

// ── What the machine said of the folder itself ────────────────────────────

export type PairedCheckoutRootInfo = { name: string; path: string; machineName: string | null }

const rootInfo = new Map<string, PairedCheckoutRootInfo>()
const machineNames = new Map<string, string>()
const rootListeners = new Set<() => void>()

function emitRoots(): void {
  for (const listener of [...rootListeners]) listener()
}

/** Say which machine a paired root is on, for the words the tree and its menus use. */
export function describePairedCheckout(root: string, machineName: string): void {
  if (machineNames.get(root) === machineName) return
  machineNames.set(root, machineName)
  const known = rootInfo.get(root)
  if (known) rootInfo.set(root, { ...known, machineName })
  emitRoots()
}

function noteRoot(root: string, info: { name: string; path: string }): void {
  const known = rootInfo.get(root)
  if (known && known.name === info.name && known.path === info.path) return
  rootInfo.set(root, { ...info, machineName: machineNames.get(root) ?? null })
  emitRoots()
}

/** The machine's name for a paired chat's folder, once it has listed it; null before, and for a path of this disk. */
export function usePairedCheckoutRootInfo(root: string | null): PairedCheckoutRootInfo | null {
  return useSyncExternalStore(
    (listener) => {
      rootListeners.add(listener)
      return () => {
        rootListeners.delete(listener)
      }
    },
    () => (root && isPairedCheckoutPath(root) ? (rootInfo.get(root) ?? null) : null),
  )
}

/** The machine a paired path is on, for words: its name where known. */
export function pairedMachineName(path: string): string {
  const parsed = parsePairedCheckoutPath(path)
  return (parsed && machineNames.get(parsed.root)) || 'the other machine'
}

// ── Following the chat while anything reads its folder ────────────────────

type Follow = {
  refs: number
  unfollow: () => void
  listeners: Set<(paths: string[] | null) => void>
  watching: boolean
  lingering: ReturnType<typeof setTimeout> | null
}

/** How long a follow outlives its last reader: a tree's reads come in bursts. */
const FOLLOW_LINGER_MS = 10_000
/** How long to wait before asking again of a follow the machine's link was not ready for. */
const RETRY_MS = 300
const RETRIES = 10

const follows = new Map<string, Follow>()

function followIdOf(key: MeshConversationKey): string {
  return pairedCheckoutRoot(key)
}

function watchNow(key: MeshConversationKey, follow: Follow, attempt = 0): void {
  void window.api.meshConversationWatchCheckoutFiles({ key, watching: true }).then(
    (result) => {
      if (result.ok || follow.refs === 0) return
      if (result.code === 'not_following' && attempt < RETRIES)
        setTimeout(() => {
          if (follow.watching && follows.get(followIdOf(key)) === follow) watchNow(key, follow, attempt + 1)
        }, RETRY_MS)
    },
    () => undefined,
  )
}

/**
 * Hold the chat followed, and its folder watched while anyone listens: the
 * lane's requests ride on the follow, and the machine says what moved only to
 * a socket that asked. Returns the release.
 */
function holdFollow(key: MeshConversationKey, listener?: (paths: string[] | null) => void): () => void {
  const id = followIdOf(key)
  let follow = follows.get(id)
  if (!follow) {
    const created: Follow = { refs: 0, unfollow: () => {}, listeners: new Set(), watching: false, lingering: null }
    created.unfollow = window.api.onMeshConversationSession({ key }, (frame) => {
      if (frame.type !== 'checkoutFiles') return
      for (const heard of [...created.listeners]) heard(frame.paths)
    })
    follows.set(id, created)
    follow = created
  }
  const held = follow
  if (held.lingering) {
    clearTimeout(held.lingering)
    held.lingering = null
  }
  held.refs += 1
  if (listener) {
    held.listeners.add(listener)
    if (!held.watching) {
      held.watching = true
      watchNow(key, held)
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    held.refs -= 1
    if (listener) {
      held.listeners.delete(listener)
      if (held.listeners.size === 0 && held.watching) {
        held.watching = false
        void window.api.meshConversationWatchCheckoutFiles({ key, watching: false }).catch(() => undefined)
      }
    }
    if (held.refs > 0) return
    held.lingering = setTimeout(() => {
      if (held.refs > 0 || follows.get(id) !== held) return
      follows.delete(id)
      held.unfollow()
    }, FOLLOW_LINGER_MS)
  }
}

/** Ask the machine something over the chat's follow, again while the follow is a moment behind. */
async function ask<T extends { ok: boolean; code?: string }>(
  key: MeshConversationKey,
  run: () => Promise<T>,
): Promise<T> {
  const release = holdFollow(key)
  try {
    for (let attempt = 0; ; attempt++) {
      const answer = await run()
      if (answer.ok || answer.code !== 'not_following' || attempt >= RETRIES) return answer
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
    }
  } finally {
    release()
  }
}

function place(path: string): { key: MeshConversationKey; root: string; relative: string } {
  const parsed = parsePairedCheckoutPath(path)
  if (!parsed) throw new Error('That path is not in a paired machine’s chat folder.')
  return parsed
}

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function parentOf(relative: string): string {
  const at = relative.lastIndexOf('/')
  return at < 0 ? '' : relative.slice(0, at)
}

function nameOf(relative: string): string {
  return relative.slice(relative.lastIndexOf('/') + 1)
}

async function change(path: string, made: ConversationCheckoutFileChange): Promise<string> {
  const { key, root } = place(path)
  const answer = await ask(key, () => window.api.meshConversationChangeCheckoutFile({ key, change: made }))
  if (!answer.ok) throw new Error(answer.message)
  return pairedCheckoutPath(root, answer.path)
}

/** The far folder's half of `checkoutFs`: each call by a paired path, answered by its machine. */
export const pairedCheckoutFs = {
  async readdir(path: string): Promise<{ name: string; isDir: boolean; ignored?: boolean }[]> {
    const { key, root, relative } = place(path)
    const answer = await ask(key, () => window.api.meshConversationCheckoutFolder({ key, path: relative }))
    if (!answer.ok) throw new Error(answer.message)
    noteRoot(root, answer.root)
    return answer.entries.map((entry) => ({
      name: entry.name,
      isDir: entry.kind === 'folder',
      ...(entry.ignored ? { ignored: true } : {}),
    }))
  },

  async readfile(path: string): Promise<string> {
    const { key, relative } = place(path)
    const answer = await ask(key, () => window.api.meshConversationCheckoutFile({ key, path: relative }))
    if (!answer.ok) throw new Error(answer.message)
    if (answer.file.kind === 'text') return answer.file.content
    if (answer.file.kind === 'too-large')
      throw new Error(`${nameOf(relative)} is too large to open from ${pairedMachineName(path)}.`)
    throw new Error(`${nameOf(relative)} is not text, so it cannot be opened from ${pairedMachineName(path)}.`)
  },

  async pathExists(path: string): Promise<boolean> {
    const { relative } = place(path)
    if (!relative) return true
    try {
      const entries = await pairedCheckoutFs.readdir(pairedCheckoutPath(place(path).root, parentOf(relative)))
      return entries.some((entry) => entry.name === nameOf(relative))
    } catch {
      return false
    }
  },

  async writefile(path: string, content: string): Promise<void> {
    await change(path, { kind: 'write', path: place(path).relative, content })
  },

  createFile(parentDir: string, name: string): Promise<string> {
    return change(parentDir, { kind: 'createFile', path: joinRelative(place(parentDir).relative, name.trim()) })
  },

  createDir(parentDir: string, name: string): Promise<string> {
    return change(parentDir, { kind: 'createFolder', path: joinRelative(place(parentDir).relative, name.trim()) })
  },

  renamePath(sourcePath: string, nextName: string): Promise<string> {
    const { relative } = place(sourcePath)
    return change(sourcePath, { kind: 'rename', path: relative, to: joinRelative(parentOf(relative), nextName.trim()) })
  },

  movePath(sourcePath: string, destinationDir: string): Promise<string> {
    const from = place(sourcePath)
    const into = place(destinationDir)
    if (from.root !== into.root) return Promise.reject(new Error('Files move only within one chat’s folder.'))
    return change(sourcePath, {
      kind: 'rename',
      path: from.relative,
      to: joinRelative(into.relative, nameOf(from.relative)),
    })
  },

  async deletePath(targetPath: string): Promise<void> {
    await change(targetPath, { kind: 'delete', path: place(targetPath).relative })
  },

  /**
   * Hear what moves under `path` in the chat's folder, as `watchPath` does on
   * this disk: each event names paths relative to `path`, and one naming none
   * means "read again".
   */
  async watchPath(path: string, cb: (event: FileWatchEvent) => void): Promise<() => Promise<void>> {
    const { key, relative } = place(path)
    const prefix = relative ? `${relative}/` : ''
    const release = holdFollow(key, (paths) => {
      if (paths === null) {
        cb({ eventType: 'rename', path: null, paths: [], overflow: true })
        return
      }
      const under = paths
        .filter((moved) => !relative || moved === relative || moved.startsWith(prefix))
        .map((moved) => (moved === relative ? '' : moved.slice(prefix.length)))
      if (under.length === 0) return
      cb({ eventType: 'rename', path: under[0] ?? null, paths: under })
    })
    return async () => release()
  },

  /** Find files by name, as the composer's mentions do over there (`conversation-file-search`). */
  async searchFiles(rootPath: string, query: string, options?: { limit?: number }): Promise<FileSearchResult> {
    const { key, root } = place(rootPath)
    const started = performance.now()
    const answer = await ask(key, () => window.api.meshConversationSearchFiles({ key, query }))
    if (!answer.ok) return { ok: false, message: answer.message, engine: null }
    const limit = options?.limit ?? answer.entries.length
    const results = answer.entries.slice(0, limit).map((entry) => {
      const path = pairedCheckoutPath(root, entry.path)
      return {
        name: nameOf(entry.path),
        path,
        parentPath: pairedCheckoutPath(root, parentOf(entry.path)),
        isDir: entry.kind === 'folder',
      }
    })
    return {
      ok: true,
      results,
      truncated: answer.truncated || answer.entries.length > limit,
      engine: 'walker',
      elapsedMs: Math.round(performance.now() - started),
      resultCount: results.length,
    }
  },
}
