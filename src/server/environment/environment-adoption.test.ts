import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { MAX_ADOPTED_PART_BYTES, type StudioAdoptedRecord } from '../../../packages/studio-protocol/src/public'
import { workspaceStorePath } from '../../main/workspace-store'
import {
  adoptedRecordDigest,
  canonicalRecordJson,
  carriedName,
  createEnvironmentAdoption,
  type EnvironmentAdoptionStores,
} from './environment-adoption'

// A machine's Studio keeping what a desktop kept for its chats: each record in
// its own store, once, a repeat held again without a second copy, a record
// that differs from what is here left as this Studio has it, and the answer
// given only once every store and the ledger are written.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeStores() {
  const calls: string[] = []
  const workspaces = new Set<string>()
  const schedules = new Set<string>()
  const adoptedSchedules: Array<Record<string, unknown>> = []
  const sources = new Set<string>()
  const rules = new Set<string>()
  let flushed = 0
  const stores: EnvironmentAdoptionStores = {
    async flush() {
      flushed += 1
      calls.push('flush')
    },
    workspaces: {
      has: (id) => workspaces.has(id),
      // Every chat here works in the one folder the tests name.
      chatRoot: (id) => (workspaces.has(id) ? '/home/dev/repo' : null),
      adopt(record) {
        calls.push(`workspace ${String(record.id)}`)
        workspaces.add(String(record.id))
        return { ok: true }
      },
    },
    schedules: {
      has: (id) => schedules.has(id),
      async adopt(record) {
        const id = String((record as { id: unknown }).id)
        calls.push(`schedule ${id}`)
        if ((record as { prompt?: unknown }).prompt === undefined)
          return { ok: false, reason: 'invalid', message: 'A scheduled agent has a prompt.' }
        schedules.add(id)
        adoptedSchedules.push(record as Record<string, unknown>)
        return { ok: true }
      },
      async keepImage(bytes, name) {
        calls.push(`image ${name}:${bytes.toString()}`)
        return `/home/dev/.studio/scheduled-images/kept/${name}`
      },
    },
    messages: {
      scheduleFrom(chat, text, sendAt, source) {
        calls.push(`schedule-message ${chat.agentId} ${text} ${sendAt}`)
        sources.add(source)
        return { ok: true }
      },
      hold(chat, text, source) {
        calls.push(`hold ${chat.agentId} ${text}`)
        sources.add(source)
        return { ok: true }
      },
      async holdCarrying(chat, text, source, carried) {
        calls.push(
          `hold ${chat.agentId} ${text} with ${carried.images.map((image) => `${image.name}:${image.bytes.toString()}`).join(',')} ${carried.files.map((file) => `${file.name}:${file.bytes.toString()}`).join(',')} ${carried.skills.join(',')}`,
        )
        sources.add(source)
        return { ok: true }
      },
    },
    approvalRules: {
      async adopt(rule) {
        const id = String((rule as { id: unknown }).id)
        calls.push(`rule ${id}`)
        if (rules.has(id)) return { ok: false, reason: 'A rule with that id is already here.', exists: true }
        rules.add(id)
        return { ok: true }
      },
    },
    resumes: {
      async adopt(stored) {
        calls.push(`resume ${String(stored.agentId)}`)
        return stored.agentId === 'gone' ? { ok: false, reason: 'Its chat is not on this machine.' } : { ok: true }
      },
    },
    pullRequests: {
      async noteOpened(chat, input) {
        calls.push(`opened ${chat.agentId} ${input.url}`)
        return input.url.endsWith('/9')
          ? { ok: false, code: 'opened_by_another_conversation', message: 'Another chat here opened it.' }
          : { ok: true }
      },
      async watch(chat, input) {
        calls.push(`watch ${chat.agentId} ${input.url}`)
        return { ok: true }
      },
      keepUntold(chat, url, untold) {
        calls.push(`untold ${chat.agentId} ${url} ${JSON.stringify(untold)}`)
      },
    },
  }
  return { stores, calls, workspaces, adoptedSchedules, flushed: () => flushed }
}

function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), 'environment-adoption-'))
  dirs.push(dataDir)
  const fake = fakeStores()
  const adoption = createEnvironmentAdoption({ dataDir, stores: fake.stores, now: () => 1_000 })
  return { ...fake, adoption, dataDir }
}

