import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { afterEach, test } from 'vitest'

import type { StudioExtensionCallAnswer } from '../../../../packages/studio-protocol/src/public'
import {
  LEAVE_FLUSH_FAILED,
  createExtensionEditorController,
  type ExtensionEditorControllerOptions,
  type ExtensionEditorPort,
  type UnsavedChoice,
} from './extension-editor-controller'
import { bytesToBase64, type EditorDocumentModel } from './extension-editor-session'
import {
  deleteEditorBuffer,
  getEditorBytes,
  getEditorBytesBaseline,
  setEditorBytes,
  setEditorBytesBaseline,
  subscribeEditorBuffer,
} from '../utils/editorBuffers'

// One custom editor on one file: what survives its frames, and what leaving
// it takes.

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const WS = 'ws'
const PATH = '/Users/dev/app/logo.bin'

afterEach(() => deleteEditorBuffer(WS, PATH))

/** A frame in front of the editor: its Studio answers, and whether it answers a flush. */
function frame(answers: { read?: StudioExtensionCallAnswer; flushes?: boolean } = {}) {
  const calls: Array<{ method: string; params: unknown }> = []
  const documents: unknown[] = []
  let onFlush: ((id: number) => void) | null = null
  const port: ExtensionEditorPort = {
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'files.read')
        return (
          answers.read ?? {
            ok: true,
            result: { content: bytesToBase64(new Uint8Array([1, 2])), sha256: sha(new Uint8Array([1, 2])) },
          }
        )
      const written = Buffer.from((params as { content: string }).content, 'base64')
      return { ok: true, result: { sha256: sha(written) } }
    },
    sendDocument: (document) => documents.push(document),
    requestFlush: (id) => onFlush?.(id),
  }
  return {
    port,
    calls,
    documents,
    answerFlushes(controller: { document: { flushed(id: number, ok: boolean): void } }) {
      if (answers.flushes !== false) onFlush = (id) => queueMicrotask(() => controller.document.flushed(id, true))
    },
  }
}

/** The window's byte buffer for the file, as the editor view builds its model; the unsaved flag is the tab's. */
function bytesModel(): EditorDocumentModel & { flag: { dirty: boolean } } {
  const flag = { dirty: false }
  return {
    flag,
    get: () => getEditorBytes(WS, PATH),
    set(content, origin) {
      setEditorBytes(WS, PATH, content as Uint8Array)
      if (origin === 'frame') flag.dirty = true
    },
    dirty: () => flag.dirty,
    markClean: () => void (flag.dirty = false),
    baseline: () => getEditorBytesBaseline(WS, PATH),
    setBaseline: (content) => setEditorBytesBaseline(WS, PATH, content as Uint8Array),
    subscribe: (listener) => subscribeEditorBuffer(WS, PATH, listener),
  }
}

