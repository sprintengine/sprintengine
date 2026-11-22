# Agent hooks

A hook lets the worker check, change or refuse what an agent or Studio is
about to do (a tool call, a prompt, a launch, a new workspace, a save), or hear
what it did. List each point in extension.json, worker tier only, and serve it
from `activate` with `studio.registerHooks`:

```json
{
  "tier": "worker",
  "main": "dist/main.cjs",
  "contributes": {
    "hooks": [{ "point": "agent.tool.before", "onError": "deny" }, { "point": "agent.tool.after" }]
  }
}
```

```ts
import type { MainHost } from '@sprintengine/extension-sdk'

export function activate(studio: MainHost): void {
  studio.registerHooks({
    'agent.tool.before': (event) => {
      const command = typeof event.input.command === 'string' ? event.input.command : ''
      if (event.tool === 'Bash' && /\brm\s+-rf\b/.test(command)) return { deny: 'it deletes files recursively.' }
      return undefined
    },
    'agent.tool.after': (event) => console.log(`${event.tool} ${event.failed ? 'failed' : 'finished'}`),
  })
}
```

`examples/tool-guard/` in this package is a complete one, and the `hook-guard`
template starts a project from it.

## What a hook answers

- **Nothing** (`undefined`): the action goes on, as the next extension's hook
  leaves it.
- **`{ change: { … } }`**: the fields the point lets a hook change, and only
  those. A change to any other field, or a value that does not fit, is
  ignored, and your log says so.
- **`{ deny: reason }`**: the action is refused, and no later hook runs. The
  reason (one line, at most 500 characters) is shown with your extension's
  name: to the agent, which reads it as the tool call's result; to the person,
  in the editor or as the action's error.

A `.after` point only observes: Studio does not wait for it, and its answer is
ignored.

## Order, time and failure

- Studio runs the hooks of every extension that lists a point, one after
  another, in the order of their install keys (`local.a-guard` before
  `local.b-format`). Each sees the event as the ones before it changed it.
- Each hook has **two seconds**. A worker that is not running is started
  first, and its start is not counted.
- A hook that throws, answers late, answers something that is not one of the
  three answers above, or whose worker crashed or did not start, counts as
  having **passed**, unless its entry says `"onError": "deny"`: then the
  action is refused, naming your extension, so a guard fails closed. An
  extension switched off or changed while its hook ran passes either way.
- Decide before any other awaited call: an awaited call into Studio ahead of
  your `{ deny }` can fail or take the two seconds.
- A point no extension lists costs nothing: Studio does not wait, ask or
  start anything.

## Who a hook runs as

A hook runs as whoever set off the action it guards: the person, the paired
device or app that started the chat, or the extension whose call it is. What
your hook asks of Studio while it runs is held to them, as well as to your own
permissions: a hook on a chat a phone started cannot read what the phone may
not. A hook can never widen what anyone may do.

## Where hooks run

Hooks run on the Studio that holds the action: the one whose chat, terminal,
workspace or file it is. A chat on a paired machine is decided by the
extensions installed on that machine's Studio, and a save of a file on another
machine by that machine's.

## What each point reaches today

- `agent.tool.before` and `.after`: **Claude Code chats.** Studio answers
  Claude Code's own PreToolUse hook, under every permission mode, bypass
  included; a changed `input` is what the tool runs, and still goes through
  the chat's permission mode. Codex, Gemini, OpenCode, Cursor and
  OpenAI-compatible chats are not hooked yet: their runtimes ask Studio only
  when they want an approval, which bypass and auto never do, so a hook
  there could not be relied on. Agents in terminals are not hooked yet either:
  their CLI hooks report to Studio and do not wait for an answer.
- `agent.prompt.before`: every message to an agent that nobody typed, in a
  chat or a terminal, with `inputKind` saying which: the first message of a
  chat an agent, an extension or a schedule starts (`launch`); another
  agent's `conversation.send`, and an extension's message to its own chat or
  through the agent control plane (`send`); a sub-agent's task, started or
  resumed (`subagent`); an extension's background agent's (`companion`);
  Studio's notices (`notice`); a first message sent again after a stop cut it
  off (`recovery`); and a tour's prompt typed to its author (`tour`). A chat's
  are all checked at the one door every message to a chat comes through. A
  message the person types, from any machine, is never hooked.
- `terminal.write.before`: raw writes Studio, an extension or a tool makes
  into a terminal, with the Enter that ends one as its own field (`enter`).
  A person's keystrokes, from any machine, are never hooked.
- `agent.launch.before`: every new chat (from a window, a phone, a paired
  machine, an agent or an extension) and every agent started in a terminal.
  It refuses; it changes nothing.