function record(kind: StudioAdoptedRecord['kind'], id: string, body: Record<string, unknown>): StudioAdoptedRecord {
  return { kind, id, digest: adoptedRecordDigest(body), body }
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const WORKSPACE = { id: 'ws-1', name: 'repo', folderPath: '/home/dev/repo', agents: {} }
const SCHEDULE = { id: 'sa-1', prompt: 'Triage the inbox', workspaceId: 'ws-1' }

test('the digest is of the body as canonical JSON, whatever order its keys came in', () => {
  assert.equal(canonicalRecordJson({ b: 1, a: { d: [1, 'x'], c: null } }), '{"a":{"c":null,"d":[1,"x"]},"b":1}')
  assert.equal(adoptedRecordDigest({ b: 1, a: 2 }), adoptedRecordDigest({ a: 2, b: 1 }))
  assert.notEqual(adoptedRecordDigest({ a: 1 }), adoptedRecordDigest({ a: 2 }))
})

test('each kind goes into its own store, a workspace first, and the answer waits for the stores and the ledger', async () => {
  const { adoption, calls, dataDir } = rig()
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [
      record('pull-request', 'pr-1', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        url: 'https://github.com/o/r/pull/1',
        watched: true,
      }),
      record('schedule', 'sa-1', SCHEDULE),
      record('scheduled-message', 'sm-1', { workspaceId: 'ws-1', agentId: 'a1', text: 'later', sendAt: 5_000 }),
      record('scheduled-message', 'sm-2', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        text: 'after this turn',
        queued: true,
      }),
      record('usage-limit-resume', 'ul-1', { workspaceId: 'ws-1', agentId: 'a1' }),
      record('workspace', 'ws-1', WORKSPACE),
    ],
  })
  assert.deepEqual(answer.conflicts, [])
  assert.deepEqual(
    answer.held.map((entry) => `${entry.kind}:${entry.id}`),
    [
      'workspace:ws-1',
      'schedule:sa-1',
      'scheduled-message:sm-1',
      'scheduled-message:sm-2',
      'usage-limit-resume:ul-1',
      'pull-request:pr-1',
    ],
  )
  assert.deepEqual(calls, [
    'workspace ws-1',
    'schedule sa-1',
    'schedule-message a1 later 5000',
    'hold a1 after this turn',
    'resume a1',
    'opened a1 https://github.com/o/r/pull/1',
    'watch a1 https://github.com/o/r/pull/1',
    'flush',
  ])
  const ledger = join(dataDir, 'environment-adoptions.json')
  assert.equal(statSync(ledger).mode & 0o777, 0o600)
  assert.ok(JSON.parse(readFileSync(ledger, 'utf8')).records['workspace:ws-1'])
})

test('a hand-over repeated is held again with nothing written twice; one that differs keeps this Studio’s copy', async () => {
  const { adoption, calls } = rig()
  const first = [record('workspace', 'ws-1', WORKSPACE), record('schedule', 'sa-1', SCHEDULE)]
  await adoption.adopt({ migrationId: 'm-1', records: first })
  calls.length = 0
  const again = await adoption.adopt({ migrationId: 'm-1', records: first })
  assert.deepEqual(again.held.length, 2)
  assert.deepEqual(again.conflicts, [])
  assert.deepEqual(calls, ['flush'], 'nothing kept a second time')

  const changed = await adoption.adopt({
    migrationId: 'm-2',
    records: [record('workspace', 'ws-1', { ...WORKSPACE, name: 'renamed' })],
  })
  assert.deepEqual(changed.held, [])
  assert.match(changed.conflicts[0]?.reason ?? '', /keeps that one/u)
  assert.deepEqual(calls, ['flush', 'flush'])
})

test('a hand-over that stopped after its stores but before its ledger is held when it comes again', async () => {
  const { adoption, calls, stores, dataDir } = rig()
  const records = [record('workspace', 'ws-1', WORKSPACE), record('schedule', 'sa-1', SCHEDULE)]
  // The process stops once the stores have the records, before the ledger says so.
  const flush = stores.flush
  stores.flush = async () => {
    throw new Error('The process stopped.')
  }
  await assert.rejects(adoption.adopt({ migrationId: 'm-1', records }))
  stores.flush = flush
  calls.length = 0
  // The desktop's journal sends it again, to the Studio started afresh.
  const restarted = createEnvironmentAdoption({ dataDir, stores, now: () => 2_000 })
  const again = await restarted.adopt({ migrationId: 'm-1', records })
  assert.deepEqual(
    again.held.map((entry) => entry.id),
    ['ws-1', 'sa-1'],
  )
  assert.deepEqual(again.conflicts, [], 'its own copies, not another way in')
  assert.deepEqual(calls, ['flush'], 'nothing kept a second time')
  const ledger = JSON.parse(readFileSync(join(dataDir, 'environment-adoptions.json'), 'utf8')) as {
    records: Record<string, { pending?: true }>
  }
  assert.equal(ledger.records['workspace:ws-1']?.pending, undefined, 'kept, no longer pending')
})

