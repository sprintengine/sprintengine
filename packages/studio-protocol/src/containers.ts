import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_CONTAINERS_CAPABILITY } from './handshake.js'

// Chats in containers (docs/design/container-chats.md), on the protocol: Docker
// on a host in words, a container made for a chat with its repository copied
// in, every container Studio made listed, its branch pushed out from the host,
// and its removal (`containers.*`, with the `containers.changed` stream). A
// container runs on a host the desktop drives: the desktop's own computer, or
// one of its saved SSH machines. Offered as `containers` by a desktop's Studio
// where it can run Docker (the SSH machines preview on); a machine's own
// Studio (WSL, SSH, a container) offers none.
//
// Grants, decided conservatively:
// - Every method is an owner's (`STUDIO_CONTAINERS_OWNER`). A container's chat
//   runs on its own Studio, which the desktop reaches as one of its machines
//   (`ssh:<id>`), and paired devices reach no machine through the desktop
//   (#602's ruling): a device that made a container could not follow the chat
//   in it. Until devices can, they are not offered the making either, and a
//   paired client says in words that a container chat is started from the
//   desktop itself. Reading is held too: the status probes Docker on the host
//   (and may ask an SSH passphrase there), and the list names folders on this
//   computer and on its SSH machines.
// - Push (`containers.push`) runs `git push` with the host's own credentials,
//   remove destroys the container and its chat's work, and starting Docker
//   starts a VM here: an owner's, whatever is decided for making one.
// - Claude Code's token for containers (`containers.tokenStatus`,
//   `.setToken`, `.clearToken`) is a credential sealed with this computer's
//   keychain: Studio's own desktop windows only (`STUDIO_CONTAINERS_WINDOW`),
//   as the tailnet's credential-making methods are.
//
// Every mutation carries a `commandId`; a retry under the same id is answered
// with the first answer, so a create retried after a dropped connection makes
// one container. `containers.create` may take minutes (a first image build);
// a client waits on it and follows `containers.changed`, whose list carries
// what the container being made is doing (`status`).

/** The machine a container runs on: the desktop's own computer, or one of its saved SSH machines by id. */
export type ContainerHost = { kind: 'local' } | { kind: 'ssh'; machine: string }

/**
 * The repository inside a container: copied in from a folder on the host as a
 * git bundle (never mounted), checked out on a branch of the chat's own. Its
 * changes leave only as that branch, which Studio brings out and pushes from
 * the host with the host's own git credentials.
 */
export type ContainerRepo = {
  /** The folder on the host it was copied from, as that machine spells it. */
  source: string
  /** Where it is inside the container. */
  path: string
  /** The branch the chat works on there, and the one pushed. */
  branch: string
  /** The branch the copy started from, if HEAD was on one. */
  base: string | null
}

/** Docker on a host, in words: what the container popover says (never a dot). */
export type DockerStatus = {
  /**
   * `ready`: Docker answers. `stopped`: Colima is installed and stopped, and
   * Studio can start it. `not-running`: Docker's command is there and its
   * engine does not answer. `missing`: no Docker. `unreachable`: the SSH
   * machine could not be asked.
   */
  state: 'ready' | 'stopped' | 'not-running' | 'missing' | 'unreachable'
  /** The sentence the popover shows: "Docker 29.2 is running on this Mac (Colima)." */
  words: string
  /** Whether Studio's image is built there already (a first container builds it). */
  imageReady: boolean
  /** What starting it would run, when Studio can: Colima's own `colima start`. */
  canStart: 'colima' | null
  /** The Docker context that answered (`ready` only); a container made now is kept on it. */
  context?: string | null
}

/** The image a container starts from. Only Studio's own for now; a devcontainer or Dockerfile may follow. */
export type ContainerImageChoice = { kind: 'studio-default' }

export type ContainerCreateRequest = {
  host: ContainerHost
  /** The project folder on the host whose repository is copied in; null for an empty folder. */
  folder: string | null
  /** The chat's name, for the container's label. */
  label: string
  image: ContainerImageChoice
}

/** A container made: its saved machine's id (the chat starts on `ssh:<id>`) and the folder inside it. */
export type ContainerCreateResult =
  { ok: true; id: string; label: string; folder: string } | { ok: false; message: string }

