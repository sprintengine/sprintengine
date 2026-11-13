#!/usr/bin/env node
// Chat locality gate: a chat view never asks whether its chat is "local" or
// "remote". A chat names its environment (`transport.environment`), what it
// may do is negotiated from its server (`transport.capabilities`), and what
// the window's shell reaches of its disk is asked of `useShellReach`. This
// keeps the transport's old kind and its remote identity fields from coming
// back under src/renderer/src/components/panels/ and the embed.
//
// Fails on:
//   - a transport's `.kind`, or a `kind: 'local' | 'remote'` union;
//   - `.kind === 'remote'` / `!== 'remote'` and `kind: 'remote'`;
//   - `.kind === 'local'` / `!== 'local'` (a workspace's machine ref, the
//     WSL/SSH routing term design-wsl-ssh-direct deletes, is marked
//     `chat-locality-allow:` with its reason until then);
//   - `isLocal…` / `isRemote…` names;
//   - a transport's `machineName`, `remoteExtensions`, `commandsFolder` or
//     `environmentId`, read or picked.
//
// Tests are scanned too: a test that builds a transport by its kind tests a
// path that no longer exists. Exit 1 with file:line findings, 0 otherwise.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const roots = ['src/renderer/src/components/panels', 'src/renderer/src/web/embed'].map((dir) => join(root, dir))

const RULES = [
  [/\b\w*[tT]ransport\??\.kind\b/, "a chat's transport has no kind: read its environment or its capabilities"],
  [/'local'\s*\|\s*'remote'|'remote'\s*\|\s*'local'/, 'no local/remote kind: a chat names its environment'],
  [/\.kind\s*[!=]==?\s*'remote'|\bkind:\s*'remote'/, "no 'remote' kind: a chat names its environment"],
  [/\.kind\s*[!=]==?\s*'local'/, "no 'local' kind: ask useShellReach or the chat's environment"],
  [/\bis(Local|Remote)[A-Z_]?\w*\b/, 'no isLocal/isRemote: ask useShellReach or the capabilities'],
  [
    /\b\w*[tT]ransport\??\.(machineName|remoteExtensions|commandsFolder|environmentId)\b/,
    "the transport's identity is its environment (`transport.environment`)",
  ],
  [
    /Pick<\s*ConversationTransport\s*,[^>]*'(kind|machineName|remoteExtensions|commandsFolder|environmentId)'/,
    "the transport's identity is its environment (`environment`)",
  ],
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.tsx?$/.test(entry)) yield full
  }
}

const violations = []
let scanned = 0
for (const dir of roots) {
  for (const file of walk(dir)) {
    scanned += 1
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        // A reviewed exception says why on its line.
        if (/chat-locality-allow:\s*\S/.test(line)) return
        for (const [pattern, message] of RULES)
          if (pattern.test(line)) violations.push(`${relative(root, file)}:${index + 1}: ${message}`)
      })
  }
}

if (violations.length > 0) {
  console.error('Chat locality gate failed:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`lint-chat-locality: ok (${scanned} files under panels/ and web/embed; 0 violations)`)
