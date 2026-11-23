import { isAllowedGitUrl, isReservedInstallKey } from '../../packages/extension-sdk/src/catalogue'
import { isExtensionInstallKey } from '../../packages/extension-sdk/src/extension-manifest'

// An install link: `sprintengine://extensions/<publisher>.<id>?catalog=…`. It
// opens the extension's page in Settings → Extensions and never installs: the
// person reads the page and presses Install, and the usual review applies.
//
// - `catalog` is `official` (the default), `community`, or an HTTPS or SSH git
//   URL of a catalogue, at most 512 characters, with no password or token. A
//   catalogue the person has not added is asked about before it is read.
// - A reserved publisher or id is accepted only with the official catalogue.
// - A link longer than 2048 characters, with another query parameter, or
//   whose id is not `<publisher>.<id>`, is refused with a short message.

export const EXTENSION_LINK_MAX_LENGTH = 2048
const CATALOGUE_URL_MAX_LENGTH = 512
const PREFIX = 'sprintengine://extensions'

/** Main to a workspace window: open this extension's page. */
export const EXTENSION_LINK_OPEN_CHANNEL = 'extension-link:open'
/** A workspace window to main: it is listening for extension links. */
export const EXTENSION_LINK_READY_CHANNEL = 'extension-link:ready'

export type ExtensionInstallLink =
  | {
      ok: true
      /** The install key. */
      id: string
      /** The catalogue's id as Studio names it: `official`, `community`, or `git:<url>`. */
      catalogue: string
    }
  | { ok: false; message: string }

/** Whether a launch argument or URL is shaped like an install link, valid or not. */
export function isExtensionInstallLinkArgument(value: string): boolean {
  const head = value
    .trim()
    .slice(0, PREFIX.length + 1)
    .toLowerCase()
  return head === `${PREFIX}/` || head === `${PREFIX}?`
}

/** The first install link among a launch's arguments, the way Windows and Linux hand one over. */
export function extensionLinkFromArgv(argv: readonly string[]): string | null {
  const value = argv.find(isExtensionInstallLinkArgument)
  // One past the cap: an oversized link must still be refused, not trimmed into a valid one.
  return value ? value.trim().slice(0, EXTENSION_LINK_MAX_LENGTH + 1) : null
}

const refused = (message: string): ExtensionInstallLink => ({ ok: false, message })

export function parseExtensionInstallLink(value: string): ExtensionInstallLink {
  const malformed = 'That extension link is not one Studio can open.'
  if (value.length > EXTENSION_LINK_MAX_LENGTH) return refused('That extension link is too long.')
  if (!isExtensionInstallLinkArgument(value)) return refused(malformed)
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return refused(malformed)
  }
  const match = /^\/([^/]+)\/?$/.exec(url.pathname)
  let id = ''
  try {
    id = match ? decodeURIComponent(match[1]!) : ''
  } catch {
    return refused(malformed)
  }
  if (url.hostname !== 'extensions' || url.hash || !isExtensionInstallKey(id))
    return refused('That extension link does not name an extension as <publisher>.<id>.')
  const keys = [...url.searchParams.keys()]
  if (keys.some((key) => key !== 'catalog') || url.searchParams.getAll('catalog').length > 1) return refused(malformed)
  const raw = url.searchParams.get('catalog')
  let catalogue: string
  if (raw === null || raw === 'official') catalogue = 'official'
  else if (raw === 'community') catalogue = 'community'
  else if (raw.length <= CATALOGUE_URL_MAX_LENGTH && isAllowedGitUrl(raw)) catalogue = `git:${raw.trim()}`
  else return refused('That extension link names a catalogue that is not an HTTPS or SSH git URL.')
  // A reserved name from any other catalogue is a spoof.
  if (catalogue !== 'official' && isReservedInstallKey(id))
    return refused(`${id} is a name only Studio’s official catalogue lists.`)
  return { ok: true, id, catalogue }
}
