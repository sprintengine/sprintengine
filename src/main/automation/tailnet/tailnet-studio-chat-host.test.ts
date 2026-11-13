import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import type { ConversationEvent, ConversationImageAttachment } from '../../../shared/conversation-runtime'
import { createConversationGatewayHost, type ConversationGatewayHost } from '../../../server/core/conversation-host'
import { ConversationAttachmentStore } from '../../conversation-attachment-store'
import { ConversationRuntime } from '../../conversation-runtime'
import { searchFiles } from '../../filesystem-search'
import type { ConversationProviderAdapter } from '../../providers/conversation-provider-adapter'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { CONVERSATION_IMAGE_MAX_BYTES } from './tailnet-conversation-images'
import { createTailnetFileUploads, TAILNET_UPLOADS_DIRNAME } from './tailnet-file-uploads'
import { deviceRig, hostBackend, refusalOf, until, type DeviceRig } from './tailnet-studio.test-helper'

// What a paired device reads and runs of a chat on the Studio socket, served
// by the real conversation host over a real runtime: the host behaviour the
// conversation lane's own tests pinned, carried over when the lane went.
// A real tailnet listener on loopback, the Studio server over the host's
// backend as the core builds it, and the shared client with a device's token.
//
// The routing around these (each method held to its grant, a retried command
// carried out once, uploads spent once per send and per client) is the
// router's, pinned with a stand-in host in src/server/rpc/studio-rpc-followed.test.ts.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1')

const workspaceId = 'workspace'
const agentId = 'agent'
const otherAgentId = 'other-agent'
const KEY = { workspaceId, agentId }

type Step = { id: string; name: string; kind?: string; input: Record<string, unknown>; status?: string }

