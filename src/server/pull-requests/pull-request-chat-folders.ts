import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeFileAtomic } from '../platform/atomic-file'
import type { PullRequestConversationKey } from './pull-request-record'

// The folders of watched chats this server holds no record of.
//
// A WSL distribution's server and an SSH machine's run chats whose records the
// desktop keeps: each start hands the server the folder, and nothing else
// says where the chat lives. A pull request watch an agent there asked for is
// that server's (`pull_request.watch` is not relayed), and its wake must reach
// the chat after the session is gone, after the server restarted, with no
// window open. So the folder the chat worked in when the watch was asked for
// is kept here, beside the record, and let go once no watch and no waiting
// news names the chat.
//
// A server that holds the chat's record (the desktop's) never writes here:
// the record says where the chat is, and whether it was put away.

const FILE_VERSION = 1

export type PullRequestChatFolders = {
  folderOf(key: PullRequestConversationKey): string | null
  /** Keep where the chat works; a write only when it changed. */
  remember(key: PullRequestConversationKey, folder: string): void
  /** Let go of every chat but these. */
  retain(keys: readonly PullRequestConversationKey[]): void
  /** Settles once every write asked for so far is on disk (or failed). */
  flush(): Promise<void>
}

const idOf = (key: PullRequestConversationKey) => JSON.stringify([key.workspaceId, key.agentId])

function pullRequestChatFoldersPath(dataDir: string): string {
  return join(dataDir, 'pull-requests', 'chat-folders.json')
}

export function createPullRequestChatFolders(options: {
  dataDir: string
  log?: (message: string) => void
}): PullRequestChatFolders {
  const path = pullRequestChatFoldersPath(options.dataDir)
  const folders = new Map<string, { key: PullRequestConversationKey; folder: string }>()
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const chats = parsed && typeof parsed === 'object' ? (parsed as { chats?: unknown }).chats : null
    if (Array.isArray(chats)) {
      for (const entry of chats) {
        if (!entry || typeof entry !== 'object') continue
        const { workspaceId, agentId, folder } = entry as Record<string, unknown>
        if (typeof workspaceId !== 'string' || typeof agentId !== 'string' || typeof folder !== 'string') continue
        if (!workspaceId || !agentId || !folder) continue
        const key = { workspaceId, agentId }
        folders.set(idOf(key), { key, folder })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT')
      options.log?.(`The folders of watched chats could not be read; starting without them: ${String(error)}`)
  }

  let writes: Promise<void> = Promise.resolve()
  const persist = (): void => {
    const body = `${JSON.stringify(
      {
        version: FILE_VERSION,
        chats: [...folders.values()].map(({ key, folder }) => ({ ...key, folder })),
      },
      null,
      2,
    )}\n`
    writes = writes
      .then(async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFileAtomic(path, body, { mode: 0o600 })
      })
      .catch((error: unknown) => {
        options.log?.(`The folders of watched chats could not be written: ${String(error)}`)
      })
  }

  return {
    folderOf: (key) => folders.get(idOf(key))?.folder ?? null,
    remember(key, folder) {
      if (!folder) return
      const id = idOf(key)
      if (folders.get(id)?.folder === folder) return
      folders.set(id, { key: { workspaceId: key.workspaceId, agentId: key.agentId }, folder })
      persist()
    },
    retain(keys) {
      const kept = new Set(keys.map(idOf))
      let changed = false
      for (const id of [...folders.keys()]) {
        if (kept.has(id)) continue
        folders.delete(id)
        changed = true
      }
      if (changed) persist()
    },
    flush: () => writes,
  }
}
