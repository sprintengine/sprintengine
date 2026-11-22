// Agent hooks: points where Studio asks an extension's worker before (or tells
// it after) it acts, and what a hook may answer.
//
// An extension lists the points it hooks in extension.json
// (`contributes.hooks`, worker tier) and its worker serves them with
// `studio.registerHooks`. Studio waits only on extensions that list a point,
// one after another in the order of their install keys, each for at most
// `EXTENSION_HOOK_TIME_LIMIT_MS`. A `before` hook may let the action go on
// (answer nothing), change the fields its point lets it change
// (`{ change: { … } }`), or refuse it (`{ deny: reason }`), which stops the
// chain and names the extension with its reason. An `after` hook observes: it
// is told, and Studio does not wait for it.
//
// A hook that throws, answers past its time limit, answers something else, or
// whose worker crashed or did not start counts as having passed, unless its
// entry says `"onError": "deny"`: then that failure refuses the action, so a
// guard fails closed. Starting a worker that is not running is not counted
// against the time limit.
//
// This table is the one description of the points: the manifest's enum, the
// approval's plain words, the guide's reference and the checks on what a hook
// answers all read it. Pure (no Node or DOM APIs).

/** The points, in the order the reference lists them. */
export const EXTENSION_HOOK_POINTS = [
  'agent.launch.before',
  'agent.prompt.before',
  'agent.tool.before',
  'agent.tool.after',
  'terminal.write.before',
  'workspace.create.before',
  'workspace.create.after',
  'editor.save.before',
] as const
export type ExtensionHookPoint = (typeof EXTENSION_HOOK_POINTS)[number]

/** What a failed hook (a throw, a timeout, a crash, a worker that did not start) does. */
export const EXTENSION_HOOK_ON_ERROR = ['pass', 'deny'] as const
export type ExtensionHookOnError = (typeof EXTENSION_HOOK_ON_ERROR)[number]

/** How long Studio waits on one extension's hook before `onError` decides. */
export const EXTENSION_HOOK_TIME_LIMIT_MS = 2_000

/** The most characters a refusal's reason may hold; the agent and the person read it. */
export const EXTENSION_HOOK_REASON_MAX_CHARS = 500

/** The most characters a prompt, a terminal write or a tool's input a hook hands back may hold, as the reference allows. */
export const EXTENSION_HOOK_TEXT_MAX_CHARS = 16 * 1024 * 1024

/**
 * How long one tool call waits on all the extensions that hook it, together:
 * once spent, each extension not yet asked is decided by its `onError`. The
 * CLI is told to wait well beyond it, so a slow chain never lets a call through
 * by timing out.
 */
export const EXTENSION_HOOK_TOOL_BUDGET_MS = 6_000

/** The most characters a saved file's text a hook hands back may hold. */
export const EXTENSION_HOOK_FILE_MAX_CHARS = 16 * 1024 * 1024

export function isExtensionHookPoint(value: unknown): value is ExtensionHookPoint {
  return typeof value === 'string' && (EXTENSION_HOOK_POINTS as readonly string[]).includes(value)
}

// ── The events ──────────────────────────────────────────────────────────────

/** An agent's tool call, as a hook sees it. */
export type ExtensionAgentToolCall = {
  /** The agent's runtime, as a chat names it (`claude-agent`). */
  agent: string
  /** The chat: its workspace and its agent. */
  workspaceId: string
  agentId: string
  /** The tool's name as the agent reports it (`Bash`, `Write`, `mcp__…`). */
  tool: string
  /** The tool's arguments as the agent reports them. */
  input: Record<string, unknown>
  /** The agent's id for this call, when it reports one. */
  callId: string | null
}

/**
 * What a prompt nobody typed is: `launch` (a new agent's first message, from
 * an agent's `conversation.create`, an extension or a schedule), `send`
 * (another agent's or an extension's message to a running agent), `subagent`
 * (a sub-agent's task, started or resumed), `companion` (an extension's
 * background agent), `notice` (Studio telling an agent what happened),
 * `recovery` (a first message sent again after a stop cut it off) or `tour`
 * (a tour's prompt typed into its terminal).
 */
export const EXTENSION_PROMPT_INPUT_KINDS = [
  'launch',
  'send',
  'subagent',
  'companion',
  'notice',
  'recovery',
  'tour',
] as const
export type ExtensionPromptInputKind = (typeof EXTENSION_PROMPT_INPUT_KINDS)[number]

