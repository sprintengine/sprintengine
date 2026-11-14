import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CONVERSATION_ATTACHMENTS_DIRECTORY,
  ConversationAttachmentStore,
  CONVERSATION_TOOL_IMAGES_DIRECTORY,
} from '../../main/conversation-attachment-store'
import { conversationStorageSegment } from '../../main/conversation-index'
import { CONVERSATION_PLANS_DIRECTORY } from '../../main/conversation-plan-store'
import { workspaceStorePath } from '../../main/workspace-store'
import { distroOfUncPath } from '../../shared/host-paths'

// The files a chat this desktop ran itself keeps on this disk
// (design-wsl-ssh-direct PR 3c): a WSL distribution's chat that ran through
// `wsl.exe`, before the distribution's own Studio held it. The hand-over
// carries each to that Studio (`environment.adopt`'s `chat`), which writes it
// where its own runtime reads it (environment-chat-files.ts).
//
// - In its workspace's store, under `conversations/<workspaceId>/`: its
//   transcript (with its commands' receipts), its tools' details and its
//   handoffs. A project in the distribution's home already keeps its store
//   inside the distribution, where its Studio reads it (workspace-store.ts
//   `resolveWslShare`): those are in place, and not carried.
// - In this desktop's data directory, in a folder named for the chat: the
//   pictures it was sent (its transcript names each by that folder), the
//   pictures its steps returned, and its plans' copies.

export type ChatSourceFile = {
  place: 'store' | 'attachments' | 'images' | 'plans'
  /** Its name in its place, as the machine checks it. */
  path: string
  /** Where it is on this disk. */
  source: string
}

const FOLDER_FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/u

async function files(folder: string): Promise<string[]> {
  return (await readdir(folder, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}

/** What the chat `{ workspaceRoot, workspaceId, agentId }` keeps on this disk that the distribution `distro` does not have. */
export async function chatSourceFiles(input: {
  dataDir: string
  distro: string
  workspaceRoot: string
  workspaceId: string
  agentId: string
}): Promise<ChatSourceFile[]> {
  const found: ChatSourceFile[] = []
  const agent = conversationStorageSegment(input.agentId)
  let store: string | null = null
  try {
    store = workspaceStorePath(input.workspaceRoot, 'conversations', conversationStorageSegment(input.workspaceId))
  } catch {
    // A folder this computer keeps no store for has no transcript here.
  }
  const inPlace = store !== null && distroOfUncPath(store)?.toLowerCase() === input.distro.toLowerCase()
  if (store && !inPlace) {
    const transcript = join(store, `${agent}.jsonl`)
    if ((await stat(transcript).catch(() => null))?.isFile())
      found.push({ place: 'store', path: `${agent}.jsonl`, source: transcript })
    for (const name of await files(join(store, `${agent}.tools`)))
      if (name.endsWith('.json'))
        found.push({ place: 'store', path: `${agent}.tools/${name}`, source: join(store, `${agent}.tools`, name) })
    for (const name of await files(join(store, 'handoffs')))
      if (name.startsWith(`${agent}-`) && name.endsWith('.md'))
        found.push({ place: 'store', path: `handoffs/${name}`, source: join(store, 'handoffs', name) })
  }
  const folder = ConversationAttachmentStore.folderFor(input)
  for (const [place, directory] of [
    ['attachments', CONVERSATION_ATTACHMENTS_DIRECTORY],
    ['images', CONVERSATION_TOOL_IMAGES_DIRECTORY],
    ['plans', CONVERSATION_PLANS_DIRECTORY],
  ] as const)
    for (const name of await files(join(input.dataDir, directory, folder)))
      // Only a name the machine keeps (environment-chat-files.ts): one it would refuse would refuse the chat.
      if (FOLDER_FILE.test(name))
        found.push({ place, path: `${folder}/${name}`, source: join(input.dataDir, directory, folder, name) })
  return found
}
