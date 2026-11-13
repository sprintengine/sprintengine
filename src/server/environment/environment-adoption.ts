import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  MAX_SCHEDULED_MESSAGE_LENGTH,
  STUDIO_ADOPTED_RECORD_KINDS,
  type StudioAdoptedRecord,
  type StudioAdoptedRecordKind,
  type StudioAdoptResult,
} from '../../../packages/studio-protocol/src/public'

// A machine's Studio taking over the records a desktop kept for its chats
// (design-environment-migration, "Hand-over spec"; design-wsl-ssh-direct PR 1):
// once the desktop stops routing a machine's chats, the workspaces they are
// in, their schedules, the messages held or scheduled for them, the resumes
// after a usage limit and the pull requests they opened are this Studio's to
// keep and run, with nobody watching.
//
// Each record goes into the store that keeps its kind, through that store's
// own way in, so it is held to what this Studio would have written itself.
// A ledger beside the stores (`environment-adoptions.json`) says which record
// was kept under which digest, so a hand-over repeated after a crash is held
// again without a second copy, and one that differs from what is here is
// reported rather than written over: this Studio's copy wins.

/** The stores records are kept in, each by its own way in. */
export type EnvironmentAdoptionStores = {
  /** Settles once every store's writes so far are on disk: the ledger goes down only after them. */
  flush(): Promise<void>
  workspaces: {
    has(workspaceId: string): boolean
    /** Keep a workspace record as created: its folder, its chats, its fields. */
    adopt(record: Record<string, unknown>): { ok: true } | { ok: false; message: string }
  }
  schedules: {
    has(id: string): boolean
    adopt(record: unknown): Promise<{ ok: true } | { ok: false; reason: 'exists' | 'invalid'; message: string }>
  }
  messages: {
    /** Schedule one for a time, once per `source`. */
    scheduleFrom(
      chat: { workspaceId: string; agentId: string },
      text: string,
      sendAt: number,
      source: string,
      untilLimitReset?: string,
    ): { ok: true } | { ok: false; reason: string }
    /** Hold one for the end of the chat's turn, once per `source`. */
    hold(
      chat: { workspaceId: string; agentId: string },
      text: string,
      source: string,
    ): { ok: true } | { ok: false; reason: string }
  }
  resumes: {
    /** Keep the resume after this chat's usage limit scheduled. */
    schedule(chat: { workspaceId: string; agentId: string }): void
  }
  pullRequests: {
    noteOpened(
      chat: { workspaceId: string; agentId: string },
      input: { url: string; title?: string },
    ): Promise<{ ok: true } | { ok: false; code: string; message: string }>
    watch(
      chat: { workspaceId: string; agentId: string },
      input: { url: string },
    ): Promise<{ ok: true } | { ok: false; code: string; message: string }>
  }
}

export type EnvironmentAdoption = {
  adopt(input: { migrationId: string; records: StudioAdoptedRecord[] }): Promise<StudioAdoptResult>
}

const LEDGER_FILE = 'environment-adoptions.json'

type Ledger = { v: 1; records: Record<string, { digest: string; migrationId: string; at: number }> }

/** A body as canonical JSON: keys sorted at every depth, no spaces. Both ends digest this. */
export function canonicalRecordJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecordJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRecordJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The digest a handed-over record is named by: sha-256 of its canonical JSON, in hex. */
export function adoptedRecordDigest(body: unknown): string {
  return createHash('sha256').update(canonicalRecordJson(body), 'utf8').digest('hex')
}

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const instant = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** The chat a body names, or null. */
function chatOf(body: Record<string, unknown>): { workspaceId: string; agentId: string } | null {
  return text(body.workspaceId, 200) && text(body.agentId, 200)
    ? { workspaceId: body.workspaceId, agentId: body.agentId }
    : null
}

