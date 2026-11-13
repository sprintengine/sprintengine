import { join } from 'node:path'

import {
  CONVERSATION_ATTACHMENTS_DIRECTORY,
  CONVERSATION_TOOL_IMAGES_DIRECTORY,
} from '../../main/conversation-attachment-store'
import { CONVERSATION_PLANS_DIRECTORY } from '../../main/conversation-plan-store'
import { isMachinePath } from '../../shared/machine-paths'

// The folders Studio knows: what a client that is not an owner (or an owner's
// connection held to known folders) may name on this machine. A workspace's
// folder (a run's worktree is inside its repository's folder, or a workspace
// of its own), and, for reading only, Studio's own stores of what chats sent
// and planned and the pictures their steps returned. A folder on an SSH
// machine is not on this disk and is no root here.

type Registry = { getRecords(): ReadonlyArray<{ folderPath?: string | null }> }

/** The workspaces' own folders on this disk: what such a client may change. */
export function workspaceFolders(registry: Registry): string[] {
  return registry
    .getRecords()
    .flatMap((record) => (record.folderPath && !isMachinePath(record.folderPath) ? [record.folderPath] : []))
}

/** Every folder such a client may read in. */
export function knownFolders(registry: Registry, dataDir: string): string[] {
  return [
    ...workspaceFolders(registry),
    join(dataDir, CONVERSATION_ATTACHMENTS_DIRECTORY),
    join(dataDir, CONVERSATION_PLANS_DIRECTORY),
    join(dataDir, CONVERSATION_TOOL_IMAGES_DIRECTORY),
  ]
}
