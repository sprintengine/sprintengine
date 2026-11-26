// What a web tab and the server's web front door agree on beyond the
// protocol: which bundle a page is. What a tab asks of its Studio is the
// Studio protocol's (`webDevices.*`, `webFolders.browse`, `webPreviews.*`),
// where its shapes are defined. Embeds are minted by `studio-server embed` alone.

export type {
  FolderBrowserEntry,
  FolderBrowserListing,
  PreviewOpenAnswer,
  PreviewPort,
  PreviewSummary,
  WebDevice,
  WebDevicesStatus,
  WebPairRequest,
} from '../../packages/studio-protocol/src/public'

// Which web bundle a page is (phase 9 spec, 3.5 and 14.11). The web build
// writes one id into every page it makes, as this meta; the server answers the
// id of the bundle it serves now in `/api/session`. A tab whose own id differs
// was loaded from a bundle the server no longer has: its next lazy chunk may
// be gone, so it offers a reload.
export const WEB_BUILD_META = 'sprintengine-web-build'

/** The build id a page carries, read from its HTML; null when it carries none. */
export function webBuildIdOf(html: string): string | null {
  const match = new RegExp(`<meta name="${WEB_BUILD_META}" content="([A-Za-z0-9._-]{1,80})"`, 'u').exec(html)
  return match ? match[1] : null
}
