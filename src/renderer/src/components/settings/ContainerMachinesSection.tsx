import React, { useEffect, useId, useState } from 'react'

import type { ContainerHost, ContainerImagePlan, ContainerUnpushed, DockerStatus } from '../../../../shared/containers'
import type { SshEnvironmentSummary } from '../../../../shared/ssh-environments'
import { GhostButton, InlineNotice, Input, OutlineButton, Select, useConfirmDialog, WorkingMark } from '../ui'
import { SettingsRow } from './SettingsAtoms'

// Containers in Settings › Machines and New chat (docs/design/container-chats.md).
// A container is a machine: its row is the machine list's, as an SSH
// machine's is. What is a container's own is here: New container (where it
// runs, Docker there in words, its name, a repository to clone), and a
// container's detail (where it runs, a clone, Delete, which first says what
// exists only in it).

export type ContainerApi = Pick<
  Window['api'],
  | 'containerDockerStatus'
  | 'containerStartDocker'
  | 'containerCreate'
  | 'containerClone'
  | 'containerUnpushed'
  | 'containerRebuild'
  | 'sshSignIn'
  | 'sshEnvironmentForget'
  | 'sshEnvironmentDiagnostics'
>

const MUTED = 'text-body leading-5 text-[color:var(--text-muted)]'
const FIELD = 'w-60 max-w-full'

/** "this Mac", "this PC" or "this computer", as the window's platform says. */
export function thisComputerWords(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  return platform.startsWith('Mac') ? 'this Mac' : platform.startsWith('Win') ? 'this PC' : 'this computer'
}

/** Where a container runs, in words: "this Mac", or its SSH machine's name. */
export function containerHostWords(host: ContainerHost, machines: readonly SshEnvironmentSummary[]): string {
  if (host.kind === 'local') return thisComputerWords()
  return machines.find((machine) => machine.id === host.machine)?.label ?? 'an SSH machine no longer saved'
}

/** The machines a container can be made on: this computer (not Windows itself, which Studio does not drive Docker on yet), and every SSH machine. */
function containerHosts(machines: readonly SshEnvironmentSummary[]): Array<{ value: string; label: string }> {
  const local = thisComputerWords() === 'this PC' ? [] : [{ value: 'local', label: thisComputerWords() }]
  return [
    ...local.map((each) => ({ ...each, label: each.label.replace(/^this/u, 'This') })),
    ...machines
      .filter((machine) => !machine.container)
      .map((machine) => ({ value: `ssh:${machine.id}`, label: machine.label })),
  ]
}

function hostOf(value: string): ContainerHost {
  return value === 'local' ? { kind: 'local' } : { kind: 'ssh', machine: value.slice('ssh:'.length) }
}

/** The agents an image has, each with its version, and the ones set up in Studio it cannot have. */
function ImageAgents({ plan }: { plan: ContainerImagePlan }): React.JSX.Element {
  return (
    <div data-container-agents="true" className="space-y-1">
      <p className={MUTED}>
        {plan.agents.length > 0
          ? `Agents: ${plan.agents.map((agent) => `${agent.name} (${agent.version})`).join(', ')}, and the GitHub CLI. Each signs in once on this machine's logins, which every container here shares.`
          : 'No agent is set up in Studio, so a container gets only git and the GitHub CLI. Set one up in Settings › Agents.'}
      </p>
      {plan.refused.map((each) => (
        <p key={each.cli} className={MUTED}>
          {each.why}
        </p>
      ))}
    </div>
  )
}

/**
 * New container: where it runs, Docker there in words (with Start Colima
 * where Colima is stopped), its name and a repository to clone into it.
 * Making one can take minutes (the first image build on a machine), and the
 * new machine's row says each step while it does.
 */
