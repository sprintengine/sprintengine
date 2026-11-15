// A conversation as one flat list of rows, for a narrow screen: the person's
// messages, what the agent thought and said, its steps in runs, the agents it
// sent off as cards of their own, and each finished turn's footer. It reads
// the projection every client folds (`projectConversation`), so a chat's
// events become entries in one place; this is only how a narrow screen lays
// those entries out. The phone draws it.
//
// Where the phone and the window draw the same thing differently, the
// difference is an option here (`ConversationRowsOptions`), never a reading of
// the events of its own.

import type {
  ConversationProjection,
  TranscriptAgentMessage,
  TranscriptAgentState,
  TranscriptEntry,
  TranscriptToolEntry,
  TurnChanges,
  TurnRetry,
} from './conversationProjection.js'
import type { ConversationStoredImageAttachment } from './attachments.js'
import type { PromptCacheReading } from './promptCache.js'
import {
  presentedToolKind,
  presentedToolTone,
  type ConversationAttachedFile,
  type ConversationStudioMessageReason,
  type PresentableTool,
} from './protocol.js'
import { formatStepDuration } from './stepDuration.js'
import { proseShownToUser } from './shownProse.js'

/** One step as a row draws it: the shared presentation's input, and what the row adds. */
export type RowTool = PresentableTool & {
  id: string
  output?: string
  /** The input came without its file-change bodies; the detail has them. */
  inputTruncated?: boolean
  /** When the call started, by the desktop's clock: it places an agent's words between its steps. */
  startedAt?: number
  /** The agent lane this call ran inside, when an agent made it. */
  parentToolUseId?: string
}

/** One agent the chat spawned: its Task/Agent call, and everything reported about it since. */
export type AgentLane = {
  /** The spawning call's tool use id; every report about the agent names it. */
  id: string
  turn: string
  /** The lane this agent was spawned from, when an agent spawned it. */
  parentId?: string
  subagentType?: string
  /** What the model sent it to do. */
  task: string
  status: 'running' | 'done'
  outcome?: 'ok' | 'error' | 'stopped' | 'declined'
  agent?: TranscriptAgentState
  startedAt: number
  completedAt?: number
  /** What it came back with: the spawning call's own output, or a background agent's result. */
  report?: string
  /** What it said between its steps, in order. */
  messages: TranscriptAgentMessage[]
  /** What the person wrote to it, passed on through the chat, in order. */
  sent?: TranscriptAgentMessage[]
  /** The tool calls it made itself, in the order they started. */
  steps: RowTool[]
}

/** A picture the person sent, as their bubble draws it. */
export type SentImage = { id: string; name?: string; ref?: string }

export type PlanStatus = 'pending' | 'approved' | 'denied' | 'cancelled'
type ToolsRow = { kind: 'tools'; id: string; tools: RowTool[]; turn?: string }
type PlanRow = { kind: 'plan'; id: string; requestId: string; plan: string; status: PlanStatus }

/** One piece of a folded turn, in the order it happened: a run of steps, what the agent said between them, or what it thought. */
export type FoldPart =
  | { kind: 'tools'; id: string; tools: RowTool[] }
  | { kind: 'prose'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }

