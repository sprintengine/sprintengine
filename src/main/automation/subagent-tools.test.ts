import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentState } from '../../shared/agent-state'
import { isAgentLaunchingGatewayTool } from '../../shared/conversation/approvalRules'
import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { McpConnectionContext, McpToolResult } from '../../shared/modules/mcp-tools'
import { conversationProviderForCli } from '../../shared/conversation-harness'
import { STUDIO_MCP_SERVER_ID } from '../../shared/product-identity'
import type { LaunchedAgentLink } from '../agent-launch-notices'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import { createSubagentTools, distinctSubagentTitle, type SubagentToolsDeps } from './subagent-tools'
import { localOnlyGatewayToolReason } from './tailnet/tailnet-scopes'

const WORKSPACE = 'ws-1'
const PARENT = 'agent-parent'
const caller: McpConnectionContext = {
  metadata: { kind: 'studio-agent', workspaceId: WORKSPACE, agentId: PARENT },
} as McpConnectionContext

function chatRecord(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runtimeKind: 'conversation',
    conversation: { providerId: 'claude-agent', modelId: 'opus' },
    ...overrides,
  } as AgentState
}

function summary(overrides: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary {
  return {
    sessionId: 'conv',
    workspaceId: WORKSPACE,
    agentId: 'x',
    status: 'ready',
    ...overrides,
  } as ConversationSessionSummary
}

function harness(
  options: {
    ceiling?: NonNullable<ReturnType<SubagentToolsDeps['resolveAgentPermissionPreset']>>
    launched?: (request: ConversationLaunchRequest, childId: string) => ConversationLaunchResult
    result?: { text: string; truncated: boolean }
    /** Where a sub-agent's session stands, each time it is read. */
    sessions?: (agentId: string, reads: number) => ConversationSessionSummary | undefined
    /** How a resumed sub-agent's task send settles. */
    sent?: (agentId: string, message: string) => Promise<{ ok: true } | { ok: false; message: string }>
    /** Whether a provider's chats resume, for one with no session listed. */
    resumes?: (providerId: string) => boolean
  } = {},
) {
  const agents: Record<string, AgentState> = { [PARENT]: chatRecord() }
  const requests: ConversationLaunchRequest[] = []
  const links: LaunchedAgentLink[] = []
  const stops: string[] = []
  const dismissed: string[] = []
  const dismissedChats: string[] = []
  const tasks: { agentId: string; message: string; starter?: unknown }[] = []
  const reads = new Map<string, number>()
  let clock = 1_000
  const deps: SubagentToolsDeps = {
    launch: async (request) => {
      requests.push(request)
      const agentId = `agent-child-${requests.length}`
      const answer = options.launched?.(request, agentId)
      if (answer && !answer.ok) return answer
      agents[agentId] = chatRecord({
        name: request.name ?? '',
        conversation: {
          providerId: conversationProviderForCli(request.cli ?? '') ?? `${request.cli}-agent`,
          modelId: request.cliModel ?? 'default',
        },
        ...(request.permissionPreset ? { cliPermissionPreset: request.permissionPreset } : {}),
        ...(request.mode ? { conversationMode: request.mode } : {}),
        ...(request.subagentOf ? { subagentOf: request.subagentOf } : {}),
        ...(request.subagentReadOnly ? { subagentReadOnly: true as const } : {}),
      })
      return (
        answer ?? {
          ok: true,
          workspaceId: WORKSPACE,
          agentId,
          name: request.name ?? '',
          cli: request.cli ?? '',
          providerId: 'p',
          modelId: 'm',
          sessionId: `conv-${agentId}`,
        }
      )
    },
    resolveAgentPermissionPreset: () => options.ceiling ?? 'bypass',
    isKnownCli: (cli) => cli !== 'missing',
    displayNames: (cli, model) => ({ cli: cli === 'cursor' ? 'Cursor' : cli, model: model ? `Model ${model}` : null }),
    linkLaunchedAgent: (link) => (links.push(link), { linked: true }),
    dismissNotice: (sessionId, chat) => {
      dismissed.push(sessionId)
      if (chat) dismissedChats.push(chat.agentId)
    },
    subagents: {
      stop: async ({ agentId }) => {
        stops.push(agentId)
      },
      fail: ({ agentId }, error) => {
        agents[agentId] = { ...agents[agentId]!, subagentEnd: { at: clock, status: 'failed', error } }
      },
      result: async () => options.result ?? null,
      // As the lifecycle does: only an ended sub-agent takes a round.
      beginRound: ({ agentId }, task) => {
        const agent = agents[agentId]
        if (!agent?.subagentOf || !agent.subagentEnd) return null
        const round = { n: (agent.subagentRound?.n ?? 1) + 1, startedAt: clock, ...(task ? { task } : {}) }
        const { subagentEnd: _ended, ...rest } = agent
        agents[agentId] = { ...rest, subagentRound: round } as AgentState
        return round
      },
    },
    sendTask: async ({ agentId }, message, starter) => {
      tasks.push({ agentId, message, starter })
      return options.sent ? options.sent(agentId, message) : { ok: true }
    },
    providerResumes: (providerId) => options.resumes?.(providerId) ?? true,
    chats: {
      agentsOf: (workspaceId) => (workspaceId === WORKSPACE ? agents : null),
      session: (_workspaceId, agentId) => {
        const read = (reads.get(agentId) ?? 0) + 1
        reads.set(agentId, read)
        return (
          options.sessions?.(agentId, read) ??
          summary({ agentId, status: 'active', phase: 'running', turnStartedAt: 1 })
        )
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    },
  }
  const tools = createSubagentTools(deps)
  const call = (name: string, args: Record<string, unknown>, context: McpConnectionContext | undefined = caller) =>
    tools.find((tool) => tool.name === name)!.handler(args, context)
  return {
    agents,
    requests,
    links,
    stops,
    dismissed,
    dismissedChats,
    tasks,
    call,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

const code = (result: McpToolResult) => (result.structuredContent as { error?: { code?: string } }).error?.code
const body = (result: McpToolResult) => result.structuredContent as Record<string, unknown>
const finished = (agentId: string) => summary({ agentId, status: 'ready', phase: 'completed', lastTurnEndedAt: 2_000 })

test('a start writes who the sub-agent belongs to and hands it only its task', async () => {
  const h = harness()
  const started = await h.call('subagent.start', {
    task: 'Check the build',
    cli: 'cursor',
    cliModel: 'muse',
    role: 'review',
  })
  assert.equal(started.isError, undefined, JSON.stringify(started.structuredContent))
  const request = h.requests[0]!
  assert.equal(request.workspaceId, WORKSPACE)
  assert.equal(request.newChat, undefined)
  assert.deepEqual(request.subagentOf, { agentId: PARENT, startedAt: 1_000, task: 'Check the build' })
  assert.equal(request.prompt, 'Act as the review sub-agent for this task.\n\nCheck the build')
  // The task is the parent agent's words, which the extensions' prompt hooks check.
  assert.deepEqual(request.promptHookAs, { inputKind: 'subagent', from: 'agent' })
  assert.equal(request.name, 'Cursor · Model muse')
  assert.equal(body(started).subagentId, 'agent-child-1')
  assert.equal(body(started).status, 'working')
  assert.match(String(body(started).next), /notice/)
  assert.equal(h.links[0]?.parent.agentId, PARENT)
  assert.equal(h.links[0]?.child.transport, 'conversation')
})

test("a general task goes as written, on the caller's own CLI and preset by default", async () => {
  const h = harness({ ceiling: 'auto' })
  await h.call('subagent.start', { task: 'Look around' })
  assert.equal(h.requests[0]?.prompt, 'Look around')
  assert.equal(h.requests[0]?.cli, 'claude-code')
  assert.equal(h.requests[0]?.permissionPreset, 'auto')
})

test('read-only maps to what holds each CLI, and a CLI with none is refused', async () => {
  const cursor = harness({ ceiling: 'manual' })
  const asked = await cursor.call('subagent.start', {
    task: 'Review',
    cli: 'cursor',
    readOnly: true,
    permissionPreset: 'bypass',
  })
  assert.equal(asked.isError, undefined, JSON.stringify(asked.structuredContent))
  assert.equal(cursor.requests[0]?.mode, 'ask')
  assert.equal(cursor.requests[0]?.permissionPreset, 'none')
  assert.equal(cursor.requests[0]?.subagentReadOnly, true)
  assert.equal(body(asked).readOnly, true)
  assert.equal(body(asked).mode, 'ask')

  const claude = harness()
  await claude.call('subagent.start', { task: 'Review', cli: 'claude-code', readOnly: true })
  assert.equal(claude.requests[0]?.mode, 'ask')
  assert.equal(claude.requests[0]?.permissionPreset, 'manual')

  const codex = harness()
  await codex.call('subagent.start', { task: 'Review', cli: 'codex', readOnly: true })
  // Ask rather than its Manual: nobody is watching to answer an approval.
  assert.equal(codex.requests[0]?.mode, 'ask')
  assert.equal(codex.requests[0]?.permissionPreset, 'manual')

  const grok = harness()
  assert.equal(
    code(await grok.call('subagent.start', { task: 'Review', cli: 'grok', readOnly: true })),
    'read_only_unsupported',
  )
  assert.equal(grok.requests.length, 0)
})

test('a sub-agent runs no looser than its parent', async () => {
  const h = harness({ ceiling: 'manual' })
  assert.equal(
    code(await h.call('subagent.start', { task: 'Go', permissionPreset: 'bypass' })),
    'permission_escalation',
  )
  assert.equal(h.requests.length, 0)
})

test('only a chat that is not itself a sub-agent can start one', async () => {
  const h = harness()
  const outsider = { metadata: { kind: 'local-script' } } as unknown as McpConnectionContext
  assert.equal(code(await h.call('subagent.start', { task: 'Go' }, outsider)), 'not_a_chat')
  h.agents[PARENT] = chatRecord({ runtimeKind: 'terminal' } as Partial<AgentState>)
  assert.equal(code(await h.call('subagent.start', { task: 'Go' })), 'not_a_chat')
  h.agents[PARENT] = chatRecord({ subagentOf: { agentId: 'agent-lead', startedAt: 1 } })
  assert.equal(code(await h.call('subagent.start', { task: 'Go' })), 'nested_subagent')
  assert.equal(h.requests.length, 0)
})

test('a fifth running sub-agent is refused, and one that ended makes room', async () => {
  const ended = new Set<string>()
  const h = harness({ sessions: (agentId) => (ended.has(agentId) ? finished(agentId) : undefined) })
  for (let run = 0; run < 4; run += 1) {
    const started = await h.call('subagent.start', { task: `Run ${run}` })
    assert.equal(started.isError, undefined)
  }
  assert.equal(code(await h.call('subagent.start', { task: 'One too many' })), 'too_many_subagents')
  ended.add('agent-child-1')
  assert.equal((await h.call('subagent.start', { task: 'Now there is room' })).isError, undefined)
})

test('a start refuses what it cannot run, and takes a launch failure in its own words', async () => {
  const h = harness()
  assert.equal(code(await h.call('subagent.start', { task: '   ' })), 'invalid_arguments')
  assert.equal(code(await h.call('subagent.start', { task: '--flag' })), 'prompt_reads_as_option')
  assert.equal(code(await h.call('subagent.start', { task: 'Go', cli: 'missing' })), 'unknown_cli')
  assert.equal(code(await h.call('subagent.start', { task: 'Go', cli: 'generic-shell' })), 'cli_not_conversational')
  assert.equal(code(await h.call('subagent.start', { task: 'Go', timeoutMs: 700_000 })), 'invalid_arguments')

  const effort = harness({
    launched: () => ({ ok: false, code: 'unsupported_effort', message: 'No such level.' }),
  })
  assert.equal(code(await effort.call('subagent.start', { task: 'Go', effort: 'huge' })), 'unsupported_effort')
  const failed = harness({
    launched: () => ({ ok: false, code: 'conversation_start_failed', message: 'The model is unknown.' }),
  })
  const refused = await failed.call('subagent.start', { task: 'Go', cliModel: 'nope' })
  assert.equal(code(refused), 'launch_failed')
  assert.match(JSON.stringify(refused.structuredContent), /The model is unknown/)
})

test('wait answers with the result when the sub-agent finishes, and the notice saying the same is dropped', async () => {
  const h = harness({
    result: { text: 'All good.', truncated: true },
    sessions: (agentId, reads) => (agentId !== PARENT && reads > 3 ? finished(agentId) : undefined),
  })
  const done = await h.call('subagent.start', { task: 'Review', wait: true })
  assert.equal(body(done).status, 'completed')
  assert.equal(body(done).result, 'All good.')
  assert.equal(body(done).resultTruncated, true)
  assert.equal(body(done).waitTimedOut, false)
  assert.equal(body(done).next, undefined)
  assert.deepEqual(h.dismissed, ['conv'])
})

test('a recorded end outranks what the session says, and a repeated read answers the same', async () => {
  const h = harness({ result: { text: 'Done.', truncated: false } })
  const started = await h.call('subagent.start', { task: 'Review' })
  const subagentId = String(body(started).subagentId)
  h.agents[subagentId] = {
    ...h.agents[subagentId]!,
    subagentEnd: { at: 3_000, status: 'failed', error: 'The model is gone.' },
  }
  const first = await h.call('subagent.status', { subagentId })
  assert.equal(body(first).status, 'failed')
  assert.equal(body(first).error, 'The model is gone.')
  assert.equal(body(first).endedAt, 3_000)
  assert.deepEqual(body(await h.call('subagent.status', { subagentId })), body(first))
})

test('a parent working in a worktree of its own gives its sub-agent the same folder', async () => {
  const h = harness()
  h.agents[PARENT] = chatRecord({ execution: { mode: 'worktree', worktreeId: null, cwd: '/repo/.wt/a' } })
  await h.call('subagent.start', { task: 'Review' })
  assert.equal(h.requests[0]?.worktreePath, '/repo/.wt/a')
})

test('wait answers when the sub-agent needs the person', async () => {
  const h = harness({
    sessions: (agentId) => summary({ agentId, status: 'awaiting_approval', phase: 'waiting_for_approval' }),
  })
  const waiting = await h.call('subagent.start', { task: 'Edit', wait: true })
  assert.equal(body(waiting).status, 'needs_input')
  assert.equal(body(waiting).waitTimedOut, false)
})

test('a wait that times out says so, cancels nothing, and can be waited on again', async () => {
  let done = false
  const h = harness({ sessions: (agentId) => (done ? finished(agentId) : undefined) })
  const first = await h.call('subagent.start', { task: 'Slow', wait: true, timeoutMs: 1_000 })
  assert.equal(body(first).waitTimedOut, true)
  assert.equal(body(first).status, 'working')
  assert.deepEqual(h.stops, [])
  done = true
  const again = await h.call('subagent.status', { subagentId: body(first).subagentId, wait: true })
  assert.equal(body(again).status, 'completed')
  assert.equal(body(again).waitTimedOut, false)
})

test('a first message that fails reads as failed, with its reason', async () => {
  const h = harness({
    launched: (request) => {
      request.onFirstSendFailed?.('The first message was refused.')
      return undefined as unknown as ConversationLaunchResult
    },
  })
  const failed = await h.call('subagent.start', { task: 'Go', wait: true })
  assert.equal(body(failed).status, 'failed')
  assert.equal(body(failed).error, 'The first message was refused.')
})

test('status answers its parent alone', async () => {
  const h = harness()
  const started = await h.call('subagent.start', { task: 'Go' })
  const subagentId = body(started).subagentId
  assert.equal(body(await h.call('subagent.status', { subagentId })).status, 'working')
  const sibling = {
    metadata: { kind: 'studio-agent', workspaceId: WORKSPACE, agentId: 'agent-other' },
  } as McpConnectionContext
  h.agents['agent-other'] = chatRecord()
  assert.equal(code(await h.call('subagent.status', { subagentId }, sibling)), 'not_your_subagent')
  assert.equal(code(await h.call('subagent.status', { subagentId: 'agent-gone' })), 'unknown_subagent')
  assert.equal(code(await h.call('subagent.status', { subagentId: PARENT })), 'unknown_subagent')
})

test('cancel stops a working sub-agent and leaves a finished one as it is', async () => {
  let done = false
  const h = harness({ sessions: (agentId) => (done ? finished(agentId) : undefined) })
  const started = await h.call('subagent.start', { task: 'Go' })
  const subagentId = body(started).subagentId
  await h.call('subagent.cancel', { subagentId })
  assert.deepEqual(h.stops, [subagentId])
  done = true
  const after = await h.call('subagent.cancel', { subagentId, reason: 'Not needed' })
  assert.equal(body(after).status, 'completed')
  assert.equal(h.stops.length, 1)
})

test("the tools are for this machine's chats alone, and a person who asks to be asked sees every start", () => {
  for (const name of ['subagent.start', 'subagent.status', 'subagent.resume', 'subagent.cancel']) {
    assert.notEqual(localOnlyGatewayToolReason(name), null, name)
  }
  assert.equal(isAgentLaunchingGatewayTool(STUDIO_MCP_SERVER_ID, 'subagent.start'), true)
  assert.equal(isAgentLaunchingGatewayTool(STUDIO_MCP_SERVER_ID, 'subagent.resume'), true)
  assert.equal(isAgentLaunchingGatewayTool(STUDIO_MCP_SERVER_ID, 'subagent.status'), false)
})

test('a sub-agent named as one of its siblings takes a number, so a restart reads as another run', () => {
  assert.equal(distinctSubagentTitle('Council: Sol', []), 'Council: Sol')
  assert.equal(distinctSubagentTitle('Council: Sol', ['Other']), 'Council: Sol')
  assert.equal(distinctSubagentTitle('Council: Sol', ['Council: Sol']), 'Council: Sol (2)')
  assert.equal(distinctSubagentTitle('Council: Sol', ['Council: Sol', 'Council: Sol (2)']), 'Council: Sol (3)')
  const long = 'x'.repeat(60)
  assert.equal(distinctSubagentTitle(long, [long]), `${'x'.repeat(56)} (2)`)
})

// ── subagent.resume ─────────────────────────────────────────────────────────

/** A sub-agent started as the caller asked and already ended, with its session at rest. */
async function endedSubagent(
  h: ReturnType<typeof harness>,
  start: Record<string, unknown>,
  ended: Set<string>,
): Promise<string> {
  const started = await h.call('subagent.start', start)
  assert.equal(started.isError, undefined, JSON.stringify(started.structuredContent))
  const subagentId = String(body(started).subagentId)
  h.agents[subagentId] = { ...h.agents[subagentId]!, subagentEnd: { at: 2_000, status: 'completed' } }
  ended.add(subagentId)
  // Later than the end it is resumed after, as a resume always is.
  h.tick(5_000)
  return subagentId
}

const resting = (agentId: string) =>
  summary({
    agentId,
    sessionId: `conv-${agentId}`,
    status: 'stopped',
    phase: 'completed',
    lastTurnEndedAt: 2_000,
    capabilities: { resume: true } as ConversationSessionSummary['capabilities'],
  })

test('a resumed Codex reviewer gets its task in the same chat, on the model and read-only mode it had', async () => {
  const ended = new Set<string>()
  const h = harness({ sessions: (agentId) => (ended.has(agentId) ? resting(agentId) : undefined) })
  const subagentId = await endedSubagent(
    h,
    {
      task: 'Review the change',
      cli: 'codex',
      cliModel: 'gpt-6.1-sol',
      effort: 'high',
      readOnly: true,
      role: 'review',
    },
    ended,
  )
  const before = { ...h.agents[subagentId]! }

  const resumed = await h.call('subagent.resume', { subagentId, task: 'Round 2: check the two fixes.' })
  assert.equal(resumed.isError, undefined, JSON.stringify(resumed.structuredContent))
  assert.equal(h.requests.length, 1, 'no new sub-agent is started')
  assert.deepEqual(
    h.tasks,
    // Sent as written, as the parent agent's, for the prompt hooks it meets.
    [{ agentId: subagentId, message: 'Round 2: check the two fixes.', starter: { kind: 'agent', ceiling: 'bypass' } }],
    'sent as written',
  )
  const answer = body(resumed)
  assert.equal(answer.subagentId, subagentId)
  assert.equal(answer.cli, 'codex')
  assert.equal(answer.model, 'gpt-6.1-sol')
  assert.equal(answer.readOnly, true)
  assert.equal(answer.mode, 'ask')
  assert.equal(answer.permissionPreset, 'manual')
  assert.equal(answer.status, 'starting')
  assert.equal(answer.round, 2)
  assert.equal(answer.roundStartedAt, 6_000)
  assert.equal(answer.result, null, 'the first round’s result is not this one’s')

  // The record it resumes on is the one it was started with, a round further on.
  const after = h.agents[subagentId]!
  for (const key of [
    'conversation',
    'cliPermissionPreset',
    'conversationMode',
    'subagentOf',
    'subagentReadOnly',
    'name',
  ] as const)
    assert.deepEqual(after[key], before[key], key)
  assert.equal(after.subagentEnd, undefined)
  assert.deepEqual(after.subagentRound, { n: 2, startedAt: 6_000, task: 'Round 2: check the two fixes.' })
  // Its parent hears this round's end too.
  assert.equal(h.links.at(-1)?.child.agentId, subagentId)
  assert.equal(h.links.at(-1)?.parent.agentId, PARENT)
  assert.match(String(answer.next), /notice/)

  // Running its round, it is busy.
  assert.equal(code(await h.call('subagent.resume', { subagentId, task: 'Again' })), 'subagent_busy')
})

test('a resumed Claude Code sub-agent keeps its model and preset, and a third round counts on', async () => {
  const ended = new Set<string>()
  const h = harness({ ceiling: 'auto', sessions: (agentId) => (ended.has(agentId) ? resting(agentId) : undefined) })
  const subagentId = await endedSubagent(h, { task: 'Review', cli: 'claude-code', cliModel: 'opus' }, ended)
  const second = body(await h.call('subagent.resume', { subagentId, task: 'Look again' }))
  assert.equal(second.cli, 'claude-code')
  assert.equal(second.model, 'opus')
  assert.equal(second.permissionPreset, 'auto')
  assert.equal(second.readOnly, false)
  assert.equal(second.round, 2)

  h.agents[subagentId] = { ...h.agents[subagentId]!, subagentEnd: { at: 7_000, status: 'completed' } }
  h.tick(5_000)
  const third = body(await h.call('subagent.resume', { subagentId, task: 'Once more' }))
  assert.equal(third.round, 3)
  assert.equal(h.requests.length, 1)
})

test('resume with wait answers with the round’s result, and drops the notice by the chat', async () => {
  const ended = new Set<string>()
  // The round ends a few looks into the wait: the lifecycle writes its end.
  let looks = 0
  let resumedId: string | null = null
  let h!: ReturnType<typeof harness>
  h = harness({
    result: { text: 'Both fixes hold.', truncated: false },
    sessions: (agentId) => {
      if (!ended.has(agentId)) return undefined
      if (agentId !== resumedId || ++looks < 4) return resting(agentId)
      h.agents[agentId] = { ...h.agents[agentId]!, subagentEnd: { at: 9_000, status: 'completed' } }
      return summary({
        agentId,
        sessionId: 'conv-round-2',
        status: 'ready',
        phase: 'completed',
        lastTurnEndedAt: 9_000,
      })
    },
  })
  const subagentId = await endedSubagent(h, { task: 'Review', cli: 'codex' }, ended)
  resumedId = subagentId
  const done = body(await h.call('subagent.resume', { subagentId, task: 'Round 2', wait: true }))
  assert.equal(done.status, 'completed')
  assert.equal(done.result, 'Both fixes hold.')
  assert.equal(done.round, 2)
  assert.equal(done.endedAt, 9_000)
  assert.equal(done.waitTimedOut, false)
  assert.deepEqual(h.dismissed, ['conv-round-2'])
  assert.deepEqual(h.dismissedChats, [subagentId])
})

test('a task the chat did not take ends the round as failed, in its words', async () => {
  const ended = new Set<string>()
  const h = harness({
    sessions: (agentId) => (ended.has(agentId) ? resting(agentId) : undefined),
    sent: async () => ({ ok: false, message: 'Conversation is unavailable.' }),
  })
  const subagentId = await endedSubagent(h, { task: 'Review', cli: 'codex' }, ended)
  const failed = body(await h.call('subagent.resume', { subagentId, task: 'Round 2', wait: true }))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'Conversation is unavailable.')
  assert.equal(failed.round, 2)
})

test('resume refuses one still working or waiting on the person, and one that is not this chat’s', async () => {
  let session: (agentId: string) => ConversationSessionSummary | undefined = () => undefined
  const h = harness({ sessions: (agentId) => session(agentId) })
  const started = await h.call('subagent.start', { task: 'Review', cli: 'codex' })
  const subagentId = String(body(started).subagentId)
  assert.equal(code(await h.call('subagent.resume', { subagentId, task: 'More' })), 'subagent_busy')

  // Its task ended, but a person's follow-up is running in it, or it asks them.
  h.agents[subagentId] = { ...h.agents[subagentId]!, subagentEnd: { at: 2_000, status: 'completed' } }
  session = (agentId) => summary({ agentId, status: 'active', phase: 'running', turnStartedAt: 3_000 })
  assert.equal(code(await h.call('subagent.resume', { subagentId, task: 'More' })), 'subagent_busy')
  session = (agentId) => summary({ agentId, status: 'awaiting_approval', phase: 'waiting_for_approval' })
  const asking = await h.call('subagent.resume', { subagentId, task: 'More' })
  assert.equal(code(asking), 'subagent_busy')
  assert.match(JSON.stringify(asking.structuredContent), /waiting on the person/)

  assert.equal(code(await h.call('subagent.resume', { subagentId: 'agent-gone', task: 'More' })), 'unknown_subagent')
  h.agents['agent-other'] = chatRecord()
  const sibling = {
    metadata: { kind: 'studio-agent', workspaceId: WORKSPACE, agentId: 'agent-other' },
  } as McpConnectionContext
  assert.equal(code(await h.call('subagent.resume', { subagentId, task: 'More' }, sibling)), 'not_your_subagent')
  assert.equal(code(await h.call('subagent.resume', { subagentId, task: '  ' })), 'invalid_arguments')
  assert.equal(code(await h.call('subagent.resume', { task: 'More' })), 'invalid_arguments')
  assert.deepEqual(h.tasks, [], 'nothing was sent')
})

test('a CLI whose chats cannot pick their session up again is refused resume_unsupported', async () => {
  const ended = new Set<string>()
  const h = harness({
    sessions: (agentId) =>
      ended.has(agentId)
        ? summary({
            agentId,
            status: 'stopped',
            phase: 'completed',
            lastTurnEndedAt: 2_000,
            capabilities: { resume: false } as ConversationSessionSummary['capabilities'],
          })
        : undefined,
    // With a session that does not say (one listed after a restart), the provider says.
    resumes: (providerId) => providerId !== conversationProviderForCli('opencode'),
  })
  const listed = await endedSubagent(h, { task: 'Review', cli: 'cursor' }, ended)
  assert.equal(code(await h.call('subagent.resume', { subagentId: listed, task: 'More' })), 'resume_unsupported')

  const silent = new Set<string>()
  const h2 = harness({
    sessions: (agentId) =>
      silent.has(agentId)
        ? summary({ agentId, status: 'stopped', phase: 'completed', lastTurnEndedAt: 2_000 })
        : undefined,
    resumes: (providerId) => providerId !== conversationProviderForCli('opencode'),
  })
  const unlisted = await endedSubagent(h2, { task: 'Review', cli: 'opencode' }, silent)
  assert.equal(code(await h2.call('subagent.resume', { subagentId: unlisted, task: 'More' })), 'resume_unsupported')
  assert.equal(h2.agents[unlisted]?.subagentEnd?.status, 'completed', 'its record is as it was')
  assert.deepEqual([...h.tasks, ...h2.tasks], [])
})

test('a resumed sub-agent counts toward the limit while its round runs, and not once it has ended', async () => {
  const ended = new Set<string>()
  const h = harness({ sessions: (agentId) => (ended.has(agentId) ? resting(agentId) : undefined) })
  const reviewer = await endedSubagent(h, { task: 'Review', cli: 'codex' }, ended)
  for (let run = 0; run < 3; run += 1)
    assert.equal((await h.call('subagent.start', { task: `Run ${run}` })).isError, undefined)
  // Three running and one ended: the ended one may run again, as the fourth.
  assert.equal((await h.call('subagent.resume', { subagentId: reviewer, task: 'Round 2' })).isError, undefined)
  assert.equal(code(await h.call('subagent.start', { task: 'A fifth' })), 'too_many_subagents')

  // With four running, an ended one is not resumed.
  const h2 = harness({ sessions: (agentId) => (ended.has(agentId) ? resting(agentId) : undefined) })
  const other = await endedSubagent(h2, { task: 'Review', cli: 'codex' }, ended)
  for (let run = 0; run < 4; run += 1) await h2.call('subagent.start', { task: `Run ${run}` })
  assert.equal(code(await h2.call('subagent.resume', { subagentId: other, task: 'Round 2' })), 'too_many_subagents')
})
