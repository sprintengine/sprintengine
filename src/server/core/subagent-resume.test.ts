import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationSubagent } from '../../../packages/conversation-protocol/src/public'
import type { AgentState } from '../../shared/agent-state'
import type { ConversationEvent, ConversationPromptHookAs } from '../../shared/conversation-runtime'
import { ownerInvoker } from '../../main/module-host/extension-invocation'
import type { ExtensionHookOutcome, ExtensionHooks } from '../extensions/hooks/extension-hooks'
import type { McpConnectionContext, McpToolResult } from '../../shared/modules/mcp-tools'
import { createSubagentTools } from '../../main/automation/subagent-tools'
import { SUBAGENT_TASK_ORIGIN } from '../../main/conversation-launch-service'
import { ConversationRuntime } from '../../main/conversation-runtime'
import type {
  ConversationProviderAdapter,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from '../../main/providers/conversation-provider-adapter'
import { MOCK_CONVERSATION_CAPABILITIES } from '../../main/providers/mock-conversation-provider'
import { createSubagentLifecycle } from '../../main/subagent-lifecycle'
import { createConversationGatewayHost, type ConversationListWorkspace } from './conversation-host'

// `subagent.resume` end to end on this machine: the tool, the sub-agent's
// lifecycle, the chat's host and runtime, down to what the CLI's adapter is
// asked to do. A resumed reviewer goes on in the CLI session it ran in, on the
// model, effort, preset and read-only mode its record holds, and stays one
// row in its parent's Subagents list. Each CLI's adapter turning those into
// its own resume is tested beside it (Claude Code's session id, Codex's
// thread with the model and sandbox named).

const WORKSPACE = 'workspace'
const PARENT = 'agent-parent'
const REVIEWER = 'agent-reviewer'
const PROVIDER = 'recording-provider'
const caller = { metadata: { kind: 'studio-agent', workspaceId: WORKSPACE, agentId: PARENT } } as McpConnectionContext

function emitted(
  input: MockAdapterSessionInput,
  type: ConversationEvent['type'],
  payload?: Record<string, unknown>,
): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload,
  }
}

/** A CLI that keeps its own session, as Claude Code and Codex do, and says what it was asked. */
function recordingProvider() {
  const starts: MockAdapterSessionInput[] = []
  const turns: MockAdapterTurnInput[] = []
  const adapter: ConversationProviderAdapter = {
    id: PROVIDER,
    displayName: 'Recording provider',
    sessions: 'stateful',
    capabilities: {
      ...MOCK_CONVERSATION_CAPABILITIES,
      resume: true,
      askMode: true,
      reasoningEfforts: ['low', 'medium', 'high'],
    },
    listModels: () => ['gpt-6.1-sol'],
    startSession: (input) => {
      starts.push(input)
      return [emitted(input, 'session_started'), emitted(input, 'session_ready')]
    },
    sendTurn: (input) => {
      turns.push(input)
      // Answers the round its message names, whichever process it runs in.
      const round = /Round (\d+)/u.exec(input.message)?.[1] ?? '1'
      return [
        emitted(input, 'turn_started', { turnId: input.turnId }),
        // Its CLI session, which the next start resumes.
        emitted(input, 'session_updated', { providerSessionId: 'cli-session-1' }),
        emitted(input, 'content_delta', { turnId: input.turnId, text: `Round ${round}: no findings.` }),
        emitted(input, 'turn_completed', { turnId: input.turnId }),
      ]
    },
    resolveApproval: () => [],
    interrupt: (input) => [emitted(input, 'turn_failed', { reason: 'interrupted' })],
    stopSession: (input) => [emitted(input, 'session_closed')],
  }
  return { adapter, starts, turns }
}

function reviewerRecords(): Record<string, AgentState> {
  return {
    [PARENT]: {
      name: 'Lead',
      runtimeKind: 'conversation',
      conversation: { providerId: PROVIDER, modelId: 'x' },
    } as AgentState,
    // As subagent.start writes a read-only reviewer on a named model and effort.
    [REVIEWER]: {
      name: 'Codex · GPT 6.1 Sol',
      runtimeKind: 'conversation',
      conversation: { providerId: PROVIDER, modelId: 'gpt-6.1-sol' },
      cliPermissionPreset: 'manual',
      conversationMode: 'ask',
      conversationModeHeld: true,
      conversationReasoningEffort: 'high',
      subagentOf: { agentId: PARENT, startedAt: 1, task: 'Review the change' },
      subagentReadOnly: true,
    } as AgentState,
  }
}

