// The desktop shell's container for extension frames: a desktop window, on
// its own Studio or a paired one, draws a panel, door or settings section in
// a sandboxed iframe whose document the shell serves from
// `studio-ext://frame/<hash>`.
//
// The window gets the document from its Studio (`extension.frame`) and stages
// it here (`extension-frames:stage`); the shell keeps it only when its bytes
// hash to the name it is staged under, and answers it with the frame's policy
// and sandbox as headers (shared/extension-frames.ts). The scheme serves
// nothing else: no file, no folder of the extension's, nothing it was not
// handed by a window of this app. It is handled on the app windows' session
// only, so no other page this app shows can load it.

import { createHash } from 'node:crypto'

import type { IpcMain, IpcMainInvokeEvent, Protocol } from 'electron'

import {
  EXTENSION_FRAME_HASH_PATTERN,
  EXTENSION_FRAME_SCHEME,
  extensionFrameHeaderCsp,
} from '../../shared/extension-frames'
import { assertAppSender } from '../ipc/ipc-sender'

/** The largest document a window may stage. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const MAX_DOCUMENTS = 32

export type StagedFrames = {
  /** Keep a document under its hash; false when its bytes do not hash to it, or it is too large. */
  stage(hash: unknown, html: unknown): boolean
  get(hash: string): string | undefined
}

export function createStagedFrames(): StagedFrames {
  const documents = new Map<string, string>()
  return {
    stage(hash, html) {
      if (typeof hash !== 'string' || !EXTENSION_FRAME_HASH_PATTERN.test(hash) || typeof html !== 'string') return false
      if (Buffer.byteLength(html, 'utf8') > MAX_DOCUMENT_BYTES) return false
      if (createHash('sha256').update(html, 'utf8').digest('hex') !== hash) return false
      documents.delete(hash)
      documents.set(hash, html)
      while (documents.size > MAX_DOCUMENTS) documents.delete(documents.keys().next().value!)
      return true
    },
    get: (hash) => documents.get(hash),
  }
}

/** The scheme's privileges, registered before the app is ready. */
export const EXTENSION_FRAME_SCHEME_PRIVILEGES = {
  scheme: EXTENSION_FRAME_SCHEME,
  privileges: { standard: true, secure: true },
} as const

/** Answer `studio-ext://frame/<hash>` from what the windows staged. */
export function handleExtensionFrameScheme(protocol: Pick<Protocol, 'handle'>, staged: StagedFrames): void {
  protocol.handle(EXTENSION_FRAME_SCHEME, (request) => {
    let hash = ''
    try {
      const url = new URL(request.url)
      if (url.host === 'frame') hash = url.pathname.replace(/^\//u, '')
    } catch {
      // Not a URL this scheme names: not found below.
    }
    const html = request.method === 'GET' ? staged.get(hash) : undefined
    if (html === undefined) return new Response('not_found', { status: 404 })
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // No `frame-ancestors`: the app's windows are `file:` pages, which no
        // source expression names, and nothing but them can reach the scheme.
        'Content-Security-Policy': extensionFrameHeaderCsp(null),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    })
  })
}

/** A window stages a frame document it got from its Studio. */
export function registerExtensionFrameIpc(ipcMain: Pick<IpcMain, 'handle'>, staged: StagedFrames): void {
  ipcMain.handle('extension-frames:stage', (event: IpcMainInvokeEvent, hash: unknown, html: unknown): boolean => {
    assertAppSender(event)
    return staged.stage(hash, html)
  })
}

/** The process's staged documents. */
export const stagedExtensionFrames: StagedFrames = createStagedFrames()
