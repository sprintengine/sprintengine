import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import { isConversationHighlightColor } from '../../../../packages/conversation-protocol/src/public'
import {
  STUDIO_APPROVAL_RULES_CAPABILITY,
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_CHAT_SEARCH_MAX_CHARS,
  STUDIO_CHAT_SEARCH_MIN_CHARS,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
} from '../../../../packages/studio-protocol/src/public'
import type { SettledChatWorktreePlan } from '../../../shared/ipc/settled-chats'
import type {
  MeshApprovalRulesResult,
  MeshChangeConversationResult,
  MeshConversationChange,
  MeshConversationDeletePlanResult,
  MeshConversationSearchResult,
  MeshRevokeApprovalRuleResult,
  MeshSettleConversationResult,
  MeshVisitConversationResult,
} from '../../../shared/tailnet-mesh'
import { askPaired, pairedCommandId, type PairedMachine } from './pairedStudio'

// A paired machine's chats' records, asked by this window of that machine's
// Studio itself (`chat-lifecycle`, `approval-rules`, `pull-request-watch`):
// their rest and read clock, the row menu's marks, rename, Auto compact,
// delete and its plan, a search of what was said, the "always allow" rules
// and Stop watching. Each is that machine's to keep, by the chat's workspace
// there, each change once per command id. What each answers keeps the shape
// the window's callers read.

const lifecycleUnsupported = (doing: string) => (machineName: string) => ({
  code: 'lifecycle_unsupported',
  message: `${machineName} cannot ${doing} from here yet. Update SprintEngine Studio there to do it from here.`,
})

/** Settle a chat there, or bring it back with `settled: false`. */
export async function settlePairedChat(
  machine: PairedMachine,
  workspaceId: string,
  settled = true,
): Promise<MeshSettleConversationResult> {
  if (!workspaceId) return { ok: false, code: 'invalid_arguments', message: 'Name the remote chat.' }
  const answer = await askPaired(
    machine,
    STUDIO_CHAT_LIFECYCLE_CAPABILITY,
    lifecycleUnsupported(settled ? 'settle its chats' : 'bring its chats back'),
    (client) =>
      client.rpc['conversation.settle']({
        workspaceId,
        commandId: pairedCommandId(),
        ...(settled ? {} : { settled: false }),
      }),
  )
  return answer.ok ? { ok: true, workspaceId, settledAt: answer.value.settledAt } : answer
}

/**
 * Say a chat there is on screen here. No time is sent: the visit is now, and
 * that machine stamps it with its own clock, which a finish there is read by.
 */
export async function visitPairedChat(
  machine: PairedMachine,
  workspaceId: string,
): Promise<MeshVisitConversationResult> {
  if (!workspaceId) return { ok: false, code: 'invalid_arguments', message: 'Name the remote chat.' }
  const answer = await askPaired(
    machine,
    STUDIO_CHAT_LIFECYCLE_CAPABILITY,
    lifecycleUnsupported('keep its chats’ read state for a chat read here'),
    (client) => client.rpc['conversation.visit']({ workspaceId }),
  )
  return answer.ok ? { ok: true, workspaceId, lastVisitedAt: answer.value.lastVisitedAt } : answer
}

/**
 * A row menu or management change to a chat there: Star, Highlight color,
 * Snooze, Auto-settle, Mark unread, Rename, Auto compact, Delete, each its own
 * method under a command id; Stop watching is the pull request's
 * (`pullRequests.unwatch`).
 */
export async function changePairedChat(
  machine: PairedMachine,
  workspaceId: string,
  change: MeshConversationChange,
): Promise<MeshChangeConversationResult> {
  if (!workspaceId) return { ok: false, code: 'invalid_arguments', message: 'Name the remote chat.' }
  if (change.kind === 'unwatch-pull-request') {
    const { agentId, url } = change
    const answer = await askPaired(
      machine,
      STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
      (machineName) => ({
        code: 'row_menu_unsupported',
        message: `${machineName} cannot stop watching its chats' pull requests from here yet. Update SprintEngine Studio there to do it from here.`,
      }),
      (client) => client.rpc['pullRequests.unwatch']({ conversation: { workspaceId, agentId }, url }),
    )
    return answer.ok ? { ok: true, workspaceId } : answer
  }
  const call = chatChangeOf(change)
  if (!call) return { ok: false, code: 'invalid_arguments', message: 'That is not a change a chat takes.' }
  const answer = await askPaired(
    machine,
    STUDIO_CHAT_LIFECYCLE_CAPABILITY,
    (machineName) => ({
      code: 'row_menu_unsupported',
      message: `${machineName} cannot ${call.ask} from here yet. Update SprintEngine Studio there to do it from here.`,
    }),
    (client) => call.send(client, { workspaceId, commandId: pairedCommandId() }),
  )
  return answer.ok ? { ok: true, workspaceId } : answer
}

const deleteUnsupported = (machineName: string) => ({
  code: 'delete_unsupported',
  message: `${machineName} cannot delete its chats from here yet. Update SprintEngine Studio there to do it from here.`,
})