test('what does not read, does not match its digest, or is already here by another way is reported, not kept', async () => {
  const { adoption, calls, workspaces } = rig()
  workspaces.add('ws-here')
  const tampered = { ...record('workspace', 'ws-2', WORKSPACE), body: { ...WORKSPACE, id: 'ws-2', name: 'other' } }
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [
      tampered,
      record('workspace', 'ws-here', { ...WORKSPACE, id: 'ws-here' }),
      record('workspace', 'ws-3', { ...WORKSPACE, id: 'ws-other' }),
      record('schedule', 'sa-2', { id: 'sa-2' }),
      record('scheduled-message', 'sm-3', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        text: 'with a picture',
        queued: true,
        carried: { images: [{ sha256: sha('never staged'), name: 'photo.png', mediaType: 'image/png' }] },
      }),
      record('scheduled-message', 'sm-4', { workspaceId: 'ws-1', agentId: 'a1', text: 'no time' }),
      record('pull-request', 'pr-9', { workspaceId: 'ws-1', agentId: 'a1', url: 'https://github.com/o/r/pull/9' }),
    ],
  })
  assert.deepEqual(answer.held, [])
  // What this Studio already keeps by its id is its own copy, which wins: done with.
  assert.deepEqual(
    answer.conflicts.map((entry) => `${entry.id}: ${entry.reason}`),
    ['ws-here: A workspace with that id is already here.', 'pr-9: Another chat here opened it.'],
  )
  // The rest it did not take: the desktop keeps them and sends them again.
  assert.deepEqual(
    answer.refused?.map((entry) => `${entry.id}: ${entry.reason}`),
    [
      'ws-2: Its digest does not match its body.',
      'ws-3: The workspace record names another id.',
      'sa-2: A scheduled agent has a prompt.',
      'sm-3: A picture it carries did not arrive whole.',
      'sm-4: A scheduled message says when it goes.',
    ],
  )
  // A refused record is not in the ledger: once what kept it from going in is fixed, it goes in.
  calls.length = 0
  workspaces.delete('ws-here')
  const retried = await adoption.adopt({
    migrationId: 'm-1',
    records: [record('workspace', 'ws-here', { ...WORKSPACE, id: 'ws-here' })],
  })
  assert.deepEqual(retried.held, [{ kind: 'workspace', id: 'ws-here' }])
})

test('two hand-overs at once are kept one after the other, never interleaved', async () => {
  const { adoption, calls } = rig()
  const [a, b] = await Promise.all([
    adoption.adopt({ migrationId: 'm-a', records: [record('workspace', 'ws-a', { ...WORKSPACE, id: 'ws-a' })] }),
    adoption.adopt({ migrationId: 'm-b', records: [record('workspace', 'ws-b', { ...WORKSPACE, id: 'ws-b' })] }),
  ])
  assert.equal(a.held.length + b.held.length, 2)
  assert.deepEqual(calls, ['workspace ws-a', 'flush', 'workspace ws-b', 'flush'])
})

