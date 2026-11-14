import { createHash, randomBytes } from 'node:crypto'

import { MAX_LAUNCH_TOKEN_CHANGES } from '../../../packages/studio-protocol/src/environment-access'
import type { GatewayLaunchIdentity } from '../core/gateway-launch-tokens'
import type { WslServerConnection } from './wsl-environment-manager'

// How a WSL terminal agent reaches Studio's tools: through the gateway of the
// Studio server inside its distribution, as an agent there reaches the server
// of the environment it runs in. The terminal is this PC's `wsl.exe` pty, so
// this desktop launches the agent and mints its launch token. The
// distribution's Studio is told only the token's SHA-256 and the agent it
// proves (`environment.launchTokens`, the shell's alone); the token itself
// goes into the startup script's environment, inherited by the CLI and the
// MCP bridge it starts, which presents it to that gateway.
//
// A connection to the distribution's Studio that ends may have missed a
// revoke, so each new one is told every live token again, replacing what it
// held. A token is revoked when its terminal ends.

/** What sending tokens needs of the distribution's servers. */
export type LaunchTokenServers = {
  /** The distribution's server, started if it is not running. */
  connect(distro: string): Promise<Pick<WslServerConnection, 'owner'>>
  /** The running connection, or null; never starts anything. */
  current(distro: string): Pick<WslServerConnection, 'owner'> | null
}

export type WslLaunchTokens = {
  /**
   * A token for one launch in `distro`. `sent` settles once the distribution's
   * Studio knows it (or could not be told: the launch's bridge then proves
   * nothing, and its agent is only who it says it is).
   */
  issue(distro: string, identity: GatewayLaunchIdentity): { token: string; sent: Promise<void> }
  /** The launch ended: the token proves nothing there from now on. */
  revoke(distro: string, token: string): void
  /** A new connection to a distribution's Studio: tell it every live token, replacing what it held. */
  connected(distro: string, connection: Pick<WslServerConnection, 'owner'>): void
}

type Change = { digest: string; identity: GatewayLaunchIdentity | null }

function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createWslLaunchTokens(
  servers: LaunchTokenServers,
  log: (message: string) => void = () => undefined,
): WslLaunchTokens {
  // Live tokens by distribution: digest → identity. The token itself is kept
  // nowhere: the terminal holds it, and a revoke names it.
  const live = new Map<string, Map<string, GatewayLaunchIdentity>>()

  const send = async (
    distro: string,
    connection: Pick<WslServerConnection, 'owner'>,
    tokens: Change[],
    replace: boolean,
  ): Promise<void> => {
    try {
      await connection.owner.request('environment.launchTokens', { tokens, ...(replace ? { replace: true } : {}) })
    } catch (error) {
      log(
        `The Studio server in ${distro} was not told its terminal agents' launch tokens: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    issue(distro, identity) {
      const token = `selaunch_${randomBytes(32).toString('base64url')}`
      const digest = digestOf(token)
      let held = live.get(distro)
      if (!held) live.set(distro, (held = new Map()))
      held.set(digest, { ...identity })
      const sent = servers
        .connect(distro)
        .then((connection) => send(distro, connection, [{ digest, identity: { ...identity } }], false))
        .catch((error: unknown) =>
          log(
            `The Studio server in ${distro} did not start for a terminal agent's launch token: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      return { token, sent }
    },
    revoke(distro, token) {
      const digest = digestOf(token)
      if (!live.get(distro)?.delete(digest)) return
      // Never started for a revoke: a server that is not running holds nothing.
      const connection = servers.current(distro)
      if (connection) void send(distro, connection, [{ digest, identity: null }], false)
    },
    connected(distro, connection) {
      const tokens = [...(live.get(distro) ?? new Map<string, GatewayLaunchIdentity>())].map(
        ([digest, identity]): Change => ({ digest, identity: { ...identity } }),
      )
      // In calls the protocol takes, the first replacing what was held.
      void (async () => {
        for (let start = 0; start === 0 || start < tokens.length; start += MAX_LAUNCH_TOKEN_CHANGES)
          await send(distro, connection, tokens.slice(start, start + MAX_LAUNCH_TOKEN_CHANGES), start === 0)
      })()
    },
  }
}
