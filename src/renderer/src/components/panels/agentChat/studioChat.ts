import {
  StudioError,
  type ConversationFollowFrame,
  type ConversationRef,
  type StudioClient,
} from '../../../../../../packages/client-runtime/src/public'
import { CONVERSATION_FORK_CAPABILITY } from '../../../../../../packages/conversation-protocol/src/public'
import {
  isChatAddress,
  STUDIO_SESSION_FILES_CAPABILITY,
  STUDIO_TERMINAL_HANDOFF_CAPABILITY,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type StudioTopicPayload,
} from '../../../../../../packages/studio-protocol/src/public'
import { mapWithLimit } from '../../../../../shared/concurrency'
import { randomId as commandId } from '../../../../../shared/random-id'
import type {
  ConversationEvent,
  ConversationImageAttachment,
  ConversationKey,
  ConversationSendTurnInput,
  ConversationSessionFrame,
} from '../../../../../shared/conversation-runtime'
import type { ChatServices } from './chatServices'
import type { ConversationTransport } from './conversationTransport'

// The chat view over the Studio protocol: the same calls the window's IPC
// answers, carried by this window's Studio client instead. Every answer has
// the shape its IPC twin has, so nothing above the transport can tell which
// one it is talking to.
//
// - A refusal of the request itself (Studio unreachable, a param it would not
//   read) is answered as the IPC answers a failure of that call: an
//   `{ ok: false, message }` where the call has an outcome, a rejection where
//   it has a plain value.
// - Every mutation carries a command id minted here, so one resent after a
//   dropped connection is answered from its receipt instead of done twice.
// - A picture goes ahead of the send that carries it, in pieces a frame can
//   hold (`uploads.*`); the send names the uploads.

type ClientSource = () => Promise<StudioClient>

// Refusals about the connection rather than the request: the window's client
// reconnects by itself, so they are told as one calm sentence instead of the
// socket's own words, which mean nothing to someone using a chat.
const CONNECTION_CODES = new Set([
  'environment_changed',
  'offline',
  'timeout',
  'disconnected',
  'closed',
  'hello_timeout',
  'shutting_down',
  'resync_required',
  'too_many_connections',
  'internal_error',
  'unauthorized',
  'busy',
])
const FORK_NEEDS_NEWER_STUDIO =
  'This Studio is older than this window and cannot fork a chat. Update it, then try again.'
const CONNECTION_LOST = 'This window lost its connection to Studio. It reconnects by itself; try again in a moment.'

const messageOf = (error: unknown): string =>
  error instanceof StudioError && CONNECTION_CODES.has(error.code)
    ? CONNECTION_LOST
    : error instanceof Error
      ? error.message
      : String(error)

// How long a push stream waits before following a client that replaced one
// that closed, or retrying one that could not connect.
const PUSH_FOLLOW_RETRY_MS = 2_000

// Pictures go up a few at a time: each is several requests, and a send that
// carries many must not crowd out the reads the rest of the window makes.
const UPLOADS_AT_ONCE = 3

async function ask<M extends StudioMethod>(
  client: ClientSource,
  method: M,
  params: StudioMethodParams<M>,
): Promise<StudioMethodResult<M>> {
  try {
    return await (await client()).request(method, params)
  } catch (error) {
    throw error instanceof StudioError && CONNECTION_CODES.has(error.code) ? new Error(CONNECTION_LOST) : error
  }
}

