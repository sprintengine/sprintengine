import type { MachineSpelling } from './machine-spelling'

// Paths at the edge between this computer and another machine's Studio, an
// SSH machine's or a WSL distribution's (phase 8, design-wsl-ssh-direct PR 1d,
// PR 3c), each spelled as `machine-spelling.ts` says. This computer's records
// name a folder there as this computer spells it (`ssh://<id>/home/dev/repo`,
// `\\wsl.localhost\Ubuntu\home\dev\repo`); the machine's Studio speaks
// the plain path, `/home/dev/repo`. The client of that machine respells at its
// edge, both ways:
//
// - Going there, every string that is a path spelled for this machine, in any
//   member of what is sent, is the plain path: a chat's key, a folder, a
//   mention, a skill's source, a stdio MCP server's command. An `ssh://<id>/`
//   string is never words; a drive path may be, so a WSL machine's are not
//   read in a person's text (`TEXT_MEMBERS`).
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

/** Members of what is sent that hold a person's (or an agent's) words: a path spelling that guesses leaves them. */
const TEXT_MEMBERS: ReadonlySet<string> = new Set([
  'text',
  'content',
  'message',
  'query',
  'body',
  'data',
  'prompt',
  'name',
  'title',
  'label',
  'description',
  'instructions',
])

/** What is sent to the machine, with each of its paths as it spells them. */
export function machinePathsIn<T>(spelling: MachineSpelling, value: T): T {
  if (typeof value === 'string') return (spelling.toMachine(value) ?? value) as T
  if (Array.isArray(value)) return value.map((entry) => machinePathsIn(spelling, entry)) as T
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [member, entry] of Object.entries(value))
    out[member] =
      spelling.guesses && TEXT_MEMBERS.has(member) && typeof entry === 'string'
        ? entry
        : machinePathsIn(spelling, entry)
  return out as T
}

/**
 * Why the machine cannot open a folder what is sent names (a member in
 * `MACHINE_PATH_MEMBERS`), in words, or null when it can open every one: a
 * WSL distribution is never handed another's share, a network share, or a
 * drive it does not mount, which it would read as a relative name.
 */
export function machineFolderRefusal(spelling: MachineSpelling, value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const refused = machineFolderRefusal(spelling, entry)
      if (refused) return refused
    }
    return null
  }
  if (!isPlainObject(value)) return null
  for (const [member, entry] of Object.entries(value)) {
    const refused =
      typeof entry === 'string'
        ? MACHINE_PATH_MEMBERS.has(member)
          ? spelling.refusal(entry)
          : null
        : machineFolderRefusal(spelling, entry)
    if (refused) return refused
  }
  return null
}

/**
 * What the machine answered, with each folder or file it names spelled for
 * this computer. `extra` names more members to respell for one answer (a
 * plan document's `path`).
 */
export function machinePathsOut<T>(spelling: MachineSpelling, value: T, extra: ReadonlySet<string> = new Set()): T {
  if (Array.isArray(value)) return value.map((entry) => machinePathsOut(spelling, entry, extra)) as T
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [member, entry] of Object.entries(value)) {
    out[member] =
      typeof entry === 'string' && entry.startsWith('/') && (MACHINE_PATH_MEMBERS.has(member) || extra.has(member))
        ? spelling.fromMachine(entry)
        : machinePathsOut(spelling, entry, extra)
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

/** What a pane sends the machine, its paths as the machine spells them and its text as written. */
export function machinePanePathsIn<T>(spelling: MachineSpelling, value: T): T {
  if (typeof value === 'string') return (spelling.toMachine(value) ?? value) as T
  if (Array.isArray(value)) return value.map((entry) => machinePanePathsIn(spelling, entry)) as T
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [member, entry] of Object.entries(value))
    out[member] = PANE_TEXT_MEMBERS.has(member) ? entry : machinePanePathsIn(spelling, entry)
  return out as T
}

/**
 * What the machine answered a pane, each file or folder it names spelled for
 * this computer, and a map keyed by absolute paths keyed by this computer's
 * spelling. A file's contents are never touched.
 */
export function machinePanePathsOut<T>(spelling: MachineSpelling, value: T): T {
  if (Array.isArray(value)) return value.map((entry) => machinePanePathsOut(spelling, entry)) as T
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [member, entry] of Object.entries(value)) {
    const key = member.startsWith('/') ? spelling.fromMachine(member) : member
    out[key] =
      typeof entry === 'string' && entry.startsWith('/') && MACHINE_PANE_PATH_MEMBERS.has(member)
        ? spelling.fromMachine(entry)
        : machinePanePathsOut(spelling, entry)
  }
  return out as T
}
