import { getConversationService, type RegisterMain } from '@sprintengine/module-sdk'

import { CHANGED_TOPIC, readNothing, readStartRequest, readStopRequest, type CompanionMethods } from './protocol'

const OPENING_PROMPT =
  "Read this project's README and its main entry point, then summarise in five bullet points what it does and how it is built. Do not change any files."

// Chats a module starts are real chats: they open as tabs in the workspace,
// run on the agent runtime the person last chose (unless `cli` says which),
// and the person can read and answer them like any other. The conversation
// service only ever shows this module its own chats.
export const registerMain: RegisterMain = (host) => {
  // An older host, or one whose chat runtime is off: say so once, rather than
  // failing the module's load at the first call.
  if (!host.supports('conversations')) {
    host.notify({
      severity: 'warning',
      title: '{{displayName}} cannot start chats here',
      body: 'This version of SprintEngine Studio does not offer chats to extensions.',
    })
    return
  }
  const conversations = getConversationService(host)

  // Started below, once per command id: a retried call passes the same
  // `commandId` on, so the conversation service finds the chat the first made.
  async function start(request: { workspaceId: string }, commandId: string | undefined) {
    const started = await conversations.create({
      workspaceId: request.workspaceId,
      name: 'Project summary',
      prompt: OPENING_PROMPT,
      ...(commandId ? { commandId } : {}),
    })
    if (!started.ok) return started

    // Follow the one turn and say if it failed. Events stream from now on;
    // `transcript(ref)` replays what already happened.
    const ref = { workspaceId: request.workspaceId, agentId: started.conversation.agentId }
    let stop: (() => void) | undefined
    let finished = false
    stop = conversations.subscribe(ref, (event) => {
      if (finished || (event.type !== 'turn_completed' && event.type !== 'turn_failed')) return
      finished = true
      stop?.()
      if (event.type === 'turn_failed') {
        host.notify({
          severity: 'warning',
          title: 'Project summary did not finish',
          body: 'Open it from {{displayName}}.',
        })
      }
    })
    if (finished) stop()
    return { ok: true as const, result: { conversation: started.conversation } }
  }

  host.registerMethods<CompanionMethods>({
    list: { access: 'read', params: readNothing, handler: () => ({ ok: true, result: conversations.list() }) },
    start: {
      access: 'operate',
      params: readStartRequest,
      handler: (request, context) => start(request, context.commandId),
    },
    stop: {
      access: 'operate',
      params: readStopRequest,
      handler: async (request) => {
        const stopped = await conversations.stop(request)
        return stopped.ok ? { ok: true, result: null } : stopped
      },
    },
  })

  // Tell every open window to read the list again whenever it changes. An
  // event is a signal, not state: a window opened later reads through
  // the `list` method and never needs an old event.
  let stopWatching = () => {}
  host.onStartup(() => {
    stopWatching = conversations.watch(undefined, () => host.emit(CHANGED_TOPIC))
  })
  host.onShutdown(() => stopWatching())
}
