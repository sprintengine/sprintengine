import { watch, type FSWatcher } from 'node:fs'

import type {
  StudioBacklogChanged,
  StudioBacklogItem,
  StudioBacklogUpdate,
  StudioBacklogWorkspace,
  StudioPullRequestDetail,
  StudioPullRequestDiffPage,
  StudioShare,
} from '../../../packages/studio-protocol/src/public'
import {
  resolveBacklogLocation,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from '../../main/backlog-service'
import { createStudioBacklogFolders, type StudioBacklogFolders } from './backlog-folders'
import { assertBacklogRelativePath, readMobileBacklogWorkspaceSnapshot } from '../../main/mobile/control/backlog'
import { MobileControlCommandError } from '../../main/mobile/control/command-error'
import { deepRedactLocalPaths } from '../../main/mobile/control/path-safety'
import {
  ghPullRequestReader,
  readMobilePullRequest,
  readMobilePullRequestDiff,
  type MobileControlPullRequestReader,
} from '../../main/mobile/control/pull-request'
import { validateMobileWorkspacePath } from '../../main/mobile/control/workspace'
import { deriveWorkspaceId, isWorkspaceIdToken } from '../../main/mobile/control/workspace-id'
import type {
  BacklogMutationResult,
  BacklogCriticalityPayload,
  BacklogDifficultyPayload,
  BacklogItemStatusPayload,
  BacklogTypePayload,
} from '../../shared/electron-api'

// What a client away from the desktop reads of the projects a Studio holds,
// and the little it changes there: each project's backlog (`backlog.*`), the
// pages the machine shares on the tailnet (`shares.list`), and a pull request
// read in full (`pullRequests.detail`, `.diff`), from the services in
// `src/main/mobile/control/`.
//
// No local path leaves: a project is named by a token derived from its folder
// (`deriveWorkspaceId`), which an update names back and which resolves only to
// a folder this Studio holds; anything else that reads as a path is redacted.

type Refusal = { ok: false; code: 'not_found' | 'invalid_params' | 'unavailable'; message: string }
type Answer<T> = { ok: true; value: T } | Refusal

export type StudioBacklog = {
  /** A project's backlog by its folder: the desktop's own windows' Backlog panel. */
  folders: StudioBacklogFolders
  list(): Promise<StudioBacklogWorkspace[]>
  update(update: StudioBacklogUpdate): Promise<Answer<{ item: StudioBacklogItem | null }>>
  /** Hear which projects' backlogs moved. The folders are watched only while someone listens. */
  onChanged(listener: (changed: StudioBacklogChanged) => void): () => void
}

export type StudioPhoneReads = {
  backlog: StudioBacklog
  shares(): Promise<StudioShare[]>
  pullRequest(url: string): Promise<Answer<StudioPullRequestDetail>>
  pullRequestDiff(url: string, path: string, offset: number): Promise<Answer<StudioPullRequestDiffPage>>
}

export type StudioPhoneReadsDeps = {
  /** The project folders this Studio holds now. */
  roots(): string[]
  /** The pages published on the tailnet; none where there is no tailnet. */
  readShares?(): Promise<StudioShare[]>
  pullRequests?: MobileControlPullRequestReader
  now?: () => number
  /** How long a change is gathered before it is said. */
  debounceMs?: number
}

/** A share started or stopped reaches a client within this; reading them runs `tailscale` twice. */
const SHARES_MAX_AGE_MS = 20_000
const CHANGE_DEBOUNCE_MS = 300
/** How often the watched folders are matched to the projects held, while someone listens. */
const ROOTS_REFRESH_MS = 60_000

/** One project's backlog with its folder turned into its token. */
function tokenized(workspace: StudioBacklogWorkspace): StudioBacklogWorkspace {
  const token = deriveWorkspaceId(workspace.workspacePath)
  return deepRedactLocalPaths({
    ...workspace,
    workspaceId: `backlog:${token}`,
    workspacePath: token,
    projectKey: token,
  })
}

/** A refusal as it crosses: a message from the filesystem names the file it failed on, so its paths are redacted. */
function refusal(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message: deepRedactLocalPaths(message) }
}

function refusalOf(error: unknown): Refusal {
  if (error instanceof MobileControlCommandError) {
    if (error.code === 'path_not_allowed') return refusal('not_found', error.message)
    if (error.code === 'invalid_payload') return refusal('invalid_params', error.message)
    return refusal('unavailable', error.message)
  }
  return refusal('unavailable', error instanceof Error ? error.message : String(error))
}

