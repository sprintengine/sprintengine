// A chat composer's slash-command list, asked for one CLI in one folder: over
// the Studio protocol (`conversation.commands`, whose topic of the same name
// carries every list published afterwards). The lists themselves are kept in
// main (src/main/conversation-commands).

export type ConversationCommandsRequest = {
  /** The chat CLI id ('claude-code', 'codex', …). */
  cli: string
  /** The chat's working folder, as the runtime sees it. */
  cwd: string
  /** Ask the CLI again even when the list is fresh. */
  refresh?: boolean
  /**
   * `false` answers with what main already holds and never asks the CLI: a
   * chat reads this as it mounts, so opening many chats at launch starts no
   * CLI process. The ask itself waits for the person to open the `/` menu.
   */
  probe?: false
}
