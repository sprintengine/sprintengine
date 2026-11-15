import { randomBytes } from 'node:crypto'

import {
  CONTAINER_NAME,
  sameContainerHost,
  type ContainerCreateRequest,
  type ContainerCreateResult,
  type ContainerHost,
  type ContainerResult,
  type ContainerSummary,
  type DockerStatus,
  type SavedContainer,
} from '../../../shared/containers'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS, type SavedSshEnvironment } from '../../../shared/ssh-environments'
import type { ContainerImage } from './container-image'
import {
  buildImageScript,
  copyRepoInScript,
  CONTAINER_WORK,
  dockerStatusScript,
  isRepositoryScript,
  listContainersScript,
  parseContainerList,
  parseDockerStatus,
  pushOutScript,
  removalOutcome,
  removeContainerScript,
  runContainerScript,
  startColimaScript,
  workFolderName,
} from './container-scripts'
import { runOnHost, type HostResult, type HostRunner } from './docker-host'

// Chats in containers (docs/design/container-chats.md), in main: Docker on a
// host in words, a container made for a chat with its repository copied in,
// its branch brought out and pushed from the host, and every container Studio
// made listed and removed. A container is then one more saved machine
// (`SavedSshEnvironment.container`): the SSH machines' code installs Studio's
// server in it, connects, reconnects and signs its CLI in, over `docker exec`.

/** What this needs of the saved machines (ssh/ssh-environments.ts). */
export type ContainerMachines = {
  get(id: string): SavedSshEnvironment | null
  list(): SavedSshEnvironment[]
  hostRunner(host: ContainerHost): HostRunner
  readyToAsk(): Promise<void>
  addContainer(entry: SavedSshEnvironment & { container: SavedContainer }): void
  updateContainer(id: string, patch: Partial<SavedContainer>): void
  connect(id: string): Promise<{ ok: true } | { ok: false; message: string }>
  forget(id: string): Promise<{ ok: true } | { ok: false; message: string }>
}

export type ContainerChatsDeps = {
  machines: ContainerMachines
  /** Studio's default image, or null when the app has no Dockerfile (a broken install). */
  image(): ContainerImage | null
  /** "this Mac", or an SSH machine's label. */
  hostLabel(host: ContainerHost): string
  /** A container's state changed (made, removed, its branch pushed): every window asks again. */
  onChange(): void
  log?(message: string): void
  now?(): number
  timing?: Partial<typeof TIMING>
}

const TIMING = {
  statusMs: 30_000,
  startDockerMs: 5 * 60_000,
  buildMs: 30 * 60_000,
  runMs: 120_000,
  copyMs: 15 * 60_000,
  pushMs: 15 * 60_000,
  listMs: 30_000,
}

const lastLine = (result: HostResult): string =>
  result.stderr
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .pop()
    ?.trim() ?? ''

export class ContainerChats {
  private readonly timing: typeof TIMING
  private readonly log: (message: string) => void
  /** What a container being made is doing now, by its saved id, for its row's words. */
  private readonly preparing = new Map<string, string>()

  constructor(private readonly deps: ContainerChatsDeps) {
    this.timing = { ...TIMING, ...deps.timing }
    this.log = deps.log ?? (() => undefined)
  }

  /**
   * Run a script on a host. On an SSH machine ssh may need to ask (a
   * passphrase), so the dialogs listen first; a background read (`quiet`)
   * never asks, and simply fails where it would have had to.
   */
  private run(host: ContainerHost, script: string, options: { timeoutMs: number; quiet?: boolean }) {
    const ask = host.kind === 'ssh' && !options.quiet
    return (ask ? this.deps.machines.readyToAsk() : Promise.resolve()).then(() =>
      runOnHost(this.deps.machines.hostRunner(host), script, { timeoutMs: options.timeoutMs, interactive: ask }),
    )
  }

