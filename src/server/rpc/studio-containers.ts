import type {
  ContainerCreateRequest,
  ContainerCreateResult,
  ContainerHost,
  ContainerRemoveTarget,
  ContainerResult,
  ContainerSummary,
  ContainerTokenStatus,
  DockerStatus,
  StudioContainersMethodMap,
  StudioErrorBody,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'

// The router's answers to the containers family (`containers.*`): each
// method's domain call, once the router has held the grant to an owner's
// connection, and the token's methods to Studio's own desktop windows (the
// method table says which, and why). What is left here is the family's own
// rule: a command is carried out once per command id, a retry answered with
// the first answer, so a create retried after a dropped connection makes one
// container and a push retried pushes once.
//
// The domain is the desktop's `ContainerChats` and its token, which live in
// main (it runs Docker and holds the SSH sessions): handed over directly when
// the server runs in main, forwarded over the shell's control channel when it
// runs in a process of its own (`SHELL_METHODS.containers`).

/** Chats' containers on the hosts this desktop drives, and Claude Code's token for them. */
export type StudioContainersDomain = {
  status(host: ContainerHost): Promise<DockerStatus>
  startDocker(host: ContainerHost): Promise<DockerStatus>
  create(request: ContainerCreateRequest): Promise<ContainerCreateResult>
  list(): Promise<ContainerSummary[]>
  push(id: string): Promise<ContainerResult>
  remove(target: ContainerRemoveTarget): Promise<ContainerResult>
  tokenStatus(): Promise<ContainerTokenStatus>
  setToken(token: string): Promise<ContainerResult>
  clearToken(): Promise<ContainerResult>
  /** A container was made, removed or pushed, or one being made moved a step. */
  onChanged(listener: () => void): () => void
}

/** The domain's calls, by name: what the shell's control channel carries for a server out of process. */
export const STUDIO_CONTAINERS_CALLS = [
  'status',
  'startDocker',
  'create',
  'list',
  'push',
  'remove',
  'tokenStatus',
  'setToken',
  'clearToken',
] as const satisfies ReadonlyArray<Exclude<keyof StudioContainersDomain, 'onChanged'>>
export type StudioContainersCall = (typeof STUDIO_CONTAINERS_CALLS)[number]

export type StudioContainersAsking = {
  grant: StudioGrant
  voice: { failed(code: 'unavailable', detail: string | undefined, context: string): unknown }
}

type Method = keyof StudioContainersMethodMap
export type StudioContainersHandlers = {
  readonly [M in Method]: StudioHandlerOf<StudioContainersMethodMap[M], StudioContainersAsking>
}

type Refused = { ok: false; error: StudioErrorBody & { code: 'unavailable' } }

export type StudioContainersHandlerOptions = {
  /** The domain; without it, every method is answered `unavailable`. */
  containers?: StudioContainersDomain
  /** The first answer to a command id is every retry's. */
  once: <A extends { ok: boolean; error?: StudioErrorBody }>(
    id: string,
    work: () => Promise<A>,
    voice: StudioContainersAsking['voice'],
    method: string,
  ) => Promise<A | Refused>
  /** A client's command id, namespaced by the client. */
  runtimeId(grant: StudioGrant, commandId: string): string
}

const unserved = (method: Method): Refused => ({
  ok: false,
  error: { code: 'unavailable', message: `This Studio does not serve ${method}.` },
})

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioContainersHandlers(options: StudioContainersHandlerOptions): StudioContainersHandlers {
  const { containers } = options

  function command<R>(
    method: Method,
    commandId: string,
    asking: StudioContainersAsking,
    work: (domain: StudioContainersDomain) => Promise<R>,
  ): Promise<{ ok: true; result: R } | Refused> | Refused {
    if (!containers) return unserved(method)
    return options.once(
      `${method}:${options.runtimeId(asking.grant, commandId)}`,
      async () => ok(await work(containers)),
      asking.voice,
      method,
    )
  }
  const read = async <R>(method: Method, work: (domain: StudioContainersDomain) => Promise<R>) =>
    containers ? ok(await work(containers)) : unserved(method)

  return {
    'containers.status': ({ host }) => read('containers.status', (domain) => domain.status(host)),
    'containers.startDocker': ({ commandId, host }, asking) =>
      command('containers.startDocker', commandId, asking, (domain) => domain.startDocker(host)),
    'containers.create': ({ commandId, host, folder, label, image }, asking) =>
      command('containers.create', commandId, asking, (domain) => domain.create({ host, folder, label, image })),
    'containers.list': () => read('containers.list', async (domain) => ({ containers: await domain.list() })),
    'containers.push': ({ commandId, id }, asking) =>
      command('containers.push', commandId, asking, (domain) => domain.push(id)),
    'containers.remove': ({ commandId, ...target }, asking) =>
      command('containers.remove', commandId, asking, (domain) => domain.remove(target)),
    'containers.tokenStatus': () => read('containers.tokenStatus', (domain) => domain.tokenStatus()),
    'containers.setToken': ({ commandId, token }, asking) =>
      command('containers.setToken', commandId, asking, (domain) => domain.setToken(token)),
    'containers.clearToken': ({ commandId }, asking) =>
      command('containers.clearToken', commandId, asking, (domain) => domain.clearToken()),
  }
}
