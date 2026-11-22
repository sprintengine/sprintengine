import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test } from 'vitest'

import {
  EXTENSION_EDITOR_BYTES_MAX_BYTES,
  EXTENSION_EDITOR_TEXT_MAX_BYTES,
} from '../../../../packages/extension-sdk/src/custom-editors'
import { STUDIO_MAX_CLIENT_FRAME_BYTES } from '../../../../packages/studio-protocol/src/public'
import {
  FLUSH_FAILED,
  base64ToBytes,
  bytesToBase64,
  createEditorSession,
  editorContentTooLarge,
  createLocalDocumentModel,
  type EditorContent,
  type EditorFrameDocument,
  type EditorSessionOptions,
} from './extension-editor-session'

// The window's side of a custom editor: versions, saving through the Studio,
// the file changing on disk, and two views of one file in a window.

const sha = (content: EditorContent) => createHash('sha256').update(content).digest('hex')

/** A file on a fake Studio, read and written as `files.read` / `files.write` answer. */
function fakeDisk(initial: EditorContent | null, refuse?: string) {
  let content: EditorContent | null = initial
  const writes: Array<{ content: EditorContent; expected?: string }> = []
  return {
    writes,
    get content() {
      return content
    },
    set(next: EditorContent | null) {
      content = next
    },
    read: async () => {
      if (refuse) return { ok: false as const, code: refuse, message: 'Extension was not approved for files.' }
      if (content === null) return { ok: false as const, code: 'missing', message: 'list.todo does not exist.' }
      return { ok: true as const, content, sha256: sha(content) }
    },
    write: async (next: EditorContent, expected: string | undefined) => {
      writes.push({ content: next, ...(expected ? { expected } : {}) })
      if (expected !== undefined && (content === null || sha(content) !== expected))
        return { ok: false as const, code: 'conflict', message: 'changed' }
      content = next
      return { ok: true as const, sha256: sha(next) }
    },
  }
}

function open(disk: ReturnType<typeof fakeDisk>, options: Partial<EditorSessionOptions> = {}) {
  const posted: EditorFrameDocument[] = []
  const model = options.model ?? createLocalDocumentModel()
  const session = createEditorSession({
    contentKind: 'text',
    readOnly: false,
    model,
    read: disk.read,
    write: disk.write,
    post: (document) => posted.push(document),
    flushFrame: async () => true,
    ...options,
  })
  return { session, posted, model }
}

const text = (document: EditorFrameDocument | undefined) =>
  document?.content.kind === 'text' ? document.content.text : undefined

test('the frame gets the file at a version, and an edit against an old version is refused with the current one', async () => {
  const disk = fakeDisk('a\n')
  const { session, posted } = open(disk)
  await session.start()
  session.attachFrame()
  assert.equal(posted.length, 1)
  assert.deepEqual(posted[0], { version: 1, readOnly: false, content: { kind: 'text', text: 'a\n' } })

  assert.deepEqual(session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'b\n' } }), { ok: true })
  assert.equal(session.state().dirty, true)
  assert.equal(posted.length, 1, 'its own edit is not handed back')

  const stale = session.applyEdit({ baseVersion: 0, content: { kind: 'text', text: 'c\n' } })
  assert.equal(stale.ok, false)
  if (!stale.ok) {
    assert.equal(stale.code, 'conflict')
    assert.deepEqual(stale.document, { version: 1, readOnly: false, content: { kind: 'text', text: 'b\n' } })
  }
})

test('save writes through the Studio against the bytes it read, and leaves the document clean', async () => {
  const disk = fakeDisk('a\n')
  const { session } = open(disk)
  await session.start()
  session.attachFrame()
  session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'b\n' } })
  assert.equal(await session.save(), true)
  assert.deepEqual(disk.writes, [{ content: 'b\n', expected: sha('a\n') }])
  assert.equal(disk.content, 'b\n')
  assert.equal(session.state().dirty, false)
})

test('a change on disk is handed to a clean document at a new version', async () => {
  const disk = fakeDisk('a\n')
  const { session, posted } = open(disk)
  await session.start()
  session.attachFrame()
  disk.set('outside\n')
  await session.diskChanged()
  assert.equal(posted.length, 2)
  assert.equal(posted[1]!.version, 2)
  assert.equal(text(posted[1]), 'outside\n')
  assert.equal(session.state().conflict, null)
})