test('a held message goes with its pictures and files, staged beside it by digest, and a watch with its untold news', async () => {
  const { adoption, calls } = rig()
  const picture = Buffer.from('png bytes')
  const file = Buffer.from('notes')
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [
      record('scheduled-message', 'sm-1', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        text: 'look at this',
        queued: true,
        carried: {
          images: [{ sha256: sha('png bytes'), name: 'shot.png', mediaType: 'image/png' }],
          files: [{ sha256: sha('notes'), name: 'notes.txt' }],
          skills: ['review'],
        },
      }),
      record('pull-request', 'https://github.com/o/r/pull/1', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        url: 'https://github.com/o/r/pull/1',
        watched: true,
        untold: [{ news: 'checks passed' }],
      }),
    ],
    files: new Map([
      [sha('png bytes'), { bytes: picture, mediaType: 'image/png', name: 'shot.png' }],
      [sha('notes'), { bytes: file, mediaType: 'text/plain', name: 'notes.txt' }],
    ]),
  })
  assert.equal(answer.held.length, 2)
  assert.deepEqual(answer.conflicts, [])
  assert.deepEqual(calls.slice(0, -1), [
    'hold a1 look at this with shot.png:png bytes notes.txt:notes review',
    'opened a1 https://github.com/o/r/pull/1',
    'watch a1 https://github.com/o/r/pull/1',
    'untold a1 https://github.com/o/r/pull/1 [{"news":"checks passed"}]',
  ])
})

test('a held message carrying a file too large to stage whole is put back together from the parts staged ahead of it', async () => {
  const { adoption, calls } = rig()
  const parts = ['first half, ', 'second half']
  // The parts go ahead in a call that names no record, under the migration.
  const ahead = await adoption.adopt({
    migrationId: 'm-1',
    records: [],
    files: new Map(
      parts.map((part) => [sha(part), { bytes: Buffer.from(part), mediaType: 'application/octet-stream' }]),
    ),
  })
  assert.deepEqual(ahead.held, [])
  const message = (id: string, partsNamed: string[]) =>
    record('scheduled-message', id, {
      workspaceId: 'ws-1',
      agentId: 'a1',
      text: `big ${id}`,
      queued: true,
      carried: { files: [{ sha256: sha(parts.join('')), name: 'big.log', parts: partsNamed }] },
    })
  const answer = await adoption.adopt({ migrationId: 'm-1', records: [message('sm-1', parts.map(sha))] })
  assert.deepEqual(answer.held, [{ kind: 'scheduled-message', id: 'sm-1' }])
  assert.equal(calls[0], 'hold a1 big sm-1 with  big.log:first half, second half ')
  // Named out of order, its bytes are not its digest: not taken, and sent again by the desktop.
  const wrong = await adoption.adopt({ migrationId: 'm-2', records: [message('sm-2', [sha(parts[1]!)])] })
  assert.deepEqual(
    wrong.refused?.map((entry) => entry.reason),
    ['A file it carries did not arrive whole.'],
  )
})

test('a staged file whose bytes are not the digest its message names is refused, and the message is not held', async () => {
  const { adoption, calls } = rig()
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [
      record('scheduled-message', 'sm-1', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        text: 'look',
        queued: true,
        carried: { files: [{ sha256: sha('notes'), name: 'notes.txt' }] },
      }),
    ],
    files: new Map([[sha('notes'), { bytes: Buffer.from('something else'), mediaType: 'text/plain' }]]),
  })
  assert.deepEqual(
    answer.refused?.map((entry) => entry.reason),
    ['A file it carries did not arrive whole.'],
  )
  assert.deepEqual(calls, ['flush'])
})

test('a resume whose chat is not here is reported, not kept', async () => {
  const { adoption } = rig()
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [record('usage-limit-resume', 'ul-gone', { workspaceId: 'ws-1', agentId: 'gone' })],
  })
  assert.deepEqual(answer.held, [])
  assert.deepEqual(
    answer.refused?.map((entry) => entry.reason),
    ['Its chat is not on this machine.'],
  )
})

test('a schedule goes with the pictures its prompt names, kept here and named by their copies here', async () => {
  const { adoption, calls, adoptedSchedules } = rig()
  const desktopPath = '/Users/dev/Library/Studio/scheduled-images/abc/shot one.png'
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [
      record('schedule', 'sa-2', {
        id: 'sa-2',
        workspaceId: 'ws-1',
        prompt: `Compare with '${desktopPath}' and ${desktopPath}`,
        carried: {
          images: [{ sha256: sha('png bytes'), name: 'shot one.png', mediaType: 'image/png', promptPath: desktopPath }],
        },
      }),
    ],
    files: new Map([[sha('png bytes'), { bytes: Buffer.from('png bytes'), mediaType: 'image/png' }]]),
  })
  assert.deepEqual(answer.conflicts, [])
  assert.deepEqual(calls.slice(0, 2), ['image shot one.png:png bytes', 'schedule sa-2'])
  const kept = "'/home/dev/.studio/scheduled-images/kept/shot one.png'"
  assert.deepEqual(adoptedSchedules[0], { id: 'sa-2', workspaceId: 'ws-1', prompt: `Compare with ${kept} and ${kept}` })
})