export type ConversationRow =
  | {
      kind: 'message'
      id: string
      role: 'user' | 'assistant'
      text: string
      at: number
      commandId?: string
      turn?: string
      /** The files the person attached by path; only a person's message has them. */
      files?: ConversationAttachedFile[]
      /** The pictures the person sent with it; only a person's message has them. */
      images?: SentImage[]
    }
  /**
   * A message Studio sent the chat itself: its words without the name they
   * open with, drawn as Studio's quiet row and never as the person's bubble.
   * `turn` is the turn it opened.
   */
  | { kind: 'studio'; id: string; text: string; at: number; reason?: ConversationStudioMessageReason; turn?: string }
  /**
   * What the model thought on its way to the reply, one row per stretch of
   * thinking, where in the turn it happened. `live` while it is the last thing
   * the running turn has said: the model is thinking now.
   */
  | { kind: 'reasoning'; id: string; text: string; at: number; live: boolean; turn?: string }
  | ToolsRow
  /**
   * A turn's work resting behind one line ("Worked for 2m 14s · 12 steps"):
   * its steps and what the agent said between them. Its agents, the pictures
   * it made and its reply stay outside.
   */
  | { kind: 'fold'; id: string; turn: string; label: string; failed: number; live: boolean; parts: FoldPart[] }
  /** An agent the chat spawned: its own card, standing between the turn's steps. */
  | { kind: 'agent'; id: string; lane: AgentLane }
  /** The provider summarised the conversation to free context. */
  | {
      kind: 'compaction'
      id: string
      trigger?: 'manual' | 'auto'
      /** Studio compacted the idle chat itself, just before its prompt cache expired. */
      beforeCacheExpiry?: true
      preTokens?: number
      postTokens?: number
    }
  /** The chat was handed off to a fresh session, pointed at a file of its messages, instead of being compacted. */
  | { kind: 'handoff'; id: string; preTokens?: number }
  /** A side question the person asked about the chat, with the answer it got. */
  | { kind: 'sideQuestion'; id: string; question: string; answer: string; truncated?: true }
  /** What a command the CLI ran by itself printed (`/context`, `/usage`); a `note` is the desktop's own remark. */
  | { kind: 'command'; id: string; command?: string; output: string; note?: boolean }
  /**
   * A finished turn's footer: the model it ran on and how long it took.
   * `reply` when the turn said anything, which its footer offers to copy.
   */
  | { kind: 'meta'; id: string; modelId?: string; durationMs?: number; at: number; turn?: string; reply?: true }
  /** A plan the agent proposed; it stays in the transcript after it is answered. */
  | PlanRow
  /**
   * What a finished turn changed. `turnSeq` opens the files and their diffs
   * when the desktop kept a checkpoint; without one the counts are all there is.
   */
  | { kind: 'diff'; id: string; turnSeq?: number; changes?: TurnChanges }

/**
 * One turn the agent answered in, by the desktop's clock: when it began, and
 * when it ended once it has. A turn still running is `streaming`; one that
 * ended without saying so (its session stopped) has neither an end nor that.
 */
export type ReplyClock = { turn: string; startedAt: number; endedAt?: number; streaming: boolean }
/** A finished turn that changed files: its counts, and its checkpoint when the desktop kept one. */
export type ChangedTurn = { id: string; at: number; turnSeq?: number; changes?: TurnChanges }
/** A request waiting on the person: its id, and the request as the projection holds it. */
export type PendingRequest = { id: string; entry: Extract<TranscriptEntry, { kind: 'approval' }> }

export type ConversationRows = {
  rows: ConversationRow[]
  /** The provider is waiting to retry a failed call in the turn running now. */
  retrying: TurnRetry | null
  pending: PendingRequest[]
  /** The command ids of the sends the log holds. */
  acknowledged: Set<string>
  /** A turn is in flight or a background agent still runs. */
  busy: boolean
  /** A turn is in flight: a send now waits for it to end. */
  turnBusy: boolean
  workingSince: number | undefined
  /** Every agent the chat spawned, nested ones included, in the order they started. */
  lanes: AgentLane[]
  plans: Record<string, { plan: string; status: PlanStatus }>
  agentTypes: Record<string, string>
  promptCache: PromptCacheReading | null
  /** Every turn that changed files, oldest first. */
  changedTurns: ChangedTurn[]
  /** Every turn the agent answered in, oldest first, with when it began and ended. */
  replies: ReplyClock[]
}

