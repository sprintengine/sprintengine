import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { chatLogKey, IMPORT_PENDING, importSource } from '../db/chat-logs'
import type { StudioDatabase } from '../db/database'

import {
  CONVERSATION_ATTACHMENTS_DIRECTORY,
  ConversationAttachmentStore,
  CONVERSATION_TOOL_IMAGES_DIRECTORY,
} from '../../main/conversation-attachment-store'
import { conversationStorageSegment } from '../../main/conversation-index'
import { readConversationStorage } from '../../main/conversation-persistence'
import { MAX_DETAIL_BYTES } from '../../main/conversation-tool-details'
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
//   files the distribution's Studio imports (`server/db/chat-logs.ts`); and
//   its handoffs, from its workspace's store, under
//   `conversations/<workspaceId>/`. A project in the distribution's home
//   keeps its store inside the distribution, where its Studio reads it
//   (workspace-store.ts `resolveWslShare`): the files there are in place and
//   not carried, but its history is, as this desktop's database has it: the
//   transcript in that store stopped at the upgrade.
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
  if (store) {
    const transcript = join(store, `${agent}.jsonl`)
    const tools = join(store, `${agent}.tools`)
    const log = chatLogKey(transcript)
    const out = join(input.dataDir, HANDOVER_EXPORTS_DIRNAME, conversationStorageSegment(input.workspaceId), agent)
    await rm(out, { recursive: true, force: true })
    const onDisk = (await stat(transcript).catch(() => null))?.isFile() === true
    // Its history is the database's once its file was imported, or when it began here with none.
    const imported =
      (
        await input.database.all('SELECT 1 FROM imports WHERE source = ? AND records <> ?', [
          importSource(log),
          IMPORT_PENDING,
        ])
      ).length > 0 ||
      (!onDisk && (await input.database.all('SELECT 1 FROM chat_logs WHERE log_key = ?', [log])).length > 0)
    if (!imported) {
      // Not taken up here since the database: its files are still its whole
      // history, and a store the distribution keeps has them already.
      if (!inPlace) {
        if (onDisk) found.push({ place: 'store', path: `${agent}.jsonl`, source: transcript })
        for (const name of await files(tools))
          if (name.endsWith('.json'))
            found.push({ place: 'store', path: `${agent}.tools/${name}`, source: join(tools, name) })
      }
    } else if (await exportTranscript(input.database, log, join(out, `${agent}.jsonl`))) {
      // Its history is this database's, newer than the file it left in the
      // store, even in a store the distribution keeps: that file stopped at
      // the upgrade.
      found.push({ place: 'store', path: `${agent}.jsonl`, source: join(out, `${agent}.jsonl`) })
      // Its tools' details: the database's, and the files from before it not
      // read into it yet. In a store the distribution keeps, a file there is
      // the distribution's to read.
      const legacy = new Set((await files(tools)).filter((name) => name.endsWith('.json')))
      const exported = new Set<string>()
      const keep = async (name: string, detail: { output?: unknown }) => {
        await mkdir(join(out, `${agent}.tools`), { recursive: true, mode: 0o700 })
        await writeFile(join(out, `${agent}.tools`, name), JSON.stringify(detail), { mode: 0o600 })
        found.push({ place: 'store', path: `${agent}.tools/${name}`, source: join(out, `${agent}.tools`, name) })
      }
      const keys = await input.database.all<{ detail_key: string }>(
        'SELECT detail_key FROM tool_details WHERE log_key = ?',
        [log],
      )
      for (const { detail_key: key } of keys) {
        const name = `${key.slice(log.length + 1)}.json`
        exported.add(name)
        if (!FOLDER_FILE.test(name) || (inPlace && legacy.has(name))) continue
        const [row] = await input.database.all<{ body: string }>('SELECT body FROM tool_details WHERE detail_key = ?', [
          key,
        ])
        if (!row) continue
        // The output a tool streamed, joined back into its detail.
        const detail = JSON.parse(row.body) as { output?: unknown }
        if (detail.output === '') {
          const parts = await input.database.all<{ bytes: Uint8Array }>(
            'SELECT bytes FROM tool_outputs WHERE detail_key = ? ORDER BY part',
            [key],
          )
          if (parts.length) detail.output = Buffer.concat(parts.map((part) => Buffer.from(part.bytes))).toString('utf8')
        }
        await keep(name, detail)
      }
      if (!inPlace)
        for (const name of legacy) {
          if (exported.has(name) || !FOLDER_FILE.test(name)) continue
          const read = (file: string, limit: number) =>
            readConversationStorage(input.workspaceRoot, join(tools, file), limit).catch(() => null)
          const body = await read(name, MAX_DETAIL_BYTES)
          let detail: { output?: unknown }
          try {
            detail = JSON.parse(body?.toString('utf8') ?? '') as { output?: unknown }
          } catch {
            continue
          }
          // Its streamed output, beside it.
          if (detail.output === '') {
            const output = await read(name.replace(/\.json$/u, '.output'), MAX_DETAIL_BYTES + 1024)
            if (output) detail.output = output.toString('utf8')
          }
          await keep(name, detail)
        }
    }
    if (!inPlace)
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

const EXPORT_PAGE_ROWS = 500

/**
 * Write a log out as builds before the database kept it, a page of rows at a
 * time: its events in order, then each receipt a line of its own. False for
 * a log with no events, which writes nothing.
 */
async function exportTranscript(database: Pick<StudioDatabase, 'all'>, log: string, path: string): Promise<boolean> {
  const events = (after: number) =>
    database.all<{ seq: number; body: string }>(
      'SELECT seq, body FROM chat_events WHERE log_key = ? AND seq > ? ORDER BY seq LIMIT ?',
      [log, after, EXPORT_PAGE_ROWS],
    )
  let rows = await events(0)
  if (rows.length === 0) return false
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'w', 0o600)
  try {
    for (;;) {
      await file.write(rows.map((row) => `${row.body}\n`).join(''))
      if (rows.length < EXPORT_PAGE_ROWS) break
      rows = await events(rows.at(-1)!.seq)
    }
    let after: { at: number; id: number } | null = null
    for (;;) {
      const receipts: Array<{ at: number; id: number; body: string }> = await database.all(
        `SELECT at, rowid AS id, body FROM chat_receipts WHERE log_key = ?
         ${after ? 'AND (at > ? OR (at = ? AND rowid > ?))' : ''} ORDER BY at, rowid LIMIT ?`,
        after ? [log, after.at, after.at, after.id, EXPORT_PAGE_ROWS] : [log, EXPORT_PAGE_ROWS],
      )
      await file.write(receipts.map((row) => `${JSON.stringify({ receipt: JSON.parse(row.body) })}\n`).join(''))
      if (receipts.length < EXPORT_PAGE_ROWS) break
      after = receipts.at(-1)!
    }
  } finally {
    await file.close()
  }
  return true
}