/** This machine's chats over one folder and one set of records: booted again, it is the app after a restart. */
function boot(workspaceRoot: string, agents: Record<string, AgentState>, extensionHooks?: ExtensionHooks) {
  const provider = recordingProvider()
  const record = { name: 'Project', createdAt: 1, agents } as unknown as ConversationListWorkspace
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    ...(extensionHooks ? { extensionHooks, starterInvoker: () => ownerInvoker(null, 'the parent agent') } : {}),
    heldChatMode: ({ agentId }) => {
      const agent = agents[agentId]
      return agent?.conversationModeHeld && agent.conversationMode !== 'default' ? agent.conversationMode : undefined
    },
  })
  const registry = {
    workspaceOf: () => record,
    reasoningEffortOf: ({ agentId }: { agentId: string }) => agents[agentId]?.conversationReasoningEffort,
    subagentChanges: () => () => undefined,
  }
  const host = (origin?: typeof SUBAGENT_TASK_ORIGIN, hookAs?: ConversationPromptHookAs) =>
    createConversationGatewayHost(
      runtime,
      () => workspaceRoot,
      () => [{ workspaceRoot, workspaceId: WORKSPACE }],
      () => 'manual',
      undefined,
      undefined,
      undefined,
      { ...registry, ...(origin ? { sendOrigin: origin } : {}), ...(hookAs ? { sendHookAs: hookAs } : {}) },
    )
  const latest = (agentId: string) => {
    const listed = runtime.listSessions({ workspaceId: WORKSPACE, agentId })
    return listed.ok ? [...listed.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] : undefined
  }
  const lifecycle = createSubagentLifecycle({
    agentsOf: () => agents,
    workspaceIds: () => [WORKSPACE],
    writeEnd: ({ agentId }, subagentEnd) => {
      agents[agentId] = { ...agents[agentId]!, subagentEnd }
    },
    writeRound: ({ agentId }, subagentRound) => {
      const { subagentEnd: _ended, ...rest } = agents[agentId]!
      agents[agentId] = { ...rest, subagentRound } as AgentState
    },
    removeAgent: () => undefined,
    session: ({ agentId }) => latest(agentId),
    interrupt: (sessionId) => runtime.interrupt({ sessionId }),
    rest: (sessionId) => runtime.suspendSession({ sessionId }),
    readEvents: async ({ agentId }, turns) => {
      const read = await runtime.readConversationSync(
        { workspaceRoot, workspaceId: WORKSPACE, agentId },
        { turnLimit: turns },
      )
      if (!read.ok) return []
      return read.kind === 'snapshot' ? read.page.events : read.events
    },
    deleteTranscript: async () => undefined,
  })
  const userMessages: ConversationEvent[] = []
  runtime.onEvent((event) => {
    lifecycle.onConversationEvent(event)
    if (event.type === 'user_message') userMessages.push(event)
  })

  const tools = createSubagentTools({
    launch: async () => {
      throw new Error('A resume starts nothing new.')
    },
    resolveAgentPermissionPreset: () => 'bypass',
    isKnownCli: () => true,
    subagents: lifecycle,
    // As the gateway sends it: the parent's words, for the prompt hooks, as the parent.
    sendTask: async ({ workspaceId, agentId }, message, starter) => {
      const taskHost = host(SUBAGENT_TASK_ORIGIN, { inputKind: 'subagent', from: 'agent', starter })
      const key = taskHost.resolveKey(workspaceId, agentId)
      if (!key) return { ok: false, message: 'No folder.' }
      const sent = await taskHost.command(key, 'studio-subagent-tasks', randomUUID(), { kind: 'send', message })
      return sent.ok ? { ok: true } : { ok: false, message: sent.message ?? 'Refused.' }
    },
    providerResumes: (providerId) => runtime.getProviderCapabilities(providerId)?.resume === true,
    chats: {
      agentsOf: (workspaceId) => (workspaceId === WORKSPACE ? agents : null),
      session: (_workspaceId, agentId) => latest(agentId),
    },
  })
  const call = (name: string, args: Record<string, unknown>) =>
    tools.find((tool) => tool.name === name)!.handler(args, caller) as Promise<McpToolResult>
  return { runtime, provider, userMessages, call, listHost: host() }
}

