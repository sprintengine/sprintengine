import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Studio's default image for a chat's container (resources/container/
// agent.Dockerfile): shipped with the app as a Dockerfile, built on the host
// that runs the container the first time one is made there, and tagged by the
// file's digest. Docker keeps it, so every later container on that host
// starts at once, and an app update that changes the file builds a new one
// beside the old (the old one is Docker's to prune, never Studio's).
//
// A project's own devcontainer or Dockerfile is the room left here: another
// `ContainerImageChoice`, resolved to a tag the same way.

export const IMAGE_REPOSITORY = 'sprintengine-studio-agent'

export type ContainerImage = { tag: string; dockerfile: string }

/** Where the Dockerfile is: the packaged app's resources, or the checkout in development. */
export function agentDockerfilePath(options: {
  packaged: boolean
  resourcesDir: string | null
  appRoot: string | null
}): string | null {
  const path = options.packaged
    ? options.resourcesDir && join(options.resourcesDir, 'container', 'agent.Dockerfile')
    : options.appRoot && join(options.appRoot, 'resources', 'container', 'agent.Dockerfile')
  return path && existsSync(path) ? path : null
}

/** The image a Dockerfile builds: tagged by the first twelve hex digits of its SHA-256. */
export function imageFor(dockerfile: string): ContainerImage {
  const digest = createHash('sha256').update(dockerfile).digest('hex').slice(0, 12)
  return { tag: `${IMAGE_REPOSITORY}:${digest}`, dockerfile }
}

export function readAgentImage(options: Parameters<typeof agentDockerfilePath>[0]): ContainerImage | null {
  const path = agentDockerfilePath(options)
  return path ? imageFor(readFileSync(path, 'utf8')) : null
}