test('a schedule whose picture did not arrive whole, or that its prompt does not name, is reported and not kept', async () => {
  const { adoption, calls } = rig()
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [
      record('schedule', 'sa-3', {
        id: 'sa-3',
        prompt: 'Look at /Users/dev/a.png',
        carried: { images: [{ sha256: sha('png bytes'), name: 'a.png', promptPath: '/Users/dev/a.png' }] },
      }),
      record('schedule', 'sa-4', {
        id: 'sa-4',
        prompt: 'No picture here',
        carried: { images: [{ sha256: sha('gif bytes'), name: 'b.gif', promptPath: '/Users/dev/b.gif' }] },
      }),
    ],
    files: new Map([
      [sha('png bytes'), { bytes: Buffer.from('other bytes'), mediaType: 'image/png' }],
      [sha('gif bytes'), { bytes: Buffer.from('gif bytes'), mediaType: 'image/gif' }],
    ]),
  })
  assert.deepEqual(
    answer.refused?.map((entry) => entry.reason),
    ['A picture its prompt names did not arrive whole.', 'A picture it carries is not one its prompt names.'],
  )
  assert.deepEqual(calls, ['flush'])
})

test('a carried file is kept under its last name part alone, never a path out of its folder', async () => {
  assert.equal(carriedName('notes.txt', 'file'), 'notes.txt')
  assert.equal(carriedName('../../etc/passwd', 'file'), 'passwd')
  assert.equal(carriedName('C:\\Users\\dev\\shot.png', 'picture'), 'shot.png')
  for (const name of ['..', '.', '', 'a/..', '/', 42]) assert.equal(carriedName(name, 'file'), 'file', String(name))

  const { adoption, calls } = rig()
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [
      record('scheduled-message', 'sm-9', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        text: 'look',
        queued: true,
        carried: {
          images: [{ sha256: sha('png bytes'), name: '../shot.png', mediaType: 'image/png' }],
          files: [{ sha256: sha('notes'), name: '..' }],
        },
      }),
    ],
    files: new Map([
      [sha('png bytes'), { bytes: Buffer.from('png bytes'), mediaType: 'image/png' }],
      [sha('notes'), { bytes: Buffer.from('notes'), mediaType: 'text/plain' }],
    ]),
  })
  assert.deepEqual(answer.conflicts, [])
  assert.equal(calls[0], 'hold a1 look with shot.png:png bytes file:notes ')
})

// A chat the desktop ran itself in this machine's folders (a WSL
// distribution's, through `wsl.exe`): its files put back together from their
// parts, where this Studio's own runtime reads them.
async function withStoreHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'environment-adoption-home-'))
  dirs.push(home)
  const before = process.env.SPRINTENGINE_STORE_HOME
  process.env.SPRINTENGINE_STORE_HOME = home
  try {
    return await run(home)
  } finally {
    if (before === undefined) delete process.env.SPRINTENGINE_STORE_HOME
    else process.env.SPRINTENGINE_STORE_HOME = before
  }
}

const PART = MAX_ADOPTED_PART_BYTES
const ATTACHMENT_FOLDER = 'a'.repeat(32)

function chatFile(place: string, path: string, bytes: Buffer) {
  const parts: string[] = []
  for (let at = 0; at < bytes.length; at += PART)
    parts.push(
      createHash('sha256')
        .update(bytes.subarray(at, at + PART))
        .digest('hex'),
    )
  return {
    file: { place, path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, parts },
    staged: parts.map((digest, index) => [
      digest,
      { bytes: bytes.subarray(index * PART, (index + 1) * PART), mediaType: 'application/octet-stream' },
    ]) as Array<[string, { bytes: Buffer; mediaType: string }]>,
  }
}