/** A reviewer that has done its first task, as the launch sends it, and is at rest. */
async function fixture(extensionHooks?: ExtensionHooks) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'subagent-resume-'))
  const agents = reviewerRecords()
  const app = boot(workspaceRoot, agents, extensionHooks)
  const first = await app.runtime.startSession({
    workspaceRoot,
    workspaceId: WORKSPACE,
    agentId: REVIEWER,
    providerId: PROVIDER,
    modelId: 'gpt-6.1-sol',
    permissionPreset: 'manual',
  })
  assert.ok(first.ok)
  const sent = await app.runtime.sendTurn({
    sessionId: first.session.sessionId,
    message: 'Act as the review sub-agent for this task.\n\nReview the change',
    reasoningEffort: 'high',
    mode: 'ask',
    origin: SUBAGENT_TASK_ORIGIN,
  })
  assert.ok(sent.ok)
  assert.equal(agents[REVIEWER]?.subagentEnd?.status, 'completed')
  await app.runtime.suspendSession({ sessionId: first.session.sessionId })
  const running = [app.runtime]
  return {
    agents,
    app,
    /** Quit and start again: the records and the transcripts are what is left. */
    async restart() {
      await app.runtime.shutdown()
      const again = boot(workspaceRoot, agents)
      running.push(again.runtime)
      return again
    },
    async close() {
      for (const runtime of running) await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

const body = (result: McpToolResult) => result.structuredContent as Record<string, unknown>

const ROUND_2 = { subagentId: REVIEWER, task: 'Round 2: check the two fixes.', wait: true, timeoutMs: 10_000 }

test('a resumed reviewer runs its next round on the model, effort and read-only mode it had, and its result is that round’s', async () => {
  const f = await fixture()
  try {
    const resumed = await f.app.call('subagent.resume', ROUND_2)
    assert.equal(resumed.isError, undefined, JSON.stringify(resumed.structuredContent))
    const answer = body(resumed)
    assert.equal(answer.status, 'completed')
    assert.equal(answer.round, 2)
    assert.equal(answer.result, 'Round 2: no findings.', "this round's result, not the first's")
    assert.equal(answer.model, 'gpt-6.1-sol')
    assert.equal(answer.readOnly, true)
    assert.equal(answer.mode, 'ask')

    // At rest in this process, the chat's own session takes the round: the
    // CLI's adapter still holds its session, and is handed the turn.
    const turn = f.app.provider.turns[1]!
    assert.match(turn.message, /Round 2: check the two fixes\./)
    assert.equal(turn.modelId, 'gpt-6.1-sol')
    assert.equal(turn.reasoningEffort, 'high')
    assert.equal(turn.mode, 'ask', 'read-only still')
    assert.equal(turn.permissionPreset, 'manual')
    assert.equal(turn.sessionId, f.app.provider.turns[0]!.sessionId, 'the same session')
    // Studio's message, as its first task was, not the person's.
    assert.deepEqual(f.app.userMessages.at(-1)?.payload?.origin, SUBAGENT_TASK_ORIGIN)

    // One sub-agent on its parent's list, a round further on.
    const told: ConversationSubagent[][] = []
    const stop = f.app.listHost.watchSubagents!({ workspaceId: WORKSPACE, agentId: PARENT }, (rows) => told.push(rows))
    stop()
    assert.equal(told[0]?.length, 1)
    assert.equal(told[0]![0]!.agentId, REVIEWER)
    assert.equal(told[0]![0]!.status, 'completed')
    assert.equal(told[0]![0]!.round, 2)
    assert.equal(told[0]![0]!.roundStartedAt, f.agents[REVIEWER]?.subagentRound?.startedAt)

    // subagent.status reads the same round.
    const status = body(await f.app.call('subagent.status', { subagentId: REVIEWER }))
    assert.equal(status.round, 2)
    assert.equal(status.result, 'Round 2: no findings.')
  } finally {
    await f.close()
  }
})

test('after a restart, a resume starts the CLI on its own session again, with the model and preset named', async () => {
  const f = await fixture()
  try {
    const app = await f.restart()
    const resumed = await app.call('subagent.resume', ROUND_2)
    assert.equal(resumed.isError, undefined, JSON.stringify(resumed.structuredContent))
    assert.equal(body(resumed).status, 'completed')
    assert.equal(body(resumed).result, 'Round 2: no findings.')

    const start = app.provider.starts[0]!
    assert.equal(start.resumeSessionId, 'cli-session-1', "the CLI's own session, resumed")
    assert.equal(start.modelId, 'gpt-6.1-sol', 'never the CLI config default')
    assert.equal(start.permissionPreset, 'manual')
    const turn = app.provider.turns[0]!
    assert.equal(turn.modelId, 'gpt-6.1-sol')
    assert.equal(turn.reasoningEffort, 'high')
    assert.equal(turn.mode, 'ask')
  } finally {
    await f.close()
  }
})

// The next task is the parent agent's words: it meets the extensions'
// `agent.prompt.before` at the runtime's door, through the chat's host, as the
// parent; a refusal ends the round as failed, in the extension's words.
test('a resumed task meets the prompt hooks as the parent agent’s, and a refusal fails the round', async () => {
  const heard: Array<{ event: Record<string, unknown>; invoker: string }> = []
  const hooks: ExtensionHooks = {
    wants: (point) => point === 'agent.prompt.before',
    run: async (_point, event, invoker) => {
      heard.push({ event: event as Record<string, unknown>, invoker: invoker.label })
      return {
        kind: 'deny',
        extensionId: 'acme.guard',
        displayName: 'Guard',
        reason: 'no second rounds',
        failed: false,
      } as ExtensionHookOutcome<never>
    },
    notify: () => undefined,
    bind: () => undefined,
  }
  const f = await fixture(hooks)
  try {
    heard.length = 0
    const resumed = await f.app.call('subagent.resume', ROUND_2)
    assert.equal(heard.length, 1)
    assert.equal(heard[0]?.invoker, 'the parent agent')
    assert.equal(heard[0]?.event.inputKind, 'subagent')
    assert.equal(heard[0]?.event.from, 'agent')
    assert.equal(heard[0]?.event.prompt, 'Round 2: check the two fixes.')
    assert.equal(f.app.provider.turns.length, 1, 'the refused task never reaches the CLI')
    assert.equal(body(resumed).status, 'failed')
    assert.match(
      String(f.agents[REVIEWER]?.subagentEnd?.error),
      /"Guard" \(acme\.guard\) refused this: no second rounds/,
    )
  } finally {
    await f.close()
  }
})
