import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

// Right-click inside a web page in the browser pane. Electron draws no context
// menu of its own: a guest (and a sign-in popup it opens) shows one only when
// something answers its `context-menu` event, so without this a right-click on
// a page did nothing at all — no Copy, no Paste, no spelling suggestions.
//
// The template is built here, apart from Electron's `Menu`, so what the menu
// offers is testable; `browser-manager.ts` focuses the page and pops it up.

/** What the menu's own items do to the page they were opened on. */
export type GuestMenuTarget = {
  replaceMisspelling(word: string): void
  copyImageAt(x: number, y: number): void
}

type GuestMenuParams = Pick<
  ContextMenuParams,
  'x' | 'y' | 'misspelledWord' | 'dictionarySuggestions' | 'linkURL' | 'mediaType' | 'editFlags'
>

/** At most this many spelling suggestions, as the system menus show. */
const MAX_SUGGESTIONS = 5

export function guestContextMenuTemplate(
  params: GuestMenuParams,
  target: GuestMenuTarget,
  copyText: (text: string) => void,
): MenuItemConstructorOptions[] {
  const sections: MenuItemConstructorOptions[][] = []

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
    sections.push(
      suggestions.length > 0
        ? suggestions.map((word) => ({ label: word, click: () => target.replaceMisspelling(word) }))
        : [{ label: 'No Guesses Found', enabled: false }],
    )
  }

  const linkSection: MenuItemConstructorOptions[] = []
  if (params.mediaType === 'image') {
    linkSection.push({ label: 'Copy Image', click: () => target.copyImageAt(params.x, params.y) })
  }
  // Only a web link: a `javascript:` or `data:` URL is not something to hand on.
  if (/^https?:\/\//iu.test(params.linkURL)) {
    linkSection.push({ label: 'Copy Link', click: () => copyText(params.linkURL) })
  }
  // A mail link hands on the address alone: pasted into a mail field,
  // `mailto:dev@example.com?subject=Hi` is not an address.
  const address = mailtoAddress(params.linkURL)
  if (address) linkSection.push({ label: 'Copy Email Address', click: () => copyText(address) })
  if (linkSection.length > 0) sections.push(linkSection)

  const flags = params.editFlags
  sections.push([
    { role: 'cut', enabled: flags.canCut },
    { role: 'copy', enabled: flags.canCopy },
    { role: 'paste', enabled: flags.canPaste },
    { role: 'selectAll', enabled: flags.canSelectAll },
  ])

  return sections.flatMap((section, index) => (index === 0 ? section : [{ type: 'separator' as const }, ...section]))
}

function mailtoAddress(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'mailto:' || url.pathname === '') return null
  try {
    return decodeURIComponent(url.pathname)
  } catch {
    return url.pathname
  }
}
