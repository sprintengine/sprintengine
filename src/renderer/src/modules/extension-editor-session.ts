// The window's side of a custom editor: the file's document session.
//
// The frame only ever holds the document. This keeps everything else:
//
// - the content, in a model the window shares (for a text file, the same
//   buffer, unsaved flag and disk baseline Studio's text editor uses, so the
//   two views of one file in a window are one document);
// - the version: it rises each time a document is handed to the frame, and an
//   edit made against an older one is refused `conflict` with the document as
//   it is now, so an edit never lands over a change the frame had not seen;
// - reading and saving, through the Studio (`extension.call`'s `files.read`
//   and `files.write`, the same contained path every frame's file calls take,
//   checked as the extension and as this window's connection). A save writes
//   only over the bytes it last read (`expectedSha256`);
// - the file on disk: a change is handed to the frame while the document has
//   no unsaved edits, and is a conflict to resolve while it has.
//
// A save never runs on edits the frame has not handed over: it asks the frame
// first, and stays unsaved when the frame does not answer. A disk read that
// began before the latest write or reload is read again, so an older version
// never replaces a newer one.
//
// Pure: the reads, writes, model and frame are handed in, so a test drives it
// without a window.

import {
  EXTENSION_EDITOR_BYTES_MAX_BYTES,
  EXTENSION_EDITOR_TEXT_MAX_BYTES,
  extensionEditorLimitWords,
} from '../../../../packages/extension-sdk/src/custom-editors'
import { STUDIO_MAX_CLIENT_FRAME_BYTES } from '../../../../packages/studio-protocol/src/public'

/** Text, or the raw bytes of a binary file. */
export type EditorContent = string | Uint8Array

/** The document as the window holds it. */
export type EditorDocumentModel = {
  get(): EditorContent | undefined
  /** `frame`: an edit, so the document has unsaved edits; `disk`: what the file holds, so it has none. */
  set(content: EditorContent, origin: 'frame' | 'disk'): void
  dirty(): boolean
  markClean(): void
  /** What the window last read from disk or wrote there. */
  baseline(): EditorContent | undefined
  setBaseline(content: EditorContent): void
  /** Hear the content change from anywhere (the text editor, a reload). */
  subscribe(listener: () => void): () => void
}

export type EditorRead =
  { ok: true; content: EditorContent; sha256: string } | { ok: false; code: string; message: string }

export type EditorWrite = { ok: true; sha256: string } | { ok: false; code: string; message: string }

/** What the frame is handed. */
export type EditorFrameDocument = {
  version: number
  readOnly: boolean
  content: { kind: 'text'; text: string } | { kind: 'bytes'; bytes: ArrayBuffer }
}

export type EditorConflict = { kind: 'changed'; content: EditorContent; sha256: string } | { kind: 'deleted' }

export type EditorSessionState = {
  status: 'loading' | 'ready' | 'refused' | 'failed'
  /** Why it is refused or failed. */
  message?: string
  dirty: boolean
  saving: boolean
  readOnly: boolean
  /** The file changed or went on disk under unsaved edits. */
  conflict: EditorConflict | null
  /** The last save failed for this reason. */
  saveError: string | null
}

export type EditorSessionOptions = {
  contentKind: 'text' | 'bytes'
  /** Studio will not save it: the extension may not write files. */
  readOnly: boolean
  model: EditorDocumentModel
  read(): Promise<EditorRead>
  write(content: EditorContent, expectedSha256: string | undefined): Promise<EditorWrite>
  /** Hand a document to the frame. */
  post(document: EditorFrameDocument): void
  /** Ask the frame to hand over what it holds back; false when it did not in time. */
  flushFrame(): Promise<boolean>
}

/** What a person is told when a frame kept edits back from a save. */
export const FLUSH_FAILED =
  'The editor did not hand over its latest changes in time, so nothing was saved. Your changes are still here.'

export type EditorEditAnswer =
  { ok: true } | { ok: false; code: string; message: string; document?: EditorFrameDocument }

