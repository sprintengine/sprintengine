import type { StudioCatalogueListing } from '../../../../../packages/studio-protocol/src/public'

// What Browse shows of a catalogue, without the DOM: searching and filtering
// its listings, and the words for what an extension adds and how it runs.

/** A listing matches when every word of the query is in its name, id, publisher or description. */
export function listingMatches(listing: StudioCatalogueListing, query: string, category: string | null): boolean {
  if (category && !listing.categories.includes(category)) return false
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [listing.name, listing.id, listing.publisher, listing.description ?? '', ...listing.categories]
    .join(' ')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** Every category the listings name, most used first, then by name. */
export function listingCategories(listings: readonly StudioCatalogueListing[]): string[] {
  const counts = new Map<string, number>()
  for (const listing of listings)
    for (const category of listing.categories) counts.set(category, (counts.get(category) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category]) => category)
}

const CONTRIBUTION_WORDS: Record<string, string> = {
  commands: 'Command',
  menus: 'Menu item',
  topBarItems: 'Top bar item',
  panels: 'Panel',
  doors: 'Door',
  settingsSections: 'Settings section',
  mcpTools: 'Tool for agents',
  hooks: 'Agent hook',
  syntaxes: 'Syntax highlighting',
  customEditors: 'Editor',
  keybindings: 'Keyboard shortcut',
  statusBarItems: 'Status bar item',
  settings: 'Setting',
  skills: 'Skill',
  mcpServers: 'MCP server',
  providers: 'Model provider',
}

/** What one listed contribution is, in words. */
export function contributionWords(kind: string): string {
  return CONTRIBUTION_WORDS[kind] ?? kind
}

/** How an extension of this tier runs, said plainly; a worker's code has full access. */
export function tierWords(tier: StudioCatalogueListing['tier']): string {
  switch (tier) {
    case 'content':
      return 'Content only: nothing runs.'
    case 'declarative':
      return 'Declarative: it adds what its extension.json says, and runs no code of its own in Studio.'
    case 'ui':
      return 'Draws its own surfaces in sandboxed frames.'
    case 'worker':
      return 'Runs code on this machine, in a process of its own, with full access to your account here.'
  }
}

/** What a listing's install button says, or why there is none. */
export function installState(
  listing: Pick<StudioCatalogueListing, 'installed' | 'installable' | 'needsStudio' | 'killed' | 'version'>,
):
  | { kind: 'install' }
  | { kind: 'installed' }
  | { kind: 'update'; version: string }
  | { kind: 'elsewhere' }
  | { kind: 'blocked'; words: string } {
  if (listing.killed) return { kind: 'blocked', words: 'Removed by Studio’s kill list' }
  if (listing.installed && !listing.installed.fromHere) return { kind: 'elsewhere' }
  if (!listing.installable) return { kind: 'blocked', words: `Needs Studio ${listing.needsStudio ?? 'newer'}` }
  if (!listing.installed) return { kind: 'install' }
  return listing.installed.version === listing.version
    ? { kind: 'installed' }
    : { kind: 'update', version: listing.version }
}
