// One custom editor open on one file in this window: its document session,
// the frames that come and go in front of it, and what has to happen before
// the person leaves it.
//
// The session belongs here, not to a frame. A frame drawn again (the
// extension's access grew, the tab moved) finds the document as it was,
// and a file that could not be opened stays an error rather than being read
// again by every frame that is put up to show it.
//
// Leaving (Open with…, closing the tab, drawing the frame again) first asks
// the frame for the edits it holds back. A frame that does not answer keeps
// the person where they are, with the reason. A binary document cannot be
// shown by the text editor, so leaving for it, or closing the tab, while it
// has unsaved edits asks first: save, discard, or stay.

import type { StudioExtensionCallAnswer } from '../../../../packages/studio-protocol/src/public'
import { EXTENSION_EDITOR_FLUSH_TIMEOUT_MS } from '../../../../packages/extension-sdk/src/custom-editors'
import type { ExtensionFrameDocumentChannel } from './extension-frame-host'
import {
  createEditorSession,
  type EditorDocumentModel,
  type EditorRead,
  type EditorSession,
} from './extension-editor-session'
import { base64ToBytes, bytesToBase64 } from './extension-editor-session'

/** What a frame in front of the editor reaches the window and the Studio through. */
export type ExtensionEditorPort = {
  /** A host call as this frame's (`extension.call`, naming its document): `files.read` and `files.write`. */
  call(method: string, params: unknown): Promise<StudioExtensionCallAnswer>
  sendDocument(document: unknown): void
  requestFlush(id: number): void
}

/** Where the person is going: another view of the same file, or away from it. */
export type ExtensionEditorLeaving = 'text-editor' | 'other-editor' | 'close' | 'redraw'

/** Save, throw the unsaved edits away, or stay. */
export type UnsavedChoice = 'save' | 'discard' | 'stay'

export type ExtensionEditorControllerOptions = {
  workspaceId: string
  /** The file, relative to the workspace's folder. */
  relativePath: string
  contentKind: 'text' | 'bytes'
  readOnly: boolean
  model: EditorDocumentModel
  /** Put the file back to what is on disk (a binary document's discard). */
  discard(): void
  /** Ask the person what to do with unsaved edits the next view cannot show. */
  askUnsaved(): Promise<UnsavedChoice>
  flushTimeoutMs?: number
}

export type ExtensionEditorController = {
  session: EditorSession
  /** What a frame mounted in front of the editor speaks to. */
  document: ExtensionFrameDocumentChannel
  /** A frame's document was built: reads and saves go through it. */
  openFrame(port: ExtensionEditorPort): void
  /** The frame is listening for its document. */
  frameReady(): void
  /** The frame went away; the session stays. */
  closeFrame(): void
  /** True when the person may leave the editor for `where` now. */
  prepareToLeave(where: ExtensionEditorLeaving): Promise<boolean>
  dispose(): void
}

const NO_FRAME: EditorRead = { ok: false, code: 'unavailable', message: 'The editor is not drawn yet.' }
export const LEAVE_FLUSH_FAILED =
  'The editor did not hand over its latest changes in time, so it stays open. Try again in a moment.'

export function createExtensionEditorController(options: ExtensionEditorControllerOptions): ExtensionEditorController {
  let port: ExtensionEditorPort | null = null
  let nextFlush = 1
  const flushes = new Map<number, (ok: boolean) => void>()
  const timeoutMs = options.flushTimeoutMs ?? EXTENSION_EDITOR_FLUSH_TIMEOUT_MS
  const { workspaceId, relativePath, contentKind } = options

  const read = async (): Promise<EditorRead> => {
    if (!port) return NO_FRAME
    const answer = await port.call('files.read', {
      workspaceId,
      path: relativePath,
      encoding: contentKind === 'bytes' ? 'base64' : 'utf8',
    })
    if (!answer.ok) return { ok: false, code: answer.code, message: answer.message }
    const result = answer.result as { content: string; sha256: string }
    return {
      ok: true,
      content: contentKind === 'bytes' ? base64ToBytes(result.content) : result.content,
      sha256: result.sha256,
    }
  }

  const flushFrame = (): Promise<boolean> => {
    // No frame in front: nothing is held back anywhere.
    if (!port) return Promise.resolve(true)
    const asked = port
    return new Promise<boolean>((resolve) => {
      const id = nextFlush++
      const timer = setTimeout(() => settle(false), timeoutMs)
      const settle = (ok: boolean) => {
        clearTimeout(timer)
        flushes.delete(id)
        resolve(ok)
      }
      flushes.set(id, settle)
      asked.requestFlush(id)
    })
  }

  const session = createEditorSession({
    contentKind,
    readOnly: options.readOnly,
    model: options.model,
    read,
    write: async (content, expected) => {
      if (!port) return { ok: false, code: 'unavailable', message: 'The editor is not drawn, so nothing was saved.' }
      const answer = await port.call('files.write', {
        workspaceId,
        path: relativePath,
        ...(typeof content === 'string'
          ? { content }
          : { content: bytesToBase64(content), encoding: 'base64' as const }),
        ...(expected ? { expectedSha256: expected } : {}),
      })
      return answer.ok ? { ok: true, sha256: (answer.result as { sha256: string }).sha256 } : answer
    },
    post: (document) => port?.sendDocument(document),
    flushFrame,
  })

  const settleFlushes = (ok: boolean) => {
    for (const settle of [...flushes.values()]) settle(ok)
  }

  return {
    session,
    document: {
      applyEdit: (params) => session.applyEdit(params),
      flushed: (id, ok) => flushes.get(id)?.(ok),
      save: () => void session.save(),
    },
    openFrame(next) {
      port = next
      void session.start()
    },
    frameReady: () => session.attachFrame(),
    closeFrame() {
      port = null
      session.detachFrame()
      settleFlushes(false)
    },
    async prepareToLeave(where) {
      const state = session.state()
      // Nothing to keep: a file that never opened, or a frame not yet drawn.
      if (state.status !== 'ready') return true
      if (!(await flushFrame())) {
        session.reportError(LEAVE_FLUSH_FAILED)
        return false
      }
      const keeps = contentKind === 'text' || where === 'other-editor' || where === 'redraw'
      if (keeps || !options.model.dirty()) return true
      const choice = await options.askUnsaved()
      if (choice === 'stay') return false
      if (choice === 'discard') {
        options.discard()
        return true
      }
      return session.save()
    },
    dispose() {
      settleFlushes(false)
      port = null
      session.dispose()
    },
  }
}