export type ExtensionHookEvents = {
  'agent.launch.before': {
    /** The agent's runtime: a chat's provider (`claude-agent`) or a terminal's CLI (`claude`). */
    agent: string
    /** Where it runs: a chat, or an agent CLI in a terminal. */
    where: 'chat' | 'terminal'
    /** The workspace it starts in. */
    workspaceId: string
    /** The model it was asked to run, when one was named. */
    model: string | null
    /** The permission preset it runs on, when one was named (`manual`, `auto`, `bypass`…). */
    permission: string | null
    /** The first message it is handed, when it has one. */
    prompt: string | null
  }
  'agent.prompt.before': {
    /** The agent's runtime, when Studio knows it. */
    agent: string | null
    /** A chat's message, or a prompt typed into a terminal agent. */
    where: 'chat' | 'terminal'
    workspaceId: string | null
    agentId: string | null
    /** The terminal, for an agent in one. */
    terminalId: string | null
    /** Who is sending it: Studio itself (a notice), an extension, or another agent. */
    from: 'studio' | 'extension' | 'agent'
    /** What kind of message it is. */
    inputKind: ExtensionPromptInputKind
    prompt: string
  }
  'agent.tool.before': ExtensionAgentToolCall
  'agent.tool.after': ExtensionAgentToolCall & {
    /** The tool's result as the agent reports it. */
    output: unknown
    /** Whether the call failed. */
    failed: boolean
  }
  'terminal.write.before': {
    /** The terminal session. */
    terminalId: string
    workspaceId: string | null
    /** The agent CLI in it, when it runs one. */
    agent: string | null
    /** Who is typing it: Studio itself, or an extension. */
    from: 'studio' | 'extension'
    /** What kind of write it is: an extension's (`send`) or Studio's own (`notice`). */
    inputKind: 'send' | 'notice'
    /** What is about to be typed, as bytes the terminal reads, without the Enter that ends it. */
    text: string
    /** Whether Enter is pressed after `text`. */
    enter: boolean
  }
  'workspace.create.before': {
    /** What it is made for: a new chat, or a workspace an agent or extension asked for. */
    for: 'chat' | 'workspace'
    /** Its name, when one was given or derived. */
    name: string | null
    /** The project folder it works in. */
    folderPath: string | null
    /** Whether its folder is a git worktree of its own. */
    worktree: boolean
  }
  'workspace.create.after': {
    for: 'chat' | 'workspace'
    workspaceId: string
    name: string
    folderPath: string | null
    worktree: boolean
  }
  'editor.save.before': {
    /** The file's path on the machine that holds it. */
    path: string
    /** The text about to be written. */
    text: string
  }
}

/** What a hook answers: nothing to let it go on, a change, or a refusal. */
export type ExtensionHookAnswer<P extends ExtensionHookPoint> = P extends keyof ExtensionHookChanges
  ? void | undefined | null | { deny: string } | { change: Partial<ExtensionHookChanges[P]> }
  : void

/** The fields a `before` point lets a hook change. */
export type ExtensionHookChanges = {
  'agent.launch.before': Record<string, never>
  'agent.prompt.before': { prompt: string }
  'agent.tool.before': { input: Record<string, unknown> }
  'terminal.write.before': { text: string; enter: boolean }
  'workspace.create.before': { name: string }
  'editor.save.before': { text: string }
}

export type ExtensionAfterHookPoint = 'agent.tool.after' | 'workspace.create.after'

/** A hook's handler: handed the event, answers (or resolves to) its decision. */
export type ExtensionHookHandler<P extends ExtensionHookPoint> = (
  event: Readonly<ExtensionHookEvents[P]>,
) => ExtensionHookAnswer<P> | Promise<ExtensionHookAnswer<P>>

/** What `studio.registerHooks` takes: a handler per point extension.json lists. */
export type ExtensionHookHandlers = { [P in ExtensionHookPoint]?: ExtensionHookHandler<P> }

// ── The table ───────────────────────────────────────────────────────────────

/** Why a value a hook hands back for a field does not fit it, or null. */
export type ExtensionHookFieldCheck = (value: unknown) => string | null

const text =
  (max: number, min = 0): ExtensionHookFieldCheck =>
  (value) =>
    typeof value !== 'string'
      ? 'must be text.'
      : value.length < min
        ? 'must not be empty.'
        : value.length > max
          ? `must be at most ${max} characters.`
          : null

const bool: ExtensionHookFieldCheck = (value) => (typeof value === 'boolean' ? null : 'must be true or false.')

const plainObject: ExtensionHookFieldCheck = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'must be an object.'
  try {
    if (JSON.stringify(value).length > EXTENSION_HOOK_TEXT_MAX_CHARS) return 'is too large.'
  } catch {
    return 'must be JSON.'
  }
  return null
}

export type ExtensionHookPointSpec = {
  /** False for a point that only observes: Studio does not wait, and the answer is ignored. */
  decides: boolean
  /** The fields a hook may change, each with its check. Empty: refuse or pass only. */
  changes: Readonly<Record<string, ExtensionHookFieldCheck>>
  /** What the approval says it lets the extension do, in plain words. */
  approval: string
  /** For the guide: when it runs, and what an answer does. */
  summary: string
  /** For the guide: the event, as a type. */
  event: string
}

