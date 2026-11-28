import type { SqlStatement, StudioDatabase } from '../db/database'
import { moveChatStatements } from '../db/chat-logs'

// Moving a chat to another project is three steps no one transaction holds:
// its history's rows are renamed to the new project's store, its store folder
// is moved there, and its record is written with the new folder. A crash
// between them would leave the rows under one project and the files or the
// record under the other, and the chat would open with no history. So the
// rename notes the move (`chat_moves`) in its own transaction, and the note
// goes once the record is written. A start that finds a note brings the rows
// and the folder to where the record says the chat is.

export type ChatMove = {
  workspaceId: string
  fromFolder: string
  toFolder: string
  /** The chat's history keys under each project's store (`chatKey`). */
  fromKey: string
  toKey: string
}

/** Rename the chat's rows to the new store and note the move: one transaction. */
export function beginChatMoveStatements(move: ChatMove): SqlStatement[] {
  return [
    ...moveChatStatements(move.fromKey, move.toKey),
    {
      sql: `INSERT INTO chat_moves (workspace_id, from_folder, to_folder, from_key, to_key) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (workspace_id) DO UPDATE SET from_folder = excluded.from_folder, to_folder = excluded.to_folder,
              from_key = excluded.from_key, to_key = excluded.to_key`,
      params: [move.workspaceId, move.fromFolder, move.toFolder, move.fromKey, move.toKey],
    },
  ]
}

/** The folder could not be moved: the rows go back, and the note with them. One transaction. */
export function undoChatMoveStatements(move: ChatMove): SqlStatement[] {
  return [
    ...moveChatStatements(move.toKey, move.fromKey),
    { sql: 'DELETE FROM chat_moves WHERE workspace_id = ?', params: [move.workspaceId] },
  ]
}

/** The move is over: its record is written, or it was put back. */
export async function endChatMove(database: StudioDatabase, workspaceId: string): Promise<void> {
  await database.run('DELETE FROM chat_moves WHERE workspace_id = ?', [workspaceId])
}

/**
 * Finish what a crash cut short: each noted move's rows and folder are
 * brought to the project its record names now, the new one or the old one
 * (the old one when the chat has no record any more). A move whose folder
 * cannot be brought there keeps its note, for the next start.
 */
export async function settleInterruptedChatMoves(deps: {
  database: StudioDatabase
  /** The folder the chat's record names now; null when there is no record. */
  folderOf(workspaceId: string): string | null
  /** Move the chat's store folder (a no-op when it is not in the first store). */
  moveFolder(workspaceId: string, fromFolder: string, toFolder: string): Promise<void>
  log(message: string): void
}): Promise<void> {
  const rows = await deps.database.all<{
    workspace_id: string
    from_folder: string
    to_folder: string
    from_key: string
    to_key: string
  }>('SELECT workspace_id, from_folder, to_folder, from_key, to_key FROM chat_moves')
  for (const row of rows) {
    const move: ChatMove = {
      workspaceId: row.workspace_id,
      fromFolder: row.from_folder,
      toFolder: row.to_folder,
      fromKey: row.from_key,
      toKey: row.to_key,
    }
    const forward = deps.folderOf(move.workspaceId) === move.toFolder
    try {
      if (forward) {
        // The record was written: the rows are there already, and the folder goes too if it had not.
        await deps.moveFolder(move.workspaceId, move.fromFolder, move.toFolder)
        await endChatMove(deps.database, move.workspaceId)
      } else {
        await deps.moveFolder(move.workspaceId, move.toFolder, move.fromFolder)
        await deps.database.batch(undoChatMoveStatements(move))
      }
      deps.log(
        `The move of chat ${move.workspaceId} was cut short; its history is now with ${forward ? move.toFolder : move.fromFolder}.`,
      )
    } catch (error) {
      deps.log(
        `The move of chat ${move.workspaceId} was cut short and could not be finished; it is tried again at the next start: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