  /** Docker on a host, in words, and whether Studio's image is built there. */
  async status(host: ContainerHost): Promise<DockerStatus> {
    const where = this.deps.hostLabel(host)
    const image = this.deps.image()
    if (!image)
      return {
        state: 'missing',
        words: 'This copy of Studio has no container image to build. Reinstall it.',
        imageReady: false,
        canStart: null,
      }
    try {
      const result = await this.run(host, dockerStatusScript(image.tag), { timeoutMs: this.timing.statusMs })
      const status = parseDockerStatus(result.stdout, where)
      if (status.state === 'unreachable' && lastLine(result)) this.log(`Docker on ${where}: ${lastLine(result)}`)
      return status
    } catch (error) {
      this.log(`Docker on ${where} could not be asked: ${error instanceof Error ? error.message : String(error)}`)
      return parseDockerStatus('', where)
    }
  }

  /** Start Colima where it is installed and stopped, with its own saved settings. */
  async startDocker(host: ContainerHost): Promise<DockerStatus> {
    const before = await this.status(host)
    if (before.canStart !== 'colima') return before
    const result = await this.run(host, startColimaScript(), { timeoutMs: this.timing.startDockerMs })
    if (result.code !== 0) this.log(`colima start on ${this.deps.hostLabel(host)}: ${lastLine(result)}`)
    return this.status(host)
  }

  /** What a container being made is doing now, or null. */
  preparingText(id: string): string | null {
    return this.preparing.get(id) ?? null
  }