test('a change on disk under unsaved edits is a conflict: nothing is overwritten until the person chooses', async () => {
  const disk = fakeDisk('a\n')
  const { session, posted, model } = open(disk)
  await session.start()
  session.attachFrame()
  session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'mine\n' } })
  disk.set('theirs\n')
  await session.diskChanged()
  assert.deepEqual(session.state().conflict, { kind: 'changed', content: 'theirs\n', sha256: sha('theirs\n') })
  assert.equal(posted.length, 1, 'the frame keeps the edits it made')
  assert.equal(await session.save(), false, 'a save waits for the person to choose')
  assert.equal(disk.content, 'theirs\n')

  // Save mine over it: written against the version the conflict showed.
  assert.equal(await session.saveOverConflict(), true)
  assert.equal(disk.content, 'mine\n')
  assert.equal(session.state().conflict, null)
  assert.equal(model.dirty(), false)

  session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'again\n' } })
  disk.set('later\n')
  await session.diskChanged()
  await session.reload()
  assert.equal(model.get(), 'later\n')
  assert.equal(text(posted.at(-1)), 'later\n')
  assert.equal(session.state().conflict, null)
})

test('a save refused because the file changed meanwhile becomes a conflict, not an overwrite', async () => {
  const disk = fakeDisk('a\n')
  const { session } = open(disk)
  await session.start()
  session.attachFrame()
  session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'mine\n' } })
  disk.set('theirs\n') // no watch event yet
  assert.equal(await session.save(), false)
  assert.equal(disk.content, 'theirs\n')
  assert.equal(session.state().conflict?.kind, 'changed')
})

test('a file deleted under the editor says so', async () => {
  const disk = fakeDisk('a\n')
  const { session } = open(disk)
  await session.start()
  session.attachFrame()
  disk.set(null)
  await session.diskChanged()
  assert.deepEqual(session.state().conflict, { kind: 'deleted' })
})

test('bytes are handed over and saved as bytes', async () => {
  const disk = fakeDisk(new Uint8Array([1, 2, 3]))
  const { session, posted } = open(disk, { contentKind: 'bytes' })
  await session.start()
  session.attachFrame()
  const first = posted[0]!
  assert.equal(first.content.kind, 'bytes')
  if (first.content.kind === 'bytes') assert.deepEqual([...new Uint8Array(first.content.bytes)], [1, 2, 3])
  const refused = session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'no' } })
  assert.equal(refused.ok ? 'applied' : refused.code, 'invalid_params')
  session.applyEdit({ baseVersion: 1, content: { kind: 'bytes', bytes: new Uint8Array([9, 9]).buffer } })
  assert.equal(await session.save(), true)
  assert.deepEqual([...(disk.content as Uint8Array)], [9, 9])
  assert.deepEqual([...base64ToBytes(bytesToBase64(new Uint8Array([0, 255, 128])))], [0, 255, 128])
})

test('an extension that may not read files gets nothing, and one that may not write gets a read-only document', async () => {
  const refused = open(fakeDisk('secret\n', 'not_permitted'))
  await refused.session.start()
  refused.session.attachFrame()
  assert.equal(refused.session.state().status, 'refused')
  assert.equal(refused.posted.length, 0, 'the frame never sees the file')

  const readOnly = open(fakeDisk('a\n'), { readOnly: true })
  await readOnly.session.start()
  readOnly.session.attachFrame()
  assert.equal(readOnly.posted[0]!.readOnly, true)
  const edit = readOnly.session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'b' } })
  assert.equal(edit.ok ? 'applied' : edit.code, 'not_permitted')
  assert.equal(await readOnly.session.save(), false)
})

test('two views of one file share its document: the text editor’s edits reach the frame, and unsaved edits are kept', async () => {
  const disk = fakeDisk('a\n')
  const model = createLocalDocumentModel()
  // The text editor typed before the extension's editor opened.
  model.set('typed\n', 'frame')
  model.setBaseline('a\n')
  const { session, posted } = open(disk, { model })
  await session.start()
  session.attachFrame()
  assert.equal(text(posted[0]), 'typed\n')
  assert.equal(session.state().dirty, true)

  // And again while it is open: handed over at a new version.
  model.set('typed more\n', 'frame')
  assert.equal(posted.length, 2)
  assert.equal(posted[1]!.version, 2)
  assert.equal(text(posted[1]), 'typed more\n')
  const stale = session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'frame\n' } })
  assert.equal(stale.ok ? 'applied' : stale.code, 'conflict')
})