/** A call whose answer has an `ok` of its own: a refused request reads as that call failing. */
async function outcome<T>(work: () => Promise<T>): Promise<T | { ok: false; message: string }> {
  try {
    return await work()
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}

const refOf = (key: ConversationKey): ConversationRef => ({
  workspaceId: key.workspaceId,
  agentId: key.agentId,
  workspaceRoot: key.workspaceRoot,
})

/** A command's answer as a transport says it: accepted (with its notice), or why not. */
const commanded = (work: () => Promise<{ notice?: string }>) =>
  outcome(async () => {
    const answer = await work()
    return { ok: true as const, ...(answer.notice ? { notice: answer.notice } : {}) }
  })

/** The decoded length of base64 text, without decoding it. */
function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/**
 * Stage a picture in pieces and answer its upload id. Pieces are cut on
 * whole base64 quanta, so each is base64 on its own and none is decoded here.
 */
async function upload(client: ClientSource, attachment: ConversationImageAttachment): Promise<string> {
  const byteLength = base64Bytes(attachment.dataBase64)
  const begun = await ask(client, 'uploads.begin', {
    mediaType: attachment.mediaType,
    byteLength,
    ...(attachment.name === undefined ? {} : { name: attachment.name }),
  })
  const quanta = Math.max(1, Math.floor(begun.chunkBytes / 3))
  const step = quanta * 4
  for (let at = 0, offset = 0; at < attachment.dataBase64.length; at += step, offset += quanta * 3) {
    await ask(client, 'uploads.append', {
      uploadId: begun.uploadId,
      offset,
      dataBase64: attachment.dataBase64.slice(at, at + step),
    })
  }
  return begun.uploadId
}

function sessionFrame(frame: ConversationFollowFrame | { type: 'error'; message: string }): ConversationSessionFrame {
  // A wire event is the runtime's event as it was stored; the client validated its envelope.
  if (frame.type === 'snapshot')
    return {
      type: 'snapshot',
      page: { ...frame.page, events: frame.page.events as ConversationEvent[] },
      ...(frame.reset ? { reset: true } : {}),
      ...(frame.generation === undefined ? {} : { generation: frame.generation }),
    }
  if (frame.type === 'event') return { type: 'event', event: frame.event as ConversationEvent }
  return frame
}

/**
 * Follow a push topic on this window's client for as long as the caller wants
 * it. The client reconnects by itself and subscribes again; one that closed
 * for good is replaced, and followed on its replacement. One parked (a refused
 * ticket) is waited out without asking for it, which would wake it only to be
 * refused again; a topic the Studio refuses for good is not asked for again.
 */
function followPush<T extends 'conversation.commands' | 'conversation.events'>(
  client: ClientSource,
  topic: T,
  listener: (payload: StudioTopicPayload<T>) => void,
): () => void {
  let stop: (() => void) | null = null
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const later = (run: () => void): void => {
    if (stopped) return
    timer = setTimeout(() => {
      timer = null
      run()
    }, PUSH_FOLLOW_RETRY_MS)
  }
  const follow = (): void =>
    void client().then(
      (connected) => {
        if (stopped) return
        const waitOut = (): void => {
          if (connected.state === 'parked') later(waitOut)
          else if (connected.state === 'closed' || connected.state === 'open') follow()
          else later(waitOut)
        }
        stop = connected.subscribe(
          topic,
          {},
          {
            onPayload: (payload) => listener(payload as StudioTopicPayload<T>),
            onEnd: () => {
              stop = null
              // Read once the client has said why: a park or a close ends its
              // streams first and sets its state after.
              queueMicrotask(() => {
                if (connected.state === 'closed') later(follow)
                else if (connected.state !== 'open') later(waitOut)
              })
            },
          },
        )
      },
      () => later(follow),
    )
  follow()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    stop?.()
  }
}

/**
 * The window's services over the Studio protocol. `watchOpen` hears each time
 * the window's connection opens, a reconnect included.
 */
