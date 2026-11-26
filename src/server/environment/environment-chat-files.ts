import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { MAX_ADOPTED_PART_BYTES } from '../../../packages/studio-protocol/src/public'
import {
  CONVERSATION_ATTACHMENTS_DIRECTORY,
  CONVERSATION_TOOL_IMAGES_DIRECTORY,
} from '../../main/conversation-attachment-store'
import { conversationStorageSegment } from '../../main/conversation-index'
import { CONVERSATION_PLANS_DIRECTORY } from '../../main/conversation-plan-store'
import { workspaceStorePath } from '../../main/workspace-store'

// A chat a desktop ran itself, kept by the Studio that holds its folder from
// now on (design-wsl-ssh-direct PR 3c): a WSL distribution's chats that ran
// through `wsl.exe` on the desktop, before the distribution's own Studio
// held them. What such a chat keeps is files: its transcript (with its
// commands' receipts), its tools' details and its handoffs in its
// workspace's store, and the pictures it was sent, the pictures its steps
// returned and its plans' copies in the data directory. Each comes in parts
// (`environment.adopt`), is put back together here, checked against its
// digest, and written where this Studio's own runtime reads it.
//
// Every path is this Studio's to choose: a file names only its place and a
// name within the chat's own part of it, checked here, so a hand-over writes
// nowhere else.

const ADOPTED_CHAT_PLACES = ['store', 'attachments', 'images', 'plans'] as const
type AdoptedChatPlace = (typeof ADOPTED_CHAT_PLACES)[number]

type AdoptedChatFile = { place: AdoptedChatPlace; path: string; sha256: string; bytes: number; parts: string[] }

type AdoptedChat = { workspaceId: string; agentId: string; workspaceRoot: string; files: AdoptedChatFile[] }

/** The largest file of a chat a hand-over carries (a transcript's ceiling, with room). */
const MAX_ADOPTED_CHAT_FILE_BYTES = 512 * 1024 * 1024

const MAX_FILES = 20_000
const SHA256 = /^[0-9a-f]{64}$/u
// What `encodeURIComponent` leaves, as the runtime names a tool's detail.
const ENCODED = "[A-Za-z0-9_.!~*'()%-]+"
const FOLDER_FILE = /^[0-9a-f]{32}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/u

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Whether `path` is one of this chat's own names in its place. */
function ownPath(place: AdoptedChatPlace, path: string, agentId: string): boolean {
  if (place !== 'store') return FOLDER_FILE.test(path)
  const agent = escape(conversationStorageSegment(agentId))
  return (
    path === `${conversationStorageSegment(agentId)}.jsonl` ||
    new RegExp(`^${agent}\\.tools/${ENCODED}\\.json$`, 'u').test(path) ||
    new RegExp(`^handoffs/${agent}-[0-9-]{1,40}\\.md$`, 'u').test(path)
  )
}

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max

/** A `chat` record's body as this Studio keeps it, or why not. */
export function readAdoptedChat(
  id: string,
  body: Record<string, unknown>,
): { ok: true; chat: AdoptedChat } | { ok: false; reason: string } {
  const { workspaceId, agentId, workspaceRoot, files } = body
  if (!text(workspaceId, 200) || !text(agentId, 200) || id !== `${workspaceId}:${agentId}`)
    return { ok: false, reason: 'A chat names its workspace and agent, as its id does.' }
  if (!text(workspaceRoot, 4_096) || !workspaceRoot.startsWith('/'))
    return { ok: false, reason: 'A chat names its folder as this machine spells it.' }
  if (!Array.isArray(files) || files.length > MAX_FILES)
    return { ok: false, reason: `A chat lists at most ${MAX_FILES} files.` }
  const read: AdoptedChatFile[] = []
  const seen = new Set<string>()
  for (const entry of files as unknown[]) {
    const file = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const place = file.place as AdoptedChatPlace
    const parts = file.parts
    const bytes = file.bytes
    if (
      !(ADOPTED_CHAT_PLACES as readonly unknown[]).includes(place) ||
      typeof file.path !== 'string' ||
      !ownPath(place, file.path, agentId) ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_ADOPTED_CHAT_FILE_BYTES ||
      !Array.isArray(parts) ||
      parts.length !== Math.ceil(bytes / MAX_ADOPTED_PART_BYTES) ||
      !parts.every((part) => typeof part === 'string' && SHA256.test(part))
    )
      return {
        ok: false,
        reason: `A chat's file is { place, path, sha256, bytes, parts }: one of its own names in ${ADOPTED_CHAT_PLACES.join(', ')}, and its parts.`,
      }
    const key = `${place}:${file.path}`
    if (seen.has(key)) return { ok: false, reason: `It lists ${file.path} twice.` }
    seen.add(key)
    read.push({ place, path: file.path, sha256: file.sha256, bytes, parts: parts as string[] })
  }
  return { ok: true, chat: { workspaceId, agentId, workspaceRoot, files: read } }
}

