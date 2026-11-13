import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { respellPromptPath } from '../../main/scheduled-agents/prompt-images'

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
    /** Keep a picture a schedule's prompt names on this disk, as a pasted one is kept; answers its path here. */
    keepImage(bytes: Buffer, name: string): Promise<string>
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
    /**
     * Hold one with what it carries beside its words, once per `source`: its
     * pictures copied and its files placed on this disk, as a message a
     * device queued with them is held.
     */
    holdCarrying(
      chat: { workspaceId: string; agentId: string },
      text: string,
      source: string,
      carried: AdoptedCarried,
    ): Promise<{ ok: true } | { ok: false; reason: string }>
  }
  resumes: {
    /** Keep the resume after this chat's usage limit as the desktop kept it; refused for a chat not here. */
    adopt(stored: Record<string, unknown>): Promise<{ ok: true } | { ok: false; reason: string }>
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
    /** Keep the news a watch found that the chat was not told yet, to be told here. */
    keepUntold(chat: { workspaceId: string; agentId: string }, url: string, untold: unknown): void
  }
}

/** A held message's pictures and files as handed over: their bytes, staged through `uploads.*`. */
export type AdoptedCarried = {
  images: Array<{ name: string; mediaType: string; bytes: Buffer }>
  files: Array<{ name: string; bytes: Buffer }>
  skills: string[]
  mentions: unknown[]
}

/** A staged file, by the sha-256 of its bytes. */
export type AdoptedFiles = ReadonlyMap<string, { bytes: Buffer; mediaType: string; name?: string }>

export type EnvironmentAdoption = {
  adopt(input: {
    migrationId: string
    records: StudioAdoptedRecord[]
    files?: AdoptedFiles
  }): Promise<StudioAdoptResult>
}

const LEDGER_FILE = 'environment-adoptions.json'

/**
 * What was kept under which digest. `pending` marks a record a hand-over was
 * about to keep when the ledger was last written: one that crashed after its
 * store's write but before the ledger's, so a repeat knows the copy already in
 * the store is its own.
 */
type Ledger = {
  v: 1
  records: Record<string, { digest: string; migrationId: string; at: number; pending?: true }>
}

/** Why a record was not kept; `exists` says its id is already in its store. */
type Kept = { ok: true } | { ok: false; reason: string; exists?: true }

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

/**
 * A carried file's name as it is kept here: its last part alone, whatever
 * path the desktop's name held, and `fallback` for one with no name left
 * (empty, `.`, `..`), so no name leads its write out of its folder.
 */
export function carriedName(value: unknown, fallback: string): string {
  if (!text(value, 500)) return fallback
  const base = value.split(/[\\/]/u).pop()?.trim() ?? ''
  return base && base !== '.' && base !== '..' ? base : fallback
}

type CarriedEntry = { sha256?: unknown; name?: unknown; mediaType?: unknown; promptPath?: unknown }

/**
 * A schedule's prompt with each picture it carries kept on this disk and
 * named by its copy here, in place of the path the desktop named it by; or why
 * not. Every picture must arrive whole, or none is kept.
 */
async function promptWithPictures(
  body: Record<string, unknown>,
  files: AdoptedFiles,
  keepImage: (bytes: Buffer, name: string) => Promise<string>,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: string }> {
  const { carried, ...rest } = body
  const images = (carried as { images?: unknown } | undefined)?.images
  if (!Array.isArray(images) || images.length === 0) return { ok: true, body: rest }
  if (typeof rest.prompt !== 'string') return { ok: false, reason: 'The scheduled agent names no prompt.' }
  const arrived: Array<{ from: string; name: string; bytes: Buffer }> = []
  for (const entry of images as CarriedEntry[]) {
    const sha256 = typeof entry.sha256 === 'string' ? entry.sha256 : ''
    const staged = files.get(sha256)
    if (!staged || createHash('sha256').update(staged.bytes).digest('hex') !== sha256)
      return { ok: false, reason: 'A picture its prompt names did not arrive whole.' }
    if (!text(entry.promptPath, 4096) || !rest.prompt.includes(entry.promptPath))
      return { ok: false, reason: 'A picture it carries is not one its prompt names.' }
    arrived.push({ from: entry.promptPath, name: carriedName(entry.name, 'picture'), bytes: staged.bytes })
  }
  let prompt = rest.prompt
  for (const picture of arrived)
    prompt = respellPromptPath(prompt, picture.from, await keepImage(picture.bytes, picture.name))
  return { ok: true, body: { ...rest, prompt } }
}