- `workspace.create.before` and `.after`: a new chat's workspace, and one an
  agent's `workspace.create` or an extension asks for.
- `editor.save.before`: a save the person makes in Studio's editor, docked or
  popped out, of a text file on any machine whose Studio runs hooks. Autosave
  and an agent's own edits are not saves the person made.

## The points

<!-- generated:extension-hook-reference:start -->

| Point | Event | Answers | May change | When |
|---|---|---|---|---|
| `agent.launch.before` | `{ agent: string; where: 'chat' \| 'terminal'; workspaceId: string; model: string \| null; permission: string \| null; prompt: string \| null }` | `{ deny }`, `{ change }` or nothing | — | Studio is about to start an agent: a new chat, or an agent CLI in a terminal. Return `{ deny }` to refuse the start; the person (or the agent or extension that asked) is told why. |
| `agent.prompt.before` | `{ agent: string \| null; where: 'chat' \| 'terminal'; workspaceId: string \| null; agentId: string \| null; terminalId: string \| null; from: 'studio' \| 'extension' \| 'agent'; inputKind: 'launch' \| 'send' \| 'subagent' \| 'companion' \| 'notice' \| 'recovery' \| 'tour'; prompt: string }` | `{ deny }`, `{ change }` or nothing | `prompt` | Studio is about to hand an agent a message the person did not type (`inputKind` says which): a new agent’s first message from an agent, an extension or a schedule; another agent’s or an extension’s message; a sub-agent’s task; an extension’s background agent’s; a notice Studio sends; a first message sent again after a stop; a tour’s prompt. A message the person types, on any machine, is never hooked. Change `prompt`, or return `{ deny }` to refuse it. |
| `agent.tool.before` | `{ agent: string; workspaceId: string; agentId: string; tool: string; input: Record<string, unknown>; callId: string \| null }` | `{ deny }`, `{ change }` or nothing | `input` | An agent in a chat is about to run a tool. Return `{ deny }` to refuse the call (the agent reads the reason) or change `input`; the chat’s permission mode still asks the person as usual. Claude Code chats only for now: other runtimes have no hook before a tool runs that Studio can answer. |
| `agent.tool.after` | `{ agent: string; workspaceId: string; agentId: string; tool: string; input: Record<string, unknown>; callId: string \| null; output: unknown; failed: boolean }` | nothing: it observes | — | An agent in a chat finished a tool call, or it failed. Observe only: Studio does not wait for it. Claude Code chats only for now. |
| `terminal.write.before` | `{ terminalId: string; workspaceId: string \| null; agent: string \| null; from: 'studio' \| 'extension'; inputKind: 'send' \| 'notice'; text: string; enter: boolean }` | `{ deny }`, `{ change }` or nothing | `text`, `enter` | Studio is about to type into a terminal for someone other than a person at its keyboard: an extension’s or a tool’s raw write. Keystrokes from a person (on any machine) are never hooked, and a prompt to an agent takes `agent.prompt.before` instead. Change `text` or `enter`, or return `{ deny }` to refuse the write. |
| `workspace.create.before` | `{ for: 'chat' \| 'workspace'; name: string \| null; folderPath: string \| null; worktree: boolean }` | `{ deny }`, `{ change }` or nothing | `name` | Studio is about to make a workspace: for a new chat, or one an agent or extension asked for. Change `name`, or return `{ deny }` to refuse it. |
| `workspace.create.after` | `{ for: 'chat' \| 'workspace'; workspaceId: string; name: string; folderPath: string \| null; worktree: boolean }` | nothing: it observes | — | Studio made a workspace. Observe only: Studio does not wait for it. |
| `editor.save.before` | `{ path: string; text: string }` | `{ deny }`, `{ change }` or nothing | `text` | The person is about to save a text file from Studio’s editor, on whichever machine holds it. Change `text` (format on save), and the editor shows what was saved; or return `{ deny }` to refuse the save, and the editor shows the reason and keeps the edits unsaved. |

<!-- generated:extension-hook-reference:end -->

## Testing

`createFakeMainHost({ manifest })` serves your hooks too:
`fake.hooks.fire(point, event)` runs yours as Studio would, and answers what it
decided (`pass`, `deny` with its reason, `change` with the event as changed,
`ignored` or `invalid`).

```ts
const fake = createFakeMainHost({ manifest })
activate(fake.host)
const verdict = await fake.hooks.fire('agent.tool.before', {
  agent: 'claude-agent',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  tool: 'Bash',
  input: { command: 'rm -rf build' },
  callId: null,
})
assert.equal(verdict.kind, 'deny')
```

The approval names each point you hook in plain words ("Can check, change or
refuse your agents' tool calls"), and an update that hooks a point the
approved version did not asks the person again.