test('a chat the desktop ran comes in parts, and is put back together where its runtime reads it', async () => {
  await withStoreHome(async () => {
    const { adoption, dataDir, workspaces } = rig()
    workspaces.add('ws-1')
    // Larger than one part, so it is staged ahead in a call with no records.
    const transcript = Buffer.alloc(PART + 10, 'x')
    const lines = chatFile('store', 'a1.jsonl', transcript)
    const detail = chatFile('store', 'a1.tools/toolu_1.json', Buffer.from('{"output":"ok"}'))
    const handoff = chatFile('store', 'handoffs/a1-20261113-0930.md', Buffer.from('# Handoff'))
    const picture = chatFile('attachments', `${ATTACHMENT_FOLDER}/0f1e.png`, Buffer.from('png bytes'))
    const ahead = await adoption.adopt({ migrationId: 'm-1', records: [], files: new Map(lines.staged) })
    assert.deepEqual(ahead, { held: [], conflicts: [] })

    const body = {
      workspaceId: 'ws-1',
      agentId: 'a1',
      workspaceRoot: '/home/dev/repo',
      files: [lines.file, detail.file, handoff.file, picture.file],
    }
    const chat = record('chat', 'ws-1:a1', body)
    const files = new Map([...detail.staged, ...handoff.staged, ...picture.staged])
    const answer = await adoption.adopt({ migrationId: 'm-1', records: [chat], files })
    assert.deepEqual(answer, { held: [{ kind: 'chat', id: 'ws-1:a1' }], conflicts: [], refused: [] })

    const store = workspaceStorePath('/home/dev/repo', 'conversations', 'ws-1')
    assert.deepEqual(readFileSync(join(store, 'a1.jsonl')), transcript)
    assert.equal(readFileSync(join(store, 'a1.tools', 'toolu_1.json'), 'utf8'), '{"output":"ok"}')
    assert.equal(readFileSync(join(store, 'handoffs', 'a1-20261113-0930.md'), 'utf8'), '# Handoff')
    // Under the folder the transcript names it by, so its bubble shows it again.
    assert.equal(
      readFileSync(join(dataDir, 'conversation-attachments', ATTACHMENT_FOLDER, '0f1e.png'), 'utf8'),
      'png bytes',
    )
    if (process.platform !== 'win32') assert.equal(statSync(join(store, 'a1.jsonl')).mode & 0o777, 0o600)

    // Its parts were let go once it was held, not left for the sweep.
    assert.deepEqual(readdirSync(join(dataDir, 'environment-adoptions', 'parts', 'm-1')), [])

    // The same hand-over again is held, nothing written twice.
    const again = await adoption.adopt({ migrationId: 'm-1', records: [chat] })
    assert.deepEqual(again, { held: [{ kind: 'chat', id: 'ws-1:a1' }], conflicts: [], refused: [] })
  })
})

test("a chat's file already here with other bytes is this Studio's, and a part that never came refuses the chat until it does", async () => {
  await withStoreHome(async () => {
    const { adoption, workspaces } = rig()
    workspaces.add('ws-1')
    const lines = chatFile('store', 'a1.jsonl', Buffer.from('{"type":"user_message"}\n'))
    const detail = chatFile('store', 'a1.tools/toolu_1.json', Buffer.from('{}'))
    const body = {
      workspaceId: 'ws-1',
      agentId: 'a1',
      workspaceRoot: '/home/dev/repo',
      files: [lines.file, detail.file],
    }
    const chat = record('chat', 'ws-1:a1', body)

    // Its detail's part never arrived: refused in words, the transcript left where it was written.
    const missing = await adoption.adopt({ migrationId: 'm-2', records: [chat], files: new Map(lines.staged) })
    assert.deepEqual(missing.held, [])
    assert.match(missing.refused![0]!.reason, /a1\.tools\/toolu_1\.json did not arrive whole/)
    const store = workspaceStorePath('/home/dev/repo', 'conversations', 'ws-1')
    assert.equal(existsSync(join(store, 'a1.tools', 'toolu_1.json')), false)

    // Sent again with it: kept, the transcript already here held.
    const resent = await adoption.adopt({ migrationId: 'm-2', records: [chat], files: new Map(detail.staged) })
    assert.deepEqual(resent.conflicts, [])

    // The same chat once more under another digest: the ledger keeps the first.
    const other = chatFile('store', 'a1.jsonl', Buffer.from('another transcript\n'))
    const theirs = record('chat', 'ws-1:a1', { ...body, files: [other.file] })
    const answer = await adoption.adopt({ migrationId: 'm-3', records: [theirs], files: new Map(other.staged) })
    assert.match(answer.conflicts[0]!.reason, /another copy/)
    assert.equal(readFileSync(join(store, 'a1.jsonl'), 'utf8'), '{"type":"user_message"}\n')

    // A chat whose transcript this Studio already writes (it ran here): its own is kept, the rest placed.
    writeFileSync(join(store, 'a2.jsonl'), 'written here\n')
    const mine = chatFile('store', 'a2.jsonl', Buffer.from('written on the desktop\n'))
    const tools = chatFile('store', 'a2.tools/toolu_2.json', Buffer.from('{}'))
    const ran = record('chat', 'ws-1:a2', {
      workspaceId: 'ws-1',
      agentId: 'a2',
      workspaceRoot: '/home/dev/repo',
      files: [mine.file, tools.file],
    })
    const kept = await adoption.adopt({
      migrationId: 'm-3',
      records: [ran],
      files: new Map([...mine.staged, ...tools.staged]),
    })
    assert.match(kept.conflicts[0]!.reason, /keeps its own a2\.jsonl/)
    assert.equal(readFileSync(join(store, 'a2.jsonl'), 'utf8'), 'written here\n')
    assert.equal(readFileSync(join(store, 'a2.tools', 'toolu_2.json'), 'utf8'), '{}')
  })
})

