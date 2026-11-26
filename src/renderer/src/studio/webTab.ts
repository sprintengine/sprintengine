import {
  STUDIO_WEB_TAB_CAPABILITY,
  type FolderBrowserListing,
  type PreviewOpenAnswer,
  type PreviewPort,
  type PreviewSummary,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// What a web tab asks of the Studio that served it (`webFolders.browse`,
// `webPreviews.*`, and the `webPreviews.changed` stream), over the tab's own
// connection. Each is an owner's, and shown only to a browser on the server's
// loopback. Only a Studio running the web listener offers `web-tab`; a desktop
// window's runs none, and draws the native browser pane instead.

function commandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function served() {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_WEB_TAB_CAPABILITY)) throw new Error('This Studio runs no web listener.')
  return client
}

/** The loopback name this tab was opened on: its previews open on the same one. */
function loopbackName(): '127.0.0.1' | 'localhost' {
  return typeof window !== 'undefined' && window.location.hostname === 'localhost' ? 'localhost' : '127.0.0.1'
}

/** One folder on the server's machine, for the dialog that stands in for the native folder picker. */
export async function browseServerFolders(input: {
  path?: string
  showHidden?: boolean
}): Promise<FolderBrowserListing> {
  return (await served()).request('webFolders.browse', input)
}

/** The ports the server's agents listen on, offered for a preview. */
export async function listPreviewPorts(): Promise<{ ports: PreviewPort[] }> {
  return (await served()).request('webPreviews.list', {})
}

export async function openPreview(input: { port: number; typed?: boolean }): Promise<PreviewOpenAnswer> {
  return (await served()).request('webPreviews.open', { ...input, host: loopbackName(), commandId: commandId() })
}

export async function closePreview(previewId: string): Promise<boolean> {
  return (await (await served()).request('webPreviews.close', { previewId, commandId: commandId() })).closed
}

/**
 * This browser's open previews, whole, as they change; kept across
 * reconnects. The stream sends the list as it stands each time it is
 * followed, so nothing is read again on a reopen.
 */
export function onPreviewsChanged(cb: (previews: PreviewSummary[]) => void): () => void {
  return followWindowStudioPush({
    topic: 'webPreviews.changed',
    params: {},
    capability: STUDIO_WEB_TAB_CAPABILITY,
    onPayload: cb,
  })
}