/** The mock provider, whose turn announces the steps a JSON message lists; any other message is the mock's. */
function stepProvider(): ConversationProviderAdapter {
  const base = { ...createMockConversationProvider({ sideQuestion: true, contextBreakdown: true }), id: 'claude-agent' }
  return {
    ...base,
    sendTurn(input) {
      if (!input.message.startsWith('[')) return base.sendTurn(input)
      const event = (type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent => ({
        id: '',
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        createdAt: 1,
        type,
        payload,
      })
      const steps = JSON.parse(input.message) as Step[]
      return [
        event('turn_started', { turnId: input.turnId }),
        ...steps.flatMap((step) => [
          event('tool_started', {
            turnId: input.turnId,
            toolUseId: step.id,
            name: step.name,
            ...(step.kind ? { kind: step.kind } : {}),
            input: step.input,
          }),
          // `pending` stands for a step still waiting on its approval: announced, never ended.
          ...(step.status === 'pending'
            ? []
            : [
                event('tool_output', {
                  turnId: input.turnId,
                  toolUseId: step.id,
                  output: 'done',
                  status: step.status ?? 'ok',
                }),
              ]),
        ]),
        event('turn_completed', { turnId: input.turnId }),
      ]
    },
  }
}

let workspaceRoot: string
let dataDir: string
let pictures: string
let elsewhere: string
let uploadsRoot: string
let runtime: ConversationRuntime
let host: ConversationGatewayHost
let rig: DeviceRig
let sessionId: string
let operator: StudioClient
let reader: StudioClient
let stranger: StudioClient
const commandAsks: Array<{ cwd: string; refresh?: boolean }> = []
/** What each sent picture was recorded as, by the name it was sent under. */
const refs = new Map<string, string>()

function attachment(id: string, name: string, mediaType: string, bytes: Buffer): ConversationImageAttachment {
  return { id, name, mediaType, dataBase64: bytes.toString('base64'), byteLength: bytes.length }
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'studio-chat-host-workspace-'))
  dataDir = mkdtempSync(join(tmpdir(), 'studio-chat-host-data-'))
  pictures = mkdtempSync(join(tmpdir(), 'studio-chat-host-pictures-'))
  elsewhere = mkdtempSync(join(tmpdir(), 'studio-chat-host-elsewhere-'))
  uploadsRoot = join(dataDir, TAILNET_UPLOADS_DIRNAME)
  // What a mention may name, and a file outside the chat's folder that it may not.
  mkdirSync(join(workspaceRoot, 'src'))
  writeFileSync(join(workspaceRoot, 'src', 'checkout.ts'), 'export {}\n')
  writeFileSync(join(elsewhere, 'checkout-secret.ts'), 'secret\n')
  // The pictures the chat's steps made or read.
  writeFileSync(join(pictures, 'generated.png'), PNG)
  // Named .png, but the bytes are a JPEG: the bytes decide.
  writeFileSync(join(pictures, 'screenshot.png'), JPEG)
  writeFileSync(join(workspaceRoot, 'relative.gif'), GIF)
  writeFileSync(join(pictures, 'notes.png'), 'these are words, not a picture')
  writeFileSync(join(pictures, 'notes.txt'), 'plain text')
  writeFileSync(join(pictures, 'huge.png'), PNG)
  truncateSync(join(pictures, 'huge.png'), CONVERSATION_IMAGE_MAX_BYTES + 1)
  writeFileSync(join(pictures, 'linked-target.webp'), WEBP)
  symlinkSync(join(pictures, 'linked-target.webp'), join(pictures, 'linked.webp'))
  mkdirSync(join(pictures, 'folder.png'))
  // Outside the chat's folder and Studio's picture folders, and a link in the chat's folder that leads there.
  writeFileSync(join(elsewhere, 'outside.png'), PNG)
  symlinkSync(join(elsewhere, 'outside.png'), join(workspaceRoot, 'leads-out.png'))

  const provider = stepProvider()
  runtime = new ConversationRuntime({
    adapters: [provider],
    getProviderById: () => undefined,
    attachmentStore: new ConversationAttachmentStore(dataDir),
  })
  host = createConversationGatewayHost(
    runtime,
    (id) => (id === workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    {
      // Stands for Studio's own picture folders, which a step's picture may be in.
      imageRoots: () => [pictures],
      searchFiles: (input) =>
        searchFiles(-1, {
          rootPath: input.rootPath,
          query: input.query,
          limit: input.limit,
          purpose: 'mention',
          channel: input.channel,
        }),
      commandsOf: async (input) => {
        commandAsks.push({ cwd: input.cwd, ...(input.refresh ? { refresh: true } : {}) })
        return {
          cli: input.cli,
          cwd: input.cwd,
          fetchedAt: 7,
          commands: [{ name: 'review', description: 'Review a pull request', source: 'cli' }],
        }
      },
    },
  )
  const start = async (agent: string) => {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId,
      agentId: agent,
      providerId: provider.id,
      modelId: provider.listModels()[0]!,
      permissionPreset: 'bypass',
    })
    assert.ok(started.ok)
    return started.session.sessionId
  }
  sessionId = await start(agentId)
  const steps: Step[] = [
    // Codex announces a picture twice: once as it starts, and again with the
    // path once the picture is saved. The second word is the one that stands.
    { id: 'generate', name: 'GenerateImage', kind: 'other', input: { prompt: 'a lighthouse' } },
    {
      id: 'generate',
      name: 'GenerateImage',
      kind: 'other',
      input: { prompt: 'a lighthouse', path: join(pictures, 'generated.png') },
    },
    { id: 'read-image', name: 'Read', kind: 'file_read', input: { file_path: join(pictures, 'screenshot.png') } },
    { id: 'read-relative', name: 'Read', input: { path: 'relative.gif' } },
    { id: 'read-outside', name: 'Read', kind: 'file_read', input: { file_path: join(elsewhere, 'outside.png') } },
    {
      id: 'read-leads-out',
      name: 'Read',
      kind: 'file_read',
      input: { file_path: join(workspaceRoot, 'leads-out.png') },
    },
    { id: 'read-linked', name: 'Read', kind: 'file_read', input: { filePath: join(pictures, 'linked.webp') } },
    { id: 'read-text', name: 'Read', kind: 'file_read', input: { file_path: join(pictures, 'notes.txt') } },
    { id: 'read-words', name: 'Read', kind: 'file_read', input: { file_path: join(pictures, 'notes.png') } },
    { id: 'read-huge', name: 'Read', kind: 'file_read', input: { file_path: join(pictures, 'huge.png') } },
    { id: 'read-missing', name: 'Read', kind: 'file_read', input: { file_path: join(pictures, 'gone.png') } },
    { id: 'read-folder', name: 'Read', kind: 'file_read', input: { file_path: join(pictures, 'folder.png') } },
    { id: 'edit-image', name: 'Write', kind: 'file_write', input: { file_path: join(pictures, 'generated.png') } },
    { id: 'generate-unsaved', name: 'GenerateImage', kind: 'other', input: { prompt: 'nothing saved' } },
    // Announced before the person answered, then declined, failed or never answered: no picture.
    {
      id: 'read-declined',
      name: 'Read',
      kind: 'file_read',
      input: { file_path: join(pictures, 'screenshot.png') },
      status: 'declined',
    },
    {
      id: 'read-unanswered',
      name: 'Read',
      kind: 'file_read',
      input: { file_path: join(pictures, 'screenshot.png') },
      status: 'pending',
    },
    {
      id: 'read-failed',
      name: 'Read',
      kind: 'file_read',
      input: { file_path: join(pictures, 'screenshot.png') },
      status: 'error',
    },
  ]
  const stepped = await runtime.sendTurn({ sessionId, message: JSON.stringify(steps) })
  assert.ok(stepped.ok)
  // The pictures a person sent with a message, in this chat and in another.
  const sent = await runtime.sendTurn({
    sessionId,
    message: 'look',
    attachments: [
      attachment('photo', 'IMG_0001.png', 'image/png', PNG),
      attachment('mislabelled', 'IMG_0002.png', 'image/png', JPEG),
      attachment('words', 'IMG_0003.png', 'image/png', Buffer.from('these are words, not a picture')),
    ],
  })
  assert.ok(sent.ok, sent.ok ? '' : sent.message)
  const other = await runtime.sendTurn({
    sessionId: await start(otherAgentId),
    message: 'look',
    attachments: [attachment('elsewhere', 'IMG_0004.png', 'image/png', PNG)],
  })
  assert.ok(other.ok)
  await runtime.flushTranscripts()
  for (const agent of [agentId, otherAgentId]) {
    const transcript = await runtime.readTranscript({ workspaceRoot, workspaceId, agentId: agent })
    assert.ok(transcript.ok)
    for (const event of transcript.events)
      if (event.type === 'user_message')
        for (const entry of (event.payload?.attachments ?? []) as Array<{ name: string; ref: string }>)
          refs.set(entry.name, entry.ref)
  }
  assert.equal(refs.size, 4, 'every sent picture was kept')

  // As the core links them: the Studio's backend keeps a device's files where
  // the listener removes them with the device.
  const fileUploads = createTailnetFileUploads({ root: uploadsRoot })
  rig = await deviceRig({ backend: hostBackend(host, runtime, { fileUploads }) }, { gateway: { fileUploads } })
  operator = await rig.client(rig.pair(['conversation:read', 'conversation:operate'], 'laptop').token)
  reader = await rig.client(rig.pair(['conversation:read']).token)
  stranger = await rig.client(rig.pair(['workspace:read', 'backlog:read']).token)
})

