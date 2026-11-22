import { createHash } from 'crypto'
import { readFile, stat } from 'fs/promises'

import type { ExtensionContent, StudioExtensionContentRequest } from '../../../packages/studio-protocol/src/public'
import {
  GRAMMAR_MAX_BYTES,
  LANGUAGE_CONFIGURATION_MAX_BYTES,
  parseLanguageConfiguration,
  parseTextMateGrammar,
} from '../../../packages/extension-sdk/src/content-syntaxes'
import type { ExtensionManifest } from '../../shared/modules/third-party-manifest'
import { resolveContainedEntry } from './entry-containment'
import { isExtensionRunnable } from './module-signature'
import type { InstalledModule } from './user-module-registry'

// What a content extension adds, served to every client the same way a frame
// is (`extension.content`): the file its extension.json names, read now from
// its folder, held to the bytes the extension was verified with, and checked
// again (a grammar's keys, types, depth and size) before any of it leaves the
// server. A client never reads an extension's folder: it gets the checked
// data, never a path. Same gate as a frame: only an extension that may run as
// it is now. The same checks refuse an install whose files fail them
// (`contentFileIssues`).

export type ContentAnswer = { ok: true; content: ExtensionContent } | { ok: false; message: string }

type Issue = { path: string; message: string }

function firstProblem(path: string, issues: readonly Issue[]): string {
  const first = issues[0]
  return `${path}${first?.path ? ` (${first.path})` : ''}: ${first?.message ?? 'is not valid.'}`
}

/** A file the extension ships, read once and held to its verified digest. */
async function readVerifiedText(
  installed: InstalledModule,
  path: string,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const expected = installed.standing.verifiedFiles?.[path]
  if (expected === undefined) return { ok: false, message: `${path} is not among the extension’s verified files.` }
  let absolute: string
  try {
    absolute = resolveContainedEntry(installed.moduleRoot, path, path)
  } catch {
    return { ok: false, message: `${path} is not inside the extension.` }
  }
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return { ok: false, message: `${path} is not a file.` }
    if (info.size > maxBytes)
      return { ok: false, message: `${path} is larger than ${Math.round(maxBytes / 1024)} KiB.` }
    // The bytes used are the bytes hashed: read once, checked, then used.
    const bytes = await readFile(absolute)
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      return { ok: false, message: `${path} changed after the extension was verified, so it was not used.` }
    return { ok: true, text: bytes.toString('utf8') }
  } catch {
    return { ok: false, message: `${path} could not be read.` }
  }
}

/** One piece of content an installed extension contributes, checked, or why it is not served. */
export async function readExtensionContent(
  installed: InstalledModule,
  request: Pick<StudioExtensionContentRequest, 'kind' | 'id'>,
): Promise<ContentAnswer> {
  if (!isExtensionRunnable(installed.standing))
    return { ok: false, message: `Extension "${installed.key}" may not run as it is now.` }
  const syntax = installed.extension.contributes.syntaxes.find((candidate) => candidate.id === request.id)
  if (!syntax) return { ok: false, message: `Extension "${installed.key}" has no syntax "${request.id}".` }
  const file = await readVerifiedText(installed, syntax.path, GRAMMAR_MAX_BYTES)
  if (!file.ok) return file
  const grammar = parseTextMateGrammar(file.text, syntax.scopeName)
  if (!grammar.ok) return { ok: false, message: firstProblem(syntax.path, grammar.issues) }
  if (syntax.configuration === undefined) return { ok: true, content: { kind: 'syntax', grammar: grammar.grammar } }
  const configurationFile = await readVerifiedText(installed, syntax.configuration, LANGUAGE_CONFIGURATION_MAX_BYTES)
  if (!configurationFile.ok) return configurationFile
  const configuration = parseLanguageConfiguration(configurationFile.text)
  if (!configuration.ok) return { ok: false, message: firstProblem(syntax.configuration, configuration.issues) }
  return {
    ok: true,
    content: { kind: 'syntax', grammar: grammar.grammar, configuration: configuration.configuration },
  }
}

/**
 * What is wrong with the content files a manifest names, read by `read` (a
 * path inside the extension, or null when it is not there): each grammar and
 * language configuration, as Studio will check them when it serves them.
 */
export async function contentFileIssues(
  extension: Pick<ExtensionManifest, 'contributes'>,
  read: (path: string, maxBytes: number) => Promise<string | null>,
): Promise<Issue[]> {
  const issues: Issue[] = []
  for (const [index, syntax] of extension.contributes.syntaxes.entries()) {
    const at = `contributes.syntaxes[${index}]`
    const text = await read(syntax.path, GRAMMAR_MAX_BYTES)
    if (text === null)
      issues.push({ path: `${at}.path`, message: `names ${syntax.path}, which is missing or too large.` })
    else {
      const grammar = parseTextMateGrammar(text, syntax.scopeName)
      if (!grammar.ok) issues.push({ path: `${at}.path`, message: firstProblem(syntax.path, grammar.issues) })
    }
    if (syntax.configuration === undefined) continue
    const configuration = await read(syntax.configuration, LANGUAGE_CONFIGURATION_MAX_BYTES)
    if (configuration === null)
      issues.push({
        path: `${at}.configuration`,
        message: `names ${syntax.configuration}, which is missing or too large.`,
      })
    else {
      const parsed = parseLanguageConfiguration(configuration)
      if (!parsed.ok)
        issues.push({ path: `${at}.configuration`, message: firstProblem(syntax.configuration, parsed.issues) })
    }
  }
  return issues
}