export type EditorSession = {
  /** Read the file and, once the frame is there, hand it its document. */
  start(): Promise<void>
  /** The frame is ready for its first document (or a new frame replaced it). */
  attachFrame(): void
  /** The frame went away; the document stays, for the next one. */
  detachFrame(): void
  /** Say why something the person asked for did not happen. */
  reportError(message: string): void
  applyEdit(params: unknown): EditorEditAnswer
  /** The file may have changed on disk. */
  diskChanged(): Promise<void>
  save(): Promise<boolean>
  /** Take what is on disk, dropping unsaved edits. */
  reload(): Promise<void>
  /** Write the document over the version on disk the conflict showed. */
  saveOverConflict(): Promise<boolean>
  state(): EditorSessionState
  subscribe(listener: () => void): () => void
  dispose(): void
}

const REFUSALS = new Set(['not_permitted', 'approval_required'])

/** How long before a disk read that writes kept overtaking is tried again. */
const RECHECK_MS = 50

export function sameContent(a: EditorContent | undefined, b: EditorContent | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if (a.byteLength !== b.byteLength) return false
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false
  return true
}

function sizeOf(content: EditorContent): number {
  return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength
}

// A save is one request to the Studio: the content as JSON (bytes in base64),
// and the request around it. Kept under the most a client may send at once.
const REQUEST_MAX_BYTES = STUDIO_MAX_CLIENT_FRAME_BYTES - 16 * 1024

/** Why `content` is too large to open or save in a custom editor, or null. */
export function editorContentTooLarge(content: EditorContent): string | null {
  const kind = typeof content === 'string' ? 'text' : 'bytes'
  const limit = kind === 'text' ? EXTENSION_EDITOR_TEXT_MAX_BYTES : EXTENSION_EDITOR_BYTES_MAX_BYTES
  const fits =
    sizeOf(content) <= limit &&
    (typeof content !== 'string' || new TextEncoder().encode(JSON.stringify(content)).byteLength <= REQUEST_MAX_BYTES)
  return fits
    ? null
    : `An extension’s editor opens and saves files of at most ${extensionEditorLimitWords(kind)}, and this is larger. Open it in the text editor instead.`
}