export function createStudioChatServices(
  client: ClientSource,
  watchOpen: (listener: () => void) => () => void = () => () => undefined,
): ChatServices {
  return {
    providers: {
      list: (input) =>
        outcome(
          async () => await ask(client, 'providers.list', input?.cliRuntimes ? { cliRuntimes: input.cliRuntimes } : {}),
        ),
      models: (input) =>
        outcome(
          async () =>
            await ask(client, 'providers.models', {
              providerId: input.providerId,
            }),
        ),
      secretStatus: (input) =>
        outcome(
          async () =>
            await ask(client, 'providers.secretStatus', {
              providerId: input.providerId,
            }),
        ),
      signIn: (input) =>
        outcome(() =>
          ask(client, 'providers.signIn', {
            providerId: input.providerId,
            ...(input.cliRuntimes ? { cliRuntimes: input.cliRuntimes } : {}),
          }),
        ),
      setSecret: (input) =>
        outcome(() =>
          ask(client, 'providers.setSecret', {
            providerId: input.providerId,
            value: input.value,
            commandId: commandId(),
          }),
        ),
      clearSecret: (input) =>
        outcome(() => ask(client, 'providers.clearSecret', { providerId: input.providerId, commandId: commandId() })),
    },
    sessions: {
      list: (input) =>
        outcome(() =>
          ask(client, 'session.list', {
            ...(input?.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
            ...(input?.agentId === undefined ? {} : { agentId: input.agentId }),
          }),
        ),
      stop: (input) =>
        outcome(() => ask(client, 'session.stop', { sessionId: input.sessionId, commandId: commandId() })),
      suspend: (input) =>
        outcome(() => ask(client, 'session.suspend', { sessionId: input.sessionId, commandId: commandId() })),
      terminalHandoff: (input) =>
        outcome(async () => {
          // Only a Studio that opens terminals offers it.
          if (!(await client()).supports(STUDIO_TERMINAL_HANDOFF_CAPABILITY))
            return { ok: false as const, message: 'This Studio cannot open a terminal to resume the chat in.' }
          return await ask(client, 'session.terminalHandoff', {
            ...('sessionId' in input
              ? { sessionId: input.sessionId }
              : { workspaceId: input.workspaceId, agentId: input.agentId }),
            commandId: commandId(),
          })
        }),
      // A wire event is the runtime's event as it was stored, without its payload.
      onLifecycleEvent: (listener, onReconnected) => {
        const stopFollowing = followPush(client, 'conversation.events', (event) => listener(event as ConversationEvent))
        // A first open the reader's own first read was waiting on reads once more, harmlessly.
        const stopWatching = onReconnected ? watchOpen(onReconnected) : () => undefined
        return () => {
          stopWatching()
          stopFollowing()
        }
      },
    },
    history: {
      threads: (input) =>
        outcome(() =>
          ask(client, 'conversation.threads', {
            workspaceId: input.workspaceId,
            ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
          }),
        ),
      search: (input) =>
        outcome(() =>
          ask(client, 'conversation.search', {
            workspaceId: input.workspaceId,
            ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
            query: input.query,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          }),
        ),
      cancelSearch: async (requestId) => {
        await ask(client, 'conversation.cancelSearch', { requestId })
      },
    },
    approvalRules: {
      list: () => outcome(() => ask(client, 'conversation.approvalRules', {})),
      revoke: (ruleId) =>
        outcome(() => ask(client, 'conversation.revokeApprovalRule', { ruleId, commandId: commandId() })),
    },
    files: {
      canStat: true,
      search: async (rootPath, query, options) =>
        await ask(client, 'files.search', {
          rootPath,
          query,
          ...(options?.limit === undefined ? {} : { limit: options.limit }),
          ...(options?.purpose === undefined ? {} : { purpose: options.purpose }),
          ...(options?.channel === undefined ? {} : { channel: options.channel }),
          ...(options?.recentAt === undefined ? {} : { recentAt: options.recentAt }),
        }),
      cancelSearch: async (channel) => {
        await ask(client, 'files.cancelSearch', channel === undefined ? {} : { channel })
      },
      stat: async (path) => {
        // Asked by an absolute path, a stat is answered in the path's shape.
        const { stat } = await ask(client, 'files.stat', { path })
        if (!('isFile' in stat)) throw new Error('Studio answered that stat in another shape.')
        return stat
      },
      readImage: async (path) => (await ask(client, 'files.readImage', { path })).dataUrl,
      repoRoot: async (folderPath, hostId) =>
        (await ask(client, 'files.repoRoot', { folderPath, ...(hostId === undefined ? {} : { hostId }) })).repoRoot,
    },
    planDocument: (input) =>
      outcome(() =>
        ask(client, 'conversation.planDocument', {
          key: refOf(input),
          plan: input.plan,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.planFilePath === undefined ? {} : { planFilePath: input.planFilePath }),
        }),
      ),
    commands: {
      list: async (input) => (await ask(client, 'conversation.commands', input)).catalog,
      onChanged: (listener) => followPush(client, 'conversation.commands', listener),
    },
  }
}