/**
 * A held message's `carried` as the desktop named it (each picture and file by
 * the sha-256 of its bytes, its skills and mentions as words), read against the
 * files staged beside it: null when it carries nothing beside its words.
 */
function carriedOf(
  value: unknown,
  files: AdoptedFiles,
): { ok: true; carried: AdoptedCarried | null } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: true, carried: null }
  const given = value as { images?: unknown; files?: unknown; skills?: unknown; mentions?: unknown }
  const list = (entries: unknown): CarriedEntry[] => (Array.isArray(entries) ? (entries as CarriedEntry[]) : [])
  const bytesOf = (entry: CarriedEntry) => {
    const sha256 = typeof entry.sha256 === 'string' ? entry.sha256 : ''
    const staged = files.get(sha256)
    return staged && createHash('sha256').update(staged.bytes).digest('hex') === sha256 ? staged : null
  }
  const images: AdoptedCarried['images'] = []
  const attached: AdoptedCarried['files'] = []
  for (const entry of list(given.images)) {
    const staged = bytesOf(entry)
    if (!staged) return { ok: false, reason: 'A picture it carries did not arrive whole.' }
    images.push({
      name: carriedName(entry.name, 'picture'),
      mediaType: text(entry.mediaType, 200) ? entry.mediaType : staged.mediaType,
      bytes: staged.bytes,
    })
  }
  for (const entry of list(given.files)) {
    const staged = bytesOf(entry)
    if (!staged) return { ok: false, reason: 'A file it carries did not arrive whole.' }
    attached.push({ name: carriedName(entry.name, 'file'), bytes: staged.bytes })
  }
  const skills = Array.isArray(given.skills) ? given.skills.filter((skill): skill is string => text(skill, 200)) : []
  const mentions = Array.isArray(given.mentions) ? given.mentions : []
  if (!images.length && !attached.length && !skills.length && !mentions.length) return { ok: true, carried: null }
  return { ok: true, carried: { images, files: attached, skills, mentions } }
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
  async function keep(record: StudioAdoptedRecord, migrationId: string, files: AdoptedFiles): Promise<Kept> {
    const body = record.body
    // The same command again, after a crash between the store's write and the ledger's.
    const source = `adopt:${migrationId}:${record.kind}:${record.id}`
    switch (record.kind) {
      case 'workspace': {
        if (body.id !== record.id) return { ok: false, reason: 'The workspace record names another id.' }
        if (stores.workspaces.has(record.id))
          return { ok: false, reason: 'A workspace with that id is already here.', exists: true }
        const kept = stores.workspaces.adopt(body)
        return kept.ok ? kept : { ok: false, reason: kept.message }
      }
      case 'schedule': {
        if (body.id !== record.id) return { ok: false, reason: 'The scheduled agent names another id.' }
        if (stores.schedules.has(record.id))
          return { ok: false, reason: 'A scheduled agent with that id is already here.', exists: true }
        // Its prompt's pictures, kept here first and named by their copies.
        const pictured = await promptWithPictures(body, files, stores.schedules.keepImage)
        if (!pictured.ok) return pictured
        const kept = await stores.schedules.adopt(pictured.body)
        return kept.ok
          ? kept
          : { ok: false, reason: kept.message, ...(kept.reason === 'exists' ? { exists: true as const } : {}) }
      }
      case 'scheduled-message': {
        const chat = chatOf(body)
        if (!chat || !text(body.text, MAX_SCHEDULED_MESSAGE_LENGTH))
          return { ok: false, reason: 'A scheduled message names its chat and its words.' }
        // What a held message carries beside its words came staged beside
        // the records, each named by the digest of its bytes.
        const carried = body.queued === true ? carriedOf(body.carried, files) : null
        if (carried && !carried.ok) return { ok: false, reason: carried.reason }
        if (carried?.ok && carried.carried) {
          const held = await stores.messages.holdCarrying(chat, body.text, source, carried.carried)
          return held.ok ? { ok: true } : { ok: false, reason: held.reason }
        }
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
        const kept = await stores.resumes.adopt(body)
        return kept.ok ? kept : { ok: false, reason: kept.reason }
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
          // What the desktop's watch found and had not told yet is told from here.
          if (Array.isArray(body.untold) && body.untold.length > 0)
            stores.pullRequests.keepUntold(chat, body.url, body.untold)
        }
        return { ok: true }
      }
    }
  }

  async function run(input: {
    migrationId: string
    records: StudioAdoptedRecord[]
    files?: AdoptedFiles
  }): Promise<StudioAdoptResult> {
    const ledger = readLedger()
    const held: StudioAdoptResult['held'] = []
    const conflicts: StudioAdoptResult['conflicts'] = []
    // A workspace first, so the chats the rest name are found.
    const order = (kind: StudioAdoptedRecordKind) => STUDIO_ADOPTED_RECORD_KINDS.indexOf(kind)
    const records = [...input.records].sort((a, b) => order(a.kind) - order(b.kind))
    const keyOf = (record: StudioAdoptedRecord) => `${record.kind}:${record.id}`
    // Each record left from a hand-over that stopped before its ledger was
    // written: the digest it was about to keep.
    const interrupted = new Map<string, string>()
    for (const [key, entry] of Object.entries(ledger.records)) if (entry.pending) interrupted.set(key, entry.digest)
    // What this hand-over is about to keep goes in the ledger first, as
    // pending: a crash between a store's write and the ledger's then leaves a
    // mark, and the repeat knows the copy in the store is its own.
    const toKeep = records.filter((record) => {
      const known = ledger.records[keyOf(record)]
      return adoptedRecordDigest(record.body) === record.digest && (!known || known.pending === true)
    })
    if (toKeep.length) {
      for (const record of toKeep)
        ledger.records[keyOf(record)] = {
          digest: record.digest,
          migrationId: input.migrationId,
          at: now(),
          pending: true,
        }
      writeLedger(ledger)
    }
    for (const record of records) {
      const key = keyOf(record)
      if (adoptedRecordDigest(record.body) !== record.digest) {
        conflicts.push({ kind: record.kind, id: record.id, reason: 'Its digest does not match its body.' })
        continue
      }
      const known = ledger.records[key]
      if (known && !known.pending) {
        if (known.digest === record.digest) held.push({ kind: record.kind, id: record.id })
        else
          conflicts.push({
            kind: record.kind,
            id: record.id,
            reason: 'This Studio already keeps another copy of it, and keeps that one.',
          })
        continue
      }
      let kept: Kept
      try {
        kept = await keep(record, input.migrationId, input.files ?? new Map())
      } catch (error) {
        kept = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      const earlier = interrupted.get(key)
      if (!kept.ok && kept.exists && earlier !== undefined) {
        // An earlier hand-over kept it and stopped before its ledger: the copy
        // here is that one. The same digest is this record, held; another is
        // the machine's copy, which wins.
        ledger.records[key] = { digest: earlier, migrationId: input.migrationId, at: now() }
        if (earlier === record.digest) held.push({ kind: record.kind, id: record.id })
        else
          conflicts.push({
            kind: record.kind,
            id: record.id,
            reason: 'This Studio already keeps another copy of it, and keeps that one.',
          })
        continue
      }
      if (!kept.ok) {
        // Not kept, so not in the ledger: it can go in once fixed.
        delete ledger.records[key]
        conflicts.push({ kind: record.kind, id: record.id, reason: kept.reason })
        continue
      }
      ledger.records[key] = { digest: record.digest, migrationId: input.migrationId, at: now() }
      held.push({ kind: record.kind, id: record.id })
    }
    // Answered only for what is on disk: each store's writes land, then the
    // ledger, then the answer. A crash before the ledger is a hand-over run
    // again: every way in here refuses a second copy, and the pending marks
    // written first answer what it had kept as held, not as another copy.
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