/** How a narrow screen lays the rows out, where clients differ. */
export type ConversationRowsOptions = {
  /** How a duration reads on a fold's line. Defaults to the transcript's clock (`formatStepDuration`). */
  formatDuration?: (ms: number) => string
  /** A step that stays in view outside its turn's fold, as an agent's card does (a Studio subagent's start). */
  staysInView?: (tool: RowTool) => boolean
  /** A step whose result is for the person to look at: drawn under the fold's line and not counted as a step. */
  shownToUser?: (tool: RowTool) => boolean
  /** The pictures a message carries, from what the log kept of them. */
  sentImages?: (attachments: readonly ConversationStoredImageAttachment[]) => SentImage[]
  /** A Studio notice's words without the name they open with. */
  studioNoticeText?: (text: string) => string
}

const defaultShownToUser = (tool: RowTool) => tool.name === 'GenerateImage' && tool.status !== 'error'
const defaultSentImages = (attachments: readonly ConversationStoredImageAttachment[]): SentImage[] =>
  attachments.map((attachment) => ({
    id: attachment.id,
    ...(attachment.name ? { name: attachment.name } : {}),
    ref: attachment.ref,
  }))

// A step's kind as the shared presentation names it.
function rowKind(tool: Pick<TranscriptToolEntry, 'name' | 'toolKind'>): PresentableTool['kind'] {
  return presentedToolKind({ name: tool.name, kind: tool.toolKind })
}

// The lane check on a laid-out step, which is kept: it reads the step's kind
// without asking the presentation again.
function isLaneStep(tool: TranscriptToolEntry): boolean {
  return tool.subagentLane === true || rowTool(tool).kind === 'subagent'
}

function stepStatus(tool: TranscriptToolEntry): RowTool['status'] {
  return tool.status === 'running' ? 'running' : (tool.outputStatus ?? 'ok')
}

// A lane's outcome: how its call ended, else "ok" for one that ended with no
// word on it, except a background agent whose end history never recorded.
function laneOutcome(tool: TranscriptToolEntry): AgentLane['outcome'] {
  if (tool.status === 'running') return undefined
  if (tool.outputStatus) return tool.outputStatus
  return tool.agent?.state === 'unknown' ? undefined : 'ok'
}

// Each entry's step, kept while the entry is the same object: an entry is
// never changed in place (a fold that changes one builds a new one), and the
// incremental fold keeps every entry it did not change, so a streamed word
// lays out no step again.
const rowTools = new WeakMap<TranscriptToolEntry, RowTool>()

function rowTool(tool: TranscriptToolEntry): RowTool {
  const kept = rowTools.get(tool)
  if (kept) return kept
  const step = buildRowTool(tool)
  rowTools.set(tool, step)
  return step
}

function buildRowTool(tool: TranscriptToolEntry): RowTool {
  // A lane's own call reads as the lane does wherever it is drawn as a step.
  const kind = rowKind(tool)
  const lane = tool.subagentLane === true || kind === 'subagent'
  const status = lane && tool.status !== 'running' ? (laneOutcome(tool) ?? 'ok') : stepStatus(tool)
  return {
    id: tool.id,
    name: tool.name,
    kind,
    input: tool.input,
    summary: tool.summary ?? '',
    status,
    ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
    ...(tool.output !== undefined ? { output: tool.output } : {}),
    ...(tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {}),
    ...(tool.inputTruncated ? { inputTruncated: true } : {}),
    ...(tool.parentToolUseId && tool.parentToolUseId !== tool.id ? { parentToolUseId: tool.parentToolUseId } : {}),
    ...(tool.subagentType ? { subagentType: tool.subagentType } : {}),
    ...(tool.displayTitle ? { displayTitle: tool.displayTitle } : {}),
    ...(tool.serverName ? { serverName: tool.serverName } : {}),
  }
}

const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

// What the model sent an agent to do: the short description every Task call
// carries, else the one-line summary the provider wrote for the call, else
// what the agent said of itself.
function laneTask(tool: TranscriptToolEntry): string {
  const input = tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input) ? tool.input : {}
  const described = textOf((input as Record<string, unknown>).description).trim()
  if (described) return described
  const summary = tool.summary ?? ''
  const prefix = `${tool.name}: `
  return (summary.startsWith(prefix) ? summary.slice(prefix.length) : summary) || tool.agent?.description || ''
}