/** Where a chat's file goes on this disk: its workspace store, or a store in the data directory. */
function adoptedChatFilePath(dataDir: string, chat: AdoptedChat, file: AdoptedChatFile): string {
  const segments = file.path.split('/')
  switch (file.place) {
    case 'store':
      return workspaceStorePath(
        chat.workspaceRoot,
        'conversations',
        conversationStorageSegment(chat.workspaceId),
        ...segments,
      )
    case 'attachments':
      return join(dataDir, CONVERSATION_ATTACHMENTS_DIRECTORY, ...segments)
    case 'images':
      return join(dataDir, CONVERSATION_TOOL_IMAGES_DIRECTORY, ...segments)
    case 'plans':
      return join(dataDir, CONVERSATION_PLANS_DIRECTORY, ...segments)
  }
}

async function digestOf(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** What a hand-over asks of this Studio's chat history (the runtime's `adoptTranscript`, over `ChatLogs.adopt`). */
export type AdoptedChatHistory = {
  /**
   * Take a transcript brought (`incoming`, or `path` itself when the file
   * there came byte for byte) as the history of the log at `path`, put there
   * in place of the file there: when what this Studio holds of the log is a
   * beginning of it. False when it is not: this Studio's own, kept.
   */
  adopt(path: string, root: string, incoming: string): Promise<boolean>
}

/**
 * Write a chat's files where this Studio reads them. A file already there
 * with the same bytes is held; one with other bytes is this Studio's own,
 * kept, and named in `kept`. A transcript goes through the chat's history:
 * it takes the place of the file there when what this Studio holds of the
 * chat is a beginning of it (a store shared with the desktop keeps the copy
 * from before the upgrade, which this Studio may have imported), and is
 * kept out when not. A part not to be found refuses the chat, which the
 * hand-over sends again; nothing half-written is left in place.
 */
export async function keepAdoptedChatFiles(
  dataDir: string,
  chat: AdoptedChat,
  partOf: (sha256: string) => Promise<Buffer | null>,
  history: AdoptedChatHistory,
): Promise<{ ok: true; kept: string[] } | { ok: false; reason: string }> {
  const kept: string[] = []
  // Null when it could not be looked at now (its store's confinement refused the file there, say).
  const adopted = (target: string, incoming: string) =>
    history.adopt(target, chat.workspaceRoot, incoming).catch(() => null)
  for (const file of chat.files) {
    const target = adoptedChatFilePath(dataDir, chat, file)
    const transcript = file.place === 'store' && file.path === `${conversationStorageSegment(chat.agentId)}.jsonl`
    const there = await lstat(target).catch(() => null)
    const regular = there?.isFile() === true && !there.isSymbolicLink()
    if (there && regular && (await digestOf(target)) === file.sha256) {
      if (transcript && (await adopted(target, target)) === false) kept.push(file.path)
      continue
    }
    if (there && (!regular || !transcript)) {
      kept.push(file.path)
      continue
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.tmp`
    const whole = createHash('sha256')
    let written = 0
    const handle = await open(temporary, 'wx', 0o600)
    let missing: string | null = null
    try {
      for (const sha of file.parts) {
        const part = await partOf(sha)
        if (!part || createHash('sha256').update(part).digest('hex') !== sha) {
          missing = `A part of ${file.path} did not arrive whole; the hand-over sends it again.`
          break
        }
        await handle.write(part)
        whole.update(part)
        written += part.length
      }
    } finally {
      await handle.close()
    }
    if (!missing && (written !== file.bytes || whole.digest('hex') !== file.sha256))
      missing = `${file.path} put back together is not the file that was sent.`
    if (missing) {
      await rm(temporary, { force: true })
      return { ok: false, reason: missing }
    }
    if (transcript) {
      const taken = await adopted(target, temporary)
      // Not looked at, and nothing there: put in place all the same, for its first read to take up.
      if (taken === null && !there) await rename(temporary, target)
      else if (taken !== true) kept.push(file.path)
      await rm(temporary, { force: true })
      continue
    }
    await rename(temporary, target)
  }
  return { ok: true, kept }
}