afterAll(async () => {
  await rig?.dispose()
  await runtime?.shutdown()
  for (const dir of [workspaceRoot, dataDir, pictures, elsewhere])
    if (dir) rmSync(dir, { recursive: true, force: true })
})

// ── Side questions and the context window (from the lane's agent reads) ──────

test('a listed chat says whether it answers a side question and says what fills its window', async () => {
  const listed = (await host.list()).find((row) => row.agentId === agentId)!.capabilities
  assert.equal(listed?.sideQuestion, true)
  assert.equal(listed?.contextBreakdown, true)
})

test("a device's side question is asked of the chat's session, and its answer comes back to it", async () => {
  const asked = vi.spyOn(runtime, 'askSideQuestion').mockResolvedValue({ ok: true, answer: 'src/app.ts first.' })
  try {
    const answer = await operator.rpc['conversation.askSideQuestion']({
      key: KEY,
      commandId: 'side-1',
      questionId: 'q-1',
      question: 'Which file did it change first?',
      history: [{ question: 'Did it run the tests?', answer: 'Yes.' }],
    })
    assert.deepEqual(answer, { ok: true, answer: 'src/app.ts first.' })
    const input = asked.mock.calls[0]![0]
    assert.equal(input.sessionId, sessionId)
    assert.equal(input.question, 'Which file did it change first?')
    assert.deepEqual(input.history, [{ question: 'Did it run the tests?', answer: 'Yes.' }])
  } finally {
    asked.mockRestore()
  }
})

