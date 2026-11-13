import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../src/protocol.js'
import { projectConversation, type TranscriptEntry } from '../src/conversationProjection.js'
import { deriveConversationRows, turnFoldLabel } from '../src/conversationRows.js'
import { applyEvent, createConversationProjectionState } from '../src/incrementalConversationProjection.js'

// The narrow screen's rows (the phone's), and what the projection reads for
// them. The phone's own suite pins the rows case by case
// (mobile/src/features/conversations/*.regression.test.js); these pin the
// projection rules every client now shares, and that both folds agree.

function event(type: ConversationEventType, index: number, payload: Record<string, unknown> = {}): ConversationEvent {
  return {
    id: `event-${index}`,
    seq: index,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'provider',
    modelId: 'model',
    type,
    createdAt: index * 10,
    payload,
  }
}

const toolsOf = (entries: TranscriptEntry[]) =>
  entries.filter((entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool')

test('an event that names no turn joins the turn running, and a message that names none is answered by the next turn', () => {
  const projection = projectConversation([
    event('user_message', 1, { text: 'go', commandId: 'send-1' }),
    event('turn_started', 2, { turnId: 't' }),
    event('content_delta', 3, { text: 'Looking.' }),
    event('tool_started', 4, { toolUseId: 'read', name: 'Read' }),
    event('approval_requested', 5, { requestId: 'r' }),
  ])
  assert.deepEqual(
    projection.entries.map((entry) => entry.kind),
    ['user', 'assistant', 'tool', 'approval'],
  )
  const [user, assistant] = projection.entries
  assert.equal(user.kind === 'user' && user.commandId, 'send-1')
  assert.equal(user.kind === 'user' && user.seq, 1, "the turn's checkpoint opens from its message")
  assert.equal(assistant.kind === 'assistant' && assistant.intermediateText?.[0]?.text, 'Looking.')
  assert.equal(projection.entries[3].kind === 'approval' && projection.entries[3].turnId, 't')
  // Before any turn begins, the message alone is work begun.
  assert.equal(projectConversation([event('user_message', 1, { text: 'go' })]).activeTurn, true)
})

test('a start sent again keeps the call it names finished, with its output and input', () => {
  const tools = toolsOf(
    projectConversation([
      event('turn_started', 1, { turnId: 't' }),
      event('tool_started', 2, { turnId: 't', toolUseId: 'x', name: 'Read', input: { path: 'a.ts' } }),
      event('tool_output', 3, { turnId: 't', toolUseId: 'x', status: 'declined', output: 'no' }),
      event('tool_started', 4, { turnId: 't', toolUseId: 'x', name: 'Read' }),
    ]).entries,
  )
  assert.equal(tools.length, 1)
  assert.equal(tools[0].status, 'done')
  assert.equal(tools[0].outputStatus, 'declined')
  assert.equal(tools[0].output, 'no')
  assert.deepEqual(tools[0].input, { path: 'a.ts' })
  assert.equal(tools[0].startedAt, 20)
})

test("a turn's finished steps say what they changed, each file once", () => {
  const assistant = projectConversation([
    event('turn_started', 1, { turnId: 't' }),
    event('tool_output', 2, {
      turnId: 't',
      toolUseId: 'a',
      partial: true,
      fileChanges: [{ path: '/repo/c.ts', additions: 9, deletions: 0 }],
    }),
    event('tool_output', 3, {
      turnId: 't',
      toolUseId: 'a',
      fileChanges: [{ path: '/repo/a.ts', additions: 3, deletions: 1 }],
    }),
    event('tool_output', 4, {
      turnId: 't',
      toolUseId: 'a',
      fileChanges: [{ path: '/repo/a.ts', additions: 3, deletions: 1 }],
    }),
    event('tool_output', 5, { turnId: 't', toolUseId: 'b', fileChanges: [{ path: '/repo/a.ts', additions: 1 }] }),
  ]).entries.find((entry) => entry.kind === 'assistant')
  assert.deepEqual(assistant?.kind === 'assistant' && assistant.reportedChanges, { files: 1, addedLines: 4 })
})

test("a session's end settles its work for the client that asks, and only for it", () => {
  const events = [
    event('turn_started', 1, { turnId: 't' }),
    event('tool_started', 2, { turnId: 't', toolUseId: 'x', name: 'Bash' }),
    event('approval_requested', 3, { turnId: 't', requestId: 'r' }),
    event('session_closed', 4),
  ]
  const window = projectConversation(events)
  assert.equal(window.activeTurn, true, "the window waits for the turn's own end")
  const phone = projectConversation(events, [], { sessionEndSettlesWork: true })
  assert.equal(phone.activeTurn, false)
  assert.equal(phone.awaitingApproval, false)
  const [tool] = toolsOf(phone.entries)
  assert.equal(tool.outputStatus, 'stopped')
  const assistant = phone.entries.find((entry) => entry.kind === 'assistant')
  assert.equal(assistant?.kind === 'assistant' && assistant.completedAt, undefined, 'settled, not ended')
})

test('the incremental fold agrees with the whole fold on what the phone reads differently', () => {
  const options = { sessionEndSettlesWork: true }
  const events = [
    event('user_message', 1, { text: 'go' }),
    event('turn_started', 2, { turnId: 't' }),
    event('reasoning_delta', 3, { text: 'Hmm.' }),
    event('content_delta', 4, { turnId: 't', text: 'Reading.' }),
    event('tool_started', 5, { toolUseId: 'x', name: 'Edit' }),
    event('tool_output', 6, { toolUseId: 'x', fileChanges: [{ path: '/repo/a.ts', additions: 2, deletions: 1 }] }),
    event('tool_started', 7, { toolUseId: 'x', name: 'Edit' }),
    event('content_delta', 8, { turnId: 't', text: 'Done.' }),
    event('session_closed', 9),
  ]
  let state = createConversationProjectionState([], [], options)
  for (let index = 0; index < events.length; index++) {
    state = applyEvent(state, events[index]!)
    assert.deepEqual(
      state.projection,
      projectConversation(events.slice(0, index + 1), [], options),
      `after event ${index}`,
    )
  }
})

test('the rows lay a turn out as it happened: its message, its work behind one line, its reply and its footer', () => {
  const projection = projectConversation([
    event('user_message', 1, { turnId: 't', text: 'fix it', commandId: 'c' }),
    event('turn_started', 2, { turnId: 't' }),
    event('content_delta', 3, { turnId: 't', text: 'Looking.' }),
    event('tool_started', 4, { turnId: 't', toolUseId: 'read', name: 'Read', kind: 'file_read' }),
    event('tool_output', 5, { turnId: 't', toolUseId: 'read', status: 'ok' }),
    event('tool_started', 6, {
      turnId: 't',
      toolUseId: 'task',
      name: 'Task',
      subagentLane: true,
      input: { description: 'Map it' },
    }),
    event('content_delta', 7, { turnId: 't', text: 'Fixed.' }),
    event('turn_completed', 8, {
      turnId: 't',
      checkpointAvailable: true,
      checkpointSummary: { files: 1, addedLines: 2, removedLines: 0 },
    }),
  ])
  const rows = deriveConversationRows(projection)
  assert.deepEqual(
    rows.rows.map((row) => row.kind),
    ['message', 'fold', 'agent', 'message', 'meta', 'diff'],
  )
  const fold = rows.rows[1]
  assert.equal(fold.kind === 'fold' && fold.label, 'Worked for 0.1s · 1 step')
  assert.deepEqual(
    rows.lanes.map((lane) => [lane.id, lane.task, lane.status]),
    [['task', 'Map it', 'running']],
  )
  assert.equal(rows.acknowledged.has('c'), true)
  assert.deepEqual(
    rows.changedTurns.map((turn) => turn.turnSeq),
    [1],
  )
  assert.equal(turnFoldLabel({ status: 'complete', durationMs: 120_000 }, 2), 'Worked for 2m 0s · 2 steps')
  assert.equal(
    turnFoldLabel({ status: 'complete', durationMs: 120_000 }, 2, () => '2m'),
    'Worked for 2m · 2 steps',
    'a client words its clock its own way',
  )
})