export const EXTENSION_HOOK_SPECS: Readonly<Record<ExtensionHookPoint, ExtensionHookPointSpec>> = {
  'agent.launch.before': {
    decides: true,
    changes: {},
    approval: 'Can refuse to let your agents start',
    summary:
      'Studio is about to start an agent: a new chat, or an agent CLI in a terminal. Return `{ deny }` to refuse the start; the person (or the agent or extension that asked) is told why.',
    event:
      "{ agent: string; where: 'chat' | 'terminal'; workspaceId: string; model: string | null; permission: string | null; prompt: string | null }",
  },
  'agent.prompt.before': {
    decides: true,
    changes: { prompt: text(EXTENSION_HOOK_TEXT_MAX_CHARS) },
    approval: 'Can check, change or refuse the messages Studio, extensions and other agents send your agents',
    summary:
      'Studio is about to hand an agent a message the person did not type (`inputKind` says which): a new agent’s first message from an agent, an extension or a schedule; another agent’s or an extension’s message; a sub-agent’s task; an extension’s background agent’s; a notice Studio sends; a first message sent again after a stop; a tour’s prompt. A message the person types, on any machine, is never hooked. Change `prompt`, or return `{ deny }` to refuse it.',
    event:
      "{ agent: string | null; where: 'chat' | 'terminal'; workspaceId: string | null; agentId: string | null; terminalId: string | null; from: 'studio' | 'extension' | 'agent'; inputKind: 'launch' | 'send' | 'subagent' | 'companion' | 'notice' | 'recovery' | 'tour'; prompt: string }",
  },
  'agent.tool.before': {
    decides: true,
    changes: { input: plainObject },
    approval: 'Can check, change or refuse your agents’ tool calls in Claude Code chats',
    summary:
      'An agent in a chat is about to run a tool. Return `{ deny }` to refuse the call (the agent reads the reason) or change `input`; the chat’s permission mode still asks the person as usual. Claude Code chats only for now: other runtimes have no hook before a tool runs that Studio can answer.',
    event:
      '{ agent: string; workspaceId: string; agentId: string; tool: string; input: Record<string, unknown>; callId: string | null }',
  },
  'agent.tool.after': {
    decides: false,
    changes: {},
    approval: 'Sees each tool call your agents finish in Claude Code chats, and what it returned',
    summary:
      'An agent in a chat finished a tool call, or it failed. Observe only: Studio does not wait for it. Claude Code chats only for now.',
    event:
      '{ agent: string; workspaceId: string; agentId: string; tool: string; input: Record<string, unknown>; callId: string | null; output: unknown; failed: boolean }',
  },
  'terminal.write.before': {
    decides: true,
    changes: { text: text(EXTENSION_HOOK_TEXT_MAX_CHARS), enter: bool },
    approval: 'Can check, change or refuse what Studio and extensions type into your terminals',
    summary:
      'Studio is about to type into a terminal for someone other than a person at its keyboard: an extension’s or a tool’s raw write. Keystrokes from a person (on any machine) are never hooked, and a prompt to an agent takes `agent.prompt.before` instead. Change `text` or `enter`, or return `{ deny }` to refuse the write.',
    event:
      "{ terminalId: string; workspaceId: string | null; agent: string | null; from: 'studio' | 'extension'; inputKind: 'send' | 'notice'; text: string; enter: boolean }",
  },
  'workspace.create.before': {
    decides: true,
    changes: { name: text(1024, 1) },
    approval: 'Can rename or refuse the workspaces Studio makes',
    summary:
      'Studio is about to make a workspace: for a new chat, or one an agent or extension asked for. Change `name`, or return `{ deny }` to refuse it.',
    event: "{ for: 'chat' | 'workspace'; name: string | null; folderPath: string | null; worktree: boolean }",
  },
  'workspace.create.after': {
    decides: false,
    changes: {},
    approval: 'Hears about each workspace Studio makes',
    summary: 'Studio made a workspace. Observe only: Studio does not wait for it.',
    event:
      "{ for: 'chat' | 'workspace'; workspaceId: string; name: string; folderPath: string | null; worktree: boolean }",
  },
  'editor.save.before': {
    decides: true,
    changes: { text: text(EXTENSION_HOOK_FILE_MAX_CHARS) },
    approval: 'Can check, change or refuse the files you save in the editor',
    summary:
      'The person is about to save a text file from Studio’s editor, on whichever machine holds it. Change `text` (format on save), and the editor shows what was saved; or return `{ deny }` to refuse the save, and the editor shows the reason and keeps the edits unsaved.',
    event: '{ path: string; text: string }',
  },
}

