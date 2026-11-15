import { conversationClis } from './conversation-harness'
import { isWslHostId, type ExecutionHostId, type ExecutionHostSettings } from './execution-host'

type CliRuntime = { command?: string; hostId?: ExecutionHostId }

/**
 * The CLI runtimes a chat in a workspace runs with. A chat in a workspace on
 * a WSL machine is that distribution's Studio's, which starts its CLI there
 * as its own: it is handed the command set for that machine (empty: found on
 * the distribution's own PATH) and no host id, since the CLI runs where the
 * chat's Studio runs. On this machine they are the app's own. Shared because
 * a window starts most chats and the server starts the rest (a scheduled
 * agent's run, a module's create), and the two must agree.
 */
export function conversationCliRuntimesForHost<T extends CliRuntime>(
  cliRuntimes: Partial<Record<string, Partial<T>>> | undefined,
  hostId: ExecutionHostId | null | undefined,
  hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>> | undefined,
): Partial<Record<string, Partial<T>>> | undefined {
  if (!hostId || !isWslHostId(hostId)) return cliRuntimes
  const onHost: Partial<Record<string, Partial<T>>> = { ...cliRuntimes }
  for (const cli of conversationClis()) {
    const { hostId: _here, ...runtime } = cliRuntimes?.[cli] ?? {}
    onHost[cli] = {
      ...runtime,
      // This machine's command means nothing there: an empty one is found on
      // the distribution's own PATH.
      command: hosts?.[hostId]?.cliCommands[cli] ?? '',
    } as Partial<T>
  }
  return onHost
}
