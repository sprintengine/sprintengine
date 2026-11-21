#!/usr/bin/env node
// Every path docs/feature-map.md names is there. The map points agents at
// where a feature lives; a path that moved without its entry sends them to a
// file that is gone. Run by `npm run lint`.
//
// A path is any backticked token with a `/` in it and no space, read from the
// repository's root: `src/main/...`, `packages/...`, `docs/...`, a folder
// with its trailing `/`. Anything else in backticks (a method, a tool, a
// capability, a bare file name beside its folder) is words, not a path.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const MAP = 'docs/feature-map.md'
const text = readFileSync(join(root, MAP), 'utf8')

const missing = []
let checked = 0
for (const match of text.matchAll(/`([^`\s]+)`/gu)) {
  const token = match[1]
  if (!token.includes('/') || /^[a-z][\w-]*:\/\//u.test(token)) continue
  // `src/foo.ts` (`bar.ts`) style; strip trailing punctuation a sentence leaves.
  const path = token.replace(/[),.;:]+$/u, '')
  checked += 1
  if (!existsSync(join(root, path))) missing.push(path)
}

if (missing.length > 0) {
  console.error(`${MAP} names ${missing.length} path(s) that are not there:`)
  for (const path of missing) console.error(`  ${path}`)
  console.error('Update the entry to where the feature lives now.')
  process.exit(1)
}
console.log(`${MAP}: ${checked} paths, all there.`)
