// The host calls written out in an extension's code, checked against what
// Studio offers before anything runs (`sprintengine-extension validate` and
// `check`): a frame's `studio.host.call('<method>', …)` that names no host
// method, or one the extension cannot use (a permission extension.json does
// not ask for, a worker it does not have), and `studio.document` outside a
// custom editor; a worker's `studio.<method>(…)` that needs a permission it
// does not ask for. Only literal calls: a method named at run time is not
// checked, and text inside a comment or a string is not a call. A call
// guarded by `studio.host.has('<method>')` with the same literal is feature
// detection, and an unknown method there is not an issue.

import type { ExtensionManifest, ExtensionSurfacePoint } from './extension-manifest.js'
import { EXTENSION_FRAME_METHODS, EXTENSION_MAIN_HOST_METHODS } from './services.js'

export type HostCallIssue = { file: string; line: number; column: number; message: string }

/** What of extension.json a host call is checked against. */
export type HostCallManifest = Pick<ExtensionManifest, 'permissions' | 'main'>

const blank = (text: string) => text.replace(/[^\n]/gu, ' ')

/**
 * `source` as code alone, every offset kept: comments and the text inside
 * string literals and template literals blanked (newlines and the quotes
 * themselves kept), and a template's `${…}` kept as the code it is. So a call
 * written inside a comment or a string is not read as a call.
 */
function codeOnly(source: string): string {
  let out = ''
  let index = 0
  // Where each open `${` returns to: the template it is in, at this brace depth.
  const templates: number[] = []
  let depth = 0
  let mode: 'code' | 'template' = 'code'
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (mode === 'template') {
      if (char === '\\') {
        out += blank(source.slice(index, index + 2))
        index += 2
      } else if (char === '`') {
        out += char
        index += 1
        mode = 'code'
      } else if (char === '$' && next === '{') {
        out += '${'
        index += 2
        templates.push(depth)
        depth += 1
        mode = 'code'
      } else {
        out += blank(char)
        index += 1
      }
      continue
    }
    if (char === '"' || char === "'") {
      let end = index + 1
      while (end < source.length && source[end] !== char && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1
      out += char + blank(source.slice(index + 1, end)) + (source[end] === char ? char : '')
      index = source[end] === char ? end + 1 : end
      continue
    }
    if (char === '`') {
      out += char
      index += 1
      mode = 'template'
      continue
    }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      const stop = end < 0 ? source.length : end
      out += blank(source.slice(index, stop))
      index = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? source.length : end + 2
      out += blank(source.slice(index, stop))
      index = stop
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (templates.length > 0 && templates.at(-1) === depth) {
        templates.pop()
        out += char
        index += 1
        mode = 'template'
        continue
      }
    }
    out += char
    index += 1
  }
  return out
}

/** The literal method name a call's quote at `quote` opens in `source`, or null when it is not a plain literal. */
function literalAt(source: string, quote: number): string | null {
  const mark = source[quote]!
  const match = /^([^'"`\\$\n]*)/u.exec(source.slice(quote + 1))
  const name = match?.[1] ?? ''
  return source[quote + 1 + name.length] === mark ? name : null
}

function place(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset).split('\n')
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
}

const DOT = String.raw`\s*\??\.\s*`
// Matched on the code alone (codeOnly); the method's literal is read from the source at the quote.
const HOST_CALL = new RegExp(String.raw`\bstudio${DOT}host${DOT}call\s*\(\s*(?=['"\x60])`, 'gu')
const HOST_HAS = new RegExp(String.raw`\bstudio${DOT}host${DOT}has\s*\(\s*(?=['"\x60])`, 'gu')
const METHODS = new RegExp(String.raw`\bstudio${DOT}methods\s*(?:<[^>()]*>\s*)?\(`, 'gu')
const DOCUMENT = new RegExp(String.raw`\bstudio${DOT}document\b`, 'gu')
const WORKER_CALL = new RegExp(String.raw`\bstudio${DOT}([A-Za-z_$][\w$]*)\s*\(`, 'gu')

const asks = (manifest: HostCallManifest, permission: string | null) =>
  permission === null || (manifest.permissions as readonly string[]).includes(permission)

/** The issues with the host calls one of a surface's files writes out. */
export function surfaceHostCallIssues(
  file: string,
  source: string,
  surface: ExtensionSurfacePoint,
  manifest: HostCallManifest,
): HostCallIssue[] {
  const code = codeOnly(source)
  const issues: HostCallIssue[] = []
  const at = (offset: number, message: string) => issues.push({ file, ...place(code, offset), message })
  const literal = (match: RegExpMatchArray) => literalAt(source, match.index! + match[0].length)
  const detected = new Set([...code.matchAll(HOST_HAS)].map(literal).filter((name) => name !== null))
  for (const match of code.matchAll(HOST_CALL)) {
    const method = literal(match)
    if (method === null) continue
    const requirement = Object.hasOwn(EXTENSION_FRAME_METHODS, method)
      ? EXTENSION_FRAME_METHODS[method as keyof typeof EXTENSION_FRAME_METHODS]
      : undefined
    if (!requirement) {
      if (!detected.has(method)) at(match.index, `studio.host.call("${method}") names no host method Studio offers.`)
      continue
    }
    if (!asks(manifest, requirement.extension))
      at(
        match.index,
        `studio.host.call("${method}") needs the "${requirement.extension}" permission, which extension.json does not ask for.`,
      )
    if ((method === 'worker.read' || method === 'worker.operate') && !manifest.main)
      at(match.index, `studio.host.call("${method}") reaches the extension's worker, and it has none (worker tier).`)
  }
  if (!manifest.main)
    for (const match of code.matchAll(METHODS))
      at(match.index, "studio.methods() reaches the extension's worker, and it has none (worker tier).")
  if (surface !== 'customEditors')
    for (const match of code.matchAll(DOCUMENT))
      at(match.index, "studio.document is there only in a custom editor's frame.")
  return issues
}

/** The issues with the host calls a worker's file writes out: a call that needs a permission it does not ask for. */
export function workerHostCallIssues(file: string, source: string, manifest: HostCallManifest): HostCallIssue[] {
  const code = codeOnly(source)
  const issues: HostCallIssue[] = []
  for (const match of code.matchAll(WORKER_CALL)) {
    const method = match[1]!
    if (!Object.hasOwn(EXTENSION_MAIN_HOST_METHODS, method)) continue
    const requirement = EXTENSION_MAIN_HOST_METHODS[method]!
    if (!asks(manifest, requirement.extension))
      issues.push({
        file,
        ...place(code, match.index),
        message: `studio.${method}() needs the "${requirement.extension}" permission, which extension.json does not ask for.`,
      })
  }
  return issues
}
