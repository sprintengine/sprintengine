import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import {
  MESH_CANVAS_BOARDS_CHANNEL,
  MESH_CANVAS_SCREENSHOT_CHANNEL,
  MESH_FORGET_CHANNEL,
  MESH_GET_LIVE_STATE_CHANNEL,
  MESH_LIST_CONNECTIONS_CHANNEL,
  MESH_CANCEL_PAIRING_CHANNEL,
  MESH_PAIR_CHANNEL,
  MESH_REQUEST_PAIRING_CHANNEL,
  meshConversationFrameChannel,
  MESH_CONVERSATION_CANCEL_SIDE_QUESTION_CHANNEL,
  MESH_CONVERSATION_COMMAND_CHANNEL,
  MESH_CONVERSATION_CONTEXT_BREAKDOWN_CHANNEL,
  MESH_CONVERSATION_EARLIER_CHANNEL,
  MESH_CONVERSATION_FOLLOW_CHANNEL,
  MESH_CONVERSATION_LIST_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_CREATE_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_DRAFT_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_PUSH_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_STATE_CHANNEL,
  MESH_CONVERSATION_SEND_CHANNEL,
  MESH_CONVERSATION_SIDE_QUESTION_CHANNEL,
  MESH_CONVERSATION_TOOL_DETAIL_CHANNEL,
  MESH_CONVERSATION_EVENT_CHANNEL,
  MESH_CONVERSATION_TOOL_IMAGE_CHANNEL,
  MESH_CONVERSATION_ATTACHMENT_CHANNEL,
  MESH_CONVERSATION_TURN_DIFF_CHANNEL,
  MESH_CONVERSATION_WATCH_CHANGES_CHANNEL,
  MESH_CONVERSATION_CHANGES_DIFF_CHANNEL,
  MESH_CONVERSATION_CHANGED_FILE_CHANNEL,
  MESH_CONVERSATION_UNFOLLOW_CHANNEL,
  MESH_CONVERSATION_FILE_SEARCH_CHANNEL,
  MESH_CONVERSATION_COMMANDS_CHANNEL,
  type MeshConversationFrame,
} from '../../shared/tailnet-mesh'
import type { AutomationService } from '../automation/automation-service'
import { asRecord } from '../../shared/records'
import { boundConversationPage, conversationWireFrame } from '../../server/conversation-stream-shaping'

// The window's door onto the Mesh.
//
// IPC-only, exactly like the tailnet configuration channels: no MCP tool
// reaches any of this, so neither a local agent nor a paired remote device can
// make this machine pair with a third one, enumerate what it is paired with, or
// follow a conversation somewhere else. Pairing another machine is a decision a
// person makes at this keyboard.
//
// A followed conversation is owned by the WINDOW that followed it. A window
// that closes or reloads has no pane left to paint, so its follows end with it
// rather than streaming into a destroyed sender.