export function createEnvironmentAdoption(deps: {
  dataDir: string
  stores: EnvironmentAdoptionStores
  now?: () => number
  log?: (message: string) => void
}): EnvironmentAdoption {
  const now = deps.now ?? Date.now
  const path = join(deps.dataDir, LEDGER_FILE)
  const { stores } = deps
  // One hand-over at a time: two would read the same ledger and each write it.
  let queue: Promise<unknown> = Promise.resolve()

  function readLedger(): Ledger {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Ledger>
      if (parsed && parsed.v === 1 && parsed.records && typeof parsed.records === 'object')
        return { v: 1, records: parsed.records }
    } catch {
      // None yet, or unreadable: the stores themselves still refuse a second copy of an id.
    }
    return { v: 1, records: {} }
  }

  function writeLedger(ledger: Ledger): void {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    try {
      chmodSync(path, 0o600)
    } catch {
      // A file system that keeps no modes.
    }
  }

  /** Keep one record in its store; a refusal says why, and nothing was written. */
  async function keep(
    record: StudioAdoptedRecord,
    migrationId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const body = record.body
    // The same command again, after a crash between the store's write and the ledger's.
    const source = `adopt:${migrationId}:${record.kind}:${record.id}`
    switch (record.kind) {
      case 'workspace': {
        if (body.id !== record.id) return { ok: false, reason: 'The workspace record names another id.' }
        if (stores.workspaces.has(record.id)) return { ok: false, reason: 'A workspace with that id is already here.' }
        const kept = stores.workspaces.adopt(body)
        return kept.ok ? kept : { ok: false, reason: kept.message }
      }
      case 'schedule': {
        if (body.id !== record.id) return { ok: false, reason: 'The scheduled agent names another id.' }
        if (stores.schedules.has(record.id))
          return { ok: false, reason: 'A scheduled agent with that id is already here.' }
        const kept = await stores.schedules.adopt(body)
        return kept.ok ? kept : { ok: false, reason: kept.message }
      }
      case 'scheduled-message': {
        const chat = chatOf(body)
        if (!chat || !text(body.text, MAX_SCHEDULED_MESSAGE_LENGTH))
          return { ok: false, reason: 'A scheduled message names its chat and its words.' }
        // What a held message carries beside its words is on the desktop's disk; not carried yet.
        const carries = body.carries as { images?: unknown[]; files?: unknown[] } | undefined
        if ((carries?.images?.length ?? 0) > 0 || (carries?.files?.length ?? 0) > 0)
          return { ok: false, reason: 'It carries pictures or files, which are not handed over yet.' }
        const kept =
          body.queued === true
            ? stores.messages.hold(chat, body.text, source)
            : instant(body.sendAt)
              ? stores.messages.scheduleFrom(
                  chat,
                  body.text,
                  body.sendAt,
                  source,
                  typeof body.untilLimitReset === 'string' ? body.untilLimitReset : undefined,
                )
              : { ok: false as const, reason: 'A scheduled message says when it goes.' }
        return kept.ok ? { ok: true } : { ok: false, reason: kept.reason }
      }
      case 'usage-limit-resume': {
        const chat = chatOf(body)
        if (!chat) return { ok: false, reason: 'A resume names its chat.' }
        stores.resumes.schedule(chat)
        return { ok: true }
      }
      case 'pull-request': {
        const chat = chatOf(body)
        if (!chat || !text(body.url, 2_000)) return { ok: false, reason: 'A pull request names its chat and its URL.' }
        const opened = await stores.pullRequests.noteOpened(chat, {
          url: body.url,
          ...(text(body.title, 1_000) ? { title: body.title } : {}),
        })
        // Another chat here claimed it first: the record's rule, its first claimant keeps it.
        if (!opened.ok) return { ok: false, reason: opened.message }
        if (body.watched === true) {
          const watched = await stores.pullRequests.watch(chat, { url: body.url })
          if (!watched.ok) return { ok: false, reason: watched.message }
        }
        return { ok: true }
      }
    }
  }

  async function run(input: { migrationId: string; records: StudioAdoptedRecord[] }): Promise<StudioAdoptResult> {
    const ledger = readLedger()
    const held: StudioAdoptResult['held'] = []
    const conflicts: StudioAdoptResult['conflicts'] = []
    // A workspace first, so the chats the rest name are found.
    const order = (kind: StudioAdoptedRecordKind) => STUDIO_ADOPTED_RECORD_KINDS.indexOf(kind)
    const records = [...input.records].sort((a, b) => order(a.kind) - order(b.kind))
    for (const record of records) {
      const key = `${record.kind}:${record.id}`
      if (adoptedRecordDigest(record.body) !== record.digest) {
        conflicts.push({ kind: record.kind, id: record.id, reason: 'Its digest does not match its body.' })
        continue
      }
      const known = ledger.records[key]
      if (known) {
        if (known.digest === record.digest) held.push({ kind: record.kind, id: record.id })
        else
          conflicts.push({
            kind: record.kind,
            id: record.id,
            reason: 'This Studio already keeps another copy of it, and keeps that one.',
          })
        continue
      }
      let kept: { ok: true } | { ok: false; reason: string }
      try {
        kept = await keep(record, input.migrationId)
      } catch (error) {
        kept = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      if (!kept.ok) {
        conflicts.push({ kind: record.kind, id: record.id, reason: kept.reason })
        continue
      }
      ledger.records[key] = { digest: record.digest, migrationId: input.migrationId, at: now() }
      held.push({ kind: record.kind, id: record.id })
    }
    // Answered only for what is on disk: each store's writes land, then the
    // ledger, then the answer. A crash before the ledger is a hand-over run
    // again, and every way in here refuses a second copy.
    await stores.flush()
    writeLedger(ledger)
    if (conflicts.length)
      deps.log?.(`A hand-over kept ${held.length} records and left ${conflicts.length} as this Studio has them.`)
    return { held, conflicts }
  }

  return {
    adopt(input) {
      const next = queue.then(() => run(input))
      queue = next.catch(() => undefined)
      return next
    },
  }
}