/** What deleting a settled chat there would do, as that machine plans it. */
export async function pairedChatDeletePlan(
  machine: PairedMachine,
  workspaceId: string,
): Promise<MeshConversationDeletePlanResult> {
  if (!workspaceId) return { ok: false, code: 'invalid_arguments', message: 'Name the remote chat.' }
  const answer = await askPaired(machine, STUDIO_CHAT_LIFECYCLE_CAPABILITY, deleteUnsupported, (client) =>
    client.rpc['conversation.deletePlan']({ workspaceId }),
  )
  return answer.ok ? deletePlanOf(workspaceId, answer.value as unknown as Record<string, unknown>) : answer
}

/** What was said in that machine's chats, as its own palette finds it. */
export async function searchPairedChats(machine: PairedMachine, query: string): Promise<MeshConversationSearchResult> {
  const asked = query.trim()
  if (asked.length < STUDIO_CHAT_SEARCH_MIN_CHARS || asked.length > STUDIO_CHAT_SEARCH_MAX_CHARS) {
    return {
      ok: false,
      code: 'invalid_arguments',
      message: `Search for ${STUDIO_CHAT_SEARCH_MIN_CHARS} to ${STUDIO_CHAT_SEARCH_MAX_CHARS} characters.`,
    }
  }
  const answer = await askPaired(
    machine,
    STUDIO_CHAT_LIFECYCLE_CAPABILITY,
    (machineName) => ({
      code: 'search_unsupported',
      message: `${machineName} cannot search its chats from here yet. Update SprintEngine Studio there to do it from here.`,
    }),
    (client) => client.rpc['conversation.searchChats']({ query: asked }),
  )
  return answer.ok ? searchAnswerOf(answer.value as unknown as Record<string, unknown>) : answer
}

const rulesUnsupported = (machineName: string) => ({
  code: 'approval_rules_unsupported',
  message: `${machineName} does not share its chat permissions yet. Update SprintEngine Studio there to see them from here.`,
})

/** The "always allow" rules that machine's chats run with, for Settings. */
export async function pairedApprovalRules(machine: PairedMachine): Promise<MeshApprovalRulesResult> {
  const answer = await askPaired(machine, STUDIO_APPROVAL_RULES_CAPABILITY, rulesUnsupported, (client) =>
    client.rpc['conversation.approvalRules']({}),
  )
  if (!answer.ok) return answer
  if (!answer.value.ok) return { ok: false, code: 'unavailable', message: answer.value.message }
  return approvalRulesOf(answer.value.rules)
}

/** Revoke one of them there: its chats ask again. */
export async function revokePairedApprovalRule(
  machine: PairedMachine,
  ruleId: string,
): Promise<MeshRevokeApprovalRuleResult> {
  if (!ruleId) return { ok: false, code: 'invalid_arguments', message: 'Name the rule.' }
  const answer = await askPaired(machine, STUDIO_APPROVAL_RULES_CAPABILITY, rulesUnsupported, (client) =>
    client.rpc['conversation.revokeApprovalRule']({ commandId: pairedCommandId(), ruleId }),
  )
  if (!answer.ok) return answer
  return answer.value.ok ? { ok: true, ruleId } : { ok: false, code: 'unavailable', message: answer.value.message }
}

/** A change to a chat's record there: the method it is on that machine's Studio, and what it asks, in words. */
type ChatChange = {
  send(client: StudioClient, chat: { workspaceId: string; commandId: string }): Promise<unknown>
  /** What is asked, for a machine that cannot be: "snooze its chats". */
  ask: string
}

/**
 * The Studio method a row menu or management change is on the chat's
 * machine, with what it carries; null for anything that is not one, and for
 * Stop watching, which is the pull request's (`pullRequests.unwatch`).
 */
function chatChangeOf(change: unknown): ChatChange | null {
  if (!change || typeof change !== 'object') return null
  const value = change as Record<string, unknown>
  switch (value.kind) {
    case 'snooze': {
      if (value.until !== null && !(typeof value.until === 'number' && Number.isFinite(value.until))) return null
      const until = value.until === null ? null : Math.trunc(value.until as number)
      return {
        send: (client, chat) => client.rpc['conversation.snooze']({ ...chat, until }),
        ask: until === null ? 'wake its chats' : 'snooze its chats',
      }
    }
    case 'highlight': {
      const starred = typeof value.starred === 'boolean' ? value.starred : undefined
      const color = value.color === null || isConversationHighlightColor(value.color) ? value.color : undefined
      if (starred === undefined && color === undefined) return null
      return {
        send: (client, chat) =>
          client.rpc['conversation.highlight']({
            ...chat,
            ...(starred !== undefined ? { starred } : {}),
            ...(color !== undefined ? { color } : {}),
          }),
        ask: starred !== undefined && color === undefined ? 'star its chats' : 'highlight its chats',
      }
    }
    case 'auto-settle': {
      const enabled = value.enabled
      if (typeof enabled !== 'boolean') return null
      return {
        send: (client, chat) => client.rpc['conversation.setAutoSettle']({ ...chat, enabled }),
        ask: 'switch Auto-settle on its chats',
      }
    }
    case 'mark-unread':
      return { send: (client, chat) => client.rpc['conversation.markUnread'](chat), ask: 'mark its chats unread' }
    case 'rename': {
      const name = typeof value.name === 'string' ? value.name.trim() : ''
      if (!name) return null
      return { send: (client, chat) => client.rpc['conversation.rename']({ ...chat, name }), ask: 'rename its chats' }
    }
    case 'auto-compact': {
      const enabled = value.enabled
      if (typeof enabled !== 'boolean') return null
      return {
        send: (client, chat) => client.rpc['conversation.setAutoCompact']({ ...chat, enabled }),
        ask: 'switch Auto compact on its chats',
      }
    }
    case 'delete':
      return { send: (client, chat) => client.rpc['conversation.delete'](chat), ask: 'delete its chats' }
    default:
      return null
  }
}

