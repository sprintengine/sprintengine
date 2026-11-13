import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_ADOPTED_PART_BYTES,
  MAX_ADOPTED_RECORDS,
  STUDIO_MAX_UPLOAD_BYTES,
  type StudioAdoptedRecord,
  type StudioAdoptedRecordKind,
  type StudioAdoptResult,
} from '../../../packages/studio-protocol/src/public'
import { STUDIO_ENVIRONMENT_ADOPT_CAPABILITY } from '../../../packages/studio-protocol/src/handshake'
import type { StudioClient } from '../../../packages/client-runtime/src/public'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { machinePathsIn } from '../../shared/machine-path-edge'
import { machineSpellingOf, type MachineSpelling } from '../../shared/machine-spelling'
import { adoptedRecordDigest } from './environment-adoption'
import type { ChatSourceFile } from './environment-chat-sources'

// The hand-over of what this desktop kept for the chats another environment
// holds (design-environment-migration's "Hand-over spec"; design-wsl-ssh-direct
// PR 1d): an SSH machine's workspace records, the schedules that run in its
// folders, the messages scheduled or held for its chats (with their pictures
// and files), the resumes after a usage limit and the pull requests its chats
// opened, with the news their watches have not told yet. Once handed over, the
// machine's own Studio keeps and runs them with no desktop watching, and this
// desktop's stores hold none of them; its workspace records stay as the
// machine's copies (environment-replicas.ts).
//
// One journal, `<dataDir>/environment-migration.json` (0600, renamed into
// place), one entry per route: planned → delivered → retired.
//
// - **Plan** (at start, and each time a machine connects): every record here
//   that names a machine's chat or folder is written under
//   `environment-migration/pending/<migrationId>/` in the machine's own
//   spelling, then listed in the journal, then taken out of its live store. A
//   crash in between finds it in both next time, and takes it out again; one
//   never reached waits there across restarts.
// - **Deliver** (when the machine is connected): `environment.adopt` with the
//   pending copies, their pictures and files staged first through `uploads.*`.
//   Safe to repeat: the machine keeps each under its digest once.
// - **Retire**: the copies move to `environment-migration/delivered/` (never
//   read again; kept for the owner to recover by hand), and the entry is done.
//
// A machine's workspace records are handed over once: from then on every
// record of its chats is the machine's, a copy here.

/** A record this desktop keeps that a chat or folder of another environment names. */
export type MigratingRecord = {
  route: string
  kind: StudioAdoptedRecordKind
  id: string
  /** The record as this desktop's store keeps it, its paths as this desktop spells them. */
  body: Record<string, unknown>
  /**
   * A held message's pictures and files, by where they are on this disk; and
   * a schedule's prompt pictures, each with the path its prompt names it by
   * (`promptPath`), which the machine names its own copy by instead.
   */
  carried?: {
    images?: Array<{ path: string; name: string; mediaType: string; promptPath?: string }>
    files?: Array<{ path: string; name: string }>
  }
  /**
   * A chat this desktop ran itself: the files it keeps here, carried in
   * parts. Not copied ahead like a message's: this desktop's copies stay
   * where they are, never written again, so they are read where they lie.
   */
  chatFiles?: ChatSourceFile[]
}

export type EnvironmentMigrationStores = {
  /**
   * Every record here naming another environment's chat or folder. Workspace
   * records only for the routes in `workspacesOf`: a route whose workspaces
   * were handed over keeps them as the machine's copies.
   */
  collect(workspacesOf: (route: string) => boolean): Promise<MigratingRecord[]>
  /** Take them out of this desktop's live stores. A workspace record stays, as the machine's copy. */
  release(records: MigratingRecord[]): Promise<void>
}

export type EnvironmentMigration = {
  /** Write what names another environment's chats into the journal and out of the live stores. */
  plan(): Promise<void>
  /**
   * Hand the route's planned records to its machine, if it is reachable.
   * True once nothing of the route's waits here (handed over, or nothing to).
   */
  deliver(route: string): Promise<boolean>
  /** Whether the route's workspace records are the machine's now, this desktop's only copies of them. */
  handedOver(route: string): boolean
  /** The routes with records still waiting for their machine. */
  waiting(): string[]
}

