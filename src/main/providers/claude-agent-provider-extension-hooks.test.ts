import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { ConversationToolHooks, MockAdapterTurnInput } from './conversation-provider-adapter'
import { createExtensionHooks, extensionHookRefusal } from '../../server/extensions/hooks/extension-hooks'
import { ownerInvoker } from '../module-host/extension-invocation'
import { startWorkerHarness, until, type TestExtension, type WorkerHarness } from '../../../tests/extension-workers'

// A Claude Code chat's tool calls meet extensions' hooks in the CLI's own
// PreToolUse and PostToolUse hooks, with real extension workers behind them.
// The stand-in child does what Claude Code does with a Bash call: it asks the
// PreToolUse hook, runs the command (with the input the hook hands back) or
// answers with the refusal, reports PostToolUse, and ends the turn. A guard
// that hangs costs the turn its time limit and no more: the turn goes on, or
// the call is refused cleanly, by the guard's `onError`.

type HookOutput = {
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
  }
}
type Hook = (input: Record<string, unknown>, toolUseId: string, context: { signal: AbortSignal }) => Promise<HookOutput>

const GUARD_DIR = join(process.cwd(), 'packages/extension-sdk/examples/tool-guard')
const GUARD: TestExtension = {
  id: 'tool-guard',
  name: 'Tool guard',
  main: readFileSync(join(GUARD_DIR, 'main.cjs'), 'utf8'),
  hooks: JSON.parse(readFileSync(join(GUARD_DIR, 'extension.json'), 'utf8')).contributes.hooks,
}

const roots: string[] = []
let workers: WorkerHarness | null = null
afterEach(async () => {
  await workers?.close()
  workers = null
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function toolHooksOver(extensions: TestExtension[]): ConversationToolHooks {
  workers = startWorkerHarness(extensions)
  const hooks = createExtensionHooks()
  hooks.bind(workers.workers)
  const chat = { agent: CLAUDE_AGENT_PROVIDER_ID, workspaceId: 'ws-1', agentId: 'agent-1' }
  // As the runtime builds them (conversation-runtime.ts toolHooksFor).
  return {
    before: (call) =>
      hooks.wants('agent.tool.before')
        ? hooks
            .run('agent.tool.before', { ...chat, ...call }, ownerInvoker())
            .then((outcome) =>
              outcome.kind === 'deny'
                ? { kind: 'deny' as const, reason: extensionHookRefusal(outcome) }
                : { kind: 'continue' as const, input: outcome.event.input },
            )
        : null,
    after: (call) => hooks.notify('agent.tool.after', { ...chat, ...call }, ownerInvoker()),
  }
}

async function chat(toolHooks: ConversationToolHooks) {
  const root = await mkdtemp(join(tmpdir(), 'claude-hooks-'))
  roots.push(root)
  const ran: string[] = []
  let calls = 0
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    const all = params.options.hooks as Record<string, { hooks: Hook[] }[]>
    const pre = all.PreToolUse![0]!.hooks[0]!
    const post = all.PostToolUse![0]!.hooks[0]!
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    const signal = new AbortController().signal
    void (async () => {
      for await (const message of params.prompt) {
        const command = String((message.message as { content: unknown }).content)
        const id = `toolu_${++calls}`
        pending.push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
          parent_tool_use_id: null,
        })
        const answer = await pre(
          { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id },
          id,
          { signal },
        )
        const output = answer.hookSpecificOutput
        const denied = output?.permissionDecision === 'deny'
        const runs = String(output?.updatedInput?.command ?? command)
        if (!denied) {
          ran.push(runs)
          await post(
            {
              hook_event_name: 'PostToolUse',
              tool_name: 'Bash',
              tool_input: { command: runs },
              tool_response: { stdout: 'done' },
              tool_use_id: id,
            },
            id,
            { signal },
          )
        }
        pending.push({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                content: denied ? output!.permissionDecisionReason : 'done',
                ...(denied ? { is_error: true } : {}),
              },
            ],
          },
          parent_tool_use_id: null,
        })
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'hooks' })
        wake?.()
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => {
        ended = true
        wake?.()
      },
      setPermissionMode: async () => undefined,
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      mcpServerStatus: async () => [],
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    resolveStudioMcpServer: async () => null,
  })
  let turns = 0
  const run = async (message: string) => {
    const input: MockAdapterTurnInput = {
      sessionId: 'conv_1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      providerId: CLAUDE_AGENT_PROVIDER_ID,
      modelId: 'sonnet',
      workspaceRoot: root,
      turnId: `turn_${++turns}`,
      requestId: `approval_${turns}`,
      message,
      permissionPreset: 'bypass',
      toolHooks,
    }
    if (turns === 1) await adapter.startSession(input)
    const events: ConversationEvent[] = []
    for await (const event of (await adapter.sendTurn(input)) as AsyncIterable<ConversationEvent>) events.push(event)
    return events
  }
  return { adapter, run, ran }
}