test('a side question called off is called off where it went, and is not answered', async () => {
  let settle: (value: { ok: false; cancelled: true; message: string }) => void = () => undefined
  const asked = vi.spyOn(runtime, 'askSideQuestion').mockReturnValue(new Promise((resolve) => (settle = resolve)))
  const cancel = vi.spyOn(runtime, 'cancelSideQuestion').mockImplementation(async () => {
    settle({ ok: false, cancelled: true, message: 'The side question was called off.' })
    return { ok: true }
  })
  try {
    const answer = operator.rpc['conversation.askSideQuestion']({
      key: KEY,
      commandId: 'side-2',
      questionId: 'q-2',
      question: 'Why?',
    })
    await until(() => asked.mock.calls.length === 1, 'the question to reach the agent')
    assert.deepEqual(await operator.rpc['conversation.cancelSideQuestion']({ questionId: 'q-2' }), { ok: true })
    assert.deepEqual(cancel.mock.calls, [[{ sessionId, requestId: asked.mock.calls[0]![0].requestId }]])
    const settled = await answer
    assert.equal(settled.ok, false)
  } finally {
    asked.mockRestore()
    cancel.mockRestore()
  }
})

test("the window's breakdown is read from the live session's agent, and needs only a read grant", async () => {
  const breakdown = {
    model: 'mock-model',
    usedTokens: 12_000,
    windowTokens: 200_000,
    categories: [{ name: 'Messages', tokens: 12_000, kind: 'used' as const }],
    mcpServers: [],
    skills: [],
    memoryFiles: [],
    agents: [],
    autoCompactAt: null,
    estimated: true,
    measuredAt: 1_700_000_000_000,
  }
  const read = vi.spyOn(runtime, 'readContextBreakdown').mockResolvedValue({ ok: true, breakdown, stale: true })
  try {
    assert.deepEqual(await reader.rpc['conversation.contextBreakdown']({ key: KEY }), {
      ok: true,
      breakdown,
      stale: true,
    })
    assert.deepEqual(read.mock.calls, [[{ sessionId }]])
  } finally {
    read.mockRestore()
  }
})

test('a chat at rest is not started to read its window: there is no agent to ask yet', async () => {
  const start = vi.spyOn(runtime, 'startSession')
  try {
    const read = await host.contextBreakdown!({ workspaceRoot, workspaceId, agentId: 'at-rest' })
    assert.equal(read.ok, false)
    assert.equal(!read.ok && read.reason, 'not-running')
    assert.equal(start.mock.calls.length, 0)
  } finally {
    start.mockRestore()
  }
})

// ── The composer's reads (from the lane's `conversation-files`/`-commands`) ──

test("a search answers the chat folder's matches by their paths in it, and nothing outside", async () => {
  const answer = await reader.rpc['conversation.searchFiles']({ key: KEY, query: 'checkout' })
  assert.ok(answer.entries.some((entry) => entry.path === 'src/checkout.ts' && entry.kind === 'file'))
  for (const entry of answer.entries) {
    assert.ok(!entry.path.startsWith('/') && !entry.path.includes('..'), entry.path)
    assert.ok(!entry.path.includes('secret'), 'nothing outside the folder')
  }
})

test('an empty query matches nothing, and an overlong one is refused', async () => {
  assert.deepEqual(await reader.rpc['conversation.searchFiles']({ key: KEY, query: '' }), {
    entries: [],
    truncated: false,
  })
  assert.equal(
    await refusalOf(reader.rpc['conversation.searchFiles']({ key: KEY, query: 'x'.repeat(201) })),
    'invalid_params',
  )
})

test("the `/` list is the chat CLI's for its folder, and asking the CLI again is for a device that may operate it", async () => {
  assert.deepEqual(await reader.rpc['conversation.listCommands']({ key: KEY }), {
    cli: 'claude-code',
    fetchedAt: 7,
    commands: [{ name: 'review', description: 'Review a pull request', source: 'cli' }],
  })
  assert.deepEqual(commandAsks.at(-1), { cwd: workspaceRoot })
  assert.equal(await refusalOf(reader.rpc['conversation.listCommands']({ key: KEY, refresh: true })), 'scope_required')
  await operator.rpc['conversation.listCommands']({ key: KEY, refresh: true })
  assert.deepEqual(commandAsks.at(-1), { cwd: workspaceRoot, refresh: true })
})

test('neither composer read is answered without the conversation grant, or for a chat not here', async () => {
  assert.equal(
    await refusalOf(stranger.rpc['conversation.searchFiles']({ key: KEY, query: 'checkout' })),
    'scope_required',
  )
  assert.equal(await refusalOf(stranger.rpc['conversation.listCommands']({ key: KEY })), 'scope_required')
  assert.equal(
    await refusalOf(reader.rpc['conversation.searchFiles']({ key: { workspaceId, agentId: 'nobody' }, query: 'a' })),
    'not_found',
  )
})