function laneOf(tool: TranscriptToolEntry): AgentLane {
  const input = tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input) ? tool.input : {}
  const subagentType = tool.subagentType || textOf((input as Record<string, unknown>).subagent_type).trim()
  const outcome = laneOutcome(tool)
  return {
    id: tool.id,
    turn: tool.turnId,
    ...(tool.parentToolUseId ? { parentId: tool.parentToolUseId } : {}),
    ...(subagentType ? { subagentType } : {}),
    task: laneTask(tool),
    status: tool.status === 'running' ? 'running' : 'done',
    ...(outcome ? { outcome } : {}),
    ...(tool.agent ? { agent: tool.agent } : {}),
    startedAt: tool.startedAt ?? 0,
    ...(tool.completedAt !== undefined && tool.status !== 'running' ? { completedAt: tool.completedAt } : {}),
    ...(tool.output ? { report: tool.output } : {}),
    messages: tool.messages ?? [],
    ...(tool.sent?.length ? { sent: tool.sent } : {}),
    steps: (tool.children ?? []).map(rowTool),
  }
}

type TurnState = { status: 'streaming' | 'complete' | 'failed' | 'interrupted'; durationMs?: number }

/** The fold's line, in the desktop's words: "Worked for 2m 14s · 12 steps". */
export function turnFoldLabel(
  state: TurnState,
  steps: number,
  formatDuration: (ms: number) => string = formatStepDuration,
): string {
  const duration = state.durationMs === undefined ? '' : formatDuration(state.durationMs)
  const lead =
    state.status === 'streaming'
      ? 'Working'
      : state.status === 'failed'
        ? duration
          ? `Failed after ${duration}`
          : 'Failed'
        : state.status === 'interrupted'
          ? duration
            ? `You stopped after ${duration}`
            : 'You stopped'
          : duration
            ? `Worked for ${duration}`
            : 'Worked'
  return steps ? `${lead} · ${steps} ${steps === 1 ? 'step' : 'steps'}` : lead
}

// Whether a step went wrong as its row says it: a non-zero exit, or an
// outcome the presentation tones as an error.
function rowStepFailed(tool: RowTool): boolean {
  if (tool.status === 'running') return false
  return Boolean(tool.exitCode) || presentedToolTone(tool) === 'error'
}

/**
 * The rows a narrow screen draws for a projected conversation, with what the
 * screen around them reads: the requests waiting, the agents, the turns' clocks.
 */
