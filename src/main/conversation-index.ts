import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { StudioDatabase } from '../server/db/database'
import { chatKey, type ChatLogs } from '../server/db/chat-logs'
import { workspaceStorePath, workspaceStoreReady } from './workspace-store'
import { CONVERSATION_MAX_REPLY_PREVIEW } from '../../packages/conversation-protocol/src/public'
import {
  isStudioCompactionReason,
  readConversationMessageOrigin,
  type ConversationEvent,
  type ConversationKey,
} from '../shared/conversation-runtime'
import type {
  ConversationSearchHit,
  ConversationSearchInput,
  ConversationThread,
  ConversationWorkspaceKey,
} from '../shared/conversation-index'
import { quotesToInlineText } from '../shared/chat-quotes'

// A chat's list of agents, their rows for the chat list, and search over what
// people said and agents replied, out of the data folder's database.
//
// A row (`chat_threads`) is folded from the log's events and kept with the
// number of the last event folded; a listing folds only what came since, in
// one transaction with the search rows it adds (`chat_search_docs`, a full
// text index by trigram), so a new turn costs its own events and never a
// re-read of the chat. Search reads the index, whole chats included; it no
// longer reads transcripts.

/**
 * One log's row as it stood after folding its events up to `folded`, with
 * what the row's counts are made from.
 */
type ThreadFold = {
  thread: ConversationThread | null
  turns: Set<string>
  // Turns Studio opened with its own `/compact` before the cache expired:
  // their end is not news for the person (`lastTurnEndedAt`).
  quietTurns: Set<string>
  costs: Map<string, number>
}
type StoredFold = { turns: string[]; quietTurns: string[]; costs: Array<[string, number]> }

/** The folder (or file) name a chat's or agent's id is stored under in its store's `conversations/`. */
export const conversationStorageSegment = (value: string) => {
  const encoded = encodeURIComponent(value.trim().replace(/[\\/]/g, '-'))
  return encoded === '.' || encoded === '..' ? encoded.replace(/\./g, '%2E') : encoded
}
const segment = conversationStorageSegment
const directory = (key: ConversationWorkspaceKey) =>
  workspaceStorePath(key.workspaceRoot, 'conversations', segment(key.workspaceId))
/** Where builds before the database kept an agent's transcript: still the name its log goes by (`chatLogKey`). */
export const conversationIndexTranscriptPath = (key: ConversationKey) =>
  join(directory(key), `${segment(key.agentId)}.jsonl`)
const text = (value: unknown) => (typeof value === 'string' ? value : '')

const FOLD_ROWS = 512
const MAX_HITS = 200