const PLAN_FATES = new Set(['remove', 'keep'])
const KEPT_BECAUSE = new Set(['changes', 'shared', 'not-made-here', 'other-machine', 'unreadable'])

/** A machine's delete plan as it answered, kept to what this build reads; null members are left as null. */
export function deletePlanOf(workspaceId: string, value: Record<string, unknown>): MeshConversationDeletePlanResult {
  const count = (entry: unknown) =>
    typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0 ? entry : null
  const worktrees = (Array.isArray(value.worktrees) ? value.worktrees : []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const worktree = entry as Record<string, unknown>
    if (typeof worktree.name !== 'string' || !PLAN_FATES.has(worktree.fate as string)) return []
    return [
      {
        name: worktree.name,
        branch: typeof worktree.branch === 'string' ? worktree.branch : null,
        pooled: worktree.pooled === true,
        changedPaths: count(worktree.changedPaths),
        unpushedCommits: count(worktree.unpushedCommits),
        fate: worktree.fate as 'remove' | 'keep',
        ...(KEPT_BECAUSE.has(worktree.keptBecause as string)
          ? { keptBecause: worktree.keptBecause as Omit<SettledChatWorktreePlan, 'path'>['keptBecause'] }
          : {}),
      },
    ]
  })
  return {
    ok: true,
    workspaceId,
    ...(value.gone === true ? { gone: true as const } : {}),
    ...(typeof value.refused === 'string' && value.refused ? { refused: value.refused } : {}),
    worktrees,
  }
}

/**
 * A machine's rules as it listed them, kept to the ones this build can read:
 * each project by its folder's name, never the path on that machine.
 */
export function approvalRulesOf(listed: unknown): MeshApprovalRulesResult {
  const text = (entry: unknown): entry is string =>
    typeof entry === 'string' && entry.length > 0 && entry.length <= 2_000
  const rules = (Array.isArray(listed) ? listed : []).slice(0, 2_000).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const rule = entry as Record<string, unknown>
    if (!text(rule.id) || !text(rule.label)) return []
    const root = typeof rule.workspaceRoot === 'string' ? rule.workspaceRoot : ''
    return [
      {
        id: rule.id,
        label: rule.label,
        toolName: text(rule.toolName) ? rule.toolName : '',
        toolKind: text(rule.toolKind) ? rule.toolKind : 'other',
        project: root.split(/[\\/]/u).filter(Boolean).at(-1) ?? '',
        createdAt: typeof rule.createdAt === 'number' && Number.isFinite(rule.createdAt) ? rule.createdAt : 0,
      },
    ]
  })
  return { ok: true, rules }
}

const HIT_FROM = new Set(['person', 'agent', 'studio'])

/** A machine's search answer, kept to the chats and matches this build can read. */
export function searchAnswerOf(value: Record<string, unknown>): MeshConversationSearchResult {
  const chats = (Array.isArray(value.chats) ? value.chats : []).slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const chat = entry as Record<string, unknown>
    if (typeof chat.workspaceId !== 'string' || !chat.workspaceId) return []
    const hits = (Array.isArray(chat.hits) ? chat.hits : []).slice(0, 20).flatMap((hit) => {
      if (!hit || typeof hit !== 'object') return []
      const found = hit as Record<string, unknown>
      if (typeof found.agentId !== 'string' || !found.agentId) return []
      if (typeof found.seq !== 'number' || !Number.isSafeInteger(found.seq)) return []
      if (typeof found.snippet !== 'string') return []
      return [
        {
          agentId: found.agentId,
          seq: found.seq,
          snippet: found.snippet.slice(0, 1_000),
          ...(HIT_FROM.has(found.from as string) ? { from: found.from as 'person' | 'agent' | 'studio' } : {}),
        },
      ]
    })
    if (hits.length === 0) return []
    const count = typeof chat.count === 'number' && Number.isSafeInteger(chat.count) ? chat.count : hits.length
    return [
      {
        workspaceId: chat.workspaceId,
        chatTitle: typeof chat.chatTitle === 'string' && chat.chatTitle.trim() ? chat.chatTitle : 'Chat',
        hits,
        count: Math.max(count, hits.length),
      },
    ]
  })
  return { ok: true, chats, truncated: value.truncated === true }
}
