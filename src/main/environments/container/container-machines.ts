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
  prepareLoginsScript,
  parseDockerStatus,
  parseUnpushed,
  replaceContainerScript,
  runContainerScript,
  startColimaScript,
  unpushedScript,
} from './container-scripts'
import { runOnHost, type HostResult, type HostRunner } from './docker-host'

// Containers as machines (docs/design/container-chats.md), in main: Docker on
// a host in words, New container (the image built on first use, the
// container started and saved as a machine with the host's logins, Studio's
// server installed in it, a repository cloned), a clone into one later,
// Rebuild on a new image, and what deleting one would lose. Once made, a container is one more saved machine
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
  /** The machine's live connection, or null; never connects. */
  connection(id: string): {
    owner: {
      request(
        method: 'conversation.list',
        params: Record<string, never>,
      ): Promise<{ conversations: Array<{ phase: string }> }>
    }
  } | null
  disconnect(id: string): unknown
  forget(id: string): Promise<{ ok: true } | { ok: false; message: string }>
}

export type ContainerMachinesDeps = {
  machines: ContainerMachinesStore
  /**
   * The image a container gets now: from the agents set up in Studio, at the
   * versions this build pins. Rejects, in words, when which agents are set up
   * cannot be told (rather than build an image of a guess).
   */
  image(): Promise<ContainerImage>
  /** The host's logins volume; a suite names one of its own so a real one is never touched. */
  loginsVolume?: string
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

/** A chat in one of these is doing something deleting its container would cut short. */
const RUNNING = new Set(['starting', 'running', 'waiting_for_approval', 'waiting_for_input'])

const lastLine = (result: HostResult): string =>
  result.stderr
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .pop()
    ?.trim() ?? ''

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

  /** The image a container gets now, or why it cannot be worked out, in words. */
  private async plannedImage(): Promise<{ ok: true; image: ContainerImage } | { ok: false; message: string }> {
    try {
      return { ok: true, image: await this.deps.image() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Docker on a host, in words, whether the image a container gets now is
   * built there (under `context`, a container's own, else the host's default),
   * and what is in it, or why that image cannot be worked out.
   */
  async status(host: ContainerHost, context: string | null = null): Promise<DockerStatus> {
    const where = this.deps.hostLabel(host)
    const planned = await this.plannedImage()
    const plan = planned.ok
      ? { image: { tag: planned.image.tag, agents: planned.image.agents, refused: planned.image.refused } }
      : { imageProblem: planned.message }
    try {
      const result = await this.run(
        host,
        dockerStatusScript(planned.ok ? planned.image.tag : 'sprintengine-studio-agent:none', context),
        this.timing.statusMs,
      )
      const status = parseDockerStatus(result.stdout, where)
      if (status.state === 'unreachable' && lastLine(result)) this.log(`Docker on ${where}: ${lastLine(result)}`)
      return { ...status, ...(planned.ok ? {} : { imageReady: false }), ...plan }
    } catch (error) {
      this.log(`Docker on ${where} could not be asked: ${error instanceof Error ? error.message : String(error)}`)
      return { ...parseDockerStatus('', where), ...plan }
    }
  }

  /** Ready the host's logins volume in a container; why not, in words, when it could not be. */
  private async prepareLogins(host: ContainerHost, name: string, context: string | null): Promise<string | null> {
    const prepared = await this.run(host, prepareLoginsScript(name, context), this.timing.runMs)
    if (prepared.code === 0) return null
    const why = lastLine(prepared) || (prepared.code === null ? 'it did not finish in time.' : 'it said nothing.')
    this.log(`The logins were not readied in ${name} on ${this.deps.hostLabel(host)}: ${why}`)
    return `The logins could not be readied in the container: ${why}`
  }

  /** Build the image on a host when it is not there yet, saying so on the container's row. */
  private async ensureImage(
    host: ContainerHost,
    image: ContainerImage,
    docker: DockerStatus,
    step: (words: string) => void,
  ): Promise<string | null> {
    if (docker.imageReady) return null
    const where = this.deps.hostLabel(host)
    step(`Building Studio's container image on ${where} (the first time takes a few minutes)…`)
    const built = await this.run(
      host,
      buildImageScript(image.tag, image.dockerfile, docker.context ?? null),
      this.timing.buildMs,
    )
    return built.code === 0 ? null : `Studio's container image did not build on ${where}: ${lastLine(built)}`
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
    const planned = await this.plannedImage()
    if (!planned.ok) return { ok: false, message: planned.message }
    const image = planned.image
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
        agents: image.agents.map((agent) => agent.cli),
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
      const unbuilt = await this.ensureImage(request.host, image, docker, step)
      if (unbuilt) {
        await this.deps.machines.forget(id)
        recorded = false
        return { ok: false, message: unbuilt }
      }
      step(`Starting the container on ${where}…`)
      const started = await this.run(
        request.host,
        runContainerScript({ name, image: image.tag, machineId: id, context, loginsVolume: this.deps.loginsVolume }),
        this.timing.runMs,
      )
      if (started.code === null) {
        // Docker did not answer in time, and its own command may still be
        // starting the container: the record is kept, so it stays listed and
        // can be deleted once Docker answers, never dropped while it may run.
        return {
          ok: false,
          message: `Docker on ${where} did not answer in time. The container may have been started; it is listed in Settings › Machines, where it can be deleted.`,
        }
      }
      if (started.code !== 0) {
        const removed = await this.deps.machines.forget(id)
        recorded = !removed.ok
        return { ok: false, message: `The container did not start on ${where}: ${lastLine(started)}` }
      }
      // The host's logins volume ready for every CLI: its folders, its first files, the home's links.
      const unprepared = await this.prepareLogins(request.host, name, context)
      if (unprepared) {
        await this.deps.machines.forget(id)
        recorded = false
        return { ok: false, message: unprepared }
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

  /**
   * Make a container again on the image a container gets now (the agents set
   * up in Studio changed, or this build moved a version), keeping its home
   * volume (repositories, worktrees, Studio's server) and the host's logins.
   * Its chats' server stops with the old container and starts in the new one.
   */
  async rebuild(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const saved = this.deps.machines.get(id)
    const container = saved?.container
    if (!saved || !container) return { ok: false, message: 'That container is no longer one of your machines.' }
    const planned = await this.plannedImage()
    if (!planned.ok) return { ok: false, message: planned.message }
    const image = planned.image
    const context = container.context ?? null
    // Asked under the container's own context: the image is built, and the container made again, there.
    const docker = await this.status(container.host, context)
    if (docker.state !== 'ready') return { ok: false, message: docker.words }
    const where = this.deps.hostLabel(container.host)
    const step = (words: string) => this.deps.machines.setPreparing(id, words)
    try {
      const unbuilt = await this.ensureImage(container.host, image, { ...docker, context }, step)
      if (unbuilt) return { ok: false, message: unbuilt }
      step(`Making ${saved.label} again on the new image…`)
      this.deps.machines.disconnect(id)
      const replaced = await this.run(
        container.host,
        replaceContainerScript({
          name: container.name,
          image: image.tag,
          machineId: id,
          context,
          loginsVolume: this.deps.loginsVolume,
        }),
        this.timing.runMs,
      )
      if (!/^@@replaced$/mu.test(replaced.stdout)) {
        const said = /^@@replaced (\S+)$/mu.exec(replaced.stdout)?.[1]
        return {
          ok: false,
          message:
            said === 'not-ours'
              ? `${container.name} on ${where} is not a container Studio made, so it was left alone.`
              : said === 'no-image'
                ? `The new image is not on ${where}, so ${saved.label} was left as it is.`
                : `${saved.label} was not made again on ${where}: ${lastLine(replaced) || 'Docker said nothing.'} Its repositories and logins are kept on their volumes; Rebuild again once Docker answers.`,
        }
      }
      const unprepared = await this.prepareLogins(container.host, container.name, context)
      if (unprepared) return { ok: false, message: `${unprepared} Rebuild again to retry.` }
      // Only now is it on the new image: a failure above leaves Rebuild offered.
      this.deps.machines.updateContainer(id, { image: image.tag, agents: image.agents.map((agent) => agent.cli) })
      step(`Starting Studio's server in the container…`)
      return await this.deps.machines.connect(id)
    } catch (error) {
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

  /**
   * What exists only inside the container (unpushed branches, uncommitted
   * changes, detached commits, stashes), and how many chats run in it now,
   * or why that could not be read.
   */
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
      const work = parseUnpushed(result.stdout)
      if (!work)
        return {
          ok: false,
          message: `Studio could not look inside the container on ${where}${lastLine(result) ? `: ${lastLine(result)}` : '.'}`,
        }
      return { ok: true, ...work, chatsRunning: await this.chatsRunning(id) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** How many chats its own Studio is running now; null when it is not connected or did not answer. */
  private async chatsRunning(id: string): Promise<number | null> {
    const connection = this.deps.machines.connection(id)
    if (!connection) return null
    try {
      const listed = await connection.owner.request('conversation.list', {})
      return listed.conversations.filter((each) => RUNNING.has(each.phase)).length
    } catch {
      return null
    }
  }
}
