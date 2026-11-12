import type {
  ModuleConversationErrorCode,
  ModuleConversationSummary,
  ModuleMethodParsed,
} from '@sprintengine/module-sdk'

// The contract between this module's two halves. entry.main declares the
// methods (`host.registerMethods<CompanionMethods>`), the renderer calls them
// (`host.methods<CompanionMethods>()`), and entry.main pushes `CHANGED_TOPIC`
// (`host.emit`) when the renderer should read again. A `read` method changes
// nothing; an `operate` one does, and is carried out once per command id.

export const CHANGED_TOPIC = 'conversations-changed'

export type StartRequest = { workspaceId: string }
export type StopRequest = { workspaceId: string; agentId: string }

export type CompanionMethods = {
  list: { access: 'read'; params: Record<string, never>; result: ModuleConversationSummary[] }
  start: {
    access: 'operate'
    params: StartRequest
    result: { conversation: ModuleConversationSummary }
    errors: ModuleConversationErrorCode
  }
  stop: { access: 'operate'; params: StopRequest; result: null; errors: ModuleConversationErrorCode }
}

export function readNothing(): ModuleMethodParsed<Record<string, never>> {
  return { ok: true, params: {} }
}

export function readStartRequest(value: unknown): ModuleMethodParsed<StartRequest> {
  const workspaceId = (value as { workspaceId?: unknown } | null)?.workspaceId
  return typeof workspaceId === 'string' && workspaceId
    ? { ok: true, params: { workspaceId } }
    : { ok: false, message: 'Pick a workspace first.' }
}

export function readStopRequest(value: unknown): ModuleMethodParsed<StopRequest> {
  const start = readStartRequest(value)
  const agentId = (value as { agentId?: unknown } | null)?.agentId
  return start.ok && typeof agentId === 'string' && agentId
    ? { ok: true, params: { workspaceId: start.params.workspaceId, agentId } }
    : { ok: false, message: 'Which chat?' }
}