export function deriveConversationRows(
  projection: ConversationProjection,
  options: ConversationRowsOptions = {},
): ConversationRows {
  const shownToUser = options.shownToUser ?? defaultShownToUser
  const sentImages = options.sentImages ?? defaultSentImages
  const noticeText = options.studioNoticeText ?? ((text: string) => text)
  const entries = projection.entries
  const rows: ConversationRow[] = []
  const pending: PendingRequest[] = []
  const acknowledged = new Set<string>()
  const plans: Record<string, { plan: string; status: PlanStatus }> = {}
  const changedTurns: ChangedTurn[] = []
  const replies: ReplyClock[] = []
  const turnStates = new Map<string, TurnState>()
  const lanes: AgentLane[] = []
  let retrying: TurnRetry | null = null
  // When this spell of work began: the message, or the turn, that opened the
  // earliest turn still running.
  let turnSince: number | undefined
  // The latest message's place in the log, which a turn's checkpoint opens
  // from when its end names none.
  let messageSeq: number | undefined
  let toolGroup: ToolsRow | undefined

  const collectLanes = (tool: TranscriptToolEntry) => {
    if (isLaneStep(tool)) lanes.push(laneOf(tool))
    for (const child of tool.children ?? []) collectLanes(child)
  }
  const requestOf = (approval: Extract<TranscriptEntry, { kind: 'approval' }>, live: boolean) => {
    // A request outlives nothing: once its turn has ended it can no longer be answered.
    const status: PlanStatus = approval.status === 'pending' && !live ? 'cancelled' : approval.status
    if (status === 'pending') pending.push({ id: approval.requestId, entry: approval })
    if (approval.requestKind !== 'plan') return
    toolGroup = undefined
    plans[approval.requestId] = { plan: approval.plan ?? '', status }
    rows.push({
      kind: 'plan',
      id: `plan:${approval.requestId}`,
      requestId: approval.requestId,
      plan: approval.plan ?? '',
      status,
    })
  }
  // A step joins the run it follows; an agent is a card of its own, and the
  // steps after it start a new run.
  const placeStep = (tool: TranscriptToolEntry, turn: string) => {
    if (isLaneStep(tool)) {
      toolGroup = undefined
      rows.push({ kind: 'agent', id: `agent:${tool.id}`, lane: laneOf(tool) })
      return
    }
    const step = rowTool(tool)
    if (toolGroup) toolGroup.tools.push(step)
    else {
      toolGroup = { kind: 'tools', id: `tools:${tool.id}`, tools: [step], turn }
      rows.push(toolGroup)
    }
    // Calls nested under a call that is not an agent are its turn's steps.
    for (const child of tool.children ?? []) placeStep(child, turn)
  }

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.kind === 'compaction') {
      toolGroup = undefined
      rows.push({
        kind: 'compaction',
        id: entry.id,
        ...(entry.trigger ? { trigger: entry.trigger } : {}),
        ...(entry.beforeCacheExpiry ? { beforeCacheExpiry: true as const } : {}),
        ...(entry.preTokens !== undefined ? { preTokens: entry.preTokens } : {}),
        ...(entry.postTokens !== undefined ? { postTokens: entry.postTokens } : {}),
      })
      continue
    }
    if (entry.kind === 'handoff') {
      toolGroup = undefined
      rows.push({
        kind: 'handoff',
        id: entry.id,
        ...(entry.preTokens !== undefined ? { preTokens: entry.preTokens } : {}),
      })
      continue
    }
    if (entry.kind === 'sideQuestion') {
      toolGroup = undefined
      rows.push({
        kind: 'sideQuestion',
        id: entry.id,
        question: entry.question,
        answer: entry.answer,
        ...(entry.truncated ? { truncated: true as const } : {}),
      })
      continue
    }
    if (entry.kind === 'commandOutput') {
      toolGroup = undefined
      rows.push({
        kind: 'command',
        id: entry.id,
        output: entry.output,
        ...(entry.command ? { command: entry.command } : {}),
        ...(entry.note ? { note: true } : {}),
      })
      continue
    }
    if (entry.kind === 'user') {
      toolGroup = undefined
      if (entry.seq !== undefined) messageSeq = entry.seq
      if (entry.commandId) acknowledged.add(entry.commandId)
      // The turn it opened: the next turn in the entries, past what the turn
      // printed and compacted before its reply.
      let next = index + 1
      while (next < entries.length && (entries[next]!.kind === 'compaction' || entries[next]!.kind === 'commandOutput'))
        next++
      const opened = entries[next]
      const turn = opened?.kind === 'assistant' ? opened.turnId : undefined
      if (
        projection.activeTurn &&
        entry.createdAt !== undefined &&
        (!opened || opened.kind !== 'assistant' || opened.status === 'streaming')
      )
        turnSince = Math.min(turnSince ?? Infinity, entry.createdAt)
      // Studio's own `/compact` is said by the divider its compaction draws.
      if (entry.origin?.reason === 'auto-compact') continue
      const at = entry.createdAt ?? 0
      if (entry.origin) {
        rows.push({
          kind: 'studio',
          id: entry.id,
          text: entry.subagentMessage
            ? `You wrote to a subagent, and this chat was asked to pass it on: ${entry.subagentMessage.text}`
            : noticeText(entry.text),
          at,
          ...(entry.origin.reason ? { reason: entry.origin.reason } : {}),
          ...(turn ? { turn } : {}),
        })
        continue
      }
      const images = entry.storedAttachments?.length ? sentImages(entry.storedAttachments) : []
      rows.push({
        kind: 'message',
        id: entry.id,
        role: 'user',
        text: entry.text,
        at,
        commandId: entry.commandId ?? '',
        ...(entry.files?.length ? { files: entry.files } : {}),
        ...(images.length ? { images } : {}),
      })
      continue
    }
    if (entry.kind === 'approval') {
      // A request that named no turn.
      requestOf(entry, true)
      continue
    }
    if (entry.kind !== 'assistant') {
      // A call outside its turn's run (none are, today): drawn as a step.
      collectLanes(entry)
      placeStep(entry, entry.turnId)
      continue
    }
    const turn = entry.turnId
    const live = entry.status === 'streaming'
    const tools: TranscriptToolEntry[] = []
    let cursor = index + 1
    while (cursor < entries.length) {
      const next = entries[cursor]!
      if (next.kind !== 'tool' || next.turnId !== turn) break
      tools.push(next)
      cursor++
    }
    const approvals: Extract<TranscriptEntry, { kind: 'approval' }>[] = []
    while (cursor < entries.length) {
      const next = entries[cursor]!
      if (next.kind !== 'approval' || next.turnId !== turn) break
      approvals.push(next)
      cursor++
    }
    index = cursor - 1
    if (live) {
      if (entry.startedAt !== undefined) turnSince = Math.min(turnSince ?? Infinity, entry.startedAt)
      if (entry.retry) retrying = entry.retry
    }
    for (const tool of tools) collectLanes(tool)
    const start = entry.startedAt ?? tools[0]?.startedAt
    const said = Boolean(
      entry.text || entry.intermediateText?.length || entry.reasoning.trim() || entry.reasoningSegments?.length,
    )
    if (start !== undefined || said || tools.length) {
      replies.push({
        turn,
        startedAt: start ?? 0,
        ...(entry.completedAt !== undefined && entry.status !== 'streaming' ? { endedAt: entry.completedAt } : {}),
        streaming: live,
      })
    }
    const at = entry.startedAt ?? 0
    const reasoningRow = (id: string, text: string, isLive: boolean): ConversationRow | null =>
      text.trim() ? { kind: 'reasoning', id, text: text.trimStart(), at, live: isLive, turn } : null
    // The turn's words and steps in the order they came: before each step,
    // the thinking and then the prose that led to it.
    const placed = new Set<string>()
    for (const tool of tools) {
      for (const segment of entry.reasoningSegments ?? []) {
        if (segment.beforeToolUseId !== tool.id) continue
        const row = reasoningRow(`reasoning:${turn}:${tool.id}`, segment.text, false)
        if (row) {
          toolGroup = undefined
          rows.push(row)
        }
      }
      entry.intermediateText?.forEach((part, order) => {
        if (part.beforeToolUseId !== tool.id) return
        toolGroup = undefined
        rows.push({ kind: 'message', id: `${turn}:${tool.id}:${order}`, role: 'assistant', text: part.text, at, turn })
      })
      placed.add(tool.id)
      placeStep(tool, turn)
    }
    // Words before a step that is not on this page are kept, after its steps.
    for (const segment of entry.reasoningSegments ?? []) {
      if (placed.has(segment.beforeToolUseId)) continue
      const row = reasoningRow(`reasoning:${turn}:${segment.beforeToolUseId}`, segment.text, false)
      if (row) {
        toolGroup = undefined
        rows.push(row)
      }
    }
    entry.intermediateText?.forEach((part, order) => {
      if (placed.has(part.beforeToolUseId)) return
      toolGroup = undefined
      rows.push({
        kind: 'message',
        id: `${turn}:${part.beforeToolUseId}:${order}`,
        role: 'assistant',
        text: part.text,
        at,
        turn,
      })
    })
    for (const approval of approvals) requestOf(approval, live)
    // Thinking since the last step, ahead of the reply it led to; live while
    // it is still the last thing the turn has said.
    const trailing = reasoningRow(
      `reasoning:${turn}`,
      entry.reasoning,
      live && entry.reasoningLive === true && !entry.text,
    )
    if (trailing) {
      toolGroup = undefined
      rows.push(trailing)
    }
    if (entry.text) {
      toolGroup = undefined
      rows.push({ kind: 'message', id: `${turn}:reply`, role: 'assistant', text: entry.text, at, turn })
    }
    const ended = entry.completedAt !== undefined && !live
    const durationMs =
      entry.durationMs ??
      (ended && entry.startedAt !== undefined ? Math.max(0, entry.completedAt! - entry.startedAt) : undefined)
    turnStates.set(turn, {
      status: entry.status,
      durationMs:
        ended && entry.startedAt !== undefined
          ? Math.max(0, entry.completedAt! - entry.startedAt)
          : ended
            ? entry.durationMs
            : undefined,
    })
    if (!ended) continue
    toolGroup = undefined
    const endedAt = entry.completedAt!
    if (entry.status === 'failed' || entry.status === 'interrupted')
      rows.push({
        kind: 'message',
        id: `failed:${turn}`,
        role: 'assistant',
        text: entry.failureDetail || 'This turn could not finish.',
        at: endedAt,
      })
    if (entry.status === 'complete') {
      const spoken = Boolean(entry.text.trim() || entry.intermediateText?.some((part) => part.text.trim()))
      rows.push({
        kind: 'meta',
        id: `meta:${turn}`,
        at: endedAt,
        ...(entry.modelId ? { modelId: entry.modelId } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        turn,
        ...(spoken ? { reply: true as const } : {}),
      })
    }
    const changes = entry.checkpointSummary ?? entry.reportedChanges
    const turnSeq =
      entry.checkpointAvailable === true && messageSeq !== undefined
        ? (entry.checkpointTurnSeq ?? messageSeq)
        : undefined
    // A checkpoint whose summary counts no files changed nothing worth a row,
    // as on the desktop; one without a summary still opens.
    if ((turnSeq !== undefined && changes?.files !== 0) || (changes && changes.files > 0)) {
      const changed = {
        id: `diff:${turn}`,
        ...(turnSeq !== undefined ? { turnSeq } : {}),
        ...(changes ? { changes } : {}),
      }
      rows.push({ kind: 'diff', ...changed })
      changedTurns.push({ ...changed, at: endedAt })
    }
  }

  // Agents in the order they started.
  lanes.sort((a, b) => a.startedAt - b.startedAt)
  const background = lanes.filter((lane) => lane.status === 'running' && lane.agent?.background === true)
  const turnBusy = projection.activeTurn
  const kept = rows.filter((row) => row.kind !== 'tools' || row.tools.length > 0)
  return {
    rows: foldTurns(kept, (turn) => turnStates.get(turn) ?? { status: 'complete' }, {
      formatDuration: options.formatDuration ?? formatStepDuration,
      staysInView: options.staysInView ?? (() => false),
      shownToUser,
    }),
    retrying: turnBusy ? retrying : null,
    pending,
    acknowledged,
    busy: turnBusy || background.length > 0,
    turnBusy,
    workingSince: turnBusy
      ? turnSince
      : background.length
        ? Math.min(...background.map((lane) => lane.startedAt))
        : undefined,
    lanes,
    plans,
    agentTypes: projection.agentTypes,
    promptCache: projection.promptCache,
    changedTurns,
    replies,
  }
}

