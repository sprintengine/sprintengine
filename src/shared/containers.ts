// Containers (docs/design/container-chats.md). A container is a machine:
// Studio runs its own server in it, reached over `docker exec` the way an SSH
// machine is reached over ssh, and keeps it in the same list of saved machines
// (`SavedSshEnvironment.container`). It runs on a host: this computer, or an
// SSH machine the person saved.
//
// Pure and shared: no fs, no electron.

/** The machine a container runs on: this computer, or one of its saved SSH machines by id. */
export type ContainerHost = { kind: 'local' } | { kind: 'ssh'; machine: string }

/** Docker on a host, in words (never a dot). */
export type DockerStatus = {
  /**
   * `ready`: Docker answers. `stopped`: Colima is installed and stopped, and
   * Studio can start it. `not-running`: Docker's command is there and its
   * engine does not answer. `missing`: no Docker. `unreachable`: the SSH
   * machine could not be asked.
   */
  state: 'ready' | 'stopped' | 'not-running' | 'missing' | 'unreachable'
  /** The sentence shown: "Docker 29.2 is running on this Mac (Colima)." */
  words: string
  /** Whether Studio's image is built there already (the first container builds it). */
  imageReady: boolean
  /** What starting it would run, when Studio can: Colima's own `colima start`. */
  canStart: 'colima' | null
  /** The Docker context that answered (`ready` only); a container made now is kept on it. */
  context?: string | null
  /** The image a container made now gets: from the agents set up in Studio. */
  image?: ContainerImagePlan
}

/** One agent in a container's image: its name and its version in words. */
export type ContainerImageAgent = { cli: string; name: string; version: string }

/** The image a container gets: its tag, the agents in it, and the ones set up in Studio it cannot have. */
export type ContainerImagePlan = {
  tag: string
  agents: ContainerImageAgent[]
  refused: Array<{ cli: string; why: string }>
}

/** New container: where it runs, its name, and a repository to clone into it, if any. */
export type ContainerCreateRequest = {
  host: ContainerHost
  label: string
  /** A repository's address (`https://…`, `git@…`, or `owner/repo` on GitHub); null for none. */
  clone: string | null
}

/**
 * A container made: its saved machine's id, and the folder the clone landed
 * in (null with no clone, or one that failed, said in `cloneFailed`).
 */
export type ContainerCreateResult =
  { ok: true; id: string; folder: string | null; cloneFailed?: string } | { ok: false; message: string }

/**
 * What exists only inside a container, which deleting it would lose: branches
 * with commits no remote has, worktrees with uncommitted or untracked changes,
 * commits on a detached HEAD on no branch or remote, and stashes; and how many
 * chats are running in it (null when its server could not be asked).
 */
export type ContainerWork = {
  branches: Array<{ repo: string; branch: string; commits: number }>
  dirty: Array<{ worktree: string; files: number }>
  detached: Array<{ worktree: string; commits: number }>
  stashes: Array<{ repo: string; count: number }>
  chatsRunning: number | null
}

/** What deleting a container would lose, or why that could not be read. */
export type ContainerUnpushed = ({ ok: true } & ContainerWork) | { ok: false; message: string }

/** A container Studio made, as the desktop keeps it with its saved machines. */
export type SavedContainer = {
  host: ContainerHost
  /** Docker's name for it: `sprintengine-<saved id>`. */
  name: string
  /**
   * The Docker context it was made under on its host (`docker context show`),
   * named on every later call so a changed default context cannot lose it;
   * null for the host's own default.
   */
  context?: string | null
  /**
   * Set from the moment Studio asks Docker to start it until it is ready, so a
   * container whose making was cut short (Studio quit, the machine went away)
   * is still listed, to be deleted.
   */
  provisioning?: boolean
  /** The image it was started from. */
  image: string
  /** The agents in that image, by CLI id (none recorded for a container made before images listed them). */
  agents?: string[]
  createdAt: number
}

/** Docker's names for what Studio makes: `sprintengine-` and sixteen hex digits. */
export const CONTAINER_NAME = /^sprintengine-[a-f0-9]{16}$/u

/** The label every container, volume and image Studio makes carries; nothing without it is ever removed. */
export const CONTAINER_LABEL = 'sprintengine.studio.container'
/** The label that names the saved machine a container belongs to. */
export const CONTAINER_MACHINE_LABEL = 'sprintengine.studio.machine'
export const IMAGE_LABEL = 'sprintengine.studio.image'

/** A host as a window sends it, checked: this computer, or a saved SSH machine's id. */
export function parseContainerHost(value: unknown): ContainerHost | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind === 'local') return { kind: 'local' }
  if (record.kind === 'ssh' && typeof record.machine === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(record.machine))
    return { kind: 'ssh', machine: record.machine }
  return null
}
