import type { TranscriptToolEntry } from './conversationProjection'
import { laneAgentState } from './subagentStatus'

// Whether a person can write to an agent a chat's CLI spawned. The box is drawn
// only where a message really arrives, and everywhere else there is no box at
// all, only a bar sending the person to the parent (owner ruling 2026-11-07): a
// box that fails, sits disabled or quietly does nothing is the thing ruled out.
//
// What was proven, with the real Claude Code SDK, asking the parent to use
// SendMessage to the agent's task id: a running background agent, named or not,
// a foreground agent moved to the background first, a nested agent, an Explore
// agent, a finished agent (it is resumed), a finished agent after the CLI
// process restarted, and a finished nested agent, in the same run and after a
// restart, all received the message. An agent the person stopped did
// not: the CLI refuses it as cancelled. Nothing proved a failed agent, or one
// whose end was never recorded, so those get the bar too.

export type SubagentDelivery = { kind: 'box' } | { kind: 'bar'; why: string }

export type LaneDeliveryFacts = {
  /** This view may drive the chat: false for a pairing that may only follow it. */
  operate: boolean
  /**
   * The chat's provider relays a message to an agent
   * (`capabilities.messageSubagent`). Undefined where nothing has said: a chat
   * at rest on a paired machine is listed without what it can do.
   */
  providerRelays: boolean | undefined
  /** The transport can ask: false for a machine older than `conversation-agent-message`. */
  transportRelays: boolean
  /** The harness, in words, for saying it cannot. */
  harnessName: string
  /** The paired machine the chat runs on, where it does. */
  machineName?: string
}

export function laneDelivery(lane: TranscriptToolEntry, facts: LaneDeliveryFacts): SubagentDelivery {
  if (!facts.operate) return { kind: 'bar', why: 'This pairing lets you read this chat but not send to it.' }
  if (!facts.transportRelays)
    return {
      kind: 'bar',
      why: facts.machineName
        ? `${facts.machineName} needs updating before a message can reach a subagent from here.`
        : 'This window cannot pass a message to a subagent.',
    }
  if (facts.providerRelays === undefined)
    return { kind: 'bar', why: 'The main chat is at rest, and has not said whether it can pass a message on.' }
  if (!facts.providerRelays)
    return { kind: 'bar', why: `${facts.harnessName} has no way to pass a message to a subagent.` }
  if (lane.agent?.canContinue === false)
    return { kind: 'bar', why: `${facts.harnessName} says it cannot be continued.` }
  // Reported only once it starts, and a call waiting on the person has not.
  if (!lane.agent?.taskId)
    return {
      kind: 'bar',
      why:
        lane.status === 'running'
          ? 'It has not started yet, so a message has nowhere to go.'
          : `${facts.harnessName} gave no way to reach this one.`,
    }
  if (lane.outputStatus === 'declined') return { kind: 'bar', why: 'It was declined before it ran.' }
  switch (laneAgentState(lane)) {
    case 'working':
    case 'done':
      return { kind: 'box' }
    case 'stopped':
      return { kind: 'bar', why: 'It was stopped, and a stopped agent cannot be continued.' }
    case 'failed':
      return { kind: 'bar', why: 'It failed, and nothing says it can be continued.' }
    case 'unknown':
      return { kind: 'bar', why: 'How it ended was never recorded, so nothing says it can be continued.' }
  }
}

/** What became of the message `sent` at `at`, read off the call the parent made to pass it on. */
export type LaneSentOutcome = { state: 'passed' } | { state: 'refused'; why: string }

function refusalOf(output: string | undefined): string | null {
  if (!output) return null
  try {
    const answer = JSON.parse(output) as { success?: unknown; message?: unknown }
    if (answer.success !== false) return null
    return typeof answer.message === 'string' ? answer.message : 'The agent could not be reached.'
  } catch {
    return null
  }
}

/**
 * Each message written to `lane`, by when it was sent, with what the parent's
 * call to pass it on answered. The parent is a model, so nothing guarantees the
 * call: a message with no refusal reads as passed on, which is all that can be
 * said of it.
 */
export function laneSentOutcomes(
  lane: TranscriptToolEntry,
  parentTools: readonly TranscriptToolEntry[],
): Map<number, LaneSentOutcome> {
  const outcomes = new Map<number, LaneSentOutcome>()
  const taskId = lane.agent?.taskId
  const calls = parentTools.filter((tool) => {
    if (tool.name !== 'SendMessage') return false
    const input = tool.input
    return input !== null && typeof input === 'object' && !Array.isArray(input) && input.to === taskId
  })
  for (const message of lane.sent ?? []) {
    const call = calls.find((tool) => (tool.startedAt ?? 0) >= message.at)
    const why = refusalOf(typeof call?.output === 'string' ? call.output : undefined)
    outcomes.set(message.at, why === null ? { state: 'passed' } : { state: 'refused', why })
  }
  return outcomes
}
