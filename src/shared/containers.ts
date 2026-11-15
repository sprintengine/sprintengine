// Chats in containers (docs/design/container-chats.md). A container is one more machine Studio
// runs its own server on, reached over `docker exec` the way an SSH machine
// is reached over ssh, and kept in the same list of saved machines
// (`SavedSshEnvironment.container`). It runs on a host: this computer, or an
// SSH machine the person saved.
//
// Pure and shared: no fs, no electron.

import type { ContainerHost, ContainerRepo } from '../../packages/studio-protocol/src/public'

// What travels between a client and the desktop's Studio is the protocol's
// (`packages/studio-protocol/src/containers.ts`); what the desktop keeps of
// each container with its saved machines is below.
export {
  CONTAINER_NAME,
  parseContainerHost,
  type ContainerCreateRequest,
  type ContainerCreateResult,
  type ContainerHost,
  type ContainerImageChoice,
  type ContainerRemoveTarget,
  type ContainerRepo,
  type ContainerResult,
  type ContainerSummary,
  type ContainerTokenStatus,
  type DockerStatus,
} from '../../packages/studio-protocol/src/public'

/** What a container's agent can reach. Full network is the default (owner ruling 2026-11-15). */
export type ContainerNetwork = 'full'

/** What a container does once its chat settles. Kept, so it can be picked up again (owner ruling 2026-11-15). */
export type ContainerAfterSettle = 'keep'

/** A container Studio made for a chat, as the desktop keeps it with its saved machines. */
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
   * is still on the list to be found and removed.
   */
  provisioning?: boolean
  /**
   * Its chat was deleted and it is waiting to be removed (Docker was not
   * running, the machine was away): why the last try did not, in words.
   * Tried again until it goes.
   */
  pendingRemoval?: string | null
  /** The image it was started from. */
  image: string
  network: ContainerNetwork
  afterSettle: ContainerAfterSettle
  repo: ContainerRepo | null
  createdAt: number
}

/** The label every container and image Studio makes carries; nothing without it is ever removed. */
export const CONTAINER_LABEL = 'sprintengine.studio.container'
/** The label that names the saved machine a container belongs to. */
export const CONTAINER_MACHINE_LABEL = 'sprintengine.studio.machine'
export const IMAGE_LABEL = 'sprintengine.studio.image'

/** Whether two hosts are the same machine. */
export function sameContainerHost(a: ContainerHost, b: ContainerHost): boolean {
  return a.kind === b.kind && (a.kind === 'local' || a.machine === (b as { machine: string }).machine)
}