export class ConversationIndex {
  private queues = new Map<string, Promise<unknown>>()
  // The chats whose folders were looked through for transcripts not yet imported, this run.
  private readonly scanned = new Set<string>()
  constructor(
    private readonly database: StudioDatabase,
    private readonly history: Pick<ChatLogs, 'ensure' | 'oldest' | 'remove'>,
    private readonly hooks: { flush?: (path: string) => Promise<void>; close?: (path: string) => Promise<void> } = {},
  ) {}
  private async serialized<T>(key: ConversationWorkspaceKey, work: () => Promise<T>): Promise<T> {
    const id = chatOf(key),
      previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.queues.set(id, next)
    try {
      return await next
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id)
    }
  }
  async list(key: ConversationWorkspaceKey): Promise<ConversationThread[]> {
    requireWorkspace(key)
    return this.serialized(key, async () => {
      const { logs, unreadable } = await this.logsOf(key)
      for (const log of logs) await this.catchUp(key, log)
      const rows = await this.database.all<{ thread: string | null }>(
        'SELECT thread FROM chat_threads WHERE chat_key = ?',
        [chatOf(key)],
      )
      return sorted([
        ...rows.flatMap((row) => (row.thread ? [JSON.parse(row.thread) as ConversationThread] : [])),
        ...unreadable,
      ])
    })
  }
  /** Refresh one completed turn without folding any other agent's log. */
  async refresh(key: ConversationKey): Promise<ConversationThread | null> {
    if (!key.agentId.trim()) throw new Error('Conversation identity is required.')
    requireWorkspace(key)
    return this.serialized(key, async () => {
      const path = conversationIndexTranscriptPath(key)
      await this.hooks.flush?.(path)
      await this.history.ensure(path, key.workspaceRoot)
      const log = `${chatOf(key)}/${segment(key.agentId)}`
      await this.catchUp(key, log)
      const row = await this.database.get<{ thread: string | null }>('SELECT thread FROM chat_threads WHERE log_key = ?', [
        log,
      ])
      return row?.thread ? (JSON.parse(row.thread) as ConversationThread) : null
    })
  }
  /** Hits in batches, so IPC and remote consumers surface them before the search finishes. */
  async search(
    input: ConversationSearchInput,
    options: { signal?: AbortSignal; onBatch?: (hits: ConversationSearchHit[]) => void } = {},
  ): Promise<ConversationSearchHit[]> {
    const query = input.query.trim().toLowerCase().slice(0, 500)
    requireWorkspace(input)
    if (!query) return []
    // What came since the last listing is indexed first.
    await this.serialized(input, async () => {
      for (const log of (await this.logsOf(input)).logs) await this.catchUp(input, log)
    })
    options.signal?.throwIfAborted()
    const chat = chatOf(input)
    // A trigram index finds three characters or more; a shorter query reads the chat's rows.
    const rows =
      [...query].length >= 3
        ? await this.database.all<Doc>(
            `SELECT d.agent_id, d.turn_id, d.kind, d.seq, d.origin, d.body FROM chat_search
             JOIN chat_search_docs d ON d.id = chat_search.rowid
             WHERE chat_search MATCH ? AND d.chat_key = ? ORDER BY d.agent_id, d.seq, d.kind DESC LIMIT ?`,
            [`"${query.replace(/"/g, '""')}"`, chat, MAX_HITS],
          )
        : await this.database.all<Doc>(
            `SELECT agent_id, turn_id, kind, seq, origin, body FROM chat_search_docs
             WHERE chat_key = ? AND instr(lower(body), ?) > 0 ORDER BY agent_id, seq, kind DESC LIMIT ?`,
            [chat, query, MAX_HITS],
          )
    options.signal?.throwIfAborted()
    const hits: ConversationSearchHit[] = []
    const pending: ConversationSearchHit[] = []
    for (const row of rows) {
      const offset = row.body.toLowerCase().indexOf(query)
      if (offset < 0) continue
      const snippet = `${offset > 80 ? '…' : ''}${row.body.slice(Math.max(0, offset - 80), offset + query.length + 100)}${row.body.length > offset + query.length + 100 ? '…' : ''}`
      const hit: ConversationSearchHit = {
        agentId: row.agent_id,
        seq: row.seq,
        ...(row.turn_id ? { turnId: row.turn_id } : {}),
        snippet,
        from: row.kind === 'agent' ? 'agent' : row.origin === 'studio' ? 'studio' : 'person',
      }
      hits.push(hit)
      pending.push(hit)
      if (pending.length >= 20) {
        options.onBatch?.(pending.splice(0))
        options.signal?.throwIfAborted()
      }
    }
    if (pending.length) options.onBatch?.(pending)
    return hits
  }
  /** Caller must reject active sessions and obtain explicit confirmation before deleting. */
  async delete(key: ConversationKey): Promise<void> {
    if (!key.agentId.trim()) throw new Error('Conversation identity is required.')
    requireWorkspace(key)
    await this.serialized(key, async () => {
      const path = conversationIndexTranscriptPath(key)
      await this.hooks.close?.(path)
      // The log, its row, its search rows and its tools' details, in one transaction.
      await this.history.remove(path, key.workspaceRoot)
    })
  }
  /**
   * The logs of a chat's agents. A chat's folder is looked through once a
   * run for transcripts builds before the database left there, and each is
   * imported before it is listed.
   */
  private async logsOf(key: ConversationWorkspaceKey): Promise<{ logs: string[]; unreadable: ConversationThread[] }> {
    const chat = chatOf(key)
    // A transcript that cannot be imported (a link out of the store) still
    // gets a row, named from its file and dated from its last write, so one
    // damaged chat does not hide every other agent of the chat.
    const unreadable: ConversationThread[] = []
    if (!this.scanned.has(chat)) {
      // Waits out the store's one-time move, so a listing right after an upgrade sees what it brings.
      await workspaceStoreReady(key.workspaceRoot)
      let names: string[] = []
      try {
        names = (await readdir(directory(key))).filter((name) => name.endsWith('.jsonl'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      let failed = false
      for (const name of names) {
        const path = join(directory(key), name)
        await this.hooks.flush?.(path)
        try {
          await this.history.ensure(path, key.workspaceRoot)
        } catch (error) {
          failed = true
          console.warn(`[conversation-index] ${name} could not be taken up:`, error instanceof Error ? error.message : error)
          const at = await lstat(path).then((info) => info.mtimeMs, () => 0)
          unreadable.push({
            agentId: decodeAgent(`${chat}/${name.slice(0, -'.jsonl'.length)}`),
            title: 'Unreadable conversation',
            titleSource: 'first-message',
            createdAt: at,
            updatedAt: at,
            turnCount: 0,
            model: '',
            providerId: '',
            lastSeq: 0,
            firstUserText: '',
          })
        }
      }
      // Looked at again next time while one could not be taken up.
      if (!failed) this.scanned.add(chat)
    }
    // Every key of this chat: `<chat>/` up to, not including, `<chat>0` ('0' follows '/').
    const rows = await this.database.all<{ log_key: string }>(
      'SELECT log_key FROM chat_logs WHERE log_key >= ? AND log_key < ? ORDER BY log_key',
      [`${chat}/`, `${chat}0`],
    )
    for (const row of rows) await this.hooks.flush?.(join(directory(key), `${row.log_key.slice(chat.length + 1)}.jsonl`))
    return { logs: rows.map((row) => row.log_key), unreadable }
  }
  /** Fold what one log gained since its row was folded, and index it for search, in one transaction. */
  private async catchUp(key: ConversationWorkspaceKey, log: string): Promise<void> {
    const kept = await this.database.get<{ folded_seq: number; thread: string | null; fold: string }>(
      'SELECT folded_seq, thread, fold FROM chat_threads WHERE log_key = ?',
      [log],
    )
    const last = await this.database.get<{ last_seq: number }>('SELECT last_seq FROM chat_logs WHERE log_key = ?', [log])
    if (!last || (kept && kept.folded_seq >= last.last_seq)) return
    const fold = readFold(kept)
    const docs = new Map<string, Doc>()
    const replied = new Set<string>()
    const path = join(directory(key), `${log.slice(log.lastIndexOf('/') + 1)}.jsonl`)
    let folded = kept?.folded_seq ?? 0
    for (;;) {
      const rows = await this.history.oldest(path, key.workspaceRoot, folded, FOLD_ROWS)
      for (const row of rows) {
        folded = row.seq
        const event = parseEvent(row.body)
        if (!event) continue
        foldEvent(fold, event)
        const turnId = text(event.payload?.turnId)
        if (event.type === 'user_message') {
          docs.set(`${turnId}\0user`, {
            agent_id: event.agentId,
            turn_id: turnId,
            kind: 'user',
            seq: event.seq ?? row.seq,
            origin: readConversationMessageOrigin(event.payload?.origin) ? 'studio' : 'person',
            // A person's message is searched as its words: a quote it carries is its passage and comment.
            body: quotesToInlineText(text(event.payload?.text)),
          })
        } else if (event.type === 'content_delta') replied.add(turnId)
      }
      if (rows.length < FOLD_ROWS) break
    }
    if (fold.thread) {
      fold.thread.turnCount = fold.turns.size
      if (fold.costs.size) fold.thread.totalCostUsd = [...fold.costs.values()].reduce((sum, cost) => sum + cost, 0)
      else delete fold.thread.totalCostUsd
    }
    const chat = chatOf(key)
    const agentId = fold.thread?.agentId ?? decodeAgent(log)
    await this.database.transaction(async (tx) => {
      for (const turnId of replied) {
        // A reply is searched whole: every delta of its turn, as stored.
        const deltas = await tx.all<{ body: string }>(
          "SELECT body FROM chat_events WHERE log_key = ? AND turn_id IS ? AND type = 'content_delta' ORDER BY seq",
          [log, turnId || null],
        )
        const user = await tx.get<{ seq: number }>(
          "SELECT seq FROM chat_search_docs WHERE log_key = ? AND turn_id = ? AND kind = 'user'",
          [log, turnId],
        )
        docs.set(`${turnId}\0agent`, {
          agent_id: agentId,
          turn_id: turnId,
          kind: 'agent',
          seq: docs.get(`${turnId}\0user`)?.seq ?? user?.seq ?? folded,
          origin: 'agent',
          body: deltas.map((delta) => text(parseEvent(delta.body)?.payload?.text)).join(''),
        })
      }
      for (const doc of docs.values())
        await tx.run(
          `INSERT INTO chat_search_docs (log_key, chat_key, agent_id, turn_id, kind, seq, origin, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (log_key, turn_id, kind) DO UPDATE SET seq = excluded.seq, origin = excluded.origin, body = excluded.body`,
          [log, chat, doc.agent_id, doc.turn_id, doc.kind, doc.seq, doc.origin, doc.body],
        )
      await tx.run(
        `INSERT INTO chat_threads (log_key, chat_key, folded_seq, thread, fold) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (log_key) DO UPDATE SET folded_seq = excluded.folded_seq, thread = excluded.thread, fold = excluded.fold`,
        [log, chat, folded, fold.thread ? JSON.stringify(fold.thread) : null, JSON.stringify(storedFold(fold))],
      )
    })
  }
}

type Doc = { agent_id: string; turn_id: string; kind: string; seq: number; origin: string; body: string }

function requireWorkspace(key: ConversationWorkspaceKey): void {
  if (!key.workspaceRoot.trim() || !key.workspaceId.trim()) throw new Error('Workspace identity is required.')
}

/** A chat's name in the database: its store's and its own (`<store>/<chat>`). */
function chatOf(key: ConversationWorkspaceKey): string {
  return chatKey(directory(key))
}

/** The agent a log is named for. A name this app did not encode (`50%`) is used as it is. */
function decodeAgent(log: string): string {
  const name = log.slice(log.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function readFold(kept: { thread: string | null; fold: string } | undefined): ThreadFold {
  if (!kept) return { thread: null, turns: new Set(), quietTurns: new Set(), costs: new Map() }
  const stored = JSON.parse(kept.fold) as StoredFold
  return {
    thread: kept.thread ? (JSON.parse(kept.thread) as ConversationThread) : null,
    turns: new Set(stored.turns),
    quietTurns: new Set(stored.quietTurns),
    costs: new Map(stored.costs),
  }
}

function storedFold(fold: ThreadFold): StoredFold {
  return { turns: [...fold.turns], quietTurns: [...fold.quietTurns], costs: [...fold.costs] }
}

function parseEvent(body: string): ConversationEvent | null {
  try {
    const event = JSON.parse(body) as ConversationEvent
    return event && typeof event === 'object' && typeof event.type === 'string' ? event : null
  } catch {
    return null
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function foldEvent(fold: ThreadFold, event: ConversationEvent): void {
  const thread = (fold.thread ??= {
    agentId: event.agentId,
    title: 'New conversation',
    titleSource: 'first-message',
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
    turnCount: 0,
    model: event.modelId ?? '',
    providerId: event.providerId ?? '',
    lastSeq: 0,
    firstUserText: '',
  })
  thread.updatedAt = Math.max(thread.updatedAt, event.createdAt)
  thread.model = event.modelId || thread.model
  thread.providerId = event.providerId || thread.providerId
  const parts = record(event).parts
  const partSeqs = Array.isArray(parts)
    ? parts.flatMap((part) => (Array.isArray(part) && typeof part[3] === 'number' ? [part[3]] : []))
    : []
  thread.lastSeq = Math.max(thread.lastSeq, event.seq ?? thread.lastSeq + 1, ...partSeqs)
  // What a fork holds of the chat it came from was spent there: its own total
  // starts at its mark.
  if (event.type === 'session_updated' && event.payload?.forkedFrom && typeof event.payload.forkedFrom === 'object')
    fold.costs.clear()
  // When the agent last finished a turn, as the runtime's session reads it
  // (`lastTurnEndedAt`): a steered turn's end is not one, the work went on.
  // Nor is the end of Studio's own compaction before a cache expired: nothing
  // happened in the chat the person has to come and read.
  if (
    ((event.type === 'turn_completed' && event.payload?.steered !== true) || event.type === 'turn_failed') &&
    !fold.quietTurns.has(text(event.payload?.turnId))
  )
    thread.lastTurnEndedAt = Math.max(thread.lastTurnEndedAt ?? 0, event.createdAt)
  if (
    event.type === 'user_message' &&
    text(event.payload?.turnId) &&
    isStudioCompactionReason(readConversationMessageOrigin(event.payload?.origin)?.reason)
  )
    fold.quietTurns.add(text(event.payload?.turnId))
  if (event.type === 'turn_completed') {
    const cost = event.payload?.costUsd
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
      fold.costs.set(text(event.payload?.turnId) || event.id, cost)
  }
  // The opening of the last reply, kept as the runtime's session keeps it: a
  // message from the person with words, or one Studio sent, starts the next
  // reply afresh; an image-only message from the person does not.
  if (
    event.type === 'user_message' &&
    (readConversationMessageOrigin(event.payload?.origin) || typeof event.payload?.text === 'string')
  )
    thread.lastAssistantText = ''
  else if (event.type === 'content_delta' && typeof event.payload?.text === 'string')
    thread.lastAssistantText = ((thread.lastAssistantText ?? '') + event.payload.text).slice(
      0,
      CONVERSATION_MAX_REPLY_PREVIEW,
    )
  if (event.type === 'user_message') {
    fold.turns.add(text(event.payload?.turnId) || event.id)
    // A message Studio sent the chat is not what the person opened it with.
    if (!thread.firstUserText && !readConversationMessageOrigin(event.payload?.origin)) {
      thread.firstUserText = quotesToInlineText(text(event.payload?.text))
      if (thread.titleSource === 'first-message') thread.title = firstMessageTitle(thread.firstUserText)
    }
  }
  if (event.type === 'session_updated' && typeof event.payload?.conversationTitle === 'string') {
    const source = event.payload.titleSource
    if (source === 'user' || (source === 'generated' && thread.titleSource !== 'user')) {
      thread.title = event.payload.conversationTitle.slice(0, 200)
      thread.titleSource = source
    }
  }
}
/** A generated-title service can replace this ladder rung without changing index ownership. */
export function firstMessageTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, 60) || 'New conversation'
}
const sorted = (threads: ConversationThread[]) => [...threads].sort((a, b) => b.updatedAt - a.updatedAt)