export function createStudioPhoneReads(deps: StudioPhoneReadsDeps): StudioPhoneReads {
  const now = deps.now ?? Date.now
  const reader = deps.pullRequests ?? ghPullRequestReader
  let shares: { read: Promise<StudioShare[]>; at: number } | null = null

  async function readOne(root: string): Promise<StudioBacklogWorkspace | null> {
    const read = await readMobileBacklogWorkspaceSnapshot(root, new Date(now()).toISOString()).catch(() => null)
    return read ? tokenized(read) : null
  }

  async function list(): Promise<StudioBacklogWorkspace[]> {
    const read = await Promise.all(deps.roots().map(readOne))
    return read
      .filter((workspace): workspace is StudioBacklogWorkspace => workspace !== null)
      .sort((left, right) => left.workspaceName.localeCompare(right.workspaceName))
  }

  async function update(change: StudioBacklogUpdate): Promise<Answer<{ item: StudioBacklogItem | null }>> {
    const roots = deps.roots()
    const token = change.workspaceId.startsWith('backlog:') ? change.workspaceId.slice('backlog:'.length) : ''
    let root: string
    let relativePath: string
    try {
      // A token only: a client never names a folder on this machine.
      if (!isWorkspaceIdToken(token))
        return { ok: false, code: 'not_found', message: 'That project is not on this machine.' }
      root = await validateMobileWorkspacePath({ workspacePath: token, allowedWorkspaceRoots: roots })
      relativePath = assertBacklogRelativePath(change.relativePath)
    } catch (error) {
      return refusalOf(error)
    }
    const { status, type, difficulty, criticality } = change
    // Each is a whole read-modify-write of the store, so they go one at a time.
    const mutations: Array<() => Promise<BacklogMutationResult>> = []
    if (status !== undefined)
      mutations.push(() =>
        updateBacklogStatus({ workspaceRoot: root, relativePath, status: status as BacklogItemStatusPayload }),
      )
    if (type !== undefined)
      mutations.push(() => updateBacklogType({ workspaceRoot: root, relativePath, type: type as BacklogTypePayload }))
    if (difficulty !== undefined || criticality !== undefined)
      mutations.push(() =>
        updateBacklogTriage({
          workspaceRoot: root,
          relativePath,
          ...(difficulty !== undefined ? { difficulty: difficulty as BacklogDifficultyPayload } : {}),
          ...(criticality !== undefined ? { criticality: criticality as BacklogCriticalityPayload } : {}),
        }),
      )
    for (const mutation of mutations) {
      const result = await mutation()
      if (!result.ok) return refusal('invalid_params', result.message)
    }
    const after = await readOne(root)
    const item = after?.items.find((entry) => entry.relativePath.toLowerCase() === relativePath.toLowerCase()) ?? null
    return { ok: true, value: { item } }
  }

  // ── Changes ────────────────────────────────────────────────────────────────

  const listeners = new Set<(changed: StudioBacklogChanged) => void>()
  const watchers = new Map<string, FSWatcher>()
  const pending = new Set<string>()
  let flush: ReturnType<typeof setTimeout> | null = null
  let refresh: ReturnType<typeof setInterval> | null = null

  function changed(root: string): void {
    pending.add(`backlog:${deriveWorkspaceId(root)}`)
    if (flush) return
    flush = setTimeout(() => {
      flush = null
      const workspaceIds = [...pending].sort()
      pending.clear()
      for (const listener of [...listeners]) listener({ workspaceIds })
    }, deps.debounceMs ?? CHANGE_DEBOUNCE_MS)
  }

  async function watchRoots(): Promise<void> {
    const roots = new Set(deps.roots())
    for (const [root, watcher] of watchers)
      if (!roots.has(root)) {
        watcher.close()
        watchers.delete(root)
      }
    for (const root of roots) {
      if (watchers.has(root)) continue
      const located = await resolveBacklogLocation(root)
      if (listeners.size === 0) return
      if (!located.ok || !located.location.exists || watchers.has(root)) continue
      try {
        const watcher = watch(located.location.root, { recursive: true, persistent: false }, () => changed(root))
        // A folder removed under it ends its watch; the next refresh finds it again.
        watcher.on('error', () => {
          watcher.close()
          if (watchers.get(root) === watcher) watchers.delete(root)
        })
        watchers.set(root, watcher)
      } catch {
        // A folder that cannot be watched is read again at the next list.
      }
    }
  }

  function stopWatching(): void {
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
    if (refresh) clearInterval(refresh)
    refresh = null
    if (flush) clearTimeout(flush)
    flush = null
    pending.clear()
  }

  function onChanged(listener: (changed: StudioBacklogChanged) => void): () => void {
    listeners.add(listener)
    if (listeners.size === 1) {
      void watchRoots()
      refresh = setInterval(() => void watchRoots(), ROOTS_REFRESH_MS)
      refresh.unref?.()
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) stopWatching()
    }
  }

  return {
    backlog: { folders: createStudioBacklogFolders(), list, update, onChanged },
    shares() {
      const at = now()
      if (shares && at - shares.at < SHARES_MAX_AGE_MS) return shares.read
      const read = (deps.readShares?.() ?? Promise.resolve([])).catch(() => [] as StudioShare[])
      shares = { read, at }
      return read
    },
    async pullRequest(url) {
      try {
        return { ok: true, value: await readMobilePullRequest(url, reader) }
      } catch (error) {
        return refusalOf(error)
      }
    },
    async pullRequestDiff(url, path, offset) {
      try {
        return { ok: true, value: await readMobilePullRequestDiff(url, path, offset, reader) }
      } catch (error) {
        return refusalOf(error)
      }
    },
  }
}
