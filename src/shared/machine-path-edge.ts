import { machinePath, parseMachinePath } from './machine-paths'

// Paths at the edge between this computer and one SSH machine's Studio
// (phase 8, design-wsl-ssh-direct PR 1d). This computer spells a path there
// `ssh://<id>/home/dev/repo` (machine-paths.ts) so nothing here takes it for one
// of its own; the machine's Studio speaks the plain path, `/home/dev/repo`.
// The window's client of that machine respells at its edge, both ways:
//
// - Going there, every string that is a path spelled for this machine, in any
//   member of what is sent, is the plain path: a chat's key, a folder, a
//   mention, a skill's source, a stdio MCP server's command. Nothing else is
//   spelled `ssh://<id>/`, so this is never a guess.
// - Coming back, only the members that name a folder or a file there are
//   respelled (`MACHINE_PATH_MEMBERS`): a plain absolute path cannot be told
//   from words, so free text, tool inputs and transcripts are left as the
//   agent wrote them.

/** The members whose absolute paths, coming back from the machine, are spelled for this computer. */
export const MACHINE_PATH_MEMBERS: ReadonlySet<string> = new Set([
  'workspaceRoot',
  'folderPath',
  'repoRoot',
  'rootPath',
  'projectFolder',
  'worktreePath',
  'planFilePath',
])

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

/** What is sent to the machine `id`, with each of its paths as it spells them. */
export function machinePathsIn<T>(id: string, value: T): T {
  if (typeof value === 'string') {
    const parsed = parseMachinePath(value)
    return (parsed && parsed.id === id ? parsed.path : value) as T
  }
  if (Array.isArray(value)) return value.map((entry) => machinePathsIn(id, entry)) as T
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [member, entry] of Object.entries(value)) out[member] = machinePathsIn(id, entry)
  return out as T
}

/**
 * What the machine `id` answered, with each folder or file it names spelled
 * for this computer. `extra` names more members to respell for one answer
 * (a plan document's `path`).
 */
export function machinePathsOut<T>(id: string, value: T, extra: ReadonlySet<string> = new Set()): T {
  if (Array.isArray(value)) return value.map((entry) => machinePathsOut(id, entry, extra)) as T
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [member, entry] of Object.entries(value)) {
    out[member] =
      typeof entry === 'string' && entry.startsWith('/') && (MACHINE_PATH_MEMBERS.has(member) || extra.has(member))
        ? machinePath(id, entry)
        : machinePathsOut(id, entry, extra)
  }
  return out as T
}

// The Files and Git panes (design-wsl-ssh-direct PR 2) ask the machine's own
// Studio `files.*` and `git.*` about the folders they show. Their answers name
// files by path in more members than a chat's do, and what they send carries a
// person's text (a file being saved, a commit message, a search): that text
// goes as it was written, whatever it says.

/** Members of what a pane sends that hold a person's text, never a path. */
const PANE_TEXT_MEMBERS: ReadonlySet<string> = new Set(['text', 'content', 'message', 'query', 'body', 'data'])

/** Members of a pane's answer whose absolute path, coming back from the machine, is spelled for this computer. */
export const MACHINE_PANE_PATH_MEMBERS: ReadonlySet<string> = new Set([
  ...MACHINE_PATH_MEMBERS,
  'path',
  'parentPath',
  'checkedPath',
  'absolutePath',
  'checkoutPath',
])

/** What a pane sends the machine `id`, its paths as the machine spells them and its text as written. */
export function machinePanePathsIn<T>(id: string, value: T): T {
  if (typeof value === 'string') return machinePathsIn(id, value)
  if (Array.isArray(value)) return value.map((entry) => machinePanePathsIn(id, entry)) as T
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [member, entry] of Object.entries(value))
    out[member] = PANE_TEXT_MEMBERS.has(member) ? entry : machinePanePathsIn(id, entry)
  return out as T
}

/**
 * What the machine `id` answered a pane, each file or folder it names spelled
 * for this computer, and a map keyed by absolute paths keyed by this
 * computer's spelling. A file's contents are never touched.
 */
export function machinePanePathsOut<T>(id: string, value: T): T {
  if (Array.isArray(value)) return value.map((entry) => machinePanePathsOut(id, entry)) as T
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [member, entry] of Object.entries(value)) {
    const key = member.startsWith('/') ? machinePath(id, member) : member
    out[key] =
      typeof entry === 'string' && entry.startsWith('/') && MACHINE_PANE_PATH_MEMBERS.has(member)
        ? machinePath(id, entry)
        : machinePanePathsOut(id, entry)
  }
  return out as T
}
