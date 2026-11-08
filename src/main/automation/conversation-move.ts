import { cp, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { conversationStorageSegment } from '../conversation-index'
import { ensureWorkspaceStoreDir, workspaceStorePath } from '../workspace-store'
import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import type { WorkspaceFieldsPatch, WorkspaceSyncCommandResult } from '../../shared/workspace-sync'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import { LOCAL_HOST_ID } from '../../shared/execution-host'
import { comparablePath } from '../../shared/host-paths'
import { isMachinePath } from '../../shared/machine-paths'
import { isProjectlessChatsRoot } from '../../shared/projectless-chats'
import { workspaceProjectRootOf } from '../../shared/worktree-paths'
import { OWN_SETTLE_GRACE_MS } from './conversation-lifecycle'

// Moving a chat to another folder, and with it to the project that folder is
// in. The case it is for: a chat started with no project whose agent made one
// (`git init`, a scaffold), or an agent whose work has moved to a folder of
// its own, wants the sidebar, the Changes pane and every device to file the
// chat under that project from then on. A chat's project is read off its
// folder (`workspaceProjectRootOf`), so the move is a change of folder.
//
// The folder is where the chat's agent runs, too, and where its history is
// kept: the transcripts are in the store kept for the folder's project
// (workspace-store.ts), and Claude Code keys its own session by the folder
// it ran in. So a move is not only a write to the record. The chat's sessions
// end, its store folder goes to the new project's store, and the next turn
// starts the agent in the new folder, resuming the same session
// (claude-transcript-integrity.ts brings the session file along).
//
// An agent asks from inside the chat, mid-turn, and its turn writes to the
// transcript the move carries away: the move waits for that turn to end, as
// an agent settling its own chat does (conversation-lifecycle.ts), and is let
// go on the same signs that the chat has moved on.
//
// Not a hook on the agent's `cd`: agents read other folders all the time, and
// only the agent knows when a folder has become the chat's work.

export type ConversationMoveDeps = {
  getRecord(workspaceId: string): WorkspaceRegistryRecord | null
  updateWorkspaceFields(
    workspaceId: string,
    patch: WorkspaceFieldsPatch,
    actor: WorkspaceRegistryActor,
  ): WorkspaceSyncCommandResult
  /** Whether a path is a folder on this machine. */
  isFolder(path: string): Promise<boolean>
  /** Whether an agent in the workspace's chats is working (conversation-lifecycle.ts `isWorking`). */
  isWorking(workspaceId: string): boolean
  /** Whether the one piece of work in the workspace is `agentId`'s own chat turn. */
  onlyTurnOf?(workspaceId: string, agentId: string): boolean
  /** Whether a message is waiting on the end of a turn to go in. */
  messageWaiting?(workspaceId: string): boolean
  /** End every session of the workspace's chats, with their transcripts on disk. */
  stopChats(workspaceId: string): Promise<void>
  /** Carry the chat's store folder from the store kept for one folder to the one kept for another. */
  moveStorage(workspaceId: string, fromFolder: string, toFolder: string): Promise<void>
  schedule?: (job: () => void, ms: number) => () => void
  log?: (message: string) => void
}

export type ConversationMoveFailure = {
  ok: false
  code:
    | 'unknown_workspace'
    | 'invalid_arguments'
    | 'not_a_folder'
    | 'not_movable'
    | 'working'
    | 'move_failed'
    | 'write_failed'
  message: string
}

export type ConversationMoveResult =
  | {
      ok: true
      workspaceId: string
      folderPath: string
      /** The project the chat is filed under now, or will be once the move is made. */
      project: string
      /** The move waits for the asking agent's turn to end. */
      movesWhenTurnEnds?: true
    }
  | ConversationMoveFailure

type PendingMove = {
  agentId: string
  folderPath: string
  actor: WorkspaceRegistryActor
  cancel: (() => void) | null
}

export type ConversationMove = ReturnType<typeof createConversationMove>

export function createConversationMove(deps: ConversationMoveDeps) {
  const schedule =
    deps.schedule ??
    ((job: () => void, ms: number) => {
      const timer = setTimeout(job, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  // In memory only, as a settle waiting on a turn is: a restart ends the turn,
  // and the agent, told the move waits on it, can ask again.
  const pending = new Map<string, PendingMove>()
  const projectOf = (folderPath: string) => workspaceProjectRootOf({ folderPath }) ?? folderPath

  function refusal(record: WorkspaceRegistryRecord): ConversationMoveFailure | null {
    const notMovable = (message: string): ConversationMoveFailure => ({ ok: false, code: 'not_movable', message })
    if (record.remoteOrigin)
      return notMovable('This chat lives on another machine. Ask the agent there, which moves it on that machine.')
    if ((record.hostId && record.hostId !== LOCAL_HOST_ID) || isMachinePath(record.folderPath))
      return notMovable('This chat runs on another machine of yours (WSL or SSH), where it stays.')
    if (record.worktree)
      return notMovable(
        'This chat works in a worktree of its project, which the worktree pool keeps for it. Start a chat in the new project instead.',
      )
    if (Object.values(record.agents ?? {}).some((agent) => agent?.execution?.mode === 'worktree'))
      return notMovable(
        'An agent in this chat works in a worktree of its own, which stays where it is. Start a chat in the new project instead.',
      )
    return null
  }

  /**
   * Move a chat to `folder`. Asked by the chat's own agent, mid-turn, the move
   * waits for that turn to end; asked of a chat at rest, it is made now.
   * Anyone else asking while an agent there works is refused.
   */
  async function move(
    workspaceId: string,
    folder: string,
    actor: WorkspaceRegistryActor,
    caller?: { workspaceId: string; agentId: string } | null,
  ): Promise<ConversationMoveResult> {
    const record = deps.getRecord(workspaceId)
    if (!record)
      return { ok: false, code: 'unknown_workspace', message: `There is no chat "${workspaceId}" on this machine.` }
    const refused = refusal(record)
    if (refused) return refused
    const trimmed = folder.trim()
    if (!trimmed || !isAbsolute(trimmed) || isMachinePath(trimmed))
      return { ok: false, code: 'invalid_arguments', message: '"folder" must be an absolute path on this machine.' }
    const folderPath = resolve(trimmed)
    if (isProjectlessChatsRoot(folderPath))
      return {
        ok: false,
        code: 'invalid_arguments',
        message:
          'That is the folder every chat with no project is made in, not a project. Name the project’s own folder.',
      }
    if (!(await deps.isFolder(folderPath)))
      return { ok: false, code: 'not_a_folder', message: `There is no folder at ${folderPath} on this machine.` }
    const done = { ok: true as const, workspaceId, folderPath, project: projectOf(folderPath) }
    const here = record.folderPath?.trim() ? comparablePath(record.folderPath) === comparablePath(folderPath) : false
    if (here) {
      dropPending(workspaceId)
      return done
    }
    if (
      caller?.workspaceId === workspaceId &&
      deps.isWorking(workspaceId) &&
      deps.onlyTurnOf?.(workspaceId, caller.agentId)
    ) {
      dropPending(workspaceId)
      pending.set(workspaceId, { agentId: caller.agentId, folderPath, actor, cancel: null })
      return { ...done, movesWhenTurnEnds: true }
    }
    if (deps.isWorking(workspaceId))
      return {
        ok: false,
        code: 'working',
        message: 'An agent in this chat is still working. Move it once it has finished.',
      }
    dropPending(workspaceId)
    return carryOut(record, folderPath, actor)
  }

  async function carryOut(
    record: WorkspaceRegistryRecord,
    folderPath: string,
    actor: WorkspaceRegistryActor,
  ): Promise<ConversationMoveResult> {
    const workspaceId = record.id
    const from = record.folderPath?.trim() || null
    try {
      await deps.stopChats(workspaceId)
      if (from) await deps.moveStorage(workspaceId, from, folderPath)
    } catch (error) {
      return {
        ok: false,
        code: 'move_failed',
        message: `The chat's history could not be moved, so the chat stays where it was: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const written = deps.updateWorkspaceFields(
      workspaceId,
      { folderPath, ...(record.folderMissing ? { folderMissing: false } : {}) },
      actor,
    )
    if (!written.ok) {
      // Put the history back where the record still says the chat is.
      if (from) await deps.moveStorage(workspaceId, folderPath, from).catch(() => undefined)
      return { ok: false, code: 'write_failed', message: written.message }
    }
    return { ok: true, workspaceId, folderPath, project: projectOf(folderPath) }
  }

  function dropPending(workspaceId: string): void {
    pending.get(workspaceId)?.cancel?.()
    pending.delete(workspaceId)
  }

  /**
   * Make a move the chat's agent asked for, once its turn completes, or let it
   * go: by the rules a settle waiting on a turn keeps. A message to the chat,
   * a new turn, or the asking turn failing or being stopped leaves the chat
   * where it is.
   */
  function onConversationEvent(event: ConversationEvent): void {
    const waiting = pending.get(event.workspaceId)
    if (!waiting) return
    const own = event.agentId === waiting.agentId
    switch (event.type) {
      case 'user_message':
        dropPending(event.workspaceId)
        return
      case 'turn_started':
        if (!own || waiting.cancel) dropPending(event.workspaceId)
        return
      case 'turn_failed':
      case 'session_closed':
        if (own) dropPending(event.workspaceId)
        return
      case 'turn_completed':
        if (!own || event.payload?.steered === true || waiting.cancel) return
        waiting.cancel = schedule(() => {
          if (pending.get(event.workspaceId) !== waiting) return
          pending.delete(event.workspaceId)
          const record = deps.getRecord(event.workspaceId)
          const why = !record
            ? 'the chat is gone'
            : deps.messageWaiting?.(event.workspaceId)
              ? 'a message is waiting to go in'
              : deps.isWorking(event.workspaceId)
                ? 'an agent there is working'
                : (refusal(record)?.message ?? null)
          if (why || !record) {
            deps.log?.(`A chat its agent asked to move to ${waiting.folderPath} was left where it is: ${why}`)
            return
          }
          void carryOut(record, waiting.folderPath, waiting.actor).then((result) => {
            if (!result.ok)
              deps.log?.(
                `A chat its agent asked to move to ${waiting.folderPath} was left where it is: ${result.message}`,
              )
          })
        }, OWN_SETTLE_GRACE_MS)
        return
    }
  }

  return {
    move,
    onConversationEvent,
    /** The folder a move waits on the asking agent's turn to go to. Exposed for tests. */
    movesWhenTurnEnds: (workspaceId: string) => pending.get(workspaceId)?.folderPath ?? null,
  }
}

/**
 * Carry a chat's store folder — its transcripts, tool output, attachments and
 * handoffs, all under `conversations/<chat>` — from the store kept for one
 * folder's project to the one kept for another's. Nothing to do when both
 * folders share a store, or the chat has no history yet. A store already
 * holding a folder for the chat keeps it, and the move is refused rather than
 * one history written over the other.
 */
export async function moveConversationStorage(
  workspaceId: string,
  fromFolder: string,
  toFolder: string,
): Promise<void> {
  const segment = conversationStorageSegment(workspaceId)
  const from = workspaceStorePath(fromFolder, 'conversations', segment)
  const to = workspaceStorePath(toFolder, 'conversations', segment)
  if (from === to) return
  if (!(await isDirectory(from))) return
  if (await isDirectory(to)) throw new Error('the new project already holds a history for this chat')
  const target = join(await ensureWorkspaceStoreDir(toFolder, 'conversations'), segment)
  try {
    await rename(from, target)
  } catch (error) {
    // Stores on two volumes (a home folder moved elsewhere): copy, then let go.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(from, target, { recursive: true, errorOnExist: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  )
}
