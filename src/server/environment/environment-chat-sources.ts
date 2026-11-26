import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { chatLogKey, importSource } from '../db/chat-logs'
import type { StudioDatabase } from '../db/database'

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
// - Its history (with its commands' receipts) and its tools' details, from
//   the data folder's database, written out as the transcript and detail
//   files the distribution's Studio imports (`server/db/chat-logs.ts`) when
//   it first opens the chat; and its handoffs, from its workspace's store,
//   under `conversations/<workspaceId>/`. A project in the distribution's home already keeps its store
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

/** The folder under the data directory a chat's history is written out to for a hand-over. */
export const HANDOVER_EXPORTS_DIRNAME = 'handover-exports'

/** What the chat `{ workspaceRoot, workspaceId, agentId }` keeps on this disk that the distribution `distro` does not have. */
export async function chatSourceFiles(input: {
  dataDir: string
  database: Pick<StudioDatabase, 'all'>
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
    const log = chatLogKey(join(store, `${agent}.jsonl`))
    const out = join(input.dataDir, HANDOVER_EXPORTS_DIRNAME, conversationStorageSegment(input.workspaceId), agent)
    await rm(out, { recursive: true, force: true })
    // Not imported here yet: its transcript and details are still the files builds before the database wrote.
    const imported = (await input.database.all('SELECT 1 FROM imports WHERE source = ?', [importSource(log)])).length > 0
    if (!imported) {
      const transcript = join(store, `${agent}.jsonl`)
      if ((await stat(transcript).catch(() => null))?.isFile())
        found.push({ place: 'store', path: `${agent}.jsonl`, source: transcript })
      for (const name of await files(join(store, `${agent}.tools`)))
        if (name.endsWith('.json'))
          found.push({ place: 'store', path: `${agent}.tools/${name}`, source: join(store, `${agent}.tools`, name) })
    }
    const events = imported
      ? await input.database.all<{ body: string }>('SELECT body FROM chat_events WHERE log_key = ? ORDER BY seq', [log])
      : []
    if (events.length > 0) {
      await mkdir(join(out, `${agent}.tools`), { recursive: true, mode: 0o700 })
      // The log as builds before the database kept it: its events in order, each receipt a line of its own.
      const receipts = await input.database.all<{ body: string }>(
        'SELECT body FROM chat_receipts WHERE log_key = ? ORDER BY at',
        [log],
      )
      const lines = [...events.map((row) => row.body), ...receipts.map((row) => JSON.stringify({ receipt: JSON.parse(row.body) }))]
      await writeFile(join(out, `${agent}.jsonl`), `${lines.join('\n')}\n`, { mode: 0o600 })
      found.push({ place: 'store', path: `${agent}.jsonl`, source: join(out, `${agent}.jsonl`) })
      const details = await input.database.all<{ detail_key: string; body: string }>(
        'SELECT detail_key, body FROM tool_details WHERE log_key = ?',
        [log],
      )
      for (const detail of details) {
        const name = `${detail.detail_key.slice(log.length + 1)}.json`
        if (!FOLDER_FILE.test(name)) continue
        // The output a tool streamed, joined back into its detail.
        const parsed = JSON.parse(detail.body) as { output?: unknown }
        if (parsed.output === '') {
          const parts = await input.database.all<{ bytes: Uint8Array }>(
            'SELECT bytes FROM tool_outputs WHERE detail_key = ? ORDER BY part',
            [detail.detail_key],
          )
          if (parts.length) parsed.output = Buffer.concat(parts.map((part) => Buffer.from(part.bytes))).toString('utf8')
        }
        await writeFile(join(out, `${agent}.tools`, name), JSON.stringify(parsed), { mode: 0o600 })
        found.push({ place: 'store', path: `${agent}.tools/${name}`, source: join(out, `${agent}.tools`, name) })
      }
    }
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