test('a save whose frame did not hand over its edits saves nothing, says so and stays unsaved', async () => {
  const disk = fakeDisk('a\n')
  const { session, model } = open(disk, { flushFrame: async () => false })
  await session.start()
  session.attachFrame()
  session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'b\n' } })
  assert.equal(await session.save(), false)
  assert.deepEqual(disk.writes, [])
  assert.equal(model.dirty(), true)
  assert.equal(session.state().saveError, FLUSH_FAILED)

  // Save mine over it waits for the frame the same way.
  disk.set('theirs\n')
  await session.diskChanged()
  assert.equal(session.state().conflict?.kind, 'changed')
  assert.equal(await session.saveOverConflict(), false)
  assert.equal(disk.content, 'theirs\n')
})

test('a disk read overtaken by a save is read again, so the older version never replaces the newer', async () => {
  let content = 'a\n'
  let hold: (() => void) | null = null
  const disk = {
    read: async () => {
      const seen = content
      // The first watch read is slow: it sees the file before the save lands.
      if (hold === null && seen === 'a\n' && reads > 0) await new Promise<void>((resolve) => (hold = resolve))
      reads += 1
      return { ok: true as const, content: seen, sha256: sha(seen) }
    },
    write: async (next: EditorContent) => {
      content = next as string
      return { ok: true as const, sha256: sha(next) }
    },
  }
  let reads = 0
  const { session, model, posted } = open(fakeDisk(null), { read: disk.read, write: disk.write })
  await session.start()
  session.attachFrame()
  const stale = session.diskChanged()
  await new Promise((resolve) => setTimeout(resolve, 0))
  session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'b\n' } })
  assert.equal(await session.save(), true)
  hold!()
  await stale
  assert.equal(model.get(), 'b\n', 'the editor keeps what it saved')
  assert.equal(posted.length, 1, 'the frame is handed nothing older than what it holds')
})

test('a file deleted under unsaved edits is written back by Save', async () => {
  const disk = fakeDisk('a\n')
  const { session, model } = open(disk)
  await session.start()
  session.attachFrame()
  session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'mine\n' } })
  disk.set(null)
  await session.diskChanged()
  assert.deepEqual(session.state().conflict, { kind: 'deleted' })
  assert.equal(await session.save(), true)
  assert.equal(disk.content, 'mine\n')
  assert.deepEqual(disk.writes.at(-1), { content: 'mine\n' }, 'written back with no bytes to expect')
  assert.equal(model.dirty(), false)
  assert.equal(session.state().conflict, null)
})

test('a document past what one save can carry does not open, and an edit past it is refused, in plain words', async () => {
  const big = 'x'.repeat(EXTENSION_EDITOR_TEXT_MAX_BYTES + 1)
  const tooBig = open(fakeDisk(big))
  await tooBig.session.start()
  assert.equal(tooBig.session.state().status, 'failed')
  assert.match(tooBig.session.state().message ?? '', /at most 1 MiB of text/)

  const { session } = open(fakeDisk('a\n'))
  await session.start()
  session.attachFrame()
  const refused = session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: big } })
  assert.equal(refused.ok ? 'applied' : refused.code, 'too_large')

  // The limits fit one request to the Studio, bytes in base64.
  const envelope = 16 * 1024
  assert.ok(EXTENSION_EDITOR_TEXT_MAX_BYTES + envelope <= STUDIO_MAX_CLIENT_FRAME_BYTES)
  assert.ok(Math.ceil(EXTENSION_EDITOR_BYTES_MAX_BYTES / 3) * 4 + envelope <= STUDIO_MAX_CLIENT_FRAME_BYTES)
  assert.equal(editorContentTooLarge(new Uint8Array(EXTENSION_EDITOR_BYTES_MAX_BYTES)), null)
  assert.match(editorContentTooLarge(new Uint8Array(EXTENSION_EDITOR_BYTES_MAX_BYTES + 1)) ?? '', /768 KiB/)
})

test('a save refused because the file changed, whose new version cannot be read, says why', async () => {
  let readable = true
  const disk = fakeDisk('a\n')
  const { session } = open(disk, {
    read: async () =>
      readable ? disk.read() : { ok: false, code: 'action_failed', message: 'list.todo is larger than 4 MiB.' },
  })
  await session.start()
  session.attachFrame()
  session.applyEdit({ baseVersion: 1, content: { kind: 'text', text: 'mine\n' } })
  disk.set('theirs\n')
  readable = false
  assert.equal(await session.save(), false)
  assert.equal(session.state().saveError, 'list.todo is larger than 4 MiB.')
})
