import type { ExtensionContent } from '../../../../../packages/studio-protocol/src/public'
import type { ExtensionSyntaxContribution } from '../../../../shared/modules/third-party-manifest'
import { extensionsApi, windowHasStudio } from '../../studio/extensions'

// The languages the window's extensions contribute (`contributes.syntaxes`),
// as the window's Studio serves them. A chat code block whose fence names one
// (its id, or one of its file suffixes without the dot) and a file the editor
// opens whose name or suffix one claims are highlighted with its TextMate
// grammar, in the grammar worker (grammarHost.ts), for chat code blocks and
// the editor alike. The grammar itself is fetched once, the first time
// something needs it, from the Studio (`extension.content`), which read and
// checked it; the window never reads the extension's folder.
//
// An extension never takes a fence, an alias or a file suffix Studio's own
// grammars already highlight (codeHighlight.ts, utils/files.ts): it adds
// languages, it does not replace them.

export type ContributedSyntax = {
  /** The language's name in the highlighter and the editor: `ext.<install key>.<id>`. */
  language: string
  extensionId: string
  extensionName: string
  syntax: ExtensionSyntaxContribution
}

export type ContributedSyntaxContent = Extract<ExtensionContent, { kind: 'syntax' }>

let syntaxes: readonly ContributedSyntax[] = []
let enabled: (extensionId: string) => boolean = () => true
let version = 0
const listeners = new Set<() => void>()
const contents = new Map<string, Promise<ContributedSyntaxContent>>()

/** The syntaxes the served extensions contribute, replacing the last list. */
export function setContributedSyntaxes(
  next: ReadonlyArray<{ extensionId: string; extensionName: string; syntaxes: readonly ExtensionSyntaxContribution[] }>,
  isEnabled: (extensionId: string) => boolean = () => true,
): void {
  syntaxes = next.flatMap(({ extensionId, extensionName, syntaxes: declared }) =>
    declared.map((syntax) => ({ language: `ext.${extensionId}.${syntax.id}`, extensionId, extensionName, syntax })),
  )
  enabled = isEnabled
  version += 1
  for (const listener of [...listeners]) listener()
}

export function subscribeContributedSyntaxes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function contributedSyntaxesVersion(): number {
  return version
}

/** Every syntax of an extension switched on now. */
export function activeContributedSyntaxes(): ContributedSyntax[] {
  return syntaxes.filter((entry) => enabled(entry.extensionId))
}

export function contributedSyntax(language: string): ContributedSyntax | undefined {
  return activeContributedSyntaxes().find((entry) => entry.language === language)
}

// Ties go to the lower language name, so the winner does not depend on the
// order the extensions were served in.
function byName(a: ContributedSyntax, b: ContributedSyntax): number {
  return a.language < b.language ? -1 : a.language > b.language ? 1 : 0
}

/** The syntax a chat code fence names: its id, or one of its suffixes without the dot. */
export function contributedSyntaxForFence(fence: string): ContributedSyntax | undefined {
  const name = fence.trim().toLowerCase()
  if (!name) return undefined
  return activeContributedSyntaxes()
    .filter(
      (entry) =>
        entry.syntax.id === name ||
        (entry.syntax.extensions ?? []).some((suffix) => suffix.slice(1).toLowerCase() === name),
    )
    .sort(byName)[0]
}

/** The syntax a file opens in: an exact name first, then the longest suffix; never a name alone as a suffix. */
export function contributedSyntaxForFile(path: string): ContributedSyntax | undefined {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (!name) return undefined
  const active = activeContributedSyntaxes()
  const exact = active
    .filter((entry) => (entry.syntax.filenames ?? []).some((candidate) => candidate.toLowerCase() === name))
    .sort(byName)[0]
  if (exact) return exact
  let best: { entry: ContributedSyntax; length: number } | undefined
  for (const entry of [...active].sort(byName)) {
    for (const suffix of entry.syntax.extensions ?? []) {
      const lower = suffix.toLowerCase()
      if (name.length > lower.length && name.endsWith(lower) && (!best || lower.length > best.length))
        best = { entry, length: lower.length }
    }
  }
  return best?.entry
}

/** A syntax's grammar and configuration, fetched from the Studio once. */
export function contributedSyntaxContent(entry: ContributedSyntax): Promise<ContributedSyntaxContent> {
  let promise = contents.get(entry.language)
  if (!promise) {
    promise = extensionsApi
      .extensionContent({ moduleId: entry.extensionId, kind: 'syntax', id: entry.syntax.id })
      .then((content) => {
        if (content.kind !== 'syntax') throw new Error('The Studio served something other than a syntax.')
        return content
      })
    // A failed fetch is tried again the next time something needs it.
    promise.catch(() => contents.delete(entry.language))
    contents.set(entry.language, promise)
  }
  return promise
}

/**
 * For a window without the module boot (an editor or diff window of its own):
 * the served extensions' languages, listed now and again whenever what is
 * installed changes. A switched-off extension's language is listed and its
 * grammar refused by the Studio, so its files stay plain.
 */
export function followServedSyntaxes(): () => void {
  if (!windowHasStudio()) return () => undefined
  const load = () =>
    extensionsApi
      .listExtensionContributions()
      .then((served) =>
        setContributedSyntaxes(
          served.extensions.map((entry) => ({
            extensionId: entry.id,
            extensionName: entry.extension.name,
            syntaxes: entry.extension.contributes.syntaxes,
          })),
        ),
      )
      .catch(() => undefined)
  void load()
  return extensionsApi.onThirdPartyModulesChanged(() => void load())
}
