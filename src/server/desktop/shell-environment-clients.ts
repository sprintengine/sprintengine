import type { Duplex } from 'node:stream'

import { connect, type StudioClient } from '../../../packages/client-runtime/src/public'
import { parseEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import type { StudioCapability } from '../../../packages/studio-protocol/src/handshake'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { machineStudioClient } from '../../shared/machine-studio-client'
import { portDuplex } from '../ipc/port-duplex'
import type { TunnelPort } from '../ipc/ipc-tunnel'
import { lineTransport, readTicket } from '../wsl/studio-door'

// Another environment's Studio for the desktop's server when it runs as a
// process of its own (design-wsl-ssh-direct PR 1d). Main holds each SSH
// machine's session (its prompts are main's dialogs); asked, it opens a stream
// on the machine's `studio` door and hands this process a message port spliced
// onto it. On it this process is the machine's owner client, as main is on
// its own: the gateway's tools and modules act on a chat there with the same
// protocol method a window sends. Its paths are respelled at the edge
// (`machine-studio-client.ts`), as everywhere on this computer.
//
// The same owner connection says whether the machine's server is up, which the
// desktop's toolsets offered to that machine's agents follow
// (`wsl-tool-relay.ts`, on a `studio` stream of their own).

export type ShellEnvironmentClientsDeps = {
  /** Ask main for a stream on the machine's `studio` door; its port arrives on the control channel as `clientId`. */
  open(route: string): Promise<{ clientId: string; label: string }>
  /** The port main attached for `clientId`, once it has arrived. */
  takePort(clientId: string): TunnelPort | null
  log?(message: string): void
}

const PORT_WAIT_MS = 5_000
const HELLO_MS = 15_000
const PING_MS = 10_000

export type ShellEnvironmentClients = EnvironmentClients & {
  machineConnected(route: string): void
  /** The machine's owner client as it is (paths not respelled), for its liveness, and the machine's name. */
  owner(route: string): Promise<{ client: StudioClient; label: string }>
  /** A fresh stream on the machine's `studio` door. */
  openStudio(route: string): Promise<Duplex>
}

export function createShellEnvironmentClients(deps: ShellEnvironmentClientsDeps): ShellEnvironmentClients {
  const live = new Map<string, { client: Promise<StudioClient>; label: string }>()
  const listeners = new Set<(route: string) => void>()

  async function stream(route: string): Promise<{ stream: Duplex; label: string }> {
    const { clientId, label } = await deps.open(route)
    const deadline = Date.now() + PORT_WAIT_MS
    let port = deps.takePort(clientId)
    while (!port && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      port = deps.takePort(clientId)
    }
    if (!port) throw new Error(`The connection to ${label} did not arrive from the app.`)
    return { stream: portDuplex(port), label }
  }

  // One owner client per machine; it does not reconnect: once it ends, the
  // next ask opens another, as main's own owner connection does.
  async function ownerOf(route: string): Promise<{ client: StudioClient; label: string }> {
    const known = live.get(route)
    if (known) {
      const client = await known.client.catch(() => null)
      if (client && client.state !== 'closed') return { client, label: known.label }
      if (live.get(route) === known) live.delete(route)
    }
    let label = route
    const client = connect({
      transport: async () => {
        const opened = await stream(route)
        label = opened.label
        return lineTransport(opened.stream, await readTicket(opened.stream, HELLO_MS))
      },
      client: { name: 'SprintEngine Studio', kind: 'desktop' },
      reconnect: false,
      helloTimeoutMs: HELLO_MS,
      heartbeat: { intervalMs: PING_MS, timeoutMs: PING_MS },
    })
    const entry = { client, label }
    live.set(route, entry)
    const forget = () => {
      if (live.get(route) === entry) live.delete(route)
    }
    client.then((opened) => opened.closed.then(forget, forget), forget)
    const opened = await client
    entry.label = label
    return { client: opened, label }
  }

  return {
    owner: (route) => ownerOf(route),
    openStudio: async (route) => (await stream(route)).stream,
    /** Main said the machine's server connected anew (`SERVER_EVENTS.sshConnected`): an old client of it is spent. */
    machineConnected(route) {
      for (const listener of listeners) listener(route)
    },
    onConnected(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async clientFor(route, capability: StudioCapability | null = null) {
      const parsed = parseEnvironmentRoute(route)
      if (parsed?.kind !== 'ssh')
        return { ok: false, code: 'unsupported_route', message: 'That machine cannot be reached from this computer.' }
      try {
        const owner = await ownerOf(route)
        if (capability && !owner.client.supports(capability))
          return {
            ok: false,
            code: 'outdated',
            message: `The Studio server on ${owner.label} is older than this app. Update it in Settings › Machines.`,
          }
        return { ok: true, client: machineStudioClient(owner.client, parsed.machine), name: owner.label }
      } catch (error) {
        deps.log?.(`Could not reach ${route}: ${error instanceof Error ? error.message : String(error)}`)
        return {
          ok: false,
          code: 'unavailable',
          message: `That SSH machine is not connected: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