// ── A step's picture (from the lane's `conversation-image` route) ───────────

const step = (toolUseId: string, client: StudioClient = reader, key = KEY) =>
  client.rpc['conversation.picture']({ key, toolUseId })
const bytesOf = (answer: { dataBase64: string }) => Buffer.from(answer.dataBase64, 'base64')

test('a picture outside the chat’s folders and Studio’s picture folders is not served', async () => {
  for (const id of ['read-outside', 'read-leads-out']) assert.equal(await refusalOf(step(id)), 'not_found', id)
})

test('a generated picture is served as the bytes on disk, under the path its last announcement named', async () => {
  const answer = await step('generate')
  assert.equal(answer.mediaType, 'image/png')
  assert.deepEqual(bytesOf(answer), PNG)
})

test('a picture a step read is served under the type its bytes say, not its name', async () => {
  const answer = await step('read-image')
  assert.equal(answer.mediaType, 'image/jpeg', 'screenshot.png holds a JPEG')
  assert.deepEqual(bytesOf(answer), JPEG)
})

test('a relative path names a file in the chat’s folder, and a link is followed to the picture it names', async () => {
  const relativeRead = await step('read-relative')
  assert.equal(relativeRead.mediaType, 'image/gif')
  assert.deepEqual(bytesOf(relativeRead), GIF)
  const linked = await step('read-linked')
  assert.equal(linked.mediaType, 'image/webp')
  assert.deepEqual(bytesOf(linked), WEBP)
})

test('a chat this machine does not have, a step not there or one that shows no picture is not found', async () => {
  for (const key of [
    { workspaceId: 'elsewhere', agentId },
    { workspaceId, agentId: 'nobody' },
  ])
    assert.equal(await refusalOf(step('generate', reader, key)), 'not_found', key.agentId)
  for (const id of [
    'no-such-step',
    'read-text',
    'edit-image',
    'generate-unsaved',
    'read-declined',
    'read-unanswered',
    'read-failed',
    // A picture that is gone, or a path that is not a file.
    'read-missing',
    'read-folder',
    // A file named like a picture whose bytes are not one.
    'read-words',
  ])
    assert.equal(await refusalOf(step(id)), 'not_found', id)
})

test('a picture over the ceiling is refused as too large', async () => {
  assert.equal(await refusalOf(step('read-huge')), 'too_large')
})

test('a device without a conversation grant is refused a picture', async () => {
  assert.equal(await refusalOf(step('generate', stranger)), 'scope_required')
})

test('a picture asked for again is found without scanning the transcript again', async () => {
  const lookups = vi.spyOn(runtime, 'findToolCall')
  try {
    await step('read-linked')
    const scans = lookups.mock.calls.length
    const [second, third] = await Promise.all([step('read-linked'), step('read-linked')])
    assert.deepEqual(third, second)
    assert.equal(lookups.mock.calls.length, scans, 'the step was found once')
  } finally {
    lookups.mockRestore()
  }
})

// ── A sent picture (from the lane's `conversation-image?attachment=`) ────────

const sentPicture = (ref: string, key = KEY) => reader.rpc['conversation.picture']({ key, attachment: ref })

test('a sent picture is served as the store kept it, under the type its bytes say', async () => {
  const photo = await sentPicture(refs.get('IMG_0001.png')!)
  assert.equal(photo.mediaType, 'image/png')
  assert.deepEqual(bytesOf(photo), PNG)
  const mislabelled = await sentPicture(refs.get('IMG_0002.png')!)
  assert.equal(mislabelled.mediaType, 'image/jpeg')
  assert.deepEqual(bytesOf(mislabelled), JPEG)
  assert.equal(await refusalOf(sentPicture(refs.get('IMG_0003.png')!)), 'not_found', 'words are not a picture')
})

test('another chat’s picture is not served under this chat, though it is under its own', async () => {
  const ref = refs.get('IMG_0004.png')!
  assert.equal(await refusalOf(sentPicture(ref)), 'not_found')
  assert.deepEqual(bytesOf(await sentPicture(ref, { workspaceId, agentId: otherAgentId })), PNG)
})

test('a ref the store did not choose never reaches the disk', async () => {
  const folder = ConversationAttachmentStore.folderFor({ workspaceRoot, workspaceId, agentId })
  for (const ref of [
    '../../../etc/hosts',
    `${folder}/../${folder}/x.png`,
    `${folder}/not-a-uuid.png`,
    `${folder}`,
    join(workspaceRoot, 'photo.png'),
  ])
    assert.equal(await refusalOf(sentPicture(ref)), 'not_found', ref)
})

