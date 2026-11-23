import type { ExtensionAgentToolCall, MainHost } from '@sprintengine/extension-sdk'

// The worker: Studio loads extension/src/main.ts in Node, as written, and calls
// `activate` with a `studio` for this extension. It hooks the points
// extension.json lists (`contributes.hooks`):
//
// - `agent.tool.before` runs before an agent's tool call. Answer nothing to
//   let it run, `{ change: { input } }` to change its arguments, or
//   `{ deny: reason }` to refuse it: the agent reads the reason, with this
//   extension's name. Its entry says `"onError": "deny"`, so if this hook
//   throws or takes more than two seconds, the call is refused rather than let
//   through. Decide before any other awaited call.
// - `agent.tool.after` hears each finished call. It only observes; its output
//   goes to the extension's log.
//
// See the guide's hooks topic for every point, and who a hook runs as.

/** Why a call is refused, or null to let it run. Change the rule to yours. */
export function refusal(call: ExtensionAgentToolCall): string | null {
  const command = typeof call.input.command === 'string' ? call.input.command : null
  if (call.tool !== 'Bash' || command === null) return null
  if (/\bgit\s+push\b[^|;&]*\s(?:--force|-f)\b/.test(command))
    return 'it force-pushes. Push without --force, or ask the person to do it.'
  return null
}

export function activate(studio: MainHost): void {
  studio.registerHooks({
    'agent.tool.before': (call) => {
      const reason = refusal(call)
      return reason ? { deny: reason } : undefined
    },
    'agent.tool.after': (call) => {
      console.log(`${call.failed ? 'failed' : 'finished'}: ${call.tool}`)
    },
  })
}
