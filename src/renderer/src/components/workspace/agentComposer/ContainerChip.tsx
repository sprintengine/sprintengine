import React from 'react'

import type { ContainerHost, DockerStatus } from '../../../../../shared/containers'
import type { ContainersApi } from '../../../studio/containers'
import { ChipButton, ContainerGlyph, OutlineButton, Popover, Switch, WorkingMark } from '../../ui'
import { ChipCaretGlyph } from './agentSpawnShared'

type ContainerApi = Pick<ContainersApi, 'containerDockerStatus' | 'containerStartDocker'>

/**
 * Container, in the New chat composer's context strip beside Worktree (owner
 * ruling 2026-11-15; docs/design/container-chats.md). Off by default, reading
 * "No container"; on, "Container", and the chat runs in a Docker container of
 * its own on the machine the machine picker names, with the project copied in
 * and its changes leaving only as a pushed branch. A separate choice from the
 * machine and from Worktree.
 *
 * Its popover is the container's settings for that machine: whether Docker is
 * there, said in words (no dot); the image; how the repository goes in and
 * comes out; the network; and what happens once the chat settles. Only the
 * switch is a choice today: the rest says what a container gets.
 */
export function ContainerChip({
  on,
  onChange,
  host,
  hostLabel,
  unsupported,
  preparing = false,
  api,
}: {
  on: boolean
  onChange: (next: boolean) => void
  /** The machine the container would run on; null when the picked machine cannot run one. */
  host: ContainerHost | null
  /** "this Mac", or the picked machine's name. */
  hostLabel: string
  /** Why the picked machine cannot run a container, when it cannot. */
  unsupported?: string | null
  /** The container is being made for a launch: the chip says so, beside the working mark. */
  preparing?: boolean
  api: ContainerApi | null
}) {
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState<DockerStatus | null>(null)
  const [busy, setBusy] = React.useState<'checking' | 'starting' | null>(null)
  const hostKey = host ? (host.kind === 'local' ? 'local' : `ssh:${host.machine}`) : null

  const check = React.useCallback(async () => {
    if (!host || !api?.containerDockerStatus) return
    setBusy('checking')
    try {
      setStatus(await api.containerDockerStatus(host))
    } catch (error) {
      setStatus({
        state: 'unreachable',
        words: error instanceof Error ? error.message : 'Docker could not be asked.',
        imageReady: false,
        canStart: null,
      })
    } finally {
      setBusy(null)
    }
    // hostKey names the host; the object itself changes identity on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey, api])

  // Asked when the popover opens, and again when the machine changes under it.
  React.useEffect(() => {
    setStatus(null)
    if (open) void check()
  }, [open, check])

  const startDocker = async () => {
    if (!host || !api?.containerStartDocker) return
    setBusy('starting')
    try {
      setStatus(await api.containerStartDocker(host))
    } finally {
      setBusy(null)
    }
  }

  const switchId = React.useId()
  const dockerWords = unsupported
    ? unsupported
    : busy === 'starting'
      ? `Starting Colima on ${hostLabel}…`
      : status
        ? status.words
        : `Looking for Docker on ${hostLabel}…`

  return (
    <span data-container-chip={on ? 'on' : 'off'} className="inline-flex shrink-0 items-center">
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Container settings"
        popupRole="dialog"
        placement="bottom-start"
        surfaceClassName="w-[340px] max-w-[calc(100vw-16px)]"
        onOpenAutoFocus={(surface) => surface.querySelector<HTMLElement>('[role="switch"]')?.focus()}
        renderTrigger={({ ref, triggerProps, togglePopover }) => (
          <ChipButton
            ref={ref}
            variant="raised"
            pressed={on}
            aria-label="Container"
            onClick={togglePopover}
            data-container-trigger="true"
            {...triggerProps}
          >
            {/* Still, whatever the container is doing (owner ruling 2026-11-15).
                Off, the mark steps down to disabled ink as Worktree's does. */}
            <ContainerGlyph className={`icon-xs shrink-0${on ? '' : ' text-[color:var(--text-disabled)]'}`} />
            {preparing ? 'Making container…' : on ? 'Container' : 'No container'}
            {preparing ? <WorkingMark label="Making the container" /> : null}
            <ChipCaretGlyph />
          </ChipButton>
        )}
      >
        <div data-container-settings="true" className="flex flex-col gap-3 p-3 text-body">
          <div className="flex items-start justify-between gap-3">
            <label htmlFor={switchId} className="min-w-0">
              <span className="block font-medium text-[color:var(--text-strong)]">Run in a container</span>
              <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">
                A Docker container of its own on {hostLabel}.
              </span>
            </label>
            <Switch
              id={switchId}
              checked={on}
              disabled={Boolean(unsupported) || !host}
              onChange={(next) => onChange(next)}
              ariaLabel="Run this chat in a container"
            />
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-meta">
            <dt className="text-[color:var(--text-subtle)]">Docker</dt>
            <dd data-container-docker={status?.state ?? (unsupported ? 'unsupported' : 'checking')} className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-[color:var(--text-muted)]">
                {busy ? <WorkingMark label={busy === 'starting' ? 'Starting Colima' : 'Looking for Docker'} /> : null}
                <span>{dockerWords}</span>
              </span>
              {status?.canStart === 'colima' && !busy ? (
                <OutlineButton size="xs" className="mt-1.5" onClick={() => void startDocker()}>
                  Start Colima
                </OutlineButton>
              ) : null}
              {status && status.state === 'ready' && !status.imageReady ? (
                <span className="mt-0.5 block text-[color:var(--text-subtle)]">
                  The first container here builds Studio’s image, which takes a few minutes.
                </span>
              ) : null}
            </dd>
            <dt className="text-[color:var(--text-subtle)]">Image</dt>
            <dd className="text-[color:var(--text-muted)]">Studio’s default: Node 22, git, Claude Code and Codex</dd>
            <dt className="text-[color:var(--text-subtle)]">Repo</dt>
            <dd className="text-[color:var(--text-muted)]">Cloned in; changes leave as a pushed branch</dd>
            <dt className="text-[color:var(--text-subtle)]">Network</dt>
            <dd className="text-[color:var(--text-muted)]">Full</dd>
            <dt className="text-[color:var(--text-subtle)]">After it settles</dt>
            <dd className="text-[color:var(--text-muted)]">Kept, until the chat is deleted</dd>
          </dl>
        </div>
      </Popover>
    </span>
  )
}