// Every call the transport makes of a chat, its session's optional ones
// included: a Studio of this build serves each of them, and the window's
// local transport calls each one, so a missing one fails typecheck.
export type StudioTransportParts = Omit<ConversationTransport, 'kind' | 'capabilities' | 'environmentId' | 'services'> &
  Required<
    Pick<
      ConversationTransport,
      | 'setModel'
      | 'attachment'
      | 'rewind'
      | 'handoff'
      | 'fork'
      | 'startSession'
      | 'revert'
      | 'mcpServerAction'
      | 'stopSubagent'
      | 'messageSubagent'
      | 'askSideQuestion'
      | 'cancelSideQuestion'
      | 'readContextBreakdown'
      | 'queue'
      | 'cancelQueued'
      | 'scheduleSend'
      | 'sendScheduledNow'
      | 'cancelScheduled'
      | 'usageLimitResume'
    >
  >

/** A conversation on this window's Studio, over the protocol. */
export function createStudioConversationParts(client: ClientSource): StudioTransportParts {
  const send = async (input: ConversationSendTurnInput) => {
    const { attachments, commandId: given, ...rest } = input
    // A Studio that does not read `files` would drop them without a word and
    // send the message as if nothing were attached; better the send says so.
    if (rest.files?.length && !(await client()).supports(STUDIO_SESSION_FILES_CAPABILITY))
      throw new Error('This Studio cannot take attached files. Remove them, or update it, and send again.')
    // What this send staged, given back if the send cannot go: Studio would
    // otherwise hold it against this window's budget until it expires. One
    // that finishes staging after the send has failed is given back as it does.
    const stagedIds: string[] = []
    let abandoned = false
    const giveBack = (uploadIds: string[]) => {
      if (uploadIds.length) void ask(client, 'uploads.discard', { uploadIds }).catch(() => undefined)
    }
    try {
      const staged = attachments?.length
        ? await mapWithLimit(attachments, UPLOADS_AT_ONCE, async (attachment) => {
            const uploadId = await upload(client, attachment)
            if (abandoned) giveBack([uploadId])
            else stagedIds.push(uploadId)
            return {
              id: attachment.id,
              uploadId,
              ...(attachment.name === undefined ? {} : { name: attachment.name }),
            }
          })
        : undefined
      return await ask(client, 'session.send', {
        ...rest,
        ...(staged ? { attachments: staged } : {}),
        commandId: given ?? commandId(),
      })
    } catch (error) {
      // A picture the send already carried is passed over by Studio.
      abandoned = true
      giveBack(stagedIds.splice(0))
      throw error
    }
  }
  return {
    subscribe(input, cb) {
      let stop: (() => void) | null = null
      let stopped = false
      void client().then(
        (connected) => {
          if (stopped) return
          stop = connected.conversations.follow(
            refOf(input.key),
            {
              ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
              ...(input.generation === undefined ? {} : { generation: input.generation }),
              ...(input.turnLimit === undefined ? {} : { turnLimit: input.turnLimit }),
              // A stream Studio could not start or keep ends with its error, as
              // the IPC's does: the view shows it and subscribes again itself.
              resubscribe: false,
            },
            (frame) => {
              if (!stopped) cb(sessionFrame(frame))
            },
          )
        },
        // As a subscription the runtime could not start: the view tries again.
        (error: unknown) => {
          if (!stopped) cb({ type: 'error', message: messageOf(error) })
        },
      )
      return () => {
        stopped = true
        stop?.()
      }
    },
    loadEarlier: (input) =>
      outcome(async () => {
        const page = await (
          await client()
        ).conversations.loadEarlier(refOf(input.key), input.beforeCursor, input.turnLimit)
        return page.ok
          ? { ok: true as const, page: { ...page.page, events: page.page.events as ConversationEvent[] } }
          : { ok: false as const, message: page.message }
      }),
    async toolDetail(input) {
      try {
        const read = await (await client()).conversations.toolDetail(refOf(input), input.toolUseId)
        if (read.ok) return { ok: true, detail: read.detail }
        return {
          ok: false,
          code:
            read.code === 'not_found' ? 'not_found' : read.code === 'invalid_params' ? 'invalid_input' : 'unavailable',
          message: read.message,
        }
      } catch (error) {
        return { ok: false, code: 'unavailable', message: messageOf(error) }
      }
    },
    async readEvent(input) {
      try {
        const read = await (await client()).conversations.event(refOf(input), input.seq, input.id)
        if (read.ok) return { ok: true, event: read.event as ConversationEvent }
        return {
          ok: false,
          code:
            read.code === 'not_found' ? 'not_found' : read.code === 'invalid_params' ? 'invalid_input' : 'unavailable',
          message: read.message,
        }
      } catch (error) {
        return { ok: false, code: 'unavailable', message: messageOf(error) }
      }
    },
    turnDiff: (input) =>
      outcome(async () => {
        const read = await (await client()).conversations.turnDiff(refOf(input.key), input.turnSeq, input.path)
        if (!read.ok) return { ok: false as const, message: read.message }
        const { ok: _ok, ...diff } = read
        return { ok: true as const, ...diff }
      }),
    send: (input) => outcome(() => send(input)),
    interrupt: (input) =>
      outcome(() =>
        ask(client, 'session.interrupt', { sessionId: input.sessionId, commandId: input.commandId ?? commandId() }),
      ),
    respond: (input) =>
      outcome(() =>
        ask(client, 'session.respond', {
          sessionId: input.sessionId,
          requestId: input.requestId,
          approved: input.approved,
          ...(input.decision === undefined ? {} : { decision: input.decision }),
          ...(input.answers === undefined ? {} : { answers: input.answers }),
          ...(input.requestKind === undefined ? {} : { requestKind: input.requestKind }),
          commandId: input.commandId ?? commandId(),
        }),
      ),
    setPermissionPreset: (input) =>
      outcome(() =>
        ask(client, 'session.setPermission', {
          sessionId: input.sessionId,
          permissionPreset: input.permissionPreset,
          ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
          commandId: input.commandId ?? commandId(),
        }),
      ),
    setModel: (input) =>
      outcome(() =>
        ask(client, 'session.setModel', {
          sessionId: input.sessionId,
          modelId: input.modelId,
          commandId: input.commandId ?? commandId(),
        }),
      ),
    attachment: (input) => outcome(() => ask(client, 'conversation.attachment', { ref: input.ref })),
    rewind: (input) =>
      outcome(() =>
        ask(client, 'conversation.rewind', { key: refOf(input.key), turnSeq: input.turnSeq, commandId: commandId() }),
      ),
    // The chat's queue, scheduled messages and usage-limit resume, kept by
    // the Studio that runs it. A held message goes as words: this connection
    // does not carry a keyed send's pictures or files
    // (`conversation-queued-attachments` is not served), and the view hands
    // over only what the Studio holds.
    queue: (input) =>
      commanded(async () => {
        if (input.attachments?.length || input.files?.length)
          throw new Error('This Studio holds a queued message as words only.')
        return ask(client, 'conversation.send', {
          key: refOf(input.key),
          message: input.message,
          ...(input.skills?.length ? { skills: input.skills.map((skill) => skill.id) } : {}),
          ...(input.mentions?.length ? { mentions: input.mentions } : {}),
          queue: true,
          commandId: commandId(),
        })
      }),
    cancelQueued: (input) =>
      commanded(() =>
        ask(client, 'conversation.cancelQueued', {
          key: refOf(input.key),
          queuedId: input.queuedId,
          commandId: commandId(),
        }),
      ),
    scheduleSend: (input) =>
      commanded(() =>
        ask(client, 'conversation.scheduleSend', {
          key: refOf(input.key),
          message: input.message,
          sendAt: input.sendAt,
          ...(input.untilLimitReset ? { untilLimitReset: input.untilLimitReset } : {}),
          commandId: commandId(),
        }),
      ),
    sendScheduledNow: (input) =>
      commanded(() =>
        ask(client, 'conversation.sendScheduledNow', {
          key: refOf(input.key),
          scheduledId: input.scheduledId,
          commandId: commandId(),
        }),
      ),
    cancelScheduled: (input) =>
      commanded(() =>
        ask(client, 'conversation.cancelScheduled', {
          key: refOf(input.key),
          scheduledId: input.scheduledId,
          commandId: commandId(),
        }),
      ),
    usageLimitResume: (input) =>
      commanded(() =>
        ask(client, 'conversation.usageLimitResume', {
          key: refOf(input.key),
          action: input.action,
          ...(input.always ? { always: true as const } : {}),
          commandId: commandId(),
        }),
      ),
    handoff: (input) =>
      outcome(() => ask(client, 'conversation.handoff', { key: refOf(input.key), commandId: commandId() })),
    // A Studio from before the fork joined the chat's records (and said
    // where it is) withholds `conversation-fork`: asking it would leave a
    // transcript no window lists, so it is not asked.
    fork: (input) =>
      outcome(async () => {
        if (!(await client()).welcome.conversation.capabilities.includes(CONVERSATION_FORK_CAPABILITY))
          return { ok: false as const, message: FORK_NEEDS_NEWER_STUDIO }
        const forked = await ask(client, 'conversation.fork', {
          key: refOf(input.key),
          newAgentId: input.newAgentId,
          ...(input.side === 'user'
            ? { side: 'user' as const, turnSeq: input.turnSeq }
            : { side: 'assistant' as const, turnId: input.turnId }),
          commandId: commandId(),
        })
        // Never read as made somewhere it was not.
        if (!isChatAddress(forked.address) || forked.address.agentId !== input.newAgentId || !forked.name)
          return {
            ok: false as const,
            message: 'Studio made the fork but did not say where it is. Reload the window to find it.',
          }
        return { ok: true as const, address: forked.address, name: forked.name }
      }),
    startSession: (input) =>
      outcome(() =>
        ask(client, 'session.start', {
          workspaceRoot: input.workspaceRoot,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          providerId: input.providerId,
          modelId: input.modelId,
          ...(input.cliRuntimes === undefined ? {} : { cliRuntimes: input.cliRuntimes }),
          ...(input.permissionPreset === undefined ? {} : { permissionPreset: input.permissionPreset }),
          ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
          ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
          commandId: commandId(),
        }),
      ),
    mcpServerAction: (input) =>
      outcome(() =>
        ask(client, 'session.mcpServerAction', {
          sessionId: input.sessionId,
          serverId: input.serverId,
          action: input.action,
          commandId: commandId(),
        }),
      ),
    stopSubagent: (input) =>
      outcome(() =>
        ask(client, 'session.stopSubagent', {
          sessionId: input.sessionId,
          toolUseId: input.toolUseId,
          commandId: commandId(),
        }),
      ),
    messageSubagent: (input) =>
      outcome(() =>
        ask(client, 'session.messageSubagent', {
          sessionId: input.sessionId,
          toolUseId: input.toolUseId,
          message: input.message,
          commandId: commandId(),
        }),
      ),
    askSideQuestion: (input) =>
      outcome(() =>
        ask(client, 'session.askSideQuestion', {
          sessionId: input.sessionId,
          requestId: input.requestId,
          question: input.question,
          ...(input.history === undefined ? {} : { history: input.history }),
          commandId: commandId(),
        }),
      ),
    cancelSideQuestion: (input) =>
      outcome(() =>
        ask(client, 'session.cancelSideQuestion', { sessionId: input.sessionId, requestId: input.requestId }),
      ),
    readContextBreakdown: async (input) => {
      try {
        return await ask(client, 'session.contextBreakdown', { sessionId: input.sessionId })
      } catch (error) {
        return { ok: false, reason: 'failed', message: messageOf(error) }
      }
    },
    revert: (input) =>
      outcome(() =>
        ask(client, 'conversation.revert', {
          key: refOf(input.key),
          turnSeq: input.turnSeq,
          ...(input.confirmed ? { confirmed: true } : {}),
          ...(input.undo ? { undo: true } : {}),
          ...(input.files === undefined ? {} : { files: input.files }),
          commandId: commandId(),
        }),
      ),
  }
}