/** A container Studio made, as Settings lists it, so none is left behind unseen. */
export type ContainerSummary = {
  /** The saved machine's id; null for one Docker has that Studio no longer has a record of. */
  id: string | null
  name: string
  host: ContainerHost
  hostLabel: string
  /** The Docker context it is under there; null for the host's default. */
  context?: string | null
  /** Docker's own words for it ("Up 3 minutes", "Exited (0) 2 hours ago"), or why it could not be read. */
  status: string
  repo: ContainerRepo | null
  /** Its chat was deleted and removing it is still to be done: why the last try did not. */
  pendingRemoval?: string | null
}

/** Whether Claude Code's token for containers is kept, and how: sealed on disk, or for this session only. */
export type ContainerTokenStatus = { set: boolean; kept: 'sealed' | 'session' | null }

export type ContainerResult = { ok: true; message?: string } | { ok: false; message: string }

/** Which container to remove: a saved one by id, or one Docker has with Studio's label and no record here. */
export type ContainerRemoveTarget = { id: string } | { host: ContainerHost; name: string; context: string | null }

/** A saved container's id: the saved machine's 16 hex. */
export const CONTAINER_ID = /^[a-f0-9]{16}$/u
/** A container name Studio minted: `sprintengine-` and the saved machine's hex id. */
export const CONTAINER_NAME = /^sprintengine-[a-f0-9]{16}$/u
/** A Docker context's name, as `docker context` accepts one. */
export const CONTAINER_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
/** The most characters of a folder, a label or a token a request carries. */
export const CONTAINER_MAX_FOLDER = 4096
export const CONTAINER_MAX_LABEL = 200
export const CONTAINER_MAX_TOKEN = 4096

/** A host as a client names it, checked: `local`, or an SSH machine's saved id. */
export function parseContainerHost(value: unknown): ContainerHost | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind === 'local') return { kind: 'local' }
  if (record.kind === 'ssh' && typeof record.machine === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(record.machine))
    return { kind: 'ssh', machine: record.machine }
  return null
}

/** Why the containers are an owner's. */
export const STUDIO_CONTAINERS_OWNER =
  'It runs Docker on this computer or its SSH machines; a container chat is started from this desktop itself.'
/** Why Claude Code's token for containers is reached from Studio's own windows only. */
export const STUDIO_CONTAINERS_WINDOW = "It keeps a credential sealed with this computer's keychain."

type Commanded<P> = P & { commandId: string }

export type StudioContainersMethodMap = {
  /** Docker on a host, in words, and whether Studio's image is built there. */
  'containers.status': { params: { host: ContainerHost }; result: DockerStatus }
  /** Start Colima on a host, where Studio can; answered with Docker's status after. */
  'containers.startDocker': { params: Commanded<{ host: ContainerHost }>; result: DockerStatus }
  /**
   * Make a container for a chat on a host and copy a folder's repository in.
   * Long the first time on a host (the image is built); the list says each
   * step while it runs. Answered once it is ready, or why not, in words.
   */
  'containers.create': {
    params: Commanded<{ host: ContainerHost; folder: string | null; label: string; image: ContainerImageChoice }>
    result: ContainerCreateResult
  }
  /** Every container Studio made, on every host it knows, with Docker's own words for each. */
  'containers.list': { params: Record<string, never>; result: { containers: ContainerSummary[] } }
  /** Bring a container's branch out and push it from its host, with the host's git. */
  'containers.push': { params: Commanded<{ id: string }>; result: ContainerResult }
  /** Remove a container Studio made, and its record. */
  'containers.remove': { params: Commanded<ContainerRemoveTarget>; result: ContainerResult }
  /** Whether Claude Code's token for containers is kept (never the token). */
  'containers.tokenStatus': { params: Record<string, never>; result: ContainerTokenStatus }
  /** Keep a token from `claude setup-token`, sealed, for the containers on this computer. */
  'containers.setToken': { params: Commanded<{ token: string }>; result: ContainerResult }
  /** Forget it. */
  'containers.clearToken': { params: { commandId: string }; result: ContainerResult }
}

export type StudioContainersTopicMap = {
  /** A container was made, removed or pushed, or one being made moved a step: list again. */
  'containers.changed': { params: Record<string, never>; payload: Record<string, never>; stream: 'push' }
}

// ── Reading params ──────────────────────────────────────────────────────────

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'
const HOST = '"host" names the machine: { kind: "local" }, or { kind: "ssh", machine } with a saved machine\'s id.'

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!text(value.commandId, 200) || !value.commandId) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