export function registerMeshIpc(ipcMain: IpcMain, service: AutomationService): void {
  // followId -> the window following.
  const followers = new Map<string, WebContents>()
  const trackedSenders = new Set<number>()

  const releaseSender = (senderId: number): void => {
    for (const [followId, sender] of [...followers]) {
      if (sender.id !== senderId) continue
      followers.delete(followId)
      service.mesh().unfollowConversation(followId)
    }
    trackedSenders.delete(senderId)
  }

  const trackSender = (event: IpcMainInvokeEvent): void => {
    if (trackedSenders.has(event.sender.id)) return
    trackedSenders.add(event.sender.id)
    event.sender.once('destroyed', () => releaseSender(event.sender.id))
  }

  ipcMain.handle(MESH_LIST_CONNECTIONS_CHANNEL, () => service.mesh().listConnections())
  // The initial read behind `mesh:event`: the requests waiting and each
  // machine's last reachability, so a reloaded window starts where it was.
  ipcMain.handle(MESH_GET_LIVE_STATE_CHANNEL, () => service.mesh().getLiveState())
  ipcMain.handle(MESH_PAIR_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.mesh().pair({ pairingUrl: record?.pairingUrl, deviceName: record?.deviceName })
  })
  // Asking a machine to pair, and polling the answer. Like every other
  // `mesh:*` channel this is IPC-only: pairing WITH a machine stays a decision
  // made at this keyboard, reachable from no MCP tool.
  ipcMain.handle(MESH_REQUEST_PAIRING_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.mesh().requestPairing({
      endpoint: record?.endpoint,
      deviceName: record?.deviceName,
      // Both halves of a both-ways pairing carry their own set: `scopes` is
      // what this machine asks to do THERE, `reverseScopes` what that machine
      // may do here. Absent leaves each end's own default in force.
      scopes: record?.scopes,
      reverseScopes: record?.reverseScopes,
    })
  })
  ipcMain.handle(MESH_CANCEL_PAIRING_CHANNEL, (_event, requestId: unknown) => {
    service.mesh().cancelPairing(requestId)
  })
  ipcMain.handle(MESH_FORGET_CHANNEL, (_event, connectionId: unknown) => service.mesh().forget(connectionId))
  ipcMain.handle(MESH_CANVAS_BOARDS_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service
      .mesh()
      .canvasBoards({ connectionId: record.connectionId, workspaceId: record.workspaceId, scope: record.scope })
  })
  ipcMain.handle(MESH_CANVAS_SCREENSHOT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().canvasScreenshot({
      connectionId: record.connectionId,
      workspaceId: record.workspaceId,
      board: record.board,
      dark: record.dark,
    })
  })
  // A remote chat's Create PR, a step per channel as the shell's own are:
  // every one runs on the chat's machine, in its checkout there.
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_STATE_CHANNEL, (_event, input: unknown) =>
    service.mesh().conversationPullRequestState({ key: asRecord(input)?.key }),
  )
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_DRAFT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationPullRequestDraft({ key: record.key, draftId: record.draftId })
  })
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationPullRequestDraftCancel({ key: record.key, draftId: record.draftId })
  })
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_PUSH_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationPullRequestPush({ key: record.key, pin: record.pin })
  })
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_CREATE_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service
      .mesh()
      .conversationPullRequestCreate({ key: record.key, title: record.title, body: record.body, pin: record.pin })
  })

  // Conversations on a paired machine. Like every `mesh:*` channel these
  // are IPC-only: following another machine's chat is something a person
  // here asks for, reachable from no MCP tool.
  ipcMain.handle(MESH_CONVERSATION_LIST_CHANNEL, (_event, connectionId: unknown) =>
    service.mesh().listConversations(connectionId),
  )
  ipcMain.handle(MESH_CONVERSATION_FOLLOW_CHANNEL, (event, input: unknown) => {
    const record = asRecord(input) ?? {}
    const followId = typeof record.followId === 'string' ? record.followId : ''
    if (!followId) {
      return { ok: false, code: 'invalid_arguments', message: 'A follow needs an id to deliver its frames on.' }
    }
    trackSender(event)
    followers.set(followId, event.sender)
    const channel = meshConversationFrameChannel(followId)
    return service.mesh().followConversation({
      followId,
      key: record.key,
      turnLimit: record.turnLimit,
      emit: (frame: MeshConversationFrame) => {
        const sender = followers.get(followId)
        if (!sender || sender.isDestroyed()) return
        // As every wire sends a conversation: a machine on an older build
        // sends its events whole, and this window reads them projected.
        sender.send(channel, conversationWireFrame(frame))
      },
    })
  })
  ipcMain.handle(MESH_CONVERSATION_UNFOLLOW_CHANNEL, (_event, followId: unknown) => {
    if (typeof followId === 'string') followers.delete(followId)
    service.mesh().unfollowConversation(followId)
  })
  ipcMain.handle(MESH_CONVERSATION_EARLIER_CHANNEL, async (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    const read = await service
      .mesh()
      .conversationLoadEarlier({ key: record.key, beforeCursor: record.beforeCursor, turnLimit: record.turnLimit })
    return read.ok ? { ...read, page: boundConversationPage(read.page).page } : read
  })
  ipcMain.handle(MESH_CONVERSATION_COMMAND_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationCommand({ key: record.key, command: record.command })
  })
  // A message with the images attached to it: main puts each in the other
  // machine's upload store and sends the message naming them. One with none
  // is the `send` command.
  ipcMain.handle(MESH_CONVERSATION_SEND_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationSend({
      key: record.key,
      message: record.message,
      attachments: record.attachments,
      queue: record.queue,
      steer: record.steer,
      skills: record.skills,
      mentions: record.mentions,
      files: record.files,
      mode: record.mode,
      composedAt: record.composedAt,
      confirmedStale: record.confirmedStale,
    })
  })
  ipcMain.handle(MESH_CONVERSATION_TOOL_DETAIL_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationToolDetail({ key: record.key, toolUseId: record.toolUseId })
  })
  ipcMain.handle(MESH_CONVERSATION_EVENT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationEvent({ key: record.key, seq: record.seq, id: record.id })
  })
  ipcMain.handle(MESH_CONVERSATION_TOOL_IMAGE_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationToolImage({ key: record.key, toolUseId: record.toolUseId })
  })
  ipcMain.handle(MESH_CONVERSATION_ATTACHMENT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationAttachment({ key: record.key, ref: record.ref })
  })
  ipcMain.handle(MESH_CONVERSATION_TURN_DIFF_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationTurnDiff({ key: record.key, turnSeq: record.turnSeq, path: record.path })
  })
  // A chat's changes on its machine, as that machine's Diff tab reads them.
  ipcMain.handle(MESH_CONVERSATION_WATCH_CHANGES_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationWatchChanges({ key: record.key, watching: record.watching })
  })
  ipcMain.handle(MESH_CONVERSATION_CHANGES_DIFF_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationChangesDiff({ key: record.key, selection: record.selection })
  })
  ipcMain.handle(MESH_CONVERSATION_CHANGED_FILE_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationChangedFile({ key: record.key, selection: record.selection, path: record.path })
  })
  // A side question to a chat over there is answered by its agent there, and
  // may take a while: the invoke waits for it, as a local side question's does.
  ipcMain.handle(MESH_CONVERSATION_SIDE_QUESTION_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationSideQuestion({
      key: record.key,
      requestId: record.requestId,
      question: record.question,
      history: record.history,
    })
  })
  ipcMain.handle(MESH_CONVERSATION_CANCEL_SIDE_QUESTION_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationCancelSideQuestion({ key: record.key, requestId: record.requestId })
  })
  ipcMain.handle(MESH_CONVERSATION_CONTEXT_BREAKDOWN_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationContextBreakdown({ key: record.key })
  })
  // What a followed chat's composer reads of its folder over there.
  ipcMain.handle(MESH_CONVERSATION_FILE_SEARCH_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationSearchFiles({ key: record.key, query: record.query })
  })
  ipcMain.handle(MESH_CONVERSATION_COMMANDS_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationCommandList({ key: record.key, refresh: record.refresh })
  })
}
