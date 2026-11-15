import {
  parseContainerHost,
  STUDIO_METHODS,
  type ContainerResult,
  type ContainerTokenStatus,
} from '../../../../packages/studio-protocol/src/public'
import type { ControlRpc } from '../../../server/bootstrap/control-rpc'
import { SERVER_EVENTS, SHELL_METHODS } from '../../../server/desktop/server-methods'
import {
  STUDIO_CONTAINERS_CALLS,
  type StudioContainersCall,
  type StudioContainersDomain,
} from '../../../server/rpc/studio-containers'
import type { ContainerChats } from './container-chats'
import { containerCommandFingerprint, type ContainerCommandReceipts } from './container-command-receipts'

// Chats' containers as the desktop's Studio serves them (`containers.*`,
// docs/design/container-chats.md): main's `ContainerChats`, which runs Docker
// on the hosts this desktop drives, and Claude Code's token for them, sealed
// with this computer's keychain. The server in main takes this domain as it
// is; a server in a process of its own asks for each call over the control
// channel (`serveContainersToServer`), and is told of each change.

/** What the token store does for the domain (`ContainerAgentToken`). */
export type ContainerTokenStore = {
  status(): Promise<ContainerTokenStatus>
  set(token: string): Promise<{ ok: true } | { ok: false; message: string }>
  clear(): Promise<void>
}

export type DesktopContainersDomain = StudioContainersDomain & {
  /** Tell every follower a container changed: `ContainerChats`' own `onChange`. */
  changed(): void
}

export function createContainersDomain(deps: {
  containers: Pick<ContainerChats, 'status' | 'startDocker' | 'create' | 'list' | 'push' | 'remove'>
  token: ContainerTokenStore
  /** What each create, push and remove a client sent did, by its command id: carried out once. */
  receipts: Pick<ContainerCommandReceipts, 'run'>
  /** A token set or forgotten: the servers already running in containers here start again on it. */
  onTokenChanged(): void
}): DesktopContainersDomain {
  const listeners = new Set<() => void>()
  const once = <T>(call: string, commandId: string, args: unknown, work: () => Promise<T>) =>
    deps.receipts.run(commandId, containerCommandFingerprint(call, args), work)
  return {
    status: (host) => deps.containers.status(host),
    startDocker: (host) => deps.containers.startDocker(host),
    create: (request, commandId) => once('create', commandId, request, () => deps.containers.create(request)),
    list: () => deps.containers.list(),
    push: (id, commandId) => once('push', commandId, { id }, () => deps.containers.push(id)),
    remove: (target, commandId) => once('remove', commandId, target, () => deps.containers.remove(target)),
    tokenStatus: () => deps.token.status(),
    setToken: async (token): Promise<ContainerResult> => {
      const result = await deps.token.set(token)
      if (result.ok) deps.onTokenChanged()
      return result
    },
    clearToken: async (): Promise<ContainerResult> => {
      await deps.token.clear()
      deps.onTokenChanged()
      return { ok: true }
    },
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    changed: () => {
      for (const listener of [...listeners]) listener()
    },
  }
}

const METHOD_OF: Record<StudioContainersCall, keyof typeof STUDIO_METHODS> = {
  status: 'containers.status',
  startDocker: 'containers.startDocker',
  create: 'containers.create',
  list: 'containers.list',
  push: 'containers.push',
  remove: 'containers.remove',
  tokenStatus: 'containers.tokenStatus',
  setToken: 'containers.setToken',
  clearToken: 'containers.clearToken',
}

/**
 * A command id as the server forwards it: the client's own, which the
 * protocol takes as any string of 1 to 200 characters without a NUL, behind
 * the namespace the server puts before it (`owner:`, `client:<id>:`).
 */
function forwardedCommandId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')
}

/** The calls main carries out once per command id: what changes a host. */
const ONCE_PER_ID: ReadonlySet<StudioContainersCall> = new Set(['create', 'push', 'remove'])

/**
 * One call from the server, checked again here by the protocol's own reader
 * of the method it serves: the server is trusted to ask, not to have checked.
 */
export async function answerContainersCall(domain: StudioContainersDomain, payload: unknown): Promise<unknown> {
  const { call, args } = (payload ?? {}) as { call?: unknown; args?: unknown }
  if (typeof call !== 'string' || !(STUDIO_CONTAINERS_CALLS as readonly string[]).includes(call))
    throw new Error('That is not something Studio does with containers.')
  const named = call as StudioContainersCall
  const raw = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  // A mutation carries the client's command id as the server namespaced it
  // (longer than a client's own), which the domain carries it out once by;
  // the rest is read as the method reads it.
  const { commandId, ...rest } = raw
  if (ONCE_PER_ID.has(named) && !forwardedCommandId(commandId))
    throw new Error('That container request carried no command id.')
  const parsed = STUDIO_METHODS[METHOD_OF[named]].params({ ...rest, commandId: 'shell' })
  if (!parsed.ok) throw new Error(parsed.message)
  const { commandId: _shell, ...read } = parsed.params as Record<string, unknown>
  switch (named) {
    case 'status':
    case 'startDocker':
      return domain[named](parseContainerHost(read.host)!)
    case 'create':
      return domain.create(
        {
          host: parseContainerHost(read.host)!,
          folder: read.folder as string | null,
          label: read.label as string,
          image: { kind: 'studio-default' },
        },
        commandId as string,
      )
    case 'list':
      return domain.list()
    case 'push':
      return domain.push(read.id as string, commandId as string)
    case 'remove':
      return domain.remove(read as Parameters<StudioContainersDomain['remove']>[0], commandId as string)
    case 'tokenStatus':
      return domain.tokenStatus()
    case 'setToken':
      return domain.setToken(read.token as string)
    case 'clearToken':
      return domain.clearToken()
  }
}

/** Serve the domain to the desktop's server out of process, and tell it of every change. */
export function serveContainersToServer(
  rpc: Pick<ControlRpc, 'handle' | 'emit'>,
  domain: StudioContainersDomain,
): void {
  rpc.handle(SHELL_METHODS.containers, (payload) => answerContainersCall(domain, payload))
  domain.onChanged(() => rpc.emit(SERVER_EVENTS.containersChanged, {}))
}
