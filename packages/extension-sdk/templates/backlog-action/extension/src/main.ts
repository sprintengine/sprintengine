import {
  getBacklogService,
  getConversationService,
  type ExtensionCommandContext,
  type MainHost,
  type ModuleMethodParsed,
} from '@sprintengine/extension-sdk'

// extension.json declares the command "Plan in a chat" and puts it in a
// Backlog item's menu (`contributes.menus`, where "backlog.item"). The command
// has no `action`, so running it calls this worker's method of the same name,
// an `operate` method, with what it was picked on: the workspace and the
// items. Its own methods need no permission.
//
// For each item it starts a chat with a planning prompt. The chat is a real
// chat: it opens as a tab in the workspace, and the person reads and answers
// it like any other.

export type BacklogMethods = {
  'plan-in-chat': {
    access: 'operate'
    params: PlanRequest
    result: { agentIds: string[] }
  }
}

export type PlanRequest = { workspaceId: string; backlogItemIds: string[] }

export function readPlanRequest(value: unknown): ModuleMethodParsed<PlanRequest> {
  const context = (value ?? {}) as Partial<ExtensionCommandContext>
  if (typeof context.workspaceId !== 'string' || context.workspaceId === '') {
    return { ok: false, message: 'Run it from a Backlog item.' }
  }
  const ids = Array.isArray(context.backlogItemIds)
    ? context.backlogItemIds.filter((id): id is string => typeof id === 'string')
    : []
  if (ids.length === 0) return { ok: false, message: 'Pick at least one Backlog item.' }
  return { ok: true, params: { workspaceId: context.workspaceId, backlogItemIds: ids } }
}

export function planningPrompt(item: { title: string; relativePath: string }): string {
  return [
    `Plan the work for the Backlog item "${item.title}" (${item.relativePath}).`,
    'Read the item first. Propose the steps and the files they touch, and wait for my go-ahead before changing anything.',
  ].join('\n\n')
}

export function activate(studio: MainHost): void {
  studio.registerMethods<BacklogMethods>({
    'plan-in-chat': {
      access: 'operate',
      params: readPlanRequest,
      handler: async (request, context) => {
        const listed = await getBacklogService(studio).list(request.workspaceId)
        if (!listed.ok) return { ok: false, code: listed.code, message: listed.message }
        const conversations = getConversationService(studio)
        const agentIds: string[] = []
        for (const id of request.backlogItemIds) {
          const item = listed.items.find((candidate) => candidate.id === id)
          if (!item) continue
          const started = await conversations.create({
            workspaceId: request.workspaceId,
            name: `Plan: ${item.title}`.slice(0, 80),
            prompt: planningPrompt(item),
            // A retried run of the same command finds the chats the first made.
            ...(context.commandId ? { commandId: `${context.commandId}:${id}` } : {}),
          })
          if (!started.ok) return { ok: false, code: started.code, message: started.message }
          agentIds.push(started.conversation.agentId)
        }
        return { ok: true, result: { agentIds } }
      },
    },
  })
}
