import type { StudioClient, StudioWebSocketConstructor } from '../../packages/client-runtime/src/public'
import type { createStudioConversationParts } from '../../src/renderer/src/components/panels/agentChat/studioChat'
import { conversationNewChatSeed } from '../../src/renderer/src/components/workspace/conversationSpawnOptions'
import { defaultAgent } from '../../src/shared/agent-state'
import type { ConversationSessionFrame } from '../../src/shared/conversation-runtime'
import { GATE_WINDOW_ORIGIN, MOCK_PROVIDER } from './client'
import type { Feed } from './feed'

// What the machine legs (ssh.ts, wsl.ts) share: a desktop window's client of
// another machine's own Studio, the New chat it makes there, and the chat
// view's follow of it.

type Parts = ReturnType<typeof createStudioConversationParts>
type Key = { workspaceRoot: string; workspaceId: string; agentId: string }

/** Node's WebSocket, saying the origin a desktop window's says. */
export function windowWebSocket(): StudioWebSocketConstructor {
  const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, init: unknown) => unknown }).WebSocket
  return class {
    constructor(url: string) {
      return new NodeWebSocket(url, { headers: { origin: GATE_WINDOW_ORIGIN } }) as never
    }
  } as unknown as StudioWebSocketConstructor
}

/** The answer, or a throw naming the leg and what was asked when it was refused. */
export function okOf(leg: string) {
  return <T>(result: unknown, what: string): T => {
    const outcome = result as { ok?: boolean; message?: string }
    if (!outcome || outcome.ok === false) throw new Error(`${leg}: ${what}: ${outcome?.message ?? 'no answer'}`)
    return result as T
  }
}

/** Whether `check` holds within `ms`, looking every 200 ms. */
export async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 200))
  return check()
}

/**
 * The window's New chat on that machine: the chat's record made in the
 * machine's own registry (as this desktop's copy forwards it), on the fake
 * provider, then its session. Answers the session's id.
 */
export async function newChatThere(input: {
  leg: string
  label: string
  client: StudioClient
  parts: Parts
  key: Key
}): Promise<string> {
  const { client, key } = input
  const ok = okOf(input.leg)
  const seed = conversationNewChatSeed(
    { provider: { ...MOCK_PROVIDER, modelLabel: 'Mock' } },
    { permissionPreset: 'manual' },
  )
  if (!seed) throw new Error(`${input.leg}: the New chat seed names no provider`)
  const theirs = await client.request('workspaceSync.snapshot', {})
  const windowId = String(theirs.state.primaryWorkspaceWindowId)
  const created = await client.request('workspaceSync.dispatch', {
    commandId: `gate-new-chat-${input.leg}`,
    windowId,
    command: {
      type: 'workspace.created',
      payload: {
        workspace: {
          id: key.workspaceId,
          name: 'repo',
          mode: 'standard',
          folderPath: key.workspaceRoot,
          templateId: 'standard',
          layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
          agents: { [key.agentId]: { ...defaultAgent(key.agentId, key.agentId), ...seed.agentPatch } },
          worktreeState: { containerPath: null, entries: {}, updatedAt: null },
          memory: { relativeRoot: null },
          editorState: { openFiles: [], activeFilePath: null },
          createdAt: Date.now(),
        },
        windowId,
        insert: { kind: 'folder_head', folderPath: key.workspaceRoot },
      },
    },
  })
  ok(created, `New chat on ${input.label}`)
  return ok<{ session: { sessionId: string } }>(await input.parts.startSession!({ ...key, ...MOCK_PROVIDER }), 'start')
    .session.sessionId
}

/**
 * The chat view's follow, into `feed`: from its cursor once it holds one, and
 * followed again from it when a stream ends, as the view does. Answers the stop.
 */
export function followChat(parts: Parts, key: Key, feed: Feed): () => void {
  let stopped = false
  let following: () => void = () => undefined
  const follow = () => {
    if (stopped) return
    following = parts.subscribe(
      {
        key,
        turnLimit: 50,
        ...(feed.cursor === undefined ? {} : { afterSeq: feed.cursor }),
        ...(feed.generation === undefined ? {} : { generation: feed.generation }),
      },
      (frame: ConversationSessionFrame) => {
        if (frame.type === 'snapshot')
          feed.snapshot(frame.page.events, {
            ...(frame.reset ? { reset: true } : {}),
            ...(frame.generation ? { generation: frame.generation } : {}),
          })
        else if (frame.type === 'event') feed.event(frame.event)
        else if (frame.type === 'synchronized') feed.side({ syncs: feed.syncs + 1 })
        else if (frame.type === 'error') {
          feed.side({ lastError: frame.message })
          following()
          if (!stopped) setTimeout(follow, 250)
        }
      },
    )
  }
  follow()
  return () => {
    stopped = true
    following()
  }
}