export function NewContainerForm({
  api,
  machines,
  onMade,
  initialHost,
}: {
  api: ContainerApi
  /** Every saved machine: the SSH machines a container may run on, and the one being made, whose row says its step. */
  machines: readonly SshEnvironmentSummary[]
  /** Made: the new machine's id, and the folder the clone landed in. */
  onMade?: (made: { id: string; folder: string | null }) => void
  initialHost?: ContainerHost
}): React.JSX.Element {
  const hosts = containerHosts(machines)
  const nameId = useId()
  const cloneId = useId()
  const [hostValue, setHostValue] = useState<string>(() =>
    initialHost?.kind === 'ssh' ? `ssh:${initialHost.machine}` : (hosts[0]?.value ?? 'local'),
  )
  const [status, setStatus] = useState<DockerStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [label, setLabel] = useState('')
  const [clone, setClone] = useState('')
  const [making, setMaking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Asked again after a container is made: its image is built there now.
  const [asked, setAsked] = useState(0)
  const where =
    hostValue === 'local'
      ? thisComputerWords()
      : (hosts.find((each) => each.value === hostValue)?.label ?? thisComputerWords())

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    void api
      .containerDockerStatus(hostOf(hostValue))
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setStatus({
            state: 'unreachable',
            words: error instanceof Error ? error.message : 'Docker could not be asked.',
            imageReady: false,
            canStart: null,
          })
      })
    return () => {
      cancelled = true
    }
  }, [api, hostValue, asked])

  const startDocker = async () => {
    setStarting(true)
    try {
      setStatus(await api.containerStartDocker(hostOf(hostValue)))
    } finally {
      setStarting(false)
    }
  }

  const make = async () => {
    setMaking(true)
    setProblem(null)
    setNote(null)
    try {
      const made = await api.containerCreate({ host: hostOf(hostValue), label, clone: clone.trim() || null })
      if (!made.ok) {
        setProblem(made.message)
        return
      }
      if (made.cloneFailed) setNote(`${label.trim()} is made, but the clone did not work: ${made.cloneFailed}`)
      setLabel('')
      setClone('')
      setAsked((count) => count + 1)
      onMade?.({ id: made.id, folder: made.folder })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setMaking(false)
    }
  }

  // The new machine's own row says which step it is on.
  const step = making
    ? machines.find((machine) => machine.container && machine.label === label.trim() && machine.working)?.stateText
    : null
  const dockerWords = starting ? `Starting Colima on ${where}…` : (status?.words ?? `Looking for Docker on ${where}…`)

  return (
    <div data-new-container="true" className="space-y-3">
      <div className="divide-y divide-[color:var(--border-subtle)]">
        <SettingsRow label="Runs on" help="This computer, or an SSH machine with Docker.">
          {hosts.length > 0 ? (
            <Select
              ariaLabel="Where the container runs"
              items={hosts}
              value={hostValue}
              onChange={(value) => setHostValue(value)}
              disabled={making}
            />
          ) : (
            <span className={MUTED}>Add an SSH machine with Docker first.</span>
          )}
        </SettingsRow>
        <SettingsRow label="Docker">
          <span data-container-docker={status?.state ?? 'checking'} className="flex flex-col items-end gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-body text-[color:var(--text-muted)]">
              {!status || starting ? <WorkingMark label={starting ? 'Starting Colima' : 'Looking for Docker'} /> : null}
              <span>{dockerWords}</span>
            </span>
            {status?.canStart === 'colima' && !starting ? (
              <OutlineButton size="xs" onClick={() => void startDocker()}>
                Start Colima
              </OutlineButton>
            ) : null}
          </span>
        </SettingsRow>
        <SettingsRow label="Name" help="How it reads in the machine picker." htmlFor={nameId}>
          <Input
            id={nameId}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="sandbox"
            size="md"
            variant="well"
            fullWidth={false}
            className={FIELD}
            disabled={making}
          />
        </SettingsRow>
        <SettingsRow
          label="Clone"
          help="A repository to clone into it, if any: owner/repo on GitHub, or its address."
          htmlFor={cloneId}
        >
          <Input
            id={cloneId}
            value={clone}
            onChange={(event) => setClone(event.target.value)}
            placeholder="owner/repo"
            size="md"
            variant="well"
            fullWidth={false}
            className={`${FIELD} font-mono`}
            disabled={making}
          />
        </SettingsRow>
      </div>
      {status?.image ? <ImageAgents plan={status.image} /> : null}
      {status?.imageProblem ? <InlineNotice tone="warn" title={status.imageProblem} /> : null}
      {status?.state === 'ready' && !status.imageReady ? (
        <p className={MUTED}>The first container on {where} builds Studio’s image, which takes a few minutes.</p>
      ) : null}
      {problem ? <InlineNotice tone="warn" title={problem} /> : null}
      {note ? <InlineNotice tone="warn" title={note} /> : null}
      <div className="flex items-center gap-2">
        <OutlineButton
          size="sm"
          disabled={making || status?.state !== 'ready' || !label.trim() || Boolean(status.imageProblem)}
          onClick={() => void make()}
        >
          Make container
        </OutlineButton>
        {making ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            <WorkingMark label="Making the container" />
            <span className="min-w-0 truncate">{step ?? `Making the container on ${where}…`}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

const homePath = (path: string) => path.replace(/^\/home\/node\//u, '~/')
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** What deleting a container would lose, in words: only what was looked at, and what was found. */
function ContainerWorkWords({ work }: { work: ContainerUnpushed }): React.JSX.Element {
  if (!work.ok)
    return (
      <>
        <p>Studio could not look inside it for work that exists only there: {work.message}</p>
        <p className="mt-2">Deleting it removes its repositories and everything else in it.</p>
      </>
    )
  const found = [
    ...work.branches.map((each) => ({
      key: `b:${each.repo}:${each.branch}`,
      what: (
        <>
          <span className="font-mono">{each.branch}</span> in <span className="font-mono">{homePath(each.repo)}</span>:{' '}
          {plural(each.commits, 'commit', 'commits')} on no remote
        </>
      ),
    })),
    ...work.dirty.map((each) => ({
      key: `d:${each.worktree}`,
      what: (
        <>
          <span className="font-mono">{homePath(each.worktree)}</span>: {plural(each.files, 'file', 'files')} changed
          and not committed
        </>
      ),
    })),
    ...work.detached.map((each) => ({
      key: `h:${each.worktree}`,
      what: (
        <>
          <span className="font-mono">{homePath(each.worktree)}</span>: {plural(each.commits, 'commit', 'commits')} on a
          detached HEAD, on no branch or remote
        </>
      ),
    })),
    ...work.stashes.map((each) => ({
      key: `s:${each.repo}`,
      what: (
        <>
          <span className="font-mono">{homePath(each.repo)}</span>: {plural(each.count, 'stash', 'stashes')}
        </>
      ),
    })),
  ]
  const chats =
    work.chatsRunning === null
      ? 'Studio could not ask its server whether a chat is running in it.'
      : work.chatsRunning > 0
        ? `${plural(work.chatsRunning, 'chat is', 'chats are')} running in it now, and stop with it.`
        : 'No chat is running in it.'
  return (
    <>
      {found.length > 0 ? (
        <>
          <p>This exists only in the container, and goes with it:</p>
          <ul data-unpushed-work="true" className="mt-2 list-disc space-y-0.5 pl-5">
            {found.map((each) => (
              <li key={each.key}>{each.what}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          In its repositories (in the home, four folders deep) and their worktrees, Studio found no commit on no remote,
          no uncommitted change and no stash. Anything else in it is removed too.
        </p>
      )}
      <p className="mt-2">{chats}</p>
      <p className="mt-2">
        What stays is on this machine's logins volume, which every container here shares: each agent's sign-in, history,
        sessions and settings, and git's and the GitHub CLI's configuration.
      </p>
    </>
  )
}

/**
 * Delete a container, after saying what would be lost (`ContainerWorkWords`).
 * When Docker cannot remove it (not running, the machine away), the person
 * may forget only its record. Resolves with whether it went, and why not.
 */
export async function deleteContainer(
  machine: SshEnvironmentSummary,
  api: ContainerApi,
  askFirst: ReturnType<typeof useConfirmDialog>['confirm'],
): Promise<{ deleted: boolean; message: string | null }> {
  const work = await api.containerUnpushed(machine.id).catch((error: unknown): ContainerUnpushed => ({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }))
  const yes = await askFirst({
    title: `Delete ${machine.label}?`,
    body: <ContainerWorkWords work={work} />,
    confirmLabel: 'Delete container',
    tone: 'danger',
  })
  if (!yes) return { deleted: false, message: null }
  const forgotten = await api.sshEnvironmentForget(machine.id)
  if (forgotten.ok) return { deleted: true, message: null }
  const recordOnly = await askFirst({
    title: `Forget only ${machine.label}'s record?`,
    body: `${forgotten.message} Forgetting its record leaves whatever Docker has untouched, and Studio stops listing it.`,
    confirmLabel: 'Forget its record',
    tone: 'danger',
  })
  if (!recordOnly) return { deleted: false, message: forgotten.message }
  const dropped = await api.sshEnvironmentForget(machine.id, { recordOnly: true })
  return dropped.ok ? { deleted: true, message: null } : { deleted: false, message: dropped.message }
}

/** A container's detail in Settings › Machines: where it runs, a clone, its diagnostics, and Delete. */
export function ContainerMachineDetail({
  machine,
  machines,
  api,
}: {
  machine: SshEnvironmentSummary
  machines: readonly SshEnvironmentSummary[]
  api: ContainerApi
}): React.JSX.Element | null {
  const { confirm: askFirst } = useConfirmDialog()
  const cloneId = useId()
  const [clone, setClone] = useState('')
  const [busy, setBusy] = useState<'cloning' | 'deleting' | 'rebuilding' | 'signing-in' | null>(null)
  const [said, setSaid] = useState<{ tone: 'warn' | 'good'; text: string } | null>(null)
  const [diagnostics, setDiagnostics] = useState<string | null>(null)
  // The image a container on this host gets now, to say whether this one is on it.
  const [plan, setPlan] = useState<ContainerImagePlan | null>(null)
  const container = machine.container
  const hostKey = container ? JSON.stringify(container.host) : null
  useEffect(() => {
    if (!hostKey) return
    let cancelled = false
    void api
      .containerDockerStatus(JSON.parse(hostKey) as ContainerHost)
      .then((status) => {
        if (!cancelled) setPlan(status.image ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api, hostKey, container?.image])
  if (!container) return null
  const agentName = (cli: string) => plan?.agents.find((agent) => agent.cli === cli)?.name ?? cli
  const outdated = plan !== null && plan.tag !== container.image
  const rebuild = async () => {
    setBusy('rebuilding')
    setSaid(null)
    try {
      // Its chats stop with the old container: said, and asked, first.
      const work = await api.containerUnpushed(machine.id).catch(() => null)
      const running = work?.ok ? work.chatsRunning : null
      const yes = await askFirst({
        title: `Rebuild ${machine.label}?`,
        body: `${
          running === null
            ? 'Studio could not ask its server whether a chat is running in it.'
            : running > 0
              ? `${running === 1 ? '1 chat is' : `${running} chats are`} running in it now, and stop when it is made again.`
              : 'No chat is running in it.'
        } Its repositories, worktrees, Studio's server and the logins are kept; anything installed outside its home goes with the old container.`,
        confirmLabel: 'Rebuild',
      })
      if (!yes) return
      const rebuilt = await api.containerRebuild(machine.id)
      setSaid(
        rebuilt.ok
          ? { tone: 'good', text: `${machine.label} is made again on the new image, with its repositories and logins.` }
          : { tone: 'warn', text: rebuilt.message },
      )
    } finally {
      setBusy(null)
    }
  }
  const signIn = async (cli: string, name: string) => {
    setBusy('signing-in')
    setSaid(null)
    try {
      const signed = await api.sshSignIn(machine.id, cli)
      setSaid(
        signed.ok
          ? {
              tone: 'good',
              text: `Signed in to ${name}. Every container on ${containerHostWords(container.host, machines)} has it.`,
            }
          : { tone: 'warn', text: signed.message },
      )
    } finally {
      setBusy(null)
    }
  }
  const cloneNow = async () => {
    setBusy('cloning')
    setSaid(null)
    try {
      const cloned = await api.containerClone(machine.id, clone)
      setSaid(
        cloned.ok ? { tone: 'good', text: `Cloned into ${cloned.folder}.` } : { tone: 'warn', text: cloned.message },
      )
      if (cloned.ok) setClone('')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-4">
      <div className="divide-y divide-[color:var(--border-subtle)]">
        <SettingsRow label="Runs on" help="Reached with docker exec there.">
          <span className="text-body text-[color:var(--text-default)]">
            {containerHostWords(container.host, machines)}
          </span>
        </SettingsRow>
        <SettingsRow label="Docker name" help={`Image ${container.image}`}>
          <span className="font-mono text-body text-[color:var(--text-default)]">{container.name}</span>
        </SettingsRow>
        {outdated ? (
          <SettingsRow
            label="Image"
            help="The agents set up in Studio, or their versions, changed since it was made. Rebuild makes it again on the new image and keeps its repositories, worktrees and logins."
          >
            <OutlineButton size="sm" disabled={busy !== null} onClick={() => void rebuild()}>
              {busy === 'rebuilding' ? 'Rebuilding…' : 'Rebuild'}
            </OutlineButton>
          </SettingsRow>
        ) : null}
        <SettingsRow
          label="Sign in"
          help="Each agent's own login, and GitHub's for git and pull requests, kept on this machine's logins: every container here shares them."
          stacked
        >
          <span data-container-sign-in="true" className="flex flex-wrap gap-2">
            {(container.agents ?? []).map((cli) => (
              <OutlineButton
                key={cli}
                size="xs"
                disabled={busy !== null || machine.state !== 'connected'}
                onClick={() => void signIn(cli, agentName(cli))}
              >
                {agentName(cli)}
              </OutlineButton>
            ))}
            <OutlineButton
              size="xs"
              disabled={busy !== null || machine.state !== 'connected'}
              onClick={() => void signIn('github', 'GitHub')}
            >
              GitHub
            </OutlineButton>
          </span>
        </SettingsRow>
        {machine.server ? (
          <SettingsRow label="Studio server" help="Installed in the container, and kept running there.">
            <span className="font-mono text-body text-[color:var(--text-default)]">{machine.server.version}</span>
          </SettingsRow>
        ) : null}
        <SettingsRow
          label="Clone a repository"
          help="Into ~/work in the container: owner/repo on GitHub, or its address."
          htmlFor={cloneId}
        >
          <span className="flex items-center gap-2">
            <Input
              id={cloneId}
              value={clone}
              onChange={(event) => setClone(event.target.value)}
              placeholder="owner/repo"
              size="md"
              variant="well"
              fullWidth={false}
              className={`${FIELD} font-mono`}
              disabled={busy !== null}
            />
            <OutlineButton size="sm" disabled={busy !== null || !clone.trim()} onClick={() => void cloneNow()}>
              {busy === 'cloning' ? 'Cloning…' : 'Clone'}
            </OutlineButton>
          </span>
        </SettingsRow>
      </div>
      {said?.tone === 'warn' ? <InlineNotice tone="warn" title={said.text} /> : null}
      {said?.tone === 'good' ? <p className={MUTED}>{said.text}</p> : null}
      <div className="flex flex-wrap gap-2">
        <GhostButton
          size="sm"
          onClick={() =>
            void api
              .sshEnvironmentDiagnostics(machine.id)
              .then((result) => setDiagnostics(result.ok ? result.text : result.message))
          }
        >
          Diagnostics
        </GhostButton>
        <GhostButton
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            setBusy('deleting')
            void deleteContainer(machine, api, askFirst)
              .then((outcome) => setSaid(outcome.message ? { tone: 'warn', text: outcome.message } : null))
              .finally(() => setBusy(null))
          }}
        >
          {busy === 'deleting' ? 'Looking for unpushed work…' : 'Delete container'}
        </GhostButton>
      </div>
      {diagnostics ? (
        <pre className="whitespace-pre-wrap break-words rounded-md border border-[color:var(--border-subtle)] px-3 py-2 font-mono text-meta text-[color:var(--text-default)]">
          {diagnostics}
        </pre>
      ) : null}
    </div>
  )
}