export function createEditorSession(options: EditorSessionOptions): EditorSession {
  const { model } = options
  let version = 0
  let attached = false
  let disposed = false
  let started = false
  // The bytes on disk the window last read or wrote, for a save's `expectedSha256`.
  let diskSha: string | undefined
  // What the frame holds, so its own edits are not handed back to it.
  let frameHolds: EditorContent | undefined
  // Counted at each write and each reload from disk: a read that began
  // before one of them may hold what the file was, and is read again.
  let diskGeneration = 0
  let current: EditorSessionState = {
    status: 'loading',
    dirty: false,
    saving: false,
    readOnly: options.readOnly,
    conflict: null,
    saveError: null,
  }
  const listeners = new Set<() => void>()
  const update = (patch: Partial<EditorSessionState>) => {
    current = { ...current, ...patch, dirty: model.dirty() }
    for (const listener of [...listeners]) listener()
  }

  const frameDocument = (content: EditorContent): EditorFrameDocument => ({
    version,
    readOnly: options.readOnly,
    content:
      typeof content === 'string'
        ? { kind: 'text', text: content }
        : { kind: 'bytes', bytes: content.slice().buffer as ArrayBuffer },
  })

  const handOver = () => {
    const content = model.get()
    if (disposed || !attached || current.status !== 'ready' || content === undefined) return
    if (frameHolds !== undefined && sameContent(frameHolds, content)) return
    version += 1
    frameHolds = content
    options.post(frameDocument(content))
  }

  // The text editor typed, or a reload replaced the content: the frame hears it.
  const stopModel = model.subscribe(() => {
    handOver()
    if (!disposed) update({})
  })

  const takeDisk = (content: EditorContent, sha256: string) => {
    diskGeneration += 1
    diskSha = sha256
    model.set(content, 'disk')
    model.setBaseline(content)
    model.markClean()
    update({ conflict: null, saveError: null })
    handOver()
  }

  const fromFrame = (raw: unknown): EditorContent | null => {
    const content = raw as { kind?: unknown; text?: unknown; bytes?: unknown } | null
    if (options.contentKind === 'text')
      return content?.kind === 'text' && typeof content.text === 'string' ? content.text : null
    return content?.kind === 'bytes' && Object.prototype.toString.call(content.bytes) === '[object ArrayBuffer]'
      ? new Uint8Array((content.bytes as ArrayBuffer).slice(0))
      : null
  }

  /** A disk read no write or reload overtook while it was on its way. */
  // Null when writes kept overtaking it: what it read is dropped, and the
  // caller looks again a moment later rather than apply an older version.
  async function readSettled(): Promise<EditorRead | null> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const generation = diskGeneration
      const read = await options.read()
      if (generation === diskGeneration) return read
    }
    return null
  }

  let recheck: ReturnType<typeof setTimeout> | null = null
  const checkAgain = (afterRefusedSave: boolean) => {
    if (recheck !== null || disposed) return
    recheck = setTimeout(() => {
      recheck = null
      void diskChanged(afterRefusedSave)
    }, RECHECK_MS)
  }

  async function write(content: EditorContent, expected: string | undefined): Promise<EditorWrite> {
    const first = await options.write(content, expected)
    if (first.ok || first.code !== 'conflict') return first
    // The sha this window holds may be older than the file while the file
    // still holds what the window believes: the text editor saved it, or
    // the same content was written again. Then write against what is there.
    const read = await options.read()
    if (read.ok && sameContent(read.content, model.baseline())) return options.write(content, read.sha256)
    return first
  }

  async function saveContent(content: EditorContent, expected: string | undefined): Promise<boolean> {
    const tooLarge = editorContentTooLarge(content)
    if (tooLarge) {
      update({ saveError: tooLarge })
      return false
    }
    update({ saving: true, saveError: null })
    const written = await write(content, expected)
    if (disposed) return false
    if (written.ok) {
      diskGeneration += 1
      diskSha = written.sha256
      model.setBaseline(content)
      if (sameContent(model.get(), content)) model.markClean()
      update({ saving: false, conflict: null })
      return true
    }
    if (written.code === 'conflict') {
      update({ saving: false })
      await diskChanged(true)
      return false
    }
    update({ saving: false, saveError: written.message })
    return false
  }

  /** Ask the frame for what it holds back; say so and stop when it does not answer. */
  async function flushed(): Promise<boolean> {
    if (await options.flushFrame()) return true
    if (!disposed) update({ saveError: FLUSH_FAILED })
    return false
  }

  async function diskChanged(afterRefusedSave = false): Promise<void> {
    if (disposed || current.status !== 'ready') return
    const read = await readSettled()
    if (disposed) return
    if (read === null) return checkAgain(afterRefusedSave)
    if (!read.ok) {
      if (read.code === 'missing') update({ conflict: { kind: 'deleted' } })
      // A save was refused because the file changed, and what it changed to cannot be read.
      else if (afterRefusedSave) update({ saveError: read.message })
      return
    }
    const tooLarge = editorContentTooLarge(read.content)
    if (tooLarge) {
      update({ saveError: tooLarge })
      return
    }
    const content = model.get()
    if (sameContent(read.content, content)) {
      diskSha = read.sha256
      model.setBaseline(read.content)
      if (model.dirty()) model.markClean()
      update({ conflict: null })
      return
    }
    if (!model.dirty()) return takeDisk(read.content, read.sha256)
    if (!afterRefusedSave && sameContent(read.content, model.baseline())) {
      diskSha = read.sha256
      if (current.conflict) update({ conflict: null })
      return
    }
    update({ conflict: { kind: 'changed', content: read.content, sha256: read.sha256 } })
  }

  return {
    async start() {
      // Once per document: a frame drawn again finds it as it was, a
      // terminal failure included, and nothing is read twice for it.
      if (started) return
      started = true
      const read = await options.read()
      if (disposed) return
      if (!read.ok) {
        update({ status: REFUSALS.has(read.code) ? 'refused' : 'failed', message: read.message })
        return
      }
      const tooLarge = editorContentTooLarge(read.content)
      if (tooLarge) {
        update({ status: 'failed', message: tooLarge })
        return
      }
      diskSha = read.sha256
      const held = model.get()
      if (held === undefined || !model.dirty()) {
        model.set(read.content, 'disk')
        model.setBaseline(read.content)
        model.markClean()
        update({ status: 'ready' })
      } else {
        // Unsaved edits made before this view opened (the text editor's, or
        // another editor's of the same file) stay.
        update({ status: 'ready' })
        if (!sameContent(read.content, held) && !sameContent(read.content, model.baseline()))
          update({ conflict: { kind: 'changed', content: read.content, sha256: read.sha256 } })
      }
      handOver()
    },
    attachFrame() {
      attached = true
      frameHolds = undefined
      handOver()
    },
    detachFrame() {
      attached = false
      frameHolds = undefined
    },
    reportError(message) {
      if (!disposed) update({ saveError: message })
    },
    applyEdit(params) {
      const edit = params as { baseVersion?: unknown; content?: unknown } | null
      if (current.status !== 'ready' || !attached || frameHolds === undefined)
        return { ok: false, code: 'unavailable', message: 'The document is not open yet.' }
      if (options.readOnly) return { ok: false, code: 'not_permitted', message: 'This document is read only.' }
      const content = fromFrame(edit?.content)
      if (typeof edit?.baseVersion !== 'number' || content === null)
        return {
          ok: false,
          code: 'invalid_params',
          message: `An edit is { baseVersion, content } with ${options.contentKind} content.`,
        }
      const tooLarge = editorContentTooLarge(content)
      if (tooLarge) return { ok: false, code: 'too_large', message: tooLarge }
      if (edit.baseVersion !== version)
        return {
          ok: false,
          code: 'conflict',
          message: 'The file changed outside this editor; edit the latest document.',
          document: frameDocument(frameHolds),
        }
      frameHolds = content
      if (!sameContent(model.get(), content)) model.set(content, 'frame')
      // The unsaved flag may move after the content's own listeners ran.
      update({})
      return { ok: true }
    },
    diskChanged: () => diskChanged(),
    async save() {
      if (options.readOnly || current.status !== 'ready' || current.saving) return false
      if (!(await flushed())) return false
      const content = model.get()
      if (content === undefined || !model.dirty()) return true
      // A file gone from disk is written back, as the text editor does.
      if (current.conflict?.kind === 'deleted') return saveContent(content, undefined)
      // Changed on disk: the person chooses first, to reload or to save over it.
      if (current.conflict) return false
      return saveContent(content, diskSha)
    },
    async reload() {
      const read = await readSettled()
      if (disposed) return
      if (read === null) {
        update({ saveError: 'The file kept changing while it was read. Try again.' })
        return
      }
      if (!read.ok) {
        if (read.code === 'missing') update({ conflict: { kind: 'deleted' } })
        else update({ saveError: read.message })
        return
      }
      const tooLarge = editorContentTooLarge(read.content)
      if (tooLarge) update({ saveError: tooLarge })
      else takeDisk(read.content, read.sha256)
    },
    async saveOverConflict() {
      const conflict = current.conflict
      if (!conflict || options.readOnly || current.saving) return false
      if (!(await flushed())) return false
      const content = model.get()
      if (content === undefined) return false
      return saveContent(content, conflict.kind === 'changed' ? conflict.sha256 : undefined)
    },
    state: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      if (recheck !== null) clearTimeout(recheck)
      stopModel()
      listeners.clear()
    },
  }
}

/** A model the session alone holds: a binary file's bytes, which no other view of the window edits. */
export function createLocalDocumentModel(): EditorDocumentModel {
  let content: EditorContent | undefined
  let baseline: EditorContent | undefined
  let dirty = false
  const listeners = new Set<() => void>()
  return {
    get: () => content,
    set(next, origin) {
      content = next
      if (origin === 'frame') dirty = true
      for (const listener of [...listeners]) listener()
    },
    dirty: () => dirty,
    markClean() {
      dirty = false
    },
    baseline: () => baseline,
    setBaseline(next) {
      baseline = next
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Bytes as base64, for `files.write`'s `encoding: 'base64'`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.byteLength; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/** `files.read`'s base64 back to bytes. */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
