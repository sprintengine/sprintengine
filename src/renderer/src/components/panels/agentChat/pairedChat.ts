import { StudioError } from '../../../../../../packages/client-runtime/src/public'
import { negotiateChatCapabilities } from '../../../../../../packages/client-runtime/src/public'
import {
  STUDIO_COMMAND_METHODS,
  type StudioMethodParams,
  type StudioWelcomeFrame,
} from '../../../../../../packages/studio-protocol/src/public'
import type { ConversationSendTurnInput } from '../../../../../shared/conversation-runtime'
import type { MeshConversationKey } from '../../../../../shared/tailnet-mesh'
import { randomId } from '../../../../../shared/random-id'
import { environmentChatSourceFor } from '../../../studio/environmentChats'
import { pairedTarget } from '../../../studio/environmentStudio'
import { changePairedChat } from '../../../studio/pairedChats'
import type { ChatEnvironment, ConversationTransport, ConversationTransportCapabilities } from './conversationTransport'
import { environmentConversationTransport } from './environmentChat'
import { studioPullRequestHost } from './pullRequestHost'
import { ask, askUntilAnswered, commanded, createStudioConversationParts, outcome, upload } from './studioChat'

// A chat on a paired desktop, as this window's chat view follows and drives
// it: over this window's own client of that machine's Studio (the route
// `tailnet:<pairing>`, `environmentStudio.ts`), the client the window's list
// of that machine's chats is read on too (`environmentChats.ts`).
//
// The chat is drawn in a pane of a workspace here, so the view names it by
// that workspace; every call names it by its own ids there. Its commands are
// the protocol's keyed ones (`conversation.send`, `.interrupt`, …), which
// that Studio carries out under this client's command id whether or not the
// chat has a session live: a message to a chat at rest wakes one there, so
// the view never starts a session itself. What it carries beside its words
// (pictures, files) goes up on the same connection first (`uploads.*`), and
// the send names them. Reads a device's grant reaches by the chat's key, not
// by a folder (it reads no file of that disk): the @ search, the `/` list, a
// step's picture.
//
// What it may do is read off that machine's welcome and this pairing's grant
// there (`negotiateChatCapabilities`), as every chat's is.

/** How a paired machine's chat's `/` list is kept in this window: under the chat, as no folder of this disk names it. */
export function pairedCommandsKey(key: MeshConversationKey): string {
  return `tailnet:${key.connectionId}/${key.workspaceId}/${key.agentId}`
}

type Result = { ok: true; notice?: string } | { ok: false; message: string; code?: string }

const failed = (error: unknown): { ok: false; message: string; code?: string } => ({
  ok: false,
  message: error instanceof Error ? error.message : String(error),
  ...(error instanceof StudioError ? { code: error.code } : {}),
})

/** The keyed command methods by the command kind each carries. */
type CommandMethod = keyof typeof STUDIO_COMMAND_METHODS