test('a chat names only its own files in its own places, and only in a workspace that is here', async () => {
  await withStoreHome(async () => {
    const { adoption, workspaces } = rig()
    const bytes = Buffer.from('x')
    const at = (place: string, path: string) =>
      record('chat', 'ws-1:a1', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        workspaceRoot: '/home/dev/repo',
        files: [chatFile(place, path, bytes).file],
      })
    const notHere = await adoption.adopt({ migrationId: 'm-1', records: [at('store', 'a1.jsonl')] })
    assert.match(notHere.refused![0]!.reason, /workspace the chat is in is not here/)
    workspaces.add('ws-1')
    for (const [place, path] of [
      ['store', '../a1.jsonl'],
      ['store', 'a2.jsonl'],
      ['store', 'a1.tools/../../../x.json'],
      ['store', 'handoffs/a2-20261113-0930.md'],
      ['attachments', '../../etc/passwd'],
      ['attachments', `${ATTACHMENT_FOLDER}/.hidden`],
      ['plans', 'plan.md'],
      ['elsewhere', `${ATTACHMENT_FOLDER}/x.png`],
    ]) {
      const answer = await adoption.adopt({ migrationId: 'm-1', records: [at(place!, path!)] })
      assert.equal(answer.held.length, 0, `${place} ${path}`)
      assert.match(answer.refused![0]!.reason, /one of its own names/, `${place} ${path}`)
    }
    const elsewhere = await adoption.adopt({
      migrationId: 'm-1',
      records: [
        record('chat', 'ws-1:a1', { workspaceId: 'ws-1', agentId: 'a1', workspaceRoot: '/home/dev/other', files: [] }),
      ],
    })
    assert.match(elsewhere.refused![0]!.reason, /folder its record here does not/)
    const windowsRoot = record('chat', 'ws-1:a1', {
      workspaceId: 'ws-1',
      agentId: 'a1',
      workspaceRoot: 'C:\\repo',
      files: [],
    })
    const answer = await adoption.adopt({ migrationId: 'm-1', records: [windowsRoot] })
    assert.match(answer.refused![0]!.reason, /folder as this machine spells it/)
  })
})

test('a saved approval is kept once, after the workspace, and one whose id is here stays as it is', async () => {
  const { adoption, calls } = rig()
  const rule = { id: 'rule-1', workspaceRoot: '/home/dev/repo', toolKind: 'command' }
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [record('approval-rule', 'rule-1', rule), record('workspace', 'ws-1', WORKSPACE)],
  })
  assert.deepEqual(
    answer.held.map((entry) => `${entry.kind}:${entry.id}`),
    ['workspace:ws-1', 'approval-rule:rule-1'],
  )
  assert.deepEqual(calls, ['workspace ws-1', 'rule rule-1', 'flush'])
  const repeat = await adoption.adopt({ migrationId: 'm-1', records: [record('approval-rule', 'rule-1', rule)] })
  assert.deepEqual(repeat.held, [{ kind: 'approval-rule', id: 'rule-1' }])
  const other = await adoption.adopt({
    migrationId: 'm-2',
    records: [record('approval-rule', 'rule-1', { ...rule, toolKind: 'edit' })],
  })
  assert.match(other.conflicts[0]!.reason, /another copy/)
})