/** Whether a point only observes. */
export function isExtensionAfterHookPoint(point: ExtensionHookPoint): point is ExtensionAfterHookPoint {
  return !EXTENSION_HOOK_SPECS[point].decides
}

// ── Reading an answer ───────────────────────────────────────────────────────

/** What one extension's answer decides, once read. */
export type ExtensionHookVerdict =
  | { kind: 'pass' }
  | { kind: 'deny'; reason: string }
  | { kind: 'change'; event: Record<string, unknown>; changed: string[] }
  /** It answered something a hook may not: counted as the hook failing. */
  | { kind: 'invalid'; problem: string }
  /** It asked for a change the point does not allow, or a value that does not fit: passed, and logged. */
  | { kind: 'ignored'; problem: string }

function oneLine(value: string): string {
  // The reason is shown in a chat and read by an agent: no control characters
  // or line breaks that would let it pose as something else there.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim()
}

/**
 * What a hook's `answer` decides for `event` at `point`: pass (nothing), a
 * refusal with its reason, or the event with the fields it may change
 * changed. A change to a field it may not change, or a value that does not fit, is
 * ignored and the event goes on as it was; an answer that is none of these
 * is `invalid`, which counts as the hook failing.
 */
export function readExtensionHookAnswer(
  point: ExtensionHookPoint,
  event: Readonly<Record<string, unknown>>,
  answer: unknown,
): ExtensionHookVerdict {
  const spec = EXTENSION_HOOK_SPECS[point]
  if (answer === undefined || answer === null) return { kind: 'pass' }
  if (!spec.decides) return { kind: 'pass' }
  if (typeof answer !== 'object' || Array.isArray(answer))
    return { kind: 'invalid', problem: 'a hook answers nothing, { deny: reason } or { change: { … } }.' }
  const keys = Object.keys(answer)
  if (keys.length === 1 && keys[0] === 'deny') {
    const reason = (answer as { deny: unknown }).deny
    if (typeof reason !== 'string' || !oneLine(reason))
      return { kind: 'invalid', problem: 'a refusal’s reason must be text.' }
    const clean = oneLine(reason)
    // Too long is malformed, as the reference has it: the hook failed, and its onError decides.
    if (clean.length > EXTENSION_HOOK_REASON_MAX_CHARS)
      return {
        kind: 'invalid',
        problem: `a refusal's reason holds at most ${EXTENSION_HOOK_REASON_MAX_CHARS} characters.`,
      }
    return { kind: 'deny', reason: clean }
  }
  if (keys.length === 1 && keys[0] === 'change') {
    const change = (answer as { change: unknown }).change
    if (change === null || typeof change !== 'object' || Array.isArray(change))
      return { kind: 'invalid', problem: '`change` must be an object of the fields to change.' }
    const fields = Object.keys(change)
    const allowed = Object.keys(spec.changes)
    const outside = fields.filter((field) => !allowed.includes(field))
    if (outside.length > 0)
      return {
        kind: 'ignored',
        problem:
          allowed.length === 0
            ? `${point} lets a hook change nothing, so its change was ignored.`
            : `${point} lets a hook change only ${allowed.map((field) => `\`${field}\``).join(', ')}, so its change to ${outside.map((field) => `\`${field}\``).join(', ')} was ignored.`,
      }
    for (const field of fields) {
      const problem = spec.changes[field]!((change as Record<string, unknown>)[field])
      if (problem) return { kind: 'ignored', problem: `its \`${field}\` ${problem} The change was ignored.` }
    }
    if (fields.length === 0) return { kind: 'pass' }
    return { kind: 'change', event: { ...event, ...(change as Record<string, unknown>) }, changed: fields }
  }
  return { kind: 'invalid', problem: 'a hook answers nothing, { deny: reason } or { change: { … } }.' }
}

/** The approval's line for each point an extension hooks, in the table's order. */
export function extensionHookApprovalLines(points: readonly string[]): string[] {
  return EXTENSION_HOOK_POINTS.filter((point) => points.includes(point)).map(
    (point) => EXTENSION_HOOK_SPECS[point].approval,
  )
}

/** The guide's table of points. */
export function extensionHookReference(): string {
  const escape = (value: string) => value.replaceAll('|', '\\|')
  return [
    '| Point | Event | Answers | May change | When |',
    '|---|---|---|---|---|',
    ...EXTENSION_HOOK_POINTS.map((point) => {
      const spec = EXTENSION_HOOK_SPECS[point]
      const changes = Object.keys(spec.changes)
      return `| \`${point}\` | \`${escape(spec.event)}\` | ${spec.decides ? '`{ deny }`, `{ change }` or nothing' : 'nothing: it observes'} | ${changes.length ? changes.map((field) => `\`${field}\``).join(', ') : '—'} | ${escape(spec.summary)} |`
    }),
  ].join('\n')
}
