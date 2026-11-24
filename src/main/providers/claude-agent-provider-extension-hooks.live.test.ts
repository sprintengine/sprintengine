import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import type { ConversationEvent, ConversationPermissionPreset } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { ConversationToolHooks, MockAdapterTurnInput } from './conversation-provider-adapter'

// The real Claude Code CLI, signed in, and a model: an extension's changed
// tool input (`updatedInput` in the CLI's PreToolUse answer) is what the CLI
// runs, under Bypass, Auto and Manual. Opt-in, since it needs a signed-in CLI
// and spends a few small turns: `STUDIO_LIVE_CLAUDE=1 npx vitest run <this file>`.
// The stand-in child in claude-agent-provider-extension-hooks.test.ts holds
// the provider's side of the contract in every run.

const live = process.env.STUDIO_LIVE_CLAUDE === '1'

/** A hook that turns `echo original` into `echo changed`, as an extension's `{ change: { input } }` would. */
function changingHooks(): { hooks: ConversationToolHooks; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    hooks: {
      before: (call) => {
        const command = typeof call.input.command === 'string' ? call.input.command : ''
        asked.push(`${call.tool}: ${command}`)
        if (call.tool !== 'Bash' || !command.includes('echo original')) return null
        return Promise.resolve({
          kind: 'continue' as const,
          input: { ...call.input, command: command.replace('echo original', 'echo changed') },
        })
      },
      after: () => undefined,
    },
  }
}

for (const preset of ['bypass', 'auto', 'manual'] as const satisfies readonly ConversationPermissionPreset[]) {
  test.skipIf(!live)(
    `under ${preset}, the real CLI runs the command an extension changed`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'claude-live-hooks-'))
      // The `claude` on this PATH, with this shell's environment (its sign-in).
      const adapter = createClaudeAgentProvider({
        resolveExecutable: async () => execFileSync('which', ['claude'], { encoding: 'utf8' }).trim(),
        buildEnv: () =>
          Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
        resolveStudioMcpServer: async () => null,
      })
      const { hooks, asked } = changingHooks()
      const approvals: Array<Record<string, unknown>> = []
      try {
        const input: MockAdapterTurnInput = {
          sessionId: `live_${preset}`,
          workspaceId: 'ws-live',
          agentId: 'agent-live',
          providerId: CLAUDE_AGENT_PROVIDER_ID,
          modelId: 'haiku',
          workspaceRoot: root,
          turnId: 'turn_1',
          requestId: 'approval_1',
          message:
            'Run exactly this shell command with the Bash tool, once, and then reply with only its output: echo original',
          permissionPreset: preset,
          toolHooks: hooks,
        }
        await adapter.startSession(input)
        const events: ConversationEvent[] = []
        for await (const event of (await adapter.sendTurn(input)) as AsyncIterable<ConversationEvent>) {
          events.push(event)
          // Manual asks the person: the card shows the call, and they allow it.
          if (event.type === 'approval_requested') {
            const payload = event.payload as Record<string, unknown>
            approvals.push(payload)
            adapter.resolveApproval({ ...input, requestId: String(payload.requestId), approved: true })
          }
        }
        const outputs = events
          .filter((event) => event.type === 'tool_output')
          .map((event) => String((event.payload as { output?: unknown }).output ?? ''))
        console.log(
          JSON.stringify({
            preset,
            asked,
            approvals: approvals.map((a) => a.input),
            outputs,
            end: events.at(-1)?.type,
          }),
        )
        expect(asked.some((call) => call.includes('echo original'))).toBe(true)
        expect(outputs.join('\n')).toContain('changed')
        expect(outputs.join('\n')).not.toContain('original')
        if (preset === 'manual') expect(approvals.length).toBeGreaterThan(0)
      } finally {
        await adapter.disposeAll()
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
}
