/**
 * The prompts a person sent each agent, kept across app restarts for the
 * conversation peek.
 *
 * The peek shows only what this app captured from the CLI's `UserPromptSubmit`
 * hook (owner ruling 2026-09-24): it never reads a CLI's own transcript, which
 * for a long session is tens of megabytes to re-parse on every hover. That makes
 * this store the only history the card has, so it has to outlive both the
 * session object and the snapshot sidecar, which is swept after 30 days while
 * the agent it belongs to lives on in the workspace registry.
 *
 * One row per agent in the data folder's database (`agent_prompts`), its body
 * the record builds before the database kept as `agent-prompts/<key>.json`
 * (imported once, `server/db/import-files.ts`). A prompt rewrites only its own
 * agent's row, and nothing is read in bulk on a hot path. The database is the
 * owner's alone (0600): this is a person's verbatim typing.
 *
 * Bounded twice: each row keeps at most {@link MAX_LIVE_PEEK_PROMPTS} prompts
 * of at most {@link MAX_AGENT_PROMPT_LENGTH} characters (the same trim the live
 * list applies, first prompt kept), and past {@link MAX_AGENT_PROMPT_FILES}
 * agents the store sheds those that no longer exist. Recency alone would be the
 * wrong test: a burst of short-lived agents (frequent automation runs) would
 * push out an idle agent the person still sees in the sidebar, and the whole
 * point of this store is that such an agent keeps its history. So an agent the
 * registry still holds is never evicted; one it has dropped goes first, oldest
 * first, and one it cannot vouch for either way after that. An agent removed
 * from the registry has its row deleted there and then (`remove`), since its
 * prompts are verbatim typing nobody can see any more.
 *
 * Every read is of untrusted input and goes through `parseSessionPrompts`.
 * Every failure is a diagnostic, never a throw: a card with no history is the
 * worst this can cause.
 */
import { createHash } from 'node:crypto'

import type { SessionPrompt } from '../shared/ipc/terminal'
import type { StudioDatabase } from '../server/db/database'
import { appendLivePeekPrompt } from './conversation-peek/service'
import { parseSessionPrompts } from './terminal-session'

/** The folder builds before the database kept them in, one file per agent; read once, by the import. */
export const AGENT_PROMPTS_DIR_NAME = 'agent-prompts'

/** Agents whose prompts are kept. Past this the least recently written go. */
export const MAX_AGENT_PROMPT_FILES = 256

/** Session ids remembered per agent, newest last, for finding it by session. */
const MAX_SESSION_IDS_PER_AGENT = 8

/** Longest id accepted into a record. Workspace, agent and session ids are short. */
const MAX_ID_LENGTH = 256

export type AgentPromptOwner = {
  workspaceId: string
  agentId: string
  /** The CLI the agent runs, so a parked agent can still say whether it reports prompts. */
  cli?: string
  /** The terminal session the prompt arrived on. */
  sessionId?: string
}

export type StoredAgentPrompts = {
  workspaceId: string
  agentId: string
  cli?: string
  prompts: SessionPrompt[]
}

export type AgentPromptStore = {
  /** Append one prompt to the agent's stored list and write it. Resolves with the stored list. */
  append(owner: AgentPromptOwner, prompt: SessionPrompt): Promise<SessionPrompt[]>
  /**
   * Fold `prompts` (a session's live list) into what is stored, oldest first
   * and without duplicates, and write the result if it grew. Resolves with the
   * merged list — what the session should hold from now on.
   */
  merge(owner: AgentPromptOwner, prompts: readonly SessionPrompt[]): Promise<SessionPrompt[]>
  /** The stored prompts for an agent, or null when none are stored. */
  read(owner: Pick<AgentPromptOwner, 'workspaceId' | 'agentId'>): Promise<SessionPrompt[] | null>
  /** The agent a terminal session belonged to, with its prompts, or null. */
  findBySessionId(sessionId: string): Promise<StoredAgentPrompts | null>
  /** Delete the agent's stored prompts: the agent is gone for good. */
  remove(owner: Pick<AgentPromptOwner, 'workspaceId' | 'agentId'>): Promise<void>
  /** Settles once every queued write has landed. */
  flush(): Promise<void>
}

/** One agent's record, as a row's body keeps it (and as each file kept it before the database). */
export type AgentPromptFile = {
  version: 1
  workspaceId: string
  agentId: string
  cli?: string
  sessionIds: string[]
  updatedAt: number
  prompts: SessionPrompt[]
}

type Row = { key: string; workspace_id: string; agent_id: string; updated_at: number }

