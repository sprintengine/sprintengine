// Chats in containers (docs/design/container-chats.md): what the renderer and
// main say to each other about them. A container is one more machine Studio
// runs its own server on, reached over `docker exec` the way an SSH machine
// is reached over ssh, and kept in the same list of saved machines
// (`SavedSshEnvironment.container`). It runs on a host: this computer, or an
// SSH machine the person saved.
//
// Pure and shared: no fs, no electron.

/** The machine a container runs on: this computer, or a saved SSH machine by its id. */
export type ContainerHost = { kind: 'local' } | { kind: 'ssh'; machine: string }

/** What a container's agent can reach. Full network is the default (owner ruling 2026-11-15). */
export type ContainerNetwork = 'full'

/** What a container does once its chat settles. Kept, so it can be picked up again (owner ruling 2026-11-15). */
export type ContainerAfterSettle = 'keep'

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

/** A container Studio made for a chat, as the desktop keeps it with its saved machines. */
export type SavedContainer = {
  host: ContainerHost
  /** Docker's name for it: `sprintengine-<saved id>`. */
  name: string
  /** The image it was started from. */
  image: string
  network: ContainerNetwork
  afterSettle: ContainerAfterSettle
  repo: ContainerRepo | null
  createdAt: number
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

export type ContainerCreateResult =
  { ok: true; id: string; label: string; folder: string } | { ok: false; message: string }

/** A container Studio made, as Settings lists it, so none is left behind unseen. */
export type ContainerSummary = {
  /** The saved machine's id; null for one Docker has that Studio no longer has a record of. */
  id: string | null
  name: string
  host: ContainerHost
  hostLabel: string
  /** Docker's own words for it ("Up 3 minutes", "Exited (0) 2 hours ago"), or why it could not be read. */
  status: string
  repo: ContainerRepo | null
}

/** Whether Claude Code's token for containers is kept, and how: sealed on disk, or for this session only. */
export type ContainerTokenStatus = { set: boolean; kept: 'sealed' | 'session' | null }

export type ContainerResult = { ok: true; message?: string } | { ok: false; message: string }

/** The channels, all owned by main (it runs Docker and holds the sessions). */
export const CONTAINER_CHANNELS = {
  /** renderer → main: Docker on a host, in words `{ host }`. */
  status: 'environments:container:status',
  /** renderer → main: start Colima on a host `{ host }`. */
  start: 'environments:container:start-docker',
  /** renderer → main: make a container for a chat and copy its repository in (`ContainerCreateRequest`). */
  create: 'environments:container:create',
  /** renderer → main: every container Studio made, on every host it knows. */
  list: 'environments:container:list',
  /** renderer → main: remove one `{ id }` (a saved one) or `{ host, name }` (one with no record). */
  remove: 'environments:container:remove',
  /** renderer → main: bring a container's branch out and push it from the host `{ id }`. */
  push: 'environments:container:push',
  /** renderer → main: whether Claude Code's token for containers is set (never the token). */
  tokenStatus: 'environments:container:token-status',
  /** renderer → main: keep Claude Code's token for containers `{ token }`. */
  tokenSet: 'environments:container:token-set',
  /** renderer → main: forget it. */
  tokenClear: 'environments:container:token-clear',
  /** main → renderer: a container was made, removed or pushed, or one being made moved a step; ask again. */
  changed: 'environments:container:changed',
} as const

/** The label every container and image Studio makes carries; nothing without it is ever removed. */
export const CONTAINER_LABEL = 'sprintengine.studio.container'
/** The label that names the saved machine a container belongs to. */
export const CONTAINER_MACHINE_LABEL = 'sprintengine.studio.machine'
export const IMAGE_LABEL = 'sprintengine.studio.image'

/** A container name Studio minted: `sprintengine-` and the saved machine's hex id. */
export const CONTAINER_NAME = /^sprintengine-[a-f0-9]{16}$/u

/** Whether two hosts are the same machine. */
export function sameContainerHost(a: ContainerHost, b: ContainerHost): boolean {
  return a.kind === b.kind && (a.kind === 'local' || a.machine === (b as { machine: string }).machine)
}

/** A host from a window, checked. */
export function parseContainerHost(value: unknown): ContainerHost | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind === 'local') return { kind: 'local' }
  if (record.kind === 'ssh' && typeof record.machine === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(record.machine))
    return { kind: 'ssh', machine: record.machine }
  return null
}