type JournalRecord = { kind: StudioAdoptedRecordKind; id: string; digest: string; file: string }

type JournalEntry = {
  state: 'planned' | 'delivered' | 'retired'
  migrationId: string
  records: JournalRecord[]
  /** The workspace records of this route were handed over: every one here is the machine's copy. */
  workspacesHandedOver?: true
  /** What the machine kept its own copy of instead, or refused, and why: said in the diagnostics. */
  conflicts?: Array<{ kind: StudioAdoptedRecordKind; id: string; reason: string }>
}

type Journal = { v: 1; environments: Record<string, JournalEntry> }

/** A pending copy: the record as the machine is handed it, and the files it carries, by digest. */
type PendingCopy = {
  kind: StudioAdoptedRecordKind
  id: string
  digest: string
  body: Record<string, unknown>
  files: Array<{ sha256: string; name: string; mediaType: string | null; bytes: number }>
  /** A chat's files, where they lie on this disk, by the digest the machine checks each against. */
  chatSources?: Array<{ sha256: string; source: string; bytes: number; parts: string[] }>
}

const JOURNAL_FILE = 'environment-migration.json'
const DIR = 'environment-migration'

const safeName = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32)

export function createEnvironmentMigration(deps: {
  dataDir: string
  stores: EnvironmentMigrationStores
  clients: EnvironmentClients
  /**
   * How a route's machine spells its paths, once that is known: a WSL
   * distribution's drive mount root is its own Studio's word, so its records
   * are planned once it has said it. An SSH machine's, and by default, from
   * the route alone.
   */
  spellingOf?: (route: string) => MachineSpelling | null
  log?: (message: string) => void
  now?: () => number
}): EnvironmentMigration {
  const spellingOf = deps.spellingOf ?? ((route: string) => machineSpellingOf(route))
  const journalPath = join(deps.dataDir, JOURNAL_FILE)
  const pendingDir = (migrationId: string) => join(deps.dataDir, DIR, 'pending', migrationId)
  const deliveredDir = (migrationId: string) => join(deps.dataDir, DIR, 'delivered', migrationId)
  let journal: Journal | null = null
  // One step at a time: a plan, a delivery and a retirement never write the journal together.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  async function read(): Promise<Journal> {
    if (journal) return journal
    try {
      const parsed = JSON.parse(await readFile(journalPath, 'utf8')) as Partial<Journal>
      if (parsed?.v === 1 && parsed.environments && typeof parsed.environments === 'object')
        return (journal = { v: 1, environments: parsed.environments })
    } catch {
      // None yet.
    }
    return (journal = { v: 1, environments: {} })
  }

  async function write(next: Journal): Promise<void> {
    await mkdir(deps.dataDir, { recursive: true })
    const temporary = `${journalPath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 })
    await rename(temporary, journalPath)
    await chmod(journalPath, 0o600).catch(() => undefined)
    journal = next
  }

  /** A file's sha-256, size, and the sha-256 of each part it goes in, read once without copying it. */
  async function digestInParts(path: string): Promise<{ sha256: string; bytes: number; parts: string[] }> {
    const whole = createHash('sha256')
    const parts: string[] = []
    let part = createHash('sha256')
    let inPart = 0
    let bytes = 0
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
      let data = chunk as Buffer
      whole.update(data)
      bytes += data.length
      while (data.length > 0) {
        const take = Math.min(data.length, MAX_ADOPTED_PART_BYTES - inPart)
        part.update(data.subarray(0, take))
        inPart += take
        data = data.subarray(take)
        if (inPart === MAX_ADOPTED_PART_BYTES) {
          parts.push(part.digest('hex'))
          part = createHash('sha256')
          inPart = 0
        }
      }
    }
    if (inPart > 0) parts.push(part.digest('hex'))
    return { sha256: whole.digest('hex'), bytes, parts }
  }

  /** The record as the machine keeps it: its paths in the machine's spelling, nothing that says where it lives. */
  function forMachine(record: MigratingRecord): Record<string, unknown> {
    const body =
      record.kind === 'workspace'
        ? (({ environment: _e, hostId: _h, remoteOrigin: _r, ...rest }) => rest)(record.body)
        : record.kind === 'schedule'
          ? (({ hostId: _h, nextRunAt: _n, waiting: _w, ...rest }) => rest)(record.body)
          : record.body
    const spelling = spellingOf(record.route)
    const spelled = spelling ? machinePathsIn(spelling, body) : body
    // A saved approval's words name its folder too: said again in the machine's spelling.
    if (record.kind === 'approval-rule') {
      const before = (body.matcher as { prefix?: unknown } | undefined)?.prefix
      const after = (spelled.matcher as { prefix?: unknown } | undefined)?.prefix
      if (typeof before === 'string' && typeof after === 'string' && typeof spelled.label === 'string')
        return { ...spelled, label: spelled.label.split(before).join(after) }
    }
    return spelled
  }

  /** Copy a record and what it carries under the migration's pending folder. */
  async function writePending(migrationId: string, record: MigratingRecord): Promise<JournalRecord> {
    const folder = pendingDir(migrationId)
    await mkdir(join(folder, 'files'), { recursive: true, mode: 0o700 })
    const files: PendingCopy['files'] = []
    const carried = (
      list: Array<{ path: string; name: string; mediaType?: string; promptPath?: string }> | undefined,
    ) =>
      Promise.all(
        (list ?? []).map(async (entry) => {
          const bytes = await readFile(entry.path)
          const sha256 = createHash('sha256').update(bytes).digest('hex')
          const target = join(folder, 'files', sha256)
          if (!existsSync(target)) {
            await copyFile(entry.path, `${target}.tmp`)
            await rename(`${target}.tmp`, target)
          }
          files.push({ sha256, name: entry.name, mediaType: entry.mediaType ?? null, bytes: bytes.length })
          return {
            sha256,
            name: entry.name,
            bytes: bytes.length,
            ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
            ...(entry.promptPath ? { promptPath: entry.promptPath } : {}),
          }
        }),
      )
    const body = forMachine(record)
    if (record.carried) {
      const images = await carried(record.carried.images)
      const attached = await carried(record.carried.files)
      const words = (body.carried ?? {}) as Record<string, unknown>
      body.carried = {
        ...words,
        ...(images.length ? { images } : {}),
        ...(attached.length ? { files: attached } : {}),
      }
    }
    const chatSources: NonNullable<PendingCopy['chatSources']> = []
    if (record.chatFiles) {
      const listed: Array<Record<string, unknown>> = []
      for (const entry of record.chatFiles) {
        const read = await digestInParts(entry.source)
        chatSources.push({ sha256: read.sha256, source: entry.source, bytes: read.bytes, parts: read.parts })
        listed.push({ place: entry.place, path: entry.path, sha256: read.sha256, bytes: read.bytes, parts: read.parts })
      }
      body.files = listed
    }
    const digest = adoptedRecordDigest(body)
    const file = `${record.kind}-${safeName(record.id)}.json`
    const copy: PendingCopy = {
      kind: record.kind,
      id: record.id,
      digest,
      body,
      files,
      ...(chatSources.length ? { chatSources } : {}),
    }
    await writeFile(join(folder, `${file}.tmp`), JSON.stringify(copy), { mode: 0o600 })
    await rename(join(folder, `${file}.tmp`), join(folder, file))
    return { kind: record.kind, id: record.id, digest, file }
  }

  const plan = () =>
    serial(async () => {
      const current = await read()
      // A route whose spelling is not known yet is planned once it is (on its connect).
      const found = (await deps.stores.collect((route) => !current.environments[route]?.workspacesHandedOver)).filter(
        (record) => spellingOf(record.route) !== null,
      )
      if (found.length === 0) return
      const next: Journal = { v: 1, environments: { ...current.environments } }
      const planned: MigratingRecord[] = []
      for (const record of found) {
        let entry = next.environments[record.route]
        if (!entry || entry.state !== 'planned') {
          // A route whose last hand-over finished starts another; what it
          // learned (its workspaces handed over) stays.
          if (entry?.state === 'delivered') await retire(entry)
          entry = {
            state: 'planned',
            migrationId: `${safeName(record.route).slice(0, 12)}-${randomUUID()}`,
            records: [],
            ...(entry?.workspacesHandedOver ? { workspacesHandedOver: true as const } : {}),
          }
        } else entry = { ...entry, records: [...entry.records] }
        next.environments[record.route] = entry
        if (!entry.records.some((known) => known.kind === record.kind && known.id === record.id)) {
          try {
            entry.records.push(await writePending(entry.migrationId, record))
          } catch (error) {
            // Left in its live store, to be planned next time: nothing is dropped.
            deps.log?.(
              `Could not keep ${record.kind} ${record.id} for ${record.route}: ${error instanceof Error ? error.message : String(error)}`,
            )
            continue
          }
        }
        planned.push(record)
      }
      // The copies are on disk and listed: only now do the live stores let go.
      await write(next)
      await deps.stores.release(planned)
    })

  async function retire(entry: JournalEntry): Promise<void> {
    const from = pendingDir(entry.migrationId)
    if (existsSync(from)) {
      await mkdir(join(deps.dataDir, DIR, 'delivered'), { recursive: true, mode: 0o700 })
      await rm(deliveredDir(entry.migrationId), { recursive: true, force: true })
      await rename(from, deliveredDir(entry.migrationId))
    }
    entry.state = 'retired'
  }

  /** Stage one file through `uploads.*`, answering its upload id. */
  async function upload(client: StudioClient, folder: string, file: PendingCopy['files'][number]): Promise<string> {
    return uploadBytes(client, await readFile(join(folder, 'files', file.sha256)), file.name, file.mediaType)
  }

  /**
   * Stage the parts of the chats in `copies` for the machine to put back
   * together, a few to a call (inside what a connection may stage at once),
   * each read where it lies and checked against the digest it was planned
   * with. A file changed since then stops the delivery; it is planned again.
   */
  async function stageChatParts(client: StudioClient, migrationId: string, copies: PendingCopy[]): Promise<void> {
    let staged: Array<{ uploadId: string; digest: string }> = []
    let stagedBytes = 0
    let calls = 0
    const flush = async () => {
      if (staged.length === 0) return
      await client.request('environment.adopt', {
        commandId: `${migrationId}-parts-${Date.now()}-${calls++}`,
        migrationId,
        records: [],
        files: staged,
      })
      staged = []
      stagedBytes = 0
    }
    const sent = new Set<string>()
    for (const copy of copies)
      for (const source of copy.chatSources ?? []) {
        const handle = await open(source.source, 'r')
        try {
          for (const [index, digest] of source.parts.entries()) {
            if (sent.has(digest)) continue
            const length = Math.min(MAX_ADOPTED_PART_BYTES, source.bytes - index * MAX_ADOPTED_PART_BYTES)
            const bytes = Buffer.alloc(length)
            await handle.read(bytes, 0, length, index * MAX_ADOPTED_PART_BYTES)
            if (createHash('sha256').update(bytes).digest('hex') !== digest)
              throw new Error(`${source.source} changed since it was planned.`)
            if (staged.length >= 5 || stagedBytes + length > 4 * STUDIO_MAX_UPLOAD_BYTES) await flush()
            staged.push({ uploadId: await uploadBytes(client, bytes, 'part', null), digest })
            stagedBytes += length
            sent.add(digest)
          }
        } finally {
          await handle.close()
        }
      }
    await flush()
  }

  async function uploadBytes(
    client: StudioClient,
    bytes: Buffer,
    name: string,
    mediaType: string | null,
  ): Promise<string> {
    const begun = await client.request('uploads.begin', {
      mediaType: mediaType ?? 'application/octet-stream',
      byteLength: bytes.length,
      name,
      purpose: mediaType?.startsWith('image/') ? 'picture' : 'attachment',
    })
    for (let offset = 0; offset < bytes.length; offset += begun.chunkBytes)
      await client.request('uploads.append', {
        uploadId: begun.uploadId,
        offset,
        dataBase64: bytes.subarray(offset, offset + begun.chunkBytes).toString('base64'),
      })
    return begun.uploadId
  }

  const deliver = (route: string) =>
    serial(async (): Promise<boolean> => {
      const current = await read()
      const entry = current.environments[route]
      if (!entry || entry.state === 'retired') return true
      const next: Journal = { v: 1, environments: { ...current.environments } }
      const working: JournalEntry = { ...entry }
      next.environments[route] = working
      if (working.state === 'planned') {
        const reached = await deps.clients.clientFor(route, STUDIO_ENVIRONMENT_ADOPT_CAPABILITY)
        if (!reached.ok) {
          deps.log?.(`What this desktop kept for ${route}'s chats waits for it: ${reached.message}`)
          return false
        }
        const folder = pendingDir(working.migrationId)
        const copies: PendingCopy[] = []
        for (const record of working.records)
          copies.push(JSON.parse(await readFile(join(folder, record.file), 'utf8')) as PendingCopy)
        const held: StudioAdoptResult['held'] = []
        const conflicts: NonNullable<JournalEntry['conflicts']> = []
        try {
          // A part at a time, each with the files its records carry; every
          // part under the one migration, so a repeat is held, not doubled.
          let part: PendingCopy[] = []
          let partBytes = 0
          const send = async () => {
            if (part.length === 0) return
            // A chat's parts go ahead of it, in calls that name no record.
            await stageChatParts(reached.client, working.migrationId, part)
            const files: Array<{ uploadId: string; digest: string }> = []
            for (const copy of part)
              for (const file of copy.files) {
                if (files.some((each) => each.digest === file.sha256)) continue
                if (file.bytes > STUDIO_MAX_UPLOAD_BYTES) continue
                files.push({ uploadId: await upload(reached.client, folder, file), digest: file.sha256 })
              }
            const records: StudioAdoptedRecord[] = part.map(({ kind, id, digest, body }) => ({
              kind,
              id,
              digest,
              body,
            }))
            const answer = await reached.client.request('environment.adopt', {
              commandId: `${working.migrationId}-${held.length + conflicts.length}`,
              migrationId: working.migrationId,
              records,
              ...(files.length ? { files } : {}),
            })
            held.push(...answer.held)
            conflicts.push(...answer.conflicts)
            part = []
            partBytes = 0
          }
          for (const copy of copies) {
            const bytes = copy.files.reduce((total, file) => total + file.bytes, 0)
            // Staged files are held per client up to a bound: a part's stay well under it.
            if (
              part.length >= MAX_ADOPTED_RECORDS ||
              (part.length > 0 && partBytes + bytes > 4 * STUDIO_MAX_UPLOAD_BYTES)
            )
              await send()
            part.push(copy)
            partBytes += bytes
          }
          await send()
        } catch (error) {
          deps.log?.(
            `Handing ${route}'s chats over stopped, and is tried again on its next connection: ${error instanceof Error ? error.message : String(error)}`,
          )
          return false
        }
        working.state = 'delivered'
        working.workspacesHandedOver = true
        if (conflicts.length) {
          working.conflicts = conflicts
          for (const conflict of conflicts)
            deps.log?.(
              `${route} kept its own ${conflict.kind} ${conflict.id} rather than this desktop's: ${conflict.reason}`,
            )
        }
        await write(next)
      }
      await retire(working)
      await write(next)
      return true
    })

  return {
    plan,
    deliver,
    // Not before the journal is read; a route with nothing ever planned has
    // nothing of this desktop's to hand over.
    handedOver: (route) => {
      if (!journal) return false
      const entry = journal.environments[route]
      return !entry || (entry.state !== 'planned' && entry.workspacesHandedOver === true)
    },
    waiting: () =>
      Object.entries(journal?.environments ?? {})
        .filter(([, entry]) => entry.state !== 'retired')
        .map(([route]) => route),
  }
}