function hosted(value: Record<string, unknown>): StudioParsed<{ host: ContainerHost }> {
  const host = parseContainerHost(value.host)
  return host ? studioParams({ host }) : refuse(HOST)
}

const created = commanded((value) => {
  const host = parseContainerHost(value.host)
  if (!host) return refuse(HOST)
  const folder = value.folder ?? null
  if (folder !== null && (!text(folder, CONTAINER_MAX_FOLDER) || !folder.trim()))
    return refuse(`"folder" is the project folder on that machine (1 to ${CONTAINER_MAX_FOLDER} characters), or null.`)
  const label = value.label ?? ''
  if (!text(label, CONTAINER_MAX_LABEL)) return refuse(`"label" is the chat's name: up to ${CONTAINER_MAX_LABEL} characters.`)
  const image = value.image ?? { kind: 'studio-default' }
  if ((image as { kind?: unknown } | null)?.kind !== 'studio-default')
    return refuse('"image" is { kind: "studio-default" }: Studio\'s own image is the only one for now.')
  return studioParams({ host, folder, label, image: { kind: 'studio-default' as const } })
})

const saved = commanded((value) =>
  typeof value.id === 'string' && CONTAINER_ID.test(value.id)
    ? studioParams({ id: value.id })
    : refuse('"id" names a container Studio made: its 16 hex characters.'),
)

const removed = commanded((value): StudioParsed<ContainerRemoveTarget> => {
  if (value.id !== undefined)
    return typeof value.id === 'string' && CONTAINER_ID.test(value.id)
      ? studioParams({ id: value.id })
      : refuse('"id" names a container Studio made: its 16 hex characters.')
  const host = parseContainerHost(value.host)
  if (!host) return refuse(HOST)
  if (typeof value.name !== 'string' || !CONTAINER_NAME.test(value.name))
    return refuse('"name" is a container Studio made: "sprintengine-" and 16 hex characters.')
  const context = value.context ?? null
  if (context !== null && (typeof context !== 'string' || !CONTAINER_CONTEXT.test(context)))
    return refuse('"context" is a Docker context\'s name, or null for the host\'s default.')
  return studioParams({ host, name: value.name, context })
})

const token = commanded((value) =>
  text(value.token, CONTAINER_MAX_TOKEN) && value.token.trim()
    ? studioParams({ token: value.token })
    : refuse(`"token" is the token \`claude setup-token\` printed: 1 to ${CONTAINER_MAX_TOKEN} characters.`),
)

// ── The table ───────────────────────────────────────────────────────────────

const owner = { capability: STUDIO_CONTAINERS_CAPABILITY, owner: STUDIO_CONTAINERS_OWNER } as const
const ownWindow = {
  scope: 'settings:write',
  capability: STUDIO_CONTAINERS_CAPABILITY,
  owner: STUDIO_CONTAINERS_WINDOW,
  window: STUDIO_CONTAINERS_WINDOW,
} as const

export const STUDIO_CONTAINERS_METHODS: StudioMethodTable<StudioContainersMethodMap> = {
  'containers.status': { ...owner, scope: 'workspaces:read', mutation: false, params: hosted },
  'containers.startDocker': { ...owner, scope: 'workspaces:operate', mutation: true, params: commanded(hosted) },
  'containers.create': { ...owner, scope: 'conversation:create', mutation: true, params: created },
  'containers.list': { ...owner, scope: 'workspaces:read', mutation: false, params: studioNoParams },
  'containers.push': { ...owner, scope: 'workspaces:operate', mutation: true, params: saved },
  'containers.remove': { ...owner, scope: 'workspaces:operate', mutation: true, params: removed },
  'containers.tokenStatus': { ...ownWindow, mutation: false, params: studioNoParams },
  'containers.setToken': { ...ownWindow, mutation: true, params: token },
  'containers.clearToken': { ...ownWindow, mutation: true, params: commanded(() => studioParams({})) },
}

export const STUDIO_CONTAINERS_TOPICS: StudioTopicTable<StudioContainersTopicMap> = {
  'containers.changed': {
    scope: 'workspaces:read',
    capability: STUDIO_CONTAINERS_CAPABILITY,
    owner: STUDIO_CONTAINERS_OWNER,
    push: true,
    params: studioNoParams,
  },
}