const toolOutput = (events: ConversationEvent[]) => events.find((event) => event.type === 'tool_output')?.payload
const ended = (events: ConversationEvent[]) => events.at(-1)?.type

test('the sample guard refuses rm -rf in a Claude Code chat, even under bypass, naming the extension; other calls run', async () => {
  const { adapter, run, ran } = await chat(toolHooksOver([GUARD]))
  const refused = await run('rm -rf build')
  expect(toolOutput(refused)).toMatchObject({ status: 'declined' })
  expect(String(toolOutput(refused)?.output)).toContain(
    'The extension "Tool guard" (local.tool-guard) refused this: it deletes files recursively and by force',
  )
  expect(ended(refused)).toBe('turn_completed')
  const allowed = await run('ls build')
  expect(toolOutput(allowed)).toMatchObject({ status: 'ok' })
  expect(ran).toEqual(['ls build'])
  // Its after hook heard the call that ran.
  await until(
    () => {
      try {
        return readFileSync(join(workers!.logDir, 'local.tool-guard.log'), 'utf8').includes('finished: Bash')
      } catch {
        return false
      }
    },
    10_000,
    'the after hook',
  )
  await adapter.disposeAll()
})

test('a hook’s changed input is what the CLI runs', async () => {
  const { adapter, run, ran } = await chat(
    toolHooksOver([
      {
        id: 'dry-run',
        main: `exports.activate = (studio) => studio.registerHooks({ 'agent.tool.before': (event) => ({ change: { input: { ...event.input, command: event.input.command + ' --dry-run' } } }) })`,
        hooks: [{ point: 'agent.tool.before' }],
      },
    ]),
  )
  await run('make deploy')
  expect(ran).toEqual(['make deploy --dry-run'])
  await adapter.disposeAll()
})

for (const onError of ['pass', 'deny'] as const) {
  test(`a guard that hangs costs the turn its time limit, and the turn ${onError === 'pass' ? 'runs the call' : 'refuses it cleanly'} (onError "${onError}")`, async () => {
    const { adapter, run, ran } = await chat(
      toolHooksOver([
        {
          id: 'hangs',
          name: 'Hangs',
          main: `exports.activate = (studio) => studio.registerHooks({ 'agent.tool.before': () => new Promise(() => undefined) })`,
          hooks: [{ point: 'agent.tool.before', onError }],
        },
      ]),
    )
    const began = Date.now()
    const events = await run('ls')
    const took = Date.now() - began
    // Its worker's start (once) and its two seconds; never the turn's whole life.
    expect(took).toBeLessThan(8_000)
    expect(took).toBeGreaterThanOrEqual(1_900)
    expect(ended(events)).toBe('turn_completed')
    if (onError === 'pass') {
      expect(ran).toEqual(['ls'])
      expect(toolOutput(events)).toMatchObject({ status: 'ok' })
    } else {
      expect(ran).toEqual([])
      expect(toolOutput(events)).toMatchObject({ status: 'declined' })
      expect(String(toolOutput(events)?.output)).toContain(
        'The extension "Hangs" (local.hangs) refused this: its hook failed, and it refuses when it fails',
      )
    }
    await adapter.disposeAll()
  })
}
