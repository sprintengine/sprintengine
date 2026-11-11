// A slash command the chat composer can offer, and the list for one CLI in one
// folder. The list for a chat is what its CLI reports it will run in that
// folder — the chat never expands a command file itself, so a command that is
// listed and one that works stay the same set. The shapes are the contract's
// (`@sprintengine/conversation-protocol`), which the Studio protocol's
// `conversation.commands` answers with.
export type {
  ConversationSlashCommand as ConversationCommand,
  ConversationCommandCatalog,
} from '../../../packages/conversation-protocol/src/public'

/**
 * The spelling a command list is kept under for a folder, so the list a
 * runtime publishes for its session's folder is the one the composer asks for
 * whatever small differences the two spellings carry: a trailing separator,
 * doubled separators, `.` segments, and on a Windows path the drive's case and
 * the direction of its slashes (the file system ignores both). Main keys its
 * registry and disk cache by it and the renderer its cache, so a catalog's
 * `cwd` as published and the folder a chat asks with meet on the same key.
 *
 * Lexical only: symlinks are not resolved, because every publisher and the
 * composer take the folder from the same place (the workspace's folder, handed
 * to the session when it starts) and never from what a CLI reports back.
 */
export function conversationCommandsFolderKey(cwd: string): string {
  const unc = cwd.startsWith('\\\\')
  const windows = unc || /^[A-Za-z]:[\\/]/.test(cwd)
  let path = windows ? cwd.replace(/\\/g, '/') : cwd
  const lead = unc ? '//' : path.startsWith('/') ? '/' : ''
  const segments = path.split('/').filter((segment) => segment && segment !== '.')
  path = lead + segments.join('/')
  if (windows && !unc && segments.length === 1) path += '/'
  if (!path) path = cwd
  return windows ? path.toLowerCase() : path
}
