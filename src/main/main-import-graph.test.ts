import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { expect, test } from 'vitest'

// One writer per store: the Studio server, in a process of its own, holds the
// core, its chats and its stores; main is the shell around the windows. This
// walks every value import main's entry reaches (type-only imports carry no
// code) and fails if one of the server's own halves is among them, so main
// cannot build a second core beside the server's.

const ROOT = resolve(__dirname, '../..')
const ENTRY = 'src/main/index.ts'

/** What only the server may load, each with why. */
const SERVER_ONLY: ReadonlyArray<{ file: string; why: string }> = [
  { file: 'src/server/core/studio-core.ts', why: 'the core and every store it writes' },
  { file: 'src/server/core/studio-rpc.ts', why: 'the Studio protocol the server serves' },
  { file: 'src/main/conversation-runtime.ts', why: 'the chats, which the server runs' },
  { file: 'src/server/desktop/desktop-server.ts', why: "the server process's own composition" },
  { file: 'src/server/core/studio-gateway.ts', why: "the agents' gateway, which the server runs" },
]

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/u.test(candidate) && existsSync(candidate)) return candidate
  }
  // `./x.js` written for ESM resolves to the source beside it.
  const stripped = base.replace(/\.js$/u, '')
  for (const candidate of [`${stripped}.ts`, `${stripped}.tsx`]) if (existsSync(candidate)) return candidate
  return null
}

/** The specifiers of a file's imports that carry code: not `import type`, not all-`type` lists. */
function valueImports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
  const found: string[] = []
  // `import … from '…'` and `export … from '…'`, over as many lines as a list takes.
  for (const match of text.matchAll(/^\s*(import|export)\s+([^'";]*?)\s+from\s+['"]([^'"]+)['"]/gmu)) {
    const [, , clause = '', specifier = ''] = match
    if (/^type\b/u.test(clause)) continue
    const list = /^\{([\s\S]*)\}$/u.exec(clause.trim())?.[1]
    const names = list
      ?.split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    if (names && names.length > 0 && names.every((name) => name.startsWith('type '))) continue
    found.push(specifier)
  }
  // `import '…'` for its effects, and `import('…')` at run time (not `typeof import('…')`).
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gmu)) found.push(match[1]!)
  for (const match of text.matchAll(/(typeof\s+)?\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    if (!match[1]) found.push(match[2]!)
  }
  return found
}

/** Every file main's entry reaches, each with the file that first imported it. */
function reachedFrom(entry: string): Map<string, string | null> {
  const reached = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const specifier of valueImports(file)) {
      const target = resolveImport(file, specifier)
      if (!target || reached.has(target)) continue
      reached.set(target, file)
      queue.push(target)
    }
  }
  return reached
}

function chainTo(reached: Map<string, string | null>, file: string): string {
  const chain: string[] = []
  for (let at: string | null | undefined = file; at; at = reached.get(at)) chain.unshift(relative(ROOT, at))
  return chain.join('\n  -> ')
}

test("main's entry never loads the server's core, chats or gateway", () => {
  const reached = reachedFrom(join(ROOT, ENTRY))
  // The walk itself works: main's entry reaches its own composition.
  expect(reached.has(join(ROOT, 'src/main/app-services.ts'))).toBe(true)
  const leaks = SERVER_ONLY.filter(({ file }) => reached.has(join(ROOT, file))).map(
    ({ file, why }) => `${file} (${why}), reached by\n  ${chainTo(reached, join(ROOT, file))}`,
  )
  expect(leaks, `main loads what only the Studio server may:\n${leaks.join('\n\n')}`).toEqual([])
})
