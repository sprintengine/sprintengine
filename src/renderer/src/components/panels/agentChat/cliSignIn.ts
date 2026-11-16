import type { ConversationCliRuntimeOverrides } from '../../../../../shared/conversation-runtime'
import {
  LOCAL_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostSettings,
} from '../../../../../shared/execution-host'
import { windowChatServices } from './windowChat'
import { focusOrAddTerminalTab } from '../../../utils/modelRegistry'
import { openTerminal, writeTerminal } from '../../../studio/terminals'
import { cliForConversationProvider, conversationSignIn } from '../../../../../shared/conversation-harness'

/**
 * Which provider a chat's failed sign-in offers to sign in, or undefined for
 * none. A machine's chat (an SSH machine, a container) signs in through this
 * desktop's own dialog for that machine (`sshSignIn`), whatever its
 * transport serves, for any CLI it runs: otherwise its words send the person
 * to a terminal here, which signs in the wrong machine. A chat on a WSL
 * distribution is held by that distribution's Studio, which has no
 * terminals; this PC's Studio opens one in the distribution instead, so it
 * signs in where this PC's Studio can (`localSignIn`). This machine's chat
 * signs in only where its transport serves it, for a CLI Studio can open a
 * sign-in for.
 */
export function chatSignInProviderId(input: {
  providerId: string | null | undefined
  machineId: string | null
  sshMachinesOn: boolean
  providerSignIn: boolean | undefined
  /** The WSL distribution the chat runs in, or null for none. */
  wslHostId?: ExecutionHostId | null
  /** Whether this PC's own Studio can open a sign-in terminal. */
  localSignIn?: boolean | undefined
}): string | undefined {
  const cli = cliForConversationProvider(input.providerId)
  const offered = input.machineId
    ? input.sshMachinesOn && Boolean(cli)
    : input.wslHostId
      ? Boolean(input.localSignIn) && Boolean(conversationSignIn(cli))
      : Boolean(input.providerSignIn) && Boolean(conversationSignIn(cli))
  return offered ? (input.providerId ?? undefined) : undefined
}

/**
 * The CLI runtimes a sign-in for a chat in a WSL distribution resolves with:
 * the chat's CLI, by the command set for that distribution (empty: found on
 * its own PATH), on that distribution. A chat there runs with no host id,
 * since its CLI runs where its Studio does (`conversationCliRuntimesForHost`),
 * but the sign-in is opened by this PC's Studio and has to be told where.
 */
export function wslSignInRuntimes(
  providerId: string,
  hostId: ExecutionHostId,
  hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>> | undefined,
): ConversationCliRuntimeOverrides | undefined {
  const cli = cliForConversationProvider(providerId)
  if (!cli) return undefined
  return { [cli]: { command: hosts?.[hostId]?.cliCommands[cli] ?? '', hostId } } as ConversationCliRuntimeOverrides
}

/**
 * Opens a terminal tab in the chat's workspace that runs the chat CLI's own
 * sign-in, so a turn that failed on a lapsed login can be fixed where it
 * failed. The command and the machine are main's: the executable the
 * conversation provider runs, on the machine it runs there — a chat on a WSL
 * machine signs in inside that distribution, This PC's chat with the native
 * Claude Code. Interactive on purpose — the login opens a browser and may ask
 * for a code pasted back.
 */
export async function openCliSignInTerminal(input: {
  workspaceId: string
  providerId: string
  cliRuntimes?: ConversationCliRuntimeOverrides
  /** The SSH machine the chat's workspace is on, by its saved id. */
  machineId?: string | null
  now?: () => number
}): Promise<{ ok: true } | { ok: false; message: string }> {
  // A chat on an SSH machine signs in there, with no terminal here (phase 8).
  if (input.machineId) return window.api.sshSignIn(input.machineId, input.providerId)
  const resolved = await windowChatServices().providers.signIn({
    providerId: input.providerId,
    ...(input.cliRuntimes ? { cliRuntimes: input.cliRuntimes } : {}),
  })
  if (!resolved.ok) return resolved
  const terminalId = `sign-in-${(input.now ?? Date.now)()}`
  const sessionId = `terminal-${terminalId}`
  const spawned = await openTerminal(sessionId, 100, 30, resolved.cwd, false, undefined, undefined, undefined, true, {
    kind: 'terminal',
    workspaceId: input.workspaceId,
    terminalId,
    hostId: normalizeExecutionHostId(resolved.hostId) ?? LOCAL_HOST_ID,
  })
  if (!spawned.ok) return { ok: false, message: spawned.message }
  await writeTerminal(sessionId, `${resolved.commandLine}\r`)
  focusOrAddTerminalTab(input.workspaceId, terminalId, 'Sign in')
  return { ok: true }
}