// ── A file sent with a message (from the lane's `upload?kind=file`) ─────────

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

/** Stage bytes on the client's connection, as the phone and a paired desktop do; answers the upload's id. */
async function stage(
  client: StudioClient,
  name: string,
  bytes: Buffer,
  purpose: 'attachment' | 'picture' = 'attachment',
  mediaType = 'application/pdf',
): Promise<string> {
  const { uploadId } = await client.rpc['uploads.begin']({ mediaType, byteLength: bytes.length, purpose, name })
  await client.rpc['uploads.append']({ uploadId, offset: 0, dataBase64: bytes.toString('base64') })
  return uploadId
}

/** The last message sent to the chat, as its transcript keeps it. */
async function lastSent(): Promise<Record<string, unknown> | undefined> {
  await runtime.flushTranscripts()
  const transcript = await runtime.readTranscript({ workspaceRoot, workspaceId, agentId })
  assert.ok(transcript.ok)
  return transcript.events.filter((event) => event.type === 'user_message').at(-1)?.payload
}

/** Until no turn of the chat is running, so a send is taken as the next turn and not held behind one. */
async function settled(): Promise<void> {
  await until(() => {
    const listed = runtime.listSessions({ workspaceId })
    return listed.ok && listed.sessions.every((session) => session.status !== 'active')
  }, 'the chat to be at rest')
}

test('a file is kept in Studio’s own store under one safe name, never in the project, and the send attaches it by path', async () => {
  await settled()
  const uploadId = await stage(
    operator,
    '../../../notes.txt',
    Buffer.from('three things to fix'),
    'attachment',
    'text/plain',
  )
  await operator.rpc['conversation.send']({
    key: KEY,
    commandId: 'send-file',
    message: 'read this',
    uploadIds: [uploadId],
  })
  const files = (await lastSent())?.files as Array<{ path: string }>
  assert.equal(files.length, 1)
  assert.ok(files[0]!.path.startsWith(uploadsRoot + sep), files[0]!.path)
  assert.ok(files[0]!.path.endsWith(`${sep}notes.txt`), 'one segment, whatever the name said')
  assert.ok(!relative(uploadsRoot, files[0]!.path).startsWith('..'))
  // The agent reads it by that path, now or in a later turn.
  assert.equal(readFileSync(files[0]!.path, 'utf8'), 'three things to fix')
  assert.equal(
    filesUnder(workspaceRoot).some((path) => path.endsWith('notes.txt')),
    false,
    'nothing lands in the project',
  )
})

test('a file sent beside a picture goes with it, each as what it is', async () => {
  await settled()
  const picture = await stage(operator, 'IMG_0005.png', PNG, 'picture', 'image/png')
  const file = await stage(operator, 'data.csv', Buffer.from('a,b\n1,2\n'), 'attachment', 'text/csv')
  await operator.rpc['conversation.send']({
    key: KEY,
    commandId: 'send-both',
    message: 'both',
    uploadIds: [picture, file],
  })
  const message = await lastSent()
  assert.deepEqual(
    (message?.files as Array<{ path: string }>).map((entry) => entry.path.split(sep).pop()),
    ['data.csv'],
  )
  assert.deepEqual(
    (message?.attachments as Array<{ name: string }>).map((entry) => entry.name),
    ['IMG_0005.png'],
  )
})

test('the files a removed device sent go with it, and another device’s stay', async () => {
  await settled()
  const pairing = rig.pair(['conversation:read', 'conversation:operate'], 'leaving-laptop')
  const leaving = await rig.client(pairing.token)
  const uploadId = await stage(leaving, 'leaving.txt', Buffer.from('bye'), 'attachment', 'text/plain')
  await leaving.rpc['conversation.send']({ key: KEY, commandId: 'send-leaving', message: 'bye', uploadIds: [uploadId] })
  const kept = filesUnder(uploadsRoot).find((path) => path.endsWith(`${sep}leaving.txt`))
  assert.ok(kept)
  assert.ok(rig.devices.revokeDevice(pairing.id))
  assert.equal(existsSync(kept), false)
  assert.equal(existsSync(dirname(dirname(kept))), false)
  assert.ok(
    filesUnder(uploadsRoot).some((path) => path.endsWith(`${sep}data.csv`)),
    'the laptop’s file stays',
  )
})
