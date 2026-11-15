// An agent CLI's stdio child on this machine.
//
// Every chat runtime that drives a CLI over stdio (Claude Code through the
// SDK, Codex's app-server, the ACP agents) starts it here, directly, or
// through its shim on Windows (`cliSpawnTarget`). A chat in a WSL
// distribution or on an SSH machine is that machine's own Studio's to run
// (design-wsl-ssh-direct): its CLI is started there, by this same code, as
// that machine's local child.
//
// Every child that is a conversation's agent is issued a gateway token, bound
// to the conversation, in its environment (`MCP_CHANNEL_TOKEN_ENV`): the app's
// MCP bridge it starts opens its channel with it, and the gateway takes the
// agent's identity from it rather than from what its bridge declares.

import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithStdioTuple,
  type StdioPipe,
} from 'node:child_process'

import { MCP_CHANNEL_TOKEN_ENV } from '../../shared/studio-env'
import {
  issueGatewayLaunchToken,
  launchIdentityOfEnv,
  revokeGatewayLaunchToken,
  type GatewayLaunchIdentity,
} from '../../server/core/gateway-launch-tokens'
import { raiseChildOomScore } from '../agent-oom-score'
import { cliSpawnTarget } from './cli-child-process'
import { wslShareSafeDirectoryEnv } from '../git-run'

/** A token one child's MCP bridge opens its channel to the app with, and how it is taken back. */
export type CliChannelToken = { token: string; revoke(): void }

type PipedSpawnOptions = SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe> & {
  windowsVerbatimArguments?: boolean
}

/** What `spawn` is called with for one CLI child. */
export type CliHostSpawn = { file: string; args: string[]; options: PipedSpawnOptions }

/**
 * How to start a CLI as a stdio child on this machine. `command` is the path
 * the runtime's CLI detection found, and `cwd` the workspace folder.
 */
export function cliHostSpawn(
  input: {
    command: string
    args: readonly string[]
    cwd: string
    env: NodeJS.ProcessEnv
  },
  deps: { platform?: NodeJS.Platform } = {},
): CliHostSpawn {
  const target = cliSpawnTarget(input.command, [...input.args], {
    platform: deps.platform,
    env: input.env,
    cwd: input.cwd,
  })
  return {
    file: target.file,
    args: target.args,
    options: {
      // On This PC in a folder inside a WSL distribution, the agent's own
      // git needs the folder listed as safe, as the app's git has it.
      env: wslShareSafeDirectoryEnv(input.env, input.cwd, deps.platform),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: input.cwd,
      ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    },
  }
}

function withoutKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of keys) delete next[key]
  return next
}

/**
 * Starts a CLI as a stdio child on this machine (`cliHostSpawn`), the way
 * every chat runtime starts one. A child that is a conversation's agent is
 * issued its own gateway token, taken back when the child ends.
 *
 * `launch` is a token the runtime issued for this child itself, because it
 * also hands the value to the gateway entry it tells the agent about (an ACP
 * agent, whose environment names no conversation). It is handed to the child
 * as an issued one would be, and taken back when the child ends or fails to
 * start; null hands it none.
 */
export function spawnCliHostChild(
  request: Parameters<typeof cliHostSpawn>[0] & { launch?: CliChannelToken | null },
  deps: Parameters<typeof cliHostSpawn>[1] & { spawn?: typeof spawn; signal?: AbortSignal } = {},
): ChildProcessWithoutNullStreams {
  const { launch, ...input } = request
  const channel = launch !== undefined ? launch : localLaunchToken(launchIdentityOfEnv(input.env))
  let revoked = false
  const revoke = () => {
    if (revoked || !channel) return
    revoked = true
    channel.revoke()
  }
  // Everything that can refuse the start is inside: a token issued to a child
  // that never ran is taken back at once, not left valid.
  let child: ChildProcessWithoutNullStreams
  try {
    const plan = cliHostSpawn(
      channel
        ? { ...input, env: { ...input.env, [MCP_CHANNEL_TOKEN_ENV]: channel.token } }
        : // A token the app's own process inherited is no launch's: never handed on.
          { ...input, env: withoutKeys(input.env, [MCP_CHANNEL_TOKEN_ENV]) },
      deps,
    )
    child = (deps.spawn ?? spawn)(plan.file, plan.args, {
      ...plan.options,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
  } catch (error) {
    revoke()
    throw error
  }
  if (channel) {
    child.once('close', revoke)
    // A child that could not be started is not certain to emit `close`.
    child.on('error', () => {
      if (child.pid === undefined) revoke()
    })
  }
  // On Linux (This PC, or the Studio server on a WSL or SSH machine) the
  // kernel's out-of-memory killer takes the agent before the app. A stand-in
  // spawn's pid names no process of ours.
  if ((deps.spawn ?? spawn) === spawn) void raiseChildOomScore(child.pid)
  return child
}

/**
 * A gateway token for a child on this machine that is a conversation's agent,
 * handed to it in its environment and taken back when it ends. Null for a
 * child that is no conversation's.
 */
export function localLaunchToken(identity: GatewayLaunchIdentity | null): CliChannelToken | null {
  if (!identity) return null
  const token = issueGatewayLaunchToken(identity)
  return { token, revoke: () => revokeGatewayLaunchToken(token) }
}
