import { environmentRouteOfRecord } from '../../shared/environment-clients'
import { isMachinePath } from '../../shared/machine-paths'
import { machineRouteOfPath } from '../../shared/machine-spelling'
import type { ConversationRuntime } from '../../main/conversation-runtime'

// What everything that drives or reads chats calls: the session API both IPC
// and the network wrap, the tailnet conversation host, the module conversation
// service, scheduled agents, companion agents and the IPC handlers.
//
// Today the only implementation is the in-process `ConversationRuntime`. The
// seam exists so a later phase can answer the same calls from another server
// (the one inside a WSL distribution, or one reached over SSH) and pick between
// them per workspace, without any of those callers changing. So a caller takes
// a `ConversationBackend`, never the runtime class, and a member belongs here
// only if a remote server could answer it too.
//
// What stays off it is the owner's business, on the owner handle the core
// hands out beside it: when its idle sweep runs, flushing and shutting down.

// `Pick` refuses a name the runtime does not have, so this list cannot drift
// from the class.
export type ConversationBackendMember =
  | 'onEvent'
  | 'listSessions'
  | 'sessionWorkspaceRoot'
  | 'listLiveConversationRoots'
  | 'liveConversationWorkspaceRoots'
  | 'getProviderCapabilities'
  | 'getNativeProviderModels'
  | 'startSession'
  | 'sendTurn'
  | 'hasCommandReceipt'
  | 'respondToRequest'
  | 'setPermission'
  | 'setModel'
  | 'mcpServerAction'
  | 'interrupt'
  | 'stopSubagent'
  | 'messageSubagent'
  | 'askSideQuestion'
  | 'cancelSideQuestion'
  | 'readContextBreakdown'
  | 'stopSession'
  | 'suspendSession'
  | 'terminalHandoffTarget'
  | 'stopForTerminalHandoff'
  | 'endTerminalHandoff'
  | 'noteTerminalHandoff'
  | 'getToolDetail'
  | 'readConversationEvent'
  | 'findToolCall'
  | 'readAttachment'
  | 'planDocument'
  | 'listThreads'
  | 'searchThreads'
  | 'renameThread'
  | 'deleteTranscript'
  | 'readTranscript'
  | 'readPeekTranscript'
  | 'readConversationSync'
  | 'readConversationPage'
  | 'recoverTranscript'
  | 'getTurnDiff'
  | 'listApprovalRules'
  | 'revokeApprovalRule'
  | 'revertToTurn'
  | 'rewindToTurn'
  | 'handoffConversation'
  | 'forkAtTurn'

export type ConversationBackend = Pick<ConversationRuntime, ConversationBackendMember>

/**
 * The in-process backend: the runtime itself, seen only through the backend's
 * members. A view rather than a copy, so `this` inside each method is still the
 * runtime.
 */
export function localConversationBackend(runtime: ConversationRuntime): ConversationBackend {
  return runtime
}

/**
 * This process's runtime, refusing a chat another environment holds: one whose
 * folder is on an SSH machine (`ssh://…`, shared/machine-paths.ts), or in a
 * WSL distribution, or whose record here says it is that environment's
 * (`environmentRouteOfRecord`). It is that environment's Studio's to run
 * (design-wsl-ssh-direct PR 1d, PR 3c): a path in that spelling handed to
 * this computer's runtime would be read as a folder here, and a WSL chat run
 * here would run on Windows. Every member answers such a call as it fails,
 * in words.
 */
export function refuseOtherEnvironments(
  backend: ConversationBackend,
  deps: {
    recordOf(workspaceId: string): Parameters<typeof environmentRouteOfRecord>[0] | null
    platform?: string
  },
): ConversationBackend {
  const platform = deps.platform ?? process.platform
  const elsewhere = (first: unknown): string | null => {
    if (typeof first !== 'object' || first === null) return null
    const given = first as {
      workspaceId?: unknown
      workspaceRoot?: unknown
      key?: { workspaceId?: unknown; workspaceRoot?: unknown }
    }
    // Only a call that names the chat's folder (a key, a session's start):
    // the rest (a list, a read by session id) find nothing of another
    // environment's here, and some answer at once rather than in a promise.
    const root = given.key?.workspaceRoot ?? given.workspaceRoot
    if (typeof root !== 'string') return null
    if (isMachinePath(root)) return 'ssh:'
    const workspaceId = given.key?.workspaceId ?? given.workspaceId
    const record = typeof workspaceId === 'string' ? deps.recordOf(workspaceId) : null
    return (
      environmentRouteOfRecord(record, platform) ??
      (platform === 'win32' && !record ? (machineRouteOfPath(root) ?? null) : null)
    )
  }
  const message = (route: string) =>
    route.startsWith('wsl:')
      ? `This chat is WSL: ${route.slice('wsl:'.length)}'s, and runs on that distribution's own Studio server.`
      : 'This chat is on an SSH machine. Turn SSH machines on (Settings › Agents › Studio server) to open it.'
  // One wrapper per member, so a member read twice is the same function (a
  // listener handed in and later taken out again is found).
  const wrapped = new Map<PropertyKey, { of: unknown; fn: (...args: unknown[]) => unknown }>()
  return new Proxy(backend, {
    get(target, member, receiver) {
      const value = Reflect.get(target, member, receiver) as unknown
      if (typeof value !== 'function') return value
      const known = wrapped.get(member)
      if (known && known.of === value) return known.fn
      const fn = (...args: unknown[]) => {
        const route = args.length > 0 ? elsewhere(args[0]) : null
        if (route)
          return member === 'recoverTranscript'
            ? Promise.reject(new Error(message(route)))
            : Promise.resolve({ ok: false, message: message(route) })
        return (value as (...input: unknown[]) => unknown).apply(target, args)
      }
      wrapped.set(member, { of: value, fn })
      return fn
    },
  })
}
