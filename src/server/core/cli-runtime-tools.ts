import type { McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import type { StudioCliRuntimes } from './studio-cli-runtimes'

// The agents' `cli.runtime.list`: the agent CLIs this Studio runs, from its
// own core (`studio-cli-runtimes.ts`), as `cliRuntimes.list` answers on the
// Studio protocol. Every Studio serves it, a WSL distribution's and an SSH
// machine's included, so an agent hears what it can launch where it runs.

export type CliRuntimeToolsDeps = {
  /** The core's own list (`core.cliRuntimes.list`). */
  listCliRuntimes: StudioCliRuntimes['list']
}

export function createCliRuntimeTools(deps: CliRuntimeToolsDeps): McpToolRegistration[] {
  // The answer to "what may I pass as a cli / model / effort?".
  // Before this, `agent.launch.cliModel` was a blind string an agent could only
  // guess at from a tool description's example. Reports the CLI plugin registry as the app itself resolves it —
  // declared, not probed: it says what the registry HOLDS, never whether the
  // binary is installed on this machine (that probe spawns a login shell per
  // CLI and belongs to the app's own availability refresh).
  const cliRuntimeList: McpToolRegistration = {
    name: 'cli.runtime.list',
    description:
      'List the agent CLIs this app can launch, with the model ids and reasoning-effort levels each one ' +
      'offers. Read it before passing `cli`/`cliModel` to agent.launch — those are otherwise blind strings. Only rows with `agentSelectable: ' +
      'true` may be launched as agents (the CLI reports agent state via lifecycle hooks); ' +
      'a false row is registry-held for install/detect only and every launch door refuses it. ' +
      '`supportsModelSelection` says whether a model can be passed at all; a CLI whose `allowCustomModelId` ' +
      'is true also accepts model ids its catalog does not list. A level outside `reasoningLevels` is ' +
      'refused by the CLI itself. This reports what the registry HOLDS, not what is installed on this ' +
      'machine — it never probes for binaries. ' +
      'Each row may carry a `catalog`: what the model picker here offers for that CLI, read the way it reads ' +
      'it — `models` is the list the CLI reported about itself followed by the ids added in Settings, ' +
      'empty until the CLI has reported (or for a CLI that reports none) and nobody has added one, ' +
      "each marked with the `family` row it renders under (a model's context " +
      'windows are one row; `contextLabel` names the window, `familyDefault` the id the row selects), and ' +
      '`isNew` where the picker shows New; `providerLabel` is the line under each row, naming the CLI a ' +
      'hosted runtime rides (`hostedVia`); `conversational` says whether conversation.create can start it as ' +
      "a chat. The CLI's own default model is not a row of `models`: omit `cliModel` for it.",
    inputSchema: {
      type: 'object',
      properties: {
        cli: {
          type: 'string',
          description: 'Report only this CLI plugin id. Unknown ids fail rather than returning an empty list.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (args) => {
      const invalid = firstInvalidOptionalString(args, ['cli'])
      if (invalid) return invalid
      const listed = await deps.listCliRuntimes(optionalString(args.cli) ?? null)
      return listed.ok ? success({ clis: listed.clis }) : failure(listed.code, listed.message)
    },
  }

  return [cliRuntimeList]
}

function success(structured: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

function failure(code: string, message: string): McpToolResult {
  const structured = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function firstInvalidOptionalString(args: Record<string, unknown>, keys: string[]): McpToolResult | null {
  for (const key of keys) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      return failure('invalid_arguments', `"${key}" must be a string when provided.`)
    }
  }
  return null
}
