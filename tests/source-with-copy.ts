import { readFileSync } from 'node:fs'

import { en } from '../src/shared/copy/en'

// A component's source with its words put back where they are shown, for the
// suites that read source to check a control is there ("the menu has a Move
// to epic item"). The words live in the copy catalog (src/shared/copy/en.ts)
// and a component names them, so `label={copy.backlog.menu.moveToEpic}`
// reads here as `label="Move to epic"`, a child `{copy…}` as its text, and any
// other `copy…` as a quoted string. Words that take values stay as written.

function lookup(path: string[]): { text: string; used: number } | null {
  let node: unknown = en
  for (let i = 0; i < path.length; i++) {
    if (node === null || typeof node !== 'object' || !(path[i] in node)) return null
    node = (node as Record<string, unknown>)[path[i]]
    if (typeof node === 'string') return { text: node, used: i + 1 }
  }
  return null
}

const REF = /\b(?:appCopy|copy)((?:\.[A-Za-z_$][\w$]*)+)/g

function inline(source: string, wrap: (text: string) => string): string {
  return source.replace(REF, (match, chain: string) => {
    const path = chain.slice(1).split('.')
    const found = lookup(path)
    if (!found) return match
    const rest = path.slice(found.used)
    return wrap(found.text) + rest.map((p) => `.${p}`).join('')
  })
}

export function withCopyInlined(source: string): string {
  // `attr={copy.x}` → `attr="text"`, and a child `{copy.x}` → `text`.
  let out = source.replace(/=\{((?:appCopy|copy)(?:\.[A-Za-z_$][\w$]*)+)\}/g, (match, ref: string) => {
    const found = lookup(ref.split('.').slice(1))
    if (!found || found.used !== ref.split('.').length - 1) return match
    return found.text.includes('"') ? `={${JSON.stringify(found.text)}}` : `="${found.text}"`
  })
  out = out.replace(/\{((?:appCopy|copy)(?:\.[A-Za-z_$][\w$]*)+)\}/g, (match, ref: string) => {
    const found = lookup(ref.split('.').slice(1))
    if (!found || found.used !== ref.split('.').length - 1) return match
    return found.text
  })
  return inline(out, (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
}

/** `readFileSync(path, 'utf8')`, with the words put back. */
export function readSourceWithCopy(path: string, _encoding: 'utf8' = 'utf8'): string {
  return withCopyInlined(readFileSync(path, 'utf8'))
}