  /**
   * Make a container for a chat on `host`: Docker must answer there; Studio's
   * image is built on first use; the container starts, is saved as a machine,
   * gets Studio's server, and the repository of `folder` is copied in on a
   * branch of the chat's own. Anything that fails after the container started
   * removes it again, so nothing is left behind.
   */
  async create(request: ContainerCreateRequest): Promise<ContainerCreateResult> {
    const where = this.deps.hostLabel(request.host)
    const image = this.deps.image()
    if (!image) return { ok: false, message: 'This copy of Studio has no container image to build. Reinstall it.' }
    const docker = await this.status(request.host)
    if (docker.state !== 'ready') return { ok: false, message: docker.words }
    if (request.folder) {
      // Before anything is started: a folder with nothing to copy in is said at once.
      const repo = await this.run(request.host, isRepositoryScript(request.folder), { timeoutMs: this.timing.statusMs })
      if (!/@@repo yes/u.test(repo.stdout))
        return {
          ok: false,
          message: `${request.folder} is not a git repository, so there is nothing to copy into a container. Start it without a container, or in a repository.`,
        }
    }
    const id = randomBytes(8).toString('hex')
    const name = `sprintengine-${id}`
    const label = request.label.trim().slice(0, 60) || 'Container'
    const context = docker.context ?? null
    const step = (words: string) => {
      this.preparing.set(id, words)
      this.deps.onChange()
    }
    let recorded = false
    try {
      if (!docker.imageReady) {
        step(`Building Studio's container image on ${where} (the first time takes a few minutes)…`)
        const built = await this.run(request.host, buildImageScript(image.tag, image.dockerfile, context), {
          timeoutMs: this.timing.buildMs,
        })
        if (built.code !== 0)
          return { ok: false, message: `Studio's container image did not build on ${where}: ${lastLine(built)}` }
      }
      // Saved before Docker is asked to start it: a container whose making is
      // cut short (Studio quits, the machine goes away) is still on the list,
      // to be found and removed, never left running unseen.
      const container: SavedContainer = {
        host: request.host,
        name,
        context,
        image: image.tag,
        network: 'full',
        afterSettle: 'keep',
        repo: null,
        createdAt: this.deps.now?.() ?? Date.now(),
        provisioning: true,
      }
      this.deps.machines.addContainer({
        id,
        label: `${label} (container)`,
        destination: name,
        resolved: null,
        environmentId: null,
        // Kept running between chats' turns: the container is the chat's, and its server is too.
        settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true },
        addedAt: container.createdAt,
        container,
      })
      recorded = true
      step(`Starting a container on ${where}…`)
      const started = await this.run(
        request.host,
        runContainerScript({ name, image: image.tag, machineId: id, context }),
        { timeoutMs: this.timing.runMs },
      )
      if (started.code !== 0) {
        const removed = await this.deps.machines.forget(id)
        recorded = !removed.ok
        return {
          ok: false,
          message:
            started.code === null
              ? `Docker on ${where} did not answer in time.${recorded ? ' A container may have been started; it is listed in Settings › Machines › Containers.' : ''}`
              : `The container did not start on ${where}: ${lastLine(started)}`,
        }
      }
      step(`Installing Studio's server in the container on ${where}…`)
      const connected = await this.deps.machines.connect(id)
      if (!connected.ok) {
        await this.deps.machines.forget(id)
        return { ok: false, message: connected.message }
      }
      let folder = `${CONTAINER_WORK}`
      if (request.folder) {
        step(`Copying the repository into the container…`)
        const path = `${CONTAINER_WORK}/${workFolderName(request.folder)}`
        const branch = `studio/container-${id.slice(0, 8)}`
        const copied = await this.run(
          request.host,
          copyRepoInScript({ source: request.folder, name, path, branch, context }),
          { timeoutMs: this.timing.copyMs },
        )
        if (/@@repo not-a-repo/u.test(copied.stdout)) {
          await this.deps.machines.forget(id)
          return {
            ok: false,
            message: `${request.folder} is not a git repository, so there is nothing to copy into a container. Start it without a container, or in a repository.`,
          }
        }
        if (!/@@repo ok/u.test(copied.stdout)) {
          await this.deps.machines.forget(id)
          return { ok: false, message: `The repository was not copied into the container: ${lastLine(copied)}` }
        }
        const base = /^@@repo base ?(.*)$/mu.exec(copied.stdout)?.[1]?.trim() || null
        this.deps.machines.updateContainer(id, { repo: { source: request.folder, path, branch, base } })
        folder = path
      }
      this.deps.machines.updateContainer(id, { provisioning: false })
      return { ok: true, id, label: `${label} (container)`, folder }
    } catch (error) {
      if (recorded && this.deps.machines.get(id)) await this.deps.machines.forget(id).catch(() => undefined)
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.preparing.delete(id)
      this.deps.onChange()
    }
  }

  /**
   * Bring a container's branch out and push it from its host, with the
   * host's own git credentials: none are ever inside the container.
   */
  async push(id: string): Promise<ContainerResult> {
    const saved = this.deps.machines.get(id)
    const container = saved?.container
    if (!saved || !container) return { ok: false, message: 'That container is no longer one of yours.' }
    if (!container.repo) return { ok: false, message: 'This container has no repository to push from.' }
    const result = await this.run(
      container.host,
      pushOutScript({
        source: container.repo.source,
        name: container.name,
        path: container.repo.path,
        branch: container.repo.branch,
        ref: `refs/sprintengine/containers/${id}`,
        context: container.context ?? null,
      }),
      { timeoutMs: this.timing.pushMs },
    )
    const said = /^@@push (\S+)(?: (\S+))?$/mu.exec(result.stdout)
    const branch = container.repo.branch
    const where = this.deps.hostLabel(container.host)
    switch (said?.[1]) {
      case 'ok':
        this.deps.onChange()
        return { ok: true, message: `Pushed ${branch} (${(said[2] ?? '').slice(0, 7)}) from ${where}.` }
      case 'no-source':
        return { ok: false, message: `${container.repo.source} on ${where} is no longer a git repository.` }
      case 'no-branch':
        return { ok: false, message: `The container has no branch ${branch} to push.` }
      case 'push-failed':
        return { ok: false, message: `git push from ${where} failed: ${lastLine(result)}` }
      default:
        return { ok: false, message: `The branch could not be brought out of the container: ${lastLine(result)}` }
    }
  }

  /**
   * Every container Studio made, on every host and Docker context it has made
   * one on: the saved ones (with why one waiting to be removed is still
   * there), and any Docker still has with Studio's label that Studio no longer
   * has a record of, so none is left unseen. Hosts are asked at once, each
   * with a deadline, and an SSH machine is never asked to prompt here.
   */
  async list(): Promise<ContainerSummary[]> {
    const saved = this.deps.machines.list().filter((entry) => entry.container)
    type Place = { host: ContainerHost; context: string | null }
    const places: Place[] = [{ host: { kind: 'local' }, context: null }]
    for (const entry of saved) {
      const place = { host: entry.container!.host, context: entry.container!.context ?? null }
      if (!places.some((each) => sameContainerHost(each.host, place.host) && each.context === place.context))
        places.push(place)
    }
    const answers = await Promise.all(
      places.map(async (place) => {
        try {
          const result = await this.run(place.host, listContainersScript(place.context), {
            timeoutMs: this.timing.listMs,
            quiet: true,
          })
          return result.code === 0
            ? { place, listed: parseContainerList(result.stdout), why: '' }
            : { place, listed: null, why: lastLine(result) || 'Docker did not answer.' }
        } catch (error) {
          return { place, listed: null, why: error instanceof Error ? error.message : String(error) }
        }
      }),
    )
    const out: ContainerSummary[] = []
    // One engine can answer under two contexts (`default` and `colima` on a Mac with Colima):
    // a saved container is never listed again as one with no record, nor an unsaved one twice.
    const hostKey = (host: ContainerHost) => (host.kind === 'local' ? 'local' : `ssh:${host.machine}`)
    const seen = new Set<string>(saved.map((entry) => `${hostKey(entry.container!.host)}:${entry.container!.name}`))
    for (const { place, listed, why } of answers) {
      const hostLabel = this.deps.hostLabel(place.host)
      const here = saved.filter(
        (entry) =>
          sameContainerHost(entry.container!.host, place.host) && (entry.container!.context ?? null) === place.context,
      )
      for (const entry of here) {
        const found = listed?.find((each) => each.name === entry.container!.name)
        const preparing = this.preparing.get(entry.id)
        const docker = found ? found.status : listed ? 'Gone from Docker' : `Not read: ${why}`
        out.push({
          id: entry.id,
          name: entry.container!.name,
          host: place.host,
          hostLabel,
          context: place.context,
          status:
            preparing ?? (entry.container!.provisioning ? `Being made, or cut short while it was. ${docker}` : docker),
          repo: entry.container!.repo,
          pendingRemoval: entry.container!.pendingRemoval ?? null,
        })
      }
      for (const found of listed ?? []) {
        if (here.some((entry) => entry.container!.name === found.name)) continue
        const key = `${hostKey(place.host)}:${found.name}`
        if (seen.has(key)) continue
        seen.add(key)
        // A container another of this person's Studio profiles saved is still listed: it is Studio's.
        out.push({
          id: null,
          name: found.name,
          host: place.host,
          hostLabel,
          context: place.context,
          status: found.status,
          repo: null,
        })
      }
    }
    return out
  }

  /** Remove a saved container (its record too), or one Docker has with no record here. */
  async remove(
    target: { id: string } | { host: ContainerHost; name: string; context?: string | null },
  ): Promise<ContainerResult> {
    if ('id' in target) {
      const saved = this.deps.machines.get(target.id)
      if (!saved?.container) return { ok: false, message: 'That container is no longer one of yours.' }
      const forgotten = await this.deps.machines.forget(target.id)
      this.deps.onChange()
      return forgotten
    }
    if (!CONTAINER_NAME.test(target.name)) return { ok: false, message: 'That is not a container Studio made.' }
    const result = await this.run(target.host, removeContainerScript(target.name, target.context ?? null), {
      timeoutMs: 120_000,
    })
    this.deps.onChange()
    return removalOutcome(result, target.name, this.deps.hostLabel(target.host))
  }
}
