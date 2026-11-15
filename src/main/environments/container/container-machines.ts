import { randomBytes } from 'node:crypto'

import type {
  ContainerCreateRequest,
  ContainerCreateResult,
  ContainerHost,
  ContainerUnpushed,
  DockerStatus,
  SavedContainer,
} from '../../../shared/containers'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS, type SavedSshEnvironment } from '../../../shared/ssh-environments'
import type { ContainerImage } from './container-image'
import {
  buildImageScript,
  cloneAddress,
  cloneFolderName,
  cloneScript,
  dockerStatusScript,
  parseDockerStatus,
  parseUnpushed,
  runContainerScript,
  startColimaScript,
  unpushedScript,
} from './container-scripts'
import { runOnHost, type HostResult, type HostRunner } from './docker-host'

// Containers as machines (docs/design/container-chats.md), in main: Docker on
// a host in words, New container (the image built on first use, the
// container started and saved as a machine, Studio's server installed in it,
// a repository cloned), a clone into one later, and what deleting one would
// lose. Once made, a container is one more saved machine
// (`SavedSshEnvironment.container`): the SSH machines' code connects to it,
// reconnects, signs its CLIs in and deletes it, over `docker exec`.

/** What this needs of the saved machines (ssh/ssh-environments.ts). */
export type ContainerMachinesStore = {
  get(id: string): SavedSshEnvironment | null
  list(): SavedSshEnvironment[]
  hostRunner(host: ContainerHost): HostRunner
  readyToAsk(): Promise<void>
  addContainer(entry: SavedSshEnvironment & { container: SavedContainer }): void
  updateContainer(id: string, patch: Partial<SavedContainer>): void
  /** What a container being made is doing now, shown as its row's state; null once it is done. */
  setPreparing(id: string, words: string | null): void
  connect(id: string): Promise<{ ok: true } | { ok: false; message: string }>
  forget(id: string): Promise<{ ok: true } | { ok: false; message: string }>
}

export type ContainerMachinesDeps = {
  machines: ContainerMachinesStore
  /** Studio's image, or null when the app has no Dockerfile (a broken install). */
  image(): ContainerImage | null
  /** "this Mac", or an SSH machine's label. */
  hostLabel(host: ContainerHost): string
  log?(message: string): void
  now?(): number
  timing?: Partial<typeof TIMING>
}

const TIMING = {
  statusMs: 30_000,
  startDockerMs: 5 * 60_000,
  buildMs: 30 * 60_000,
  runMs: 120_000,
  cloneMs: 15 * 60_000,
  unpushedMs: 60_000,
}

const lastLine = (result: HostResult): string =>
  result.stderr
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .pop()
    ?.trim() ?? ''

const NO_IMAGE = 'This copy of Studio has no container image to build. Reinstall it.'

export class ContainerMachines {
  private readonly timing: typeof TIMING
  private readonly log: (message: string) => void

  constructor(private readonly deps: ContainerMachinesDeps) {
    this.timing = { ...TIMING, ...deps.timing }
    this.log = deps.log ?? (() => undefined)
  }

  /**
   * Run a script on a host. On an SSH machine ssh may need to ask (a
   * passphrase), so the dialogs listen first.
   */
  private run(host: ContainerHost, script: string, timeoutMs: number) {
    const ask = host.kind === 'ssh'
    return (ask ? this.deps.machines.readyToAsk() : Promise.resolve()).then(() =>
      runOnHost(this.deps.machines.hostRunner(host), script, { timeoutMs, interactive: ask }),
    )
  }