export function createAgentPromptStore(options: {
  database: StudioDatabase
  now?: () => number
  maxFiles?: number
  /**
   * Whether the agent still exists (is in the workspace registry): true keeps
   * its row through eviction, false makes it the first to go, undefined (not
   * known, or no answer given) falls back to least recently written.
   */
  agentExists?: (owner: { workspaceId: string; agentId: string }) => boolean | undefined
  logDiagnostic?: (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => void
}): AgentPromptStore {
  const now = options.now ?? Date.now
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_AGENT_PROMPT_FILES)
  const db = options.database

  // One chain per agent, so a read that follows a write sees it and two appends
  // for one agent land in order.
  const chains = new Map<string, Promise<unknown>>()

  const warn = (title: string, error: unknown): void => {
    options.logDiagnostic?.({
      level: 'warning',
      title,
      message: 'Agent prompt store operation failed.',
      details: error instanceof Error ? error.message : String(error),
    })
  }

  function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch(() => undefined)
    chains.set(key, settled)
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key)
    })
    return next
  }

  async function readRecord(key: string): Promise<AgentPromptFile | null> {
    let row: { body: string } | undefined
    try {
      row = await db.get<{ body: string }>('SELECT body FROM agent_prompts WHERE key = ?', [key])
    } catch (error) {
      warn('Agent prompt read failed', error)
      return null
    }
    if (!row) return null
    try {
      return parseAgentPromptFile(JSON.parse(row.body))
    } catch (error) {
      warn('Agent prompt parse failed', error)
      return null
    }
  }

  function existence(row: Row): boolean | undefined {
    try {
      return options.agentExists?.({ workspaceId: row.workspace_id, agentId: row.agent_id })
    } catch {
      return undefined
    }
  }

  async function writeRecord(key: string, file: AgentPromptFile): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO agent_prompts (key, workspace_id, agent_id, updated_at, body) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET workspace_id = excluded.workspace_id, agent_id = excluded.agent_id,
           updated_at = excluded.updated_at, body = excluded.body`,
        [key, file.workspaceId, file.agentId, file.updatedAt, JSON.stringify(file)],
      )
      const count = (await tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_prompts'))?.n ?? 0
      if (count <= maxFiles) return
      // Gone agents first, then the ones nothing vouches for; each oldest first.
      // An agent that still exists is never a candidate.
      const rank = (exists: boolean | undefined): number => (exists === false ? 0 : 1)
      const candidates = (
        await tx.all<Row>('SELECT key, workspace_id, agent_id, updated_at FROM agent_prompts WHERE key != ?', [key])
      )
        .map((row) => ({ row, exists: existence(row) }))
        .filter((candidate) => candidate.exists !== true)
        .sort((a, b) => rank(a.exists) - rank(b.exists) || a.row.updated_at - b.row.updated_at)
      for (const { row } of candidates.slice(0, count - maxFiles))
        await tx.run('DELETE FROM agent_prompts WHERE key = ?', [row.key])
    })
  }

  function nextFile(
    owner: AgentPromptOwner,
    existing: AgentPromptFile | null,
    prompts: SessionPrompt[],
  ): AgentPromptFile {
    const sessionIds = [...(existing?.sessionIds ?? [])]
    const sessionId = safeId(owner.sessionId)
    if (sessionId && sessionIds[sessionIds.length - 1] !== sessionId) {
      const without = sessionIds.filter((id) => id !== sessionId)
      sessionIds.length = 0
      sessionIds.push(...without.slice(-(MAX_SESSION_IDS_PER_AGENT - 1)), sessionId)
    }
    const cli = safeId(owner.cli) ?? existing?.cli
    return {
      version: 1,
      workspaceId: owner.workspaceId,
      agentId: owner.agentId,
      ...(cli ? { cli } : {}),
      sessionIds,
      updatedAt: now(),
      prompts,
    }
  }

  return {
    append(owner, prompt) {
      const key = agentPromptKey(owner)
      if (!key) return Promise.resolve([])
      return run(key, async () => {
        const existing = await readRecord(key)
        const text = capPrompt(prompt.text)
        if (!text) return existing?.prompts ?? []
        const prompts = appendLivePeekPrompt(existing?.prompts, text, prompt.at)
        try {
          await writeRecord(key, nextFile(owner, existing, prompts))
        } catch (error) {
          warn('Agent prompt write failed', error)
        }
        return prompts
      })
    },

    merge(owner, prompts) {
      const key = agentPromptKey(owner)
      if (!key) return Promise.resolve([...prompts])
      return run(key, async () => {
        const existing = await readRecord(key)
        const stored = existing?.prompts ?? []
        const seen = new Set(stored.map(promptIdentity))
        let merged = stored
        for (const prompt of [...prompts].sort((a, b) => a.at - b.at)) {
          const text = capPrompt(prompt.text)
          if (!text || seen.has(promptIdentity({ text, at: prompt.at }))) continue
          seen.add(promptIdentity({ text, at: prompt.at }))
          merged = appendLivePeekPrompt(merged, text, prompt.at)
        }
        if (merged !== stored) {
          try {
            await writeRecord(key, nextFile(owner, existing, merged))
          } catch (error) {
            warn('Agent prompt write failed', error)
          }
        }
        return merged
      })
    },

    read(owner) {
      const key = agentPromptKey(owner)
      if (!key) return Promise.resolve(null)
      return run(key, async () => {
        const file = await readRecord(key)
        return file && file.prompts.length > 0 ? file.prompts : null
      })
    },

    async findBySessionId(sessionId) {
      if (!safeId(sessionId)) return null
      let found: { key: string } | undefined
      try {
        // The newest agent that names the session among its last few.
        found = await db.get<{ key: string }>(
          // A body that does not read is passed over, never a failure of the whole lookup.
          `SELECT key FROM agent_prompts WHERE EXISTS (
             SELECT 1 FROM json_each(CASE WHEN json_valid(agent_prompts.body) THEN agent_prompts.body ELSE '{}' END, '$.sessionIds')
             WHERE json_each.value = ?
           ) ORDER BY updated_at DESC LIMIT 1`,
          [sessionId],
        )
      } catch (error) {
        warn('Agent prompt lookup failed', error)
        return null
      }
      if (!found) return null
      const key = found.key
      return run(key, async () => {
        const file = await readRecord(key)
        if (!file || !file.sessionIds.includes(sessionId)) return null
        return {
          workspaceId: file.workspaceId,
          agentId: file.agentId,
          ...(file.cli ? { cli: file.cli } : {}),
          prompts: file.prompts,
        }
      })
    },

    remove(owner) {
      const key = agentPromptKey(owner)
      if (!key) return Promise.resolve()
      return run(key, async () => {
        try {
          await db.run('DELETE FROM agent_prompts WHERE key = ?', [key])
        } catch (error) {
          warn('Agent prompt removal failed', error)
        }
      })
    },

    async flush() {
      await Promise.all([...chains.values()])
    },
  }
}

/**
 * Every agent a registry state holds, keyed by workspace and agent id. Diffing
 * two of these tells which agents a registry change removed.
 */
export function registeredAgentOwners(state: {
  workspaces: ReadonlyArray<{ id: string; agents: Readonly<Record<string, unknown>> }>
}): Map<string, { workspaceId: string; agentId: string }> {
  const owners = new Map<string, { workspaceId: string; agentId: string }>()
  for (const workspace of state.workspaces) {
    for (const agentId of Object.keys(workspace.agents ?? {})) {
      owners.set(`${workspace.id}\0${agentId}`, { workspaceId: workspace.id, agentId })
    }
  }
  return owners
}

/**
 * An agent's key: a hash of its two ids, because both are caller-supplied
 * strings (and, as builds before the database kept them, its file's name,
 * which neither could be let choose).
 */
export function agentPromptKey(owner: Pick<AgentPromptOwner, 'workspaceId' | 'agentId'>): string | null {
  const workspaceId = safeId(owner.workspaceId)
  const agentId = safeId(owner.agentId)
  if (!workspaceId || !agentId) return null
  return createHash('sha256').update(`${workspaceId}\0${agentId}`).digest('hex').slice(0, 32)
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes('\0')
    ? value
    : undefined
}

function promptIdentity(prompt: SessionPrompt): string {
  return `${prompt.at}\0${prompt.text}`
}

function capPrompt(text: string): string {
  // `parseSessionPrompts` applies the same cap on the way back in.
  return parseSessionPrompts([{ text, at: 0 }])?.[0]?.text ?? ''
}

/** A record as a row (or a file before the database) holds it, held to what this store writes; null for anything else. */
export function parseAgentPromptFile(raw: unknown): AgentPromptFile | null {
  if (!raw || typeof raw !== 'object') return null
  const file = raw as Partial<AgentPromptFile>
  if (file.version !== 1) return null
  const workspaceId = safeId(file.workspaceId)
  const agentId = safeId(file.agentId)
  if (!workspaceId || !agentId) return null
  const cli = safeId(file.cli)
  const sessionIds = Array.isArray(file.sessionIds)
    ? file.sessionIds
        .slice(-MAX_SESSION_IDS_PER_AGENT)
        .map(safeId)
        .filter((id): id is string => id !== undefined)
    : []
  return {
    version: 1,
    workspaceId,
    agentId,
    ...(cli ? { cli } : {}),
    sessionIds,
    updatedAt: typeof file.updatedAt === 'number' && Number.isFinite(file.updatedAt) ? file.updatedAt : 0,
    prompts: parseSessionPrompts(file.prompts) ?? [],
  }
}