function controllerOf(model: EditorDocumentModel, more: Partial<ExtensionEditorControllerOptions> = {}) {
  const asked: string[] = []
  const controller = createExtensionEditorController({
    workspaceId: WS,
    relativePath: 'logo.bin',
    contentKind: 'bytes',
    readOnly: false,
    model,
    discard: () => undefined,
    askUnsaved: async () => {
      asked.push('asked')
      return 'stay'
    },
    askUnsent: async () => false,
    flushTimeoutMs: 20,
    ...more,
  })
  return { controller, asked }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function opened(model = bytesModel(), more: Partial<ExtensionEditorControllerOptions> = {}, answers = {}) {
  const made = controllerOf(model, more)
  const shown = frame(answers)
  shown.answerFlushes(made.controller)
  made.controller.openFrame(shown.port)
  made.controller.frameReady()
  await settle()
  return { ...made, model, shown }
}

test('a binary document’s unsaved edits outlive the editor that made them', async () => {
  const model = bytesModel()
  const first = await opened(model)
  first.controller.document.applyEdit({ baseVersion: 1, content: { kind: 'bytes', bytes: new Uint8Array([9]).buffer } })
  assert.equal(model.dirty(), true)
  first.controller.closeFrame()
  first.controller.dispose()

  // Another editor of the same file (Open with…), or the frame drawn again.
  const second = await opened(model)
  assert.deepEqual([...(model.get() ?? [])], [9])
  const handed = second.shown.documents[0] as { content: { bytes: ArrayBuffer } }
  assert.deepEqual([...new Uint8Array(handed.content.bytes)], [9], 'the new frame is handed the unsaved bytes')
})

test('leaving a binary document with unsaved edits for a view that cannot keep them asks first', async () => {
  let choice: UnsavedChoice = 'stay'
  let discarded = 0
  const { controller, model, asked } = await opened(bytesModel(), {
    askUnsaved: async () => choice,
    discard: () => void (discarded += 1),
  })
  controller.document.applyEdit({ baseVersion: 1, content: { kind: 'bytes', bytes: new Uint8Array([7]).buffer } })
  assert.equal(await controller.prepareToLeave('other-editor'), true, 'another editor of the file keeps them')
  assert.deepEqual(asked, [])
  assert.equal(await controller.prepareToLeave('text-editor'), false, 'Cancel stays')
  choice = 'discard'
  assert.equal(await controller.prepareToLeave('close'), true)
  assert.equal(discarded, 1)
  choice = 'save'
  model.set(new Uint8Array([8]), 'frame')
  assert.equal(await controller.prepareToLeave('close'), true)
  assert.equal(model.dirty(), false, 'saved before it went')
})

test('a frame that does not hand over its edits never traps the tab: the person may drop them and go, or stay', async () => {
  let dropUnsent = false
  const { controller, model } = await opened(bytesModel(), { askUnsent: async () => dropUnsent }, { flushes: false })
  controller.document.applyEdit({ baseVersion: 1, content: { kind: 'bytes', bytes: new Uint8Array([5]).buffer } })
  assert.equal(await controller.prepareToLeave('other-editor', 'bytes'), false, 'Cancel stays')
  assert.equal(controller.session.state().saveError, LEAVE_FLUSH_FAILED)
  dropUnsent = true
  assert.equal(await controller.prepareToLeave('other-editor', 'bytes'), true)
  assert.deepEqual([...(model.get() ?? [])], [5], 'what the editor had handed over stays')

  // A frame that failed is let go: leaving no longer waits on it at all.
  dropUnsent = false
  controller.closeFrame()
  assert.equal(await controller.prepareToLeave('other-editor', 'bytes'), true)
})

test('a file that could not be opened stays an error, and no frame reads it again', async () => {
  const { controller, shown } = await opened(
    bytesModel(),
    {},
    {
      read: { ok: false, code: 'action_failed', message: 'logo.bin is larger than 4 MiB.' },
    },
  )
  assert.equal(controller.session.state().status, 'failed')
  // The view shows the error in the frame's place: the frame closes, and a new one may be put up.
  controller.closeFrame()
  const again = frame()
  controller.openFrame(again.port)
  await settle()
  assert.equal(controller.session.state().status, 'failed')
  assert.deepEqual(
    [...shown.calls, ...again.calls].map((call) => call.method),
    ['files.read'],
  )
})

test('leaving unsaved bytes for an editor of text, or text for one of bytes, asks first', async () => {
  const { controller, asked } = await opened()
  controller.document.applyEdit({ baseVersion: 1, content: { kind: 'bytes', bytes: new Uint8Array([7]).buffer } })
  assert.equal(await controller.prepareToLeave('other-editor', 'bytes'), true, 'another editor of bytes keeps them')
  assert.deepEqual(asked, [])
  assert.equal(await controller.prepareToLeave('other-editor', 'text'), false, 'Cancel stays')
  assert.deepEqual(asked, ['asked'])
})