  /** Docker on a host, in words, and whether Studio's image is built there. */
  async status(host: ContainerHost): Promise<DockerStatus> {
    const where = this.deps.hostLabel(host)
    const image = this.deps.image()
    if (!image) return { state: 'missing', words: NO_IMAGE, imageReady: false, canStart: null }
    try {
      const result = await this.run(host, dockerStatusScript(image.tag), this.timing.statusMs)
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
    const result = await this.run(host, startColimaScript(), this.timing.startDockerMs)
    if (result.code !== 0) this.log(`colima start on ${this.deps.hostLabel(host)}: ${lastLine(result)}`)
    return this.status(host)
  }

  /**
   * New container on `host`: Docker must answer there; Studio's image is
   * built on first use; the container is saved as a machine before Docker is
   * asked to start it, gets Studio's server, and the repository asked for is
   * cloned in. Anything that fails after the container started deletes it
   * again, so nothing is left behind.
   */
  async create(request: ContainerCreateRequest): Promise<ContainerCreateResult> {
    const where = this.deps.hostLabel(request.host)
    const label = request.label.trim().slice(0, 60)
    if (!label) return { ok: false, message: 'Give the container a name.' }
    if (this.deps.machines.list().some((entry) => entry.label === label))
      return { ok: false, message: `${label} is already one of your machines. Give the container another name.` }
    const address = request.clone?.trim() ? cloneAddress(request.clone) : null
    if (request.clone?.trim() && !address)
      return {
        ok: false,
        message: `${request.clone.trim()} is not a repository address. Use https://…, git@host:owner/repo, or owner/repo for GitHub.`,
      }
    const image = this.deps.image()
    if (!image) return { ok: false, message: NO_IMAGE }
    const docker = await this.status(request.host)
    if (docker.state !== 'ready') return { ok: false, message: docker.words }
    const id = randomBytes(8).toString('hex')
    const name = `sprintengine-${id}`
    const context = docker.context ?? null
    const step = (words: string) => this.deps.machines.setPreparing(id, words)
    let recorded = false
    try {
      // Saved before anything is built or started: the person sees it on the
      // list at once, and a making cut short (Studio quits, the machine goes
      // away) is still there to be deleted, never left running unseen.
      const container: SavedContainer = {
        host: request.host,
        name,
        context,
        image: image.tag,
        createdAt: this.deps.now?.() ?? Date.now(),
        provisioning: true,
      }
      this.deps.machines.addContainer({
        id,
        label,
        destination: name,
        resolved: null,
        environmentId: null,
        // A container's server keeps running between chats: nothing else runs in it.
        settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true },
        addedAt: container.createdAt,
        container,
      })
      recorded = true
      if (!docker.imageReady) {
        step(`Building Studio's container image on ${where} (the first time takes a few minutes)…`)
        const built = await this.run(
          request.host,
          buildImageScript(image.tag, image.dockerfile, context),
          this.timing.buildMs,
        )
        if (built.code !== 0) {
          await this.deps.machines.forget(id)
          recorded = false
          return { ok: false, message: `Studio's container image did not build on ${where}: ${lastLine(built)}` }
        }
      }
      step(`Starting the container on ${where}…`)
      const started = await this.run(
        request.host,
        runContainerScript({ name, image: image.tag, machineId: id, context }),
        this.timing.runMs,
      )
      if (started.code !== 0) {
        const removed = await this.deps.machines.forget(id)
        recorded = !removed.ok
        return {
          ok: false,
          message:
            started.code === null
              ? `Docker on ${where} did not answer in time.${recorded ? ` The container may have been started; it is listed in Settings › Machines, where it can be deleted.` : ''}`
              : `The container did not start on ${where}: ${lastLine(started)}`,
        }
      }
      step(`Installing Studio's server in the container…`)
      const connected = await this.deps.machines.connect(id)
      if (!connected.ok) {
        await this.deps.machines.forget(id)
        recorded = false
        return { ok: false, message: connected.message }
      }
      this.deps.machines.updateContainer(id, { provisioning: false })
      let folder: string | null = null
      if (address) {
        step(`Cloning ${request.clone!.trim()}…`)
        const cloned = await this.clone(id, address)
        // The container is made either way: a clone that failed is said, and can be tried again.
        if (!cloned.ok) return { ok: true, id, folder: null, cloneFailed: cloned.message }
        folder = cloned.folder
      }
      return { ok: true, id, folder }
    } catch (error) {
      if (recorded && this.deps.machines.get(id)?.container?.provisioning)
        await this.deps.machines.forget(id).catch(() => undefined)
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.deps.machines.setPreparing(id, null)
    }
  }

  /** Clone a repository into a container, with the container's own credentials. */
  async clone(id: string, typed: string): Promise<{ ok: true; folder: string } | { ok: false; message: string }> {
    const container = this.deps.machines.get(id)?.container
    if (!container) return { ok: false, message: 'That container is no longer one of your machines.' }
    const address = cloneAddress(typed)
    if (!address)
      return {
        ok: false,
        message: `${typed.trim()} is not a repository address. Use https://…, git@host:owner/repo, or owner/repo for GitHub.`,
      }
    const result = await this.run(
      container.host,
      cloneScript({ name: container.name, address, folder: cloneFolderName(address), context: container.context }),
      this.timing.cloneMs,
    )
    const ok = /^@@clone ok (\S+)$/mu.exec(result.stdout)
    if (ok) return { ok: true, folder: ok[1]! }
    const exists = /^@@clone exists (\S+)$/mu.exec(result.stdout)
    if (exists) return { ok: false, message: `${exists[1]} is already there in the container.` }
    if (result.code === null) return { ok: false, message: 'The clone did not finish in time.' }
    return { ok: false, message: `git clone did not work: ${lastLine(result) || 'it said nothing.'}` }
  }

  /** Every branch in the container's repositories with commits no remote has, or why that could not be read. */
  async unpushed(id: string): Promise<ContainerUnpushed> {
    const container = this.deps.machines.get(id)?.container
    if (!container) return { ok: false, message: 'That container is no longer one of your machines.' }
    const where = this.deps.hostLabel(container.host)
    try {
      const result = await this.run(
        container.host,
        unpushedScript(container.name, container.context ?? null),
        this.timing.unpushedMs,
      )
      const branches = parseUnpushed(result.stdout)
      if (branches) return { ok: true, branches }
      return {
        ok: false,
        message: `Studio could not look inside the container on ${where}${lastLine(result) ? `: ${lastLine(result)}` : '.'}`,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}
