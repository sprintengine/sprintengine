// The extension guide: how to build, test and ship an extension, as topics an
// agent reads one at a time. The topics are the Markdown files in this
// package's `guide/` folder; this list says which ones there are, in reading
// order, and what each answers.
//
// Subpath export `@sprintengine/extension-sdk/guide`. Node-only (it reads the
// files), like `./scaffold`. SprintEngine Studio serves the same topics to
// agents with its `extension.guide` tool, and `extension.create` answers with
// the `start` topic, so an agent working on an extension never needs a copy of
// the guide inside the project.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ExtensionGuideTopic = {
  /** The topic's id, and its file's name without `.md`. */
  id: string
  /** When to read it, in a line. */
  summary: string
}

/** Every topic, in the order a newcomer reads them. `start` is the first. */
export const EXTENSION_GUIDE_TOPICS: readonly ExtensionGuideTopic[] = [
  {
    id: 'start',
    summary:
      'Read first: what an extension is, the project layout, the first steps, the no-build dev loop (npm run dev, approve once, save and read what came back), testing without Studio, and what done means.',
  },
  {
    id: 'dev-loop',
    summary:
      'The sprintengine-extension commands (validate, inspect, test, check, dev load/watch/…, shot): every flag, the --json answers, the watch events, error and exit codes.',
  },
  {
    id: 'surfaces',
    summary:
      'Which contribution or API adds what to Studio (panel, door, command, menu, MCP tool, chat, …), and its tier and permission.',
  },
  {
    id: 'components',
    summary:
      'Components panels: a panel drawn with Studio’s own controls from the tree its module renders. Atoms and persistence, setup, talking to Studio, hot reload, testing with mountPanel, check scenarios, the catalogue and its limits.',
  },
  { id: 'manifest', summary: 'extension.json, field by field: tiers, contributions, ids, versions, paths.' },
  { id: 'permissions', summary: 'Every permission, what it allows, and which the host enforces.' },
  {
    id: 'rules',
    summary:
      'The mistakes that cost earlier extensions time: how source loads, styling, approval, storage, untrusted input.',
  },
  {
    id: 'api-renderer',
    summary: 'The `studio` a surface’s mount is handed in its frame: host calls, worker methods, events, ready().',
  },
  {
    id: 'api-main',
    summary: 'The worker’s activate(studio): methods, commands, MCP tools, services, storage, notifications.',
  },
  {
    id: 'hooks',
    summary:
      'Agent hooks: checking, changing or refusing what agents and Studio are about to do (tool calls, prompts, launches, saves), and hearing what they did.',
  },
  {
    id: 'events',
    summary:
      "Studio's events (workspaces made, removed or changed, agents' status) in a worker and a surface, and the person's terminals from a worker: send, create, read, close, list.",
  },
  { id: 'conversations', summary: "The extension's own chats, and one-shot text generation." },
  { id: 'brokers', summary: 'API keys and GitHub through the host, never a token in the extension.' },
  {
    id: 'styling',
    summary: 'Drawing a surface in its frame: plain DOM or JSX, the theme properties, Studio’s kit, your own CSS.',
  },
  {
    id: 'troubleshooting',
    summary: 'Studio does not list, trust or run the extension: what it shows, the cause, the fix.',
  },
  { id: 'publishing', summary: 'Signing with extension.sig, packing, and handing an extension to others.' },
  {
    id: 'catalogue',
    summary:
      'Listing an extension in a catalogue: the format, release entries, what Studio checks at install, updates, the kill list and install links.',
  },
]

/**
 * The `guide/` folder of this package. dist/guide.js (published) and
 * src/guide.ts (in the repository) both sit one level below the package root.
 * Worked out when asked, not when the module loads: an app that bundles this
 * file into CommonJS (Studio's server) has no `import.meta.url`, and always
 * passes the folder it ships the guide in instead.
 */
export function defaultGuideRoot(): string {
  return join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'guide')
}

export function isExtensionGuideTopic(id: unknown): id is string {
  return typeof id === 'string' && EXTENSION_GUIDE_TOPICS.some((topic) => topic.id === id)
}

/**
 * One topic's Markdown, or null for an id that is not a topic. Only ids from
 * `EXTENSION_GUIDE_TOPICS` are read, so the id never names a path. Throws when
 * a listed topic's file is missing: that is a packaging bug.
 */
export function readExtensionGuideTopic(id: string, guideRoot: string = defaultGuideRoot()): string | null {
  if (!isExtensionGuideTopic(id)) return null
  return readFileSync(join(guideRoot, `${id}.md`), 'utf8')
}