/** A paired machine's chat, driven over this window's client of that machine. */
export function createPairedChatTransport(input: {
  key: MeshConversationKey
  machineName: string
  /** Told once a pull request Create PR opened there is recorded as the chat's. */
  onPullRequestRecorded?: () => void
}): ConversationTransport {
  const { key, machineName } = input
  const target = pairedTarget({ id: key.connectionId, machineName })
  const source = environmentChatSourceFor(target)
  const client = () => source.client()
  // The view's key names the pane's workspace here; the chat is that
  // machine's, by its ids there. One transport per chat (a sub-agent's is its own).
  const ref = { workspaceId: key.workspaceId, agentId: key.agentId }
  const parts = createStudioConversationParts(client, { chatRef: () => ref })
  // That machine's providers, command lists and history, as its environment transport reads them.
  const { services } = environmentConversationTransport(target)

  const command = <M extends CommandMethod>(
    method: M,
    params: Omit<StudioMethodParams<M>, 'key' | 'commandId'>,
  ): Promise<Result> =>
    commanded(() =>
      ask(client, method, { ...params, key: ref, commandId: randomId() } as unknown as StudioMethodParams<M>),
    )

  // What a send carries beside its words goes up first, on the same connection.
  const staged = async (
    attachments: ConversationSendTurnInput['attachments'],
    files: ConversationSendTurnInput['files'],
  ): Promise<string[]> => {
    const ids: string[] = []
    for (const picture of attachments ?? []) ids.push(await upload(client, picture))
    for (const file of files ?? []) {
      const read = await window.api.readAttachedFile(file.path)
      if (!read.ok) throw new Error(read.message)
      ids.push(
        await upload(
          client,
          { mediaType: 'application/octet-stream', dataBase64: read.dataBase64, name: read.name },
          'attachment',
        ),
      )
    }
    return ids
  }
  const giveBack = (uploadIds: string[]) => {
    if (uploadIds.length) void ask(client, 'uploads.discard', { uploadIds }).catch(() => undefined)
  }

  const send = async (
    turn: Pick<
      ConversationSendTurnInput,
      | 'message'
      | 'localTurnId'
      | 'mentions'
      | 'files'
      | 'skills'
      | 'attachments'
      | 'mode'
      | 'steer'
      | 'composedAt'
      | 'confirmedStale'
      | 'commandId'
    > & { queue?: boolean },
  ): Promise<Result> => {
    let uploadIds: string[] = []
    try {
      uploadIds = await staged(turn.attachments, turn.files)
    } catch (error) {
      return failed(error)
    }
    const params = {
      key: ref,
      commandId: turn.commandId ?? randomId(),
      message: turn.message,
      ...(uploadIds.length ? { uploadIds } : {}),
      ...(turn.localTurnId ? { localTurnId: turn.localTurnId } : {}),
      ...(turn.skills?.length ? { skills: turn.skills.map((skill) => skill.id) } : {}),
      ...(turn.mentions?.length ? { mentions: turn.mentions } : {}),
      ...(turn.steer ? { steer: true as const } : {}),
      ...(turn.queue ? { queue: true as const } : {}),
      ...(turn.mode && turn.mode !== 'default' ? { mode: turn.mode } : {}),
      ...(turn.composedAt !== undefined ? { composedAt: turn.composedAt } : {}),
      ...(turn.confirmedStale ? { confirmedStale: true as const } : {}),
    } as StudioMethodParams<'conversation.send'>
    // A held message is asked again under its id while its answer is lost:
    // held there once, not once there and again when the view keeps it.
    const sent = await commanded(() =>
      turn.queue ? askUntilAnswered(client, 'conversation.send', params) : ask(client, 'conversation.send', params),
    )
    if (!sent.ok) giveBack(uploadIds)
    return sent
  }

  let said: { welcome: object | null; capabilities: ConversationTransportCapabilities } | null = null
  let where: ChatEnvironment | null = null
  const welcome = (): StudioWelcomeFrame | null => source.welcome()

  return {
    get capabilities() {
      const now = welcome()
      if (said?.welcome !== now) {
        const negotiated = negotiateChatCapabilities(now ? { via: 'studio', welcome: now } : null)
        // A keyed send wakes the chat's session there; none is started from here.
        said = { welcome: now, capabilities: { ...negotiated, startSession: false } }
      }
      return said.capabilities
    },
    get environment() {
      const id = welcome()?.environment.id ?? null
      if (where?.id !== id) where = { id, label: machineName, route: target.route }
      return where
    },
    services,
    // Every Create PR step over there, in the chat's own checkout there.
    pullRequestHost: () => {
      const host = studioPullRequestHost(ref, client)
      return {
        ...host,
        create: async (text, pin) => {
          const created = await host.create(text, pin)
          if (created.ok && created.kind === 'created') input.onPullRequestRecorded?.()
          return created
        },
      }
    },
    subscribe: (subscription, cb) => parts.subscribe(subscription, cb),
    loadEarlier: (page) => parts.loadEarlier(page),
    toolDetail: (detail) => parts.toolDetail(detail),
    readEvent: (read) => parts.readEvent(read),
    turnDiff: (diff) => parts.turnDiff(diff),
    attachment: (stored) => parts.attachment(stored),
    rewind: (turn) => parts.rewind(turn),
    handoff: (handed) => parts.handoff(handed),
    fork: (fork) => parts.fork(fork),
    revert: (turn) => parts.revert(turn),
    cancelQueued: (held) => parts.cancelQueued(held),
    scheduleSend: (scheduled) => parts.scheduleSend(scheduled),
    sendScheduledNow: (scheduled) => parts.sendScheduledNow(scheduled),
    cancelScheduled: (scheduled) => parts.cancelScheduled(scheduled),
    usageLimitResume: (resume) => parts.usageLimitResume(resume),
    restartSession: (restart) => parts.restartSession(restart),
    send: (turn) => send(turn),
    queue: ({ key: _viewKey, ...turn }) => send({ ...turn, queue: true }),
    interrupt: () => command('conversation.interrupt', {}),
    respond: (response) =>
      response.answers && response.approved
        ? command('conversation.answerQuestion', {
            requestId: response.requestId,
            answers: response.answers,
          })
        : command('conversation.resolveApproval', {
            requestId: response.requestId,
            decision: !response.approved
              ? 'deny'
              : response.decision === 'always' || response.decision === 'conversation'
                ? response.decision
                : 'once',
          }),
    setPermissionPreset: (change) =>
      command('conversation.setPermissionPreset', {
        preset: change.permissionPreset,
        ...(change.permissionMode ? { permissionMode: change.permissionMode } : {}),
      }),
    setModel: (change) => command('conversation.setModel', { modelId: change.modelId }),
    // That machine keeps the chat's effort and runs each turn at it.
    setReasoningEffort: (change) =>
      command('conversation.setReasoningEffort', change.effort ? { effort: change.effort } : {}),
    mcpServerAction: async (asked) => {
      // Its CLI waits for the sign-in's callback over there.
      if (asked.action === 'sign-in')
        return {
          ok: false,
          message: `Sign in to ${asked.serverId} on ${machineName}: its agent waits for the sign-in there.`,
        }
      const done = await command('conversation.mcpServerAction', {
        serverId: asked.serverId,
        action: asked.action,
      })
      return done.ok ? { ok: true } : { ok: false, message: done.message }
    },
    stopSubagent: (stop) => command('conversation.stopSubagent', { toolUseId: stop.toolUseId }),
    messageSubagent: (words) =>
      command('conversation.messageSubagent', { toolUseId: words.toolUseId, message: words.message }),
    askSideQuestion: (question) =>
      outcome(() =>
        ask(client, 'conversation.askSideQuestion', {
          key: ref,
          commandId: randomId(),
          questionId: question.requestId,
          question: question.question,
          ...(question.history?.length ? { history: question.history } : {}),
        }),
      ),
    cancelSideQuestion: (question) =>
      outcome(() => ask(client, 'conversation.cancelSideQuestion', { questionId: question.requestId })),
    readContextBreakdown: async () => {
      try {
        return await ask(client, 'conversation.contextBreakdown', { key: ref })
      } catch (error) {
        return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
    },
    // Searched there, in the chat's own folder: what comes back is relative to it.
    searchMentions: ({ query }) =>
      outcome(async () => ({
        ok: true as const,
        entries: (await ask(client, 'conversation.searchFiles', { key: ref, query, limit: 50 })).entries,
      })),
    // Kept under the chat itself here (`pairedCommandsKey`), never a folder of this disk.
    listCommands: async ({ refresh }) => {
      const listed = await ask(client, 'conversation.listCommands', {
        key: ref,
        ...(refresh ? { refresh: true } : {}),
      })
      return {
        cli: listed.cli,
        cwd: pairedCommandsKey(key),
        commands: listed.commands,
        fetchedAt: listed.fetchedAt,
        ...(listed.error ? { error: listed.error } : {}),
      }
    },
    // By the step's id, never its path, which names a file over there.
    toolImage: async ({ toolUseId }) => {
      try {
        const picture = await ask(client, 'conversation.picture', { key: ref, toolUseId })
        return { ok: true, src: `data:${picture.mediaType};base64,${picture.dataBase64}` }
      } catch (error) {
        const unsupported = error instanceof StudioError && ['unknown_method', 'outdated'].includes(error.code)
        return { ok: false, unsupported, message: error instanceof Error ? error.message : String(error) }
      }
    },
    // The pull request's, on that machine's Studio; one that cannot take it says so in words.
    unwatchPullRequest: async (asked) => {
      const answer = await changePairedChat({ id: key.connectionId, machineName }, key.workspaceId, {
        kind: 'unwatch-pull-request',
        agentId: key.agentId,
        url: asked.url,
      })
      return answer.ok ? { ok: true } : { ok: false, message: answer.message }
    },
  }
}