/**
 * Every turn's work rests behind one line, the turn running now included: its
 * steps, and what the agent said between them. The agents it sent off stay
 * cards of their own, the reply stays as written, and prose that shows a
 * picture stays in view; a generated picture is drawn under the line. A turn
 * with no steps, or whose only steps made pictures, is left as it is: its
 * reply and its pictures are all there is, as on the desktop.
 *
 * The fold stands where the turn's first folded row stood, so the agents and
 * the reply follow it as they do on the desktop.
 */
function foldTurns(
  input: ConversationRow[],
  stateOf: (turn: string) => TurnState,
  rules: {
    formatDuration: (ms: number) => string
    staysInView: (tool: RowTool) => boolean
    shownToUser: (tool: RowTool) => boolean
  },
): ConversationRow[] {
  const { staysInView, shownToUser } = rules
  // A step that stays in view is taken out of the run it was grouped in.
  const rows = input.flatMap((row): ConversationRow[] => {
    if (row.kind !== 'tools' || !row.tools.some(staysInView) || row.tools.every(staysInView)) return [row]
    const split: ConversationRow[] = []
    let run: RowTool[] = []
    let inView = false
    const flush = () => {
      if (run.length) split.push({ ...row, id: `${row.id}:${split.length}`, tools: run })
      run = []
    }
    for (const tool of row.tools) {
      if (staysInView(tool) !== inView) {
        flush()
        inView = !inView
      }
      run.push(tool)
    }
    flush()
    return split
  })
  const inViewOnly = (row: ConversationRow) => row.kind === 'tools' && row.tools.every(staysInView)
  const turnOf = (row: ConversationRow) =>
    row.kind === 'tools' || row.kind === 'reasoning' || (row.kind === 'message' && row.role === 'assistant')
      ? row.turn
      : undefined
  const lastStep = new Map<string, number>()
  // Only a step that is work counts: a turn whose steps all made a picture
  // for the person has nothing to fold, and its picture stays as it is.
  rows.forEach((row, index) => {
    if (row.kind === 'tools' && row.turn && !inViewOnly(row) && row.tools.some((tool) => !shownToUser(tool)))
      lastStep.set(row.turn, index)
  })
  const folds = new Map<string, Extract<ConversationRow, { kind: 'fold' }>>()
  const out: ConversationRow[] = []
  rows.forEach((row, index) => {
    const turn = turnOf(row)
    const last = turn === undefined ? undefined : lastStep.get(turn)
    // Thinking before the turn's last step folds with the work it led to, as
    // its prose does; the thinking after it stays in view above the reply.
    const folded =
      turn !== undefined &&
      last !== undefined &&
      ((row.kind === 'tools' && !inViewOnly(row)) ||
        (row.kind === 'reasoning' && index < last) ||
        (row.kind === 'message' && index < last && !proseShownToUser(row.text)))
    if (!folded || turn === undefined || (row.kind !== 'tools' && row.kind !== 'message' && row.kind !== 'reasoning')) {
      out.push(row)
      return
    }
    let fold = folds.get(turn)
    if (!fold) {
      fold = { kind: 'fold', id: `fold:${turn}`, turn, label: '', failed: 0, live: false, parts: [] }
      folds.set(turn, fold)
      out.push(fold)
    }
    fold.parts.push(
      row.kind === 'tools'
        ? { kind: 'tools', id: row.id, tools: row.tools }
        : row.kind === 'reasoning'
          ? { kind: 'reasoning', id: row.id, text: row.text }
          : { kind: 'prose', id: row.id, text: row.text },
    )
  })
  for (const fold of folds.values()) {
    const steps = fold.parts.flatMap((part) => (part.kind === 'tools' ? part.tools : []))
    const counted = steps.filter((tool) => !shownToUser(tool))
    const state = stateOf(fold.turn)
    fold.live = state.status === 'streaming'
    fold.label = turnFoldLabel(state, counted.length, rules.formatDuration)
    fold.failed = counted.filter(rowStepFailed).length
  }
  return out
}
