// The host calls written out in an extension's code, checked against what
// Studio offers before anything runs (`sprintengine-extension validate` and
// `check`): a frame's `studio.host.call('<method>', …)` that names no host
// method, or one the extension cannot use (a permission extension.json does
// not ask for, a worker it does not have), and `studio.document` outside a
// custom editor; a worker's `studio.<method>(…)` that needs a permission it
// does not ask for. Only literal calls: a method named at run time is not
// checked. A call guarded by `studio.host.has('<method>')` with the same
// literal is feature detection, and an unknown method there is not an issue.

import type { ExtensionManifest, ExtensionSurfacePoint } from './extension-manifest.js'
import { EXTENSION_FRAME_METHODS, EXTENSION_MAIN_HOST_METHODS } from './services.js'

export type HostCallIssue = { file: string; line: number; column: number; message: string }

/** What of extension.json a host call is checked against. */
export type HostCallManifest = Pick<ExtensionManifest, 'permissions' | 'main'>

/** `source` with its comments blanked (newlines kept), so a call in a comment is not read as one. */
function withoutComments(source: string): string {
  let out = ''
  let index = 0
  let quote: string | null = null
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (quote) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' '
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? source.length : end + 2
      out += source.slice(index, stop).replace(/[^\n]/gu, ' ')
      index = stop
      continue
    }
    out += char
    index += 1
  }
  return out
}

function place(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset).split('\n')
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
}

const DOT = String.raw`\s*\??\.\s*`
const HOST_CALL = new RegExp(String.raw`\bstudio${DOT}host${DOT}call\s*\(\s*(['"\x60])([^'"\x60\\$]*)\1`, 'gu')
const HOST_HAS = new RegExp(String.raw`\bstudio${DOT}host${DOT}has\s*\(\s*(['"\x60])([^'"\x60\\$]*)\1`, 'gu')
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
  const code = withoutComments(source)
  const issues: HostCallIssue[] = []
  const at = (offset: number, message: string) => issues.push({ file, ...place(code, offset), message })
  const detected = new Set([...code.matchAll(HOST_HAS)].map((match) => match[2]!))
  for (const match of code.matchAll(HOST_CALL)) {
    const method = match[2]!
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
  const code = withoutComments(source)
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
