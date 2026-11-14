import React, { useCallback, useEffect, useRef, useState } from 'react'

import { formatEnvironmentRoute, type EnvironmentRoute } from '../../../../../packages/studio-protocol/src/environment'
import { hostIdOfEnvironmentRoute } from '../../../../shared/environment-keys'
import { environmentStatus } from '../../../../shared/environment-status'
import { environmentKey } from '../../../../shared/environments'
import {
  emptyExecutionHostSettings,
  executionHostStateWords,
  type ExecutionHostId,
  type ExecutionHostSettings,
  type ExecutionHostSummary,
  type WslServerSummary,
} from '../../../../shared/execution-host'
import type { SshEnvironmentSummary } from '../../../../shared/ssh-environments'
import { retryEnvironment, useEnvironments } from '../../hooks/useEnvironments'
import { useExecutionHosts } from '../../hooks/useExecutionHosts'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  GhostButton,
  InlineNotice,
  Input,
  OutlineButton,
  ProviderRow,
  ProviderStateId,
  Select,
  Textarea,
  WorkingMark,
} from '../ui'
import { MachineMarkPicker, MachineRowMark } from './MachineMarkPicker'
import { SettingCard, SettingsPageHeader, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'
import { AddSshMachine, SshMachineActions, SshMachineDetail, useSshMachines } from './SshMachinesSection'

const ROW_FIELD = 'w-60 max-w-full font-mono'

/** `NAME=value` per line, the way a person writes an environment; blank lines and `#` comments skipped. */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const name = line.slice(0, equals).trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) env[name] = line.slice(equals + 1)
  }
  return env
}

export function formatEnvLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')
}

const SERVER_TRANSPORT_ITEMS: Array<{ value: 'auto' | 'stdio'; label: string }> = [
  { value: 'auto', label: 'Loopback, else the bridge' },
  { value: 'stdio', label: 'Always the bridge' },
]

/** How a distribution's Studio server, which holds its chats, stands, in words (phase 7). */
export function serverWords(server: WslServerSummary): string {
  const how = server.transport === 'stdio' ? 'through the stdio bridge' : 'over loopback'
  switch (server.state) {
    case 'ready':
      return `Running, reached ${how}.${server.transport === 'stdio' && server.reason ? ` (${server.reason})` : ''}`
    case 'starting':
      return server.reason ?? 'Starting…'
    case 'unavailable':
    case 'shut-down':
      return server.reason ?? 'Not running.'
    default:
      return 'Starts with the first chat here, and stops after ten minutes with nothing to do.'
  }
}

const MUTED = 'text-body leading-5 text-[color:var(--text-muted)]'

/**
 * Settings ▸ Machines: every machine this desktop can run chats on, in one
 * list (design-environments): this computer, its WSL distributions turned on
 * as machines, the SSH machines a person added, and the desktops paired over
 * the tailnet. Each row says how the machine stands, in the same words every
 * other surface uses (`environmentStatus`), and offers the one thing to do
 * about it. Its detail is where that kind of machine is set up: a
 * distribution's shell and environment, an SSH machine's server, a pairing.
 *
 * A distribution not turned on is not a machine yet; it is listed under the
 * list, with the switch that makes it one. Its agent CLIs, like this
 * computer's, are on the Agents tab with the machine picked there (owner
 * ruling 2026-09-24).
 */
export function MachinesSettingsTab({
  onShowAgentClis,
  onOpenRemoteSettings,
}: {
  /** Open Settings ▸ Agents with this machine picked. */
  onShowAgentClis?: (id: ExecutionHostId) => void
  /** Open Settings ▸ Remote, where a pairing is made, renewed and forgotten. */
  onOpenRemoteSettings?: () => void
} = {}): React.JSX.Element {
  const { listing, refresh } = useExecutionHosts({ all: true, refreshOnMount: true })
  const environments = useEnvironments()
  const sshOn = window.api?.sshMachinesEnabled === true
  const { machines: sshMachines } = useSshMachines(sshOn ? window.api : null)
  const [refreshing, setRefreshing] = useState(false)
  const hostSettings = useWorkspaceStore((s) => s.appSettings.hosts)
  const setHostSettings = useWorkspaceStore((s) => s.setHostSettings)
  const [expanded, setExpanded] = useState<string | null>(null)
  const now = useRelativeNow(30_000)

  const settingsOf = (id: ExecutionHostId): ExecutionHostSettings => hostSettings?.[id] ?? emptyExecutionHostSettings()
  const write = (id: ExecutionHostId, patch: Partial<ExecutionHostSettings>): void => {
    setHostSettings(id, { ...settingsOf(id), ...patch })
  }
  const hostOf = (id: ExecutionHostId): ExecutionHostSummary | null =>
    listing?.hosts.find((host) => host.id === id) ?? null
  const sshOf = (id: string): SshEnvironmentSummary | null => sshMachines.find((machine) => machine.id === id) ?? null
  // The distributions not turned on: not machines yet, so not in the list.
  const offDistros = (listing?.hosts ?? []).filter((host) => host.kind === 'wsl' && !settingsOf(host.id).enabled)

  const routeParts = (route: EnvironmentRoute) => {
    const hostId = hostIdOfEnvironmentRoute(route)
    const host = route.kind === 'wsl' && hostId ? hostOf(hostId) : null
    const ssh = route.kind === 'ssh' ? sshOf(route.machine) : null
    return { hostId, host, ssh }
  }

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Machines"
        actions={
          <GhostButton
            size="md"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              void refresh().finally(() => setRefreshing(false))
            }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </GhostButton>
        }
      />

      {listing?.wsl && !listing.wsl.available ? (
        <InlineNotice tone="warn" title="WSL did not answer." hint={listing.wsl.reason} />
      ) : null}

      <section className="space-y-2">
        <SettingsSectionTitle count={environments.length || undefined}>Machines</SettingsSectionTitle>
        <SettingCard as="ul" ariaLabel="Machines">
          {environments.map((entry) => {
            const key = environmentKey(entry)
            const best = entry.routes[0]!
            const { hostId, host, ssh } = routeParts(best)
            const status = environmentStatus(entry, now)
            const details = entry.routes.flatMap((route) => {
              const parts = routeParts(route)
              const detail = (
                <RouteDetail
                  route={route}
                  host={parts.host}
                  hostSettings={parts.hostId ? settingsOf(parts.hostId) : null}
                  onHostChange={(patch) => (parts.hostId ? write(parts.hostId, patch) : undefined)}
                  ssh={parts.ssh}
                  onOpenRemoteSettings={onOpenRemoteSettings}
                />
              )
              return route.kind === 'local' ||
                (route.kind === 'wsl' && !parts.host) ||
                (route.kind === 'ssh' && !parts.ssh)
                ? []
                : [<React.Fragment key={formatEnvironmentRoute(route)}>{detail}</React.Fragment>]
            })
            const isOpen = expanded === key
            const act = (): void => {
              if (status.action === 'retry') void retryEnvironment(entry)
              else if (best.kind === 'tailnet') onOpenRemoteSettings?.()
              else setExpanded(key)
            }
            return (
              <ProviderRow
                key={key}
                as="li"
                surface="card"
                icon={
                  status.tone === 'working' ? (
                    <WorkingMark label={`${entry.displayName}: ${status.words}`} className="size-icon-lg" />
                  ) : best.kind === 'local' ? (
                    <span aria-hidden="true" className="size-icon-lg" />
                  ) : (
                    <MachineRowMark machine={entry.machine} />
                  )
                }
                recessed={status.kind === 'offline'}
                name={entry.displayName}
                version={
                  host?.isDefaultDistro ? 'default' : (entry.descriptor?.serverVersion ?? ssh?.server?.version ?? null)
                }
                stateLine={status.words}
                {...(best.kind === 'wsl' && hostId
                  ? {
                      enabled: settingsOf(hostId).enabled,
                      onEnabledChange: (enabled: boolean) => write(hostId, { enabled }),
                    }
                  : {})}
                {...(details.length > 0
                  ? { expanded: isOpen, onExpandedChange: (next: boolean) => setExpanded(next ? key : null) }
                  : {})}
                actions={
                  <>
                    {best.kind !== 'local' ? (
                      <MachineMarkPicker machine={entry.machine} name={entry.displayName} />
                    ) : null}
                    {status.action && status.actionLabel ? (
                      <OutlineButton size="xs" aria-label={`${status.actionLabel}, ${entry.displayName}`} onClick={act}>
                        {status.actionLabel}
                      </OutlineButton>
                    ) : null}
                    {ssh ? <SshMachineActions machine={ssh} api={window.api} /> : null}
                    {hostId && (best.kind === 'local' || (host && settingsOf(hostId).enabled)) ? (
                      <AgentClisLink hostId={hostId} label={entry.displayName} onShow={onShowAgentClis} />
                    ) : null}
                  </>
                }
              >
                {details.length > 0 ? <div className="space-y-4">{details}</div> : null}
              </ProviderRow>
            )
          })}
        </SettingCard>
      </section>

      {offDistros.length > 0 ? (
        <section className="space-y-2">
          <SettingsSectionTitle count={offDistros.length}>WSL distributions not turned on</SettingsSectionTitle>
          <p className={MUTED}>
            Turn one on to run chats and terminals in it. A workspace whose folder is inside a distribution runs there
            either way; this only decides what New chat offers.
          </p>
          <SettingCard as="ul" ariaLabel="WSL distributions not turned on">
            {offDistros.map((host) => (
              <ProviderRow
                key={host.id}
                as="li"
                surface="card"
                icon={<MachineRowMark machine={{ kind: 'wsl', hostId: host.id }} />}
                recessed
                name={host.label}
                version={host.isDefaultDistro ? 'default' : null}
                stateLine={executionHostStateWords(host)}
                enabled={false}
                onEnabledChange={(enabled) => write(host.id, { enabled })}
              />
            ))}
          </SettingCard>
        </section>
      ) : listing?.wsl?.available && !(listing.hosts ?? []).some((host) => host.kind === 'wsl') ? (
        <p className={MUTED}>
          No WSL distributions are installed. Install one with <ProviderStateId>wsl --install</ProviderStateId>.
        </p>
      ) : null}

      {sshOn ? (
        <section className="space-y-2">
          <SettingsSectionTitle>Add an SSH machine</SettingsSectionTitle>
          <p className={MUTED}>
            A machine you reach over SSH runs its own Studio server, which Studio installs and starts for you. Your SSH
            config, keys and agent are used as they are; Studio keeps no password or passphrase.
          </p>
          <AddSshMachine api={window.api} />
        </section>
      ) : null}
    </div>
  )
}

/** One way into a machine, and what is set up for it there. */
function RouteDetail({
  route,
  host,
  hostSettings,
  onHostChange,
  ssh,
  onOpenRemoteSettings,
}: {
  route: EnvironmentRoute
  host: ExecutionHostSummary | null
  hostSettings: ExecutionHostSettings | null
  onHostChange: (patch: Partial<ExecutionHostSettings>) => void
  ssh: SshEnvironmentSummary | null
  onOpenRemoteSettings?: () => void
}): React.JSX.Element | null {
  if (route.kind === 'wsl' && host && hostSettings)
    return <MachineDetail host={host} settings={hostSettings} onChange={onHostChange} />
  if (route.kind === 'ssh' && ssh) return <SshMachineDetail machine={ssh} api={window.api} />
  if (route.kind === 'tailnet')
    return (
      <div className="flex items-center gap-3">
        <p className={`${MUTED} min-w-0 flex-1`}>
          Paired over the tailnet. Pairing again and forgetting it are in Remote.
        </p>
        {onOpenRemoteSettings ? (
          <OutlineButton size="xs" onClick={onOpenRemoteSettings}>
            Remote settings
          </OutlineButton>
        ) : null}
      </div>
    )
  return null
}

// How long the environment field waits after the last keystroke before it
// writes: long enough not to send main a patch per character.
const ENV_COMMIT_DELAY_MS = 600

function AgentClisLink({
  hostId,
  label,
  onShow,
}: {
  hostId: ExecutionHostId
  label: string
  onShow?: (id: ExecutionHostId) => void
}): React.JSX.Element | null {
  if (!onShow) return null
  // The visible words lead the accessible name, so a person who says what they
  // see reaches it by voice; the machine follows, so a list of these is not a
  // list of identical buttons.
  return (
    <OutlineButton size="xs" aria-label={`Agent CLIs on this machine, ${label}`} onClick={() => onShow(hostId)}>
      Agent CLIs on this machine
    </OutlineButton>
  )
}

function MachineDetail({
  host,
  settings,
  onChange,
}: {
  host: ExecutionHostSummary
  settings: ExecutionHostSettings
  onChange: (patch: Partial<ExecutionHostSettings>) => void
}): React.JSX.Element {
  // The environment is edited as text and parsed only when it is written, so
  // a half-typed line is never parsed away under the cursor. It is written a
  // moment after typing stops, on blur, and when the panel goes away: closing
  // Settings with Escape unmounts the field without a blur, and the edit used
  // to go with it.
  const [envText, setEnvText] = useState(() => formatEnvLines(settings.env))
  const latest = useRef({ envText, env: settings.env, onChange })
  latest.current = { envText, env: settings.env, onChange }
  const envTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitEnv = useCallback(() => {
    if (envTimer.current !== null) {
      clearTimeout(envTimer.current)
      envTimer.current = null
    }
    const current = latest.current
    const env = parseEnvLines(current.envText)
    // Unchanged is not a write: an unmount after no edit leaves main alone.
    if (formatEnvLines(env) === formatEnvLines(current.env)) return
    current.onChange({ env })
  }, [])
  useEffect(() => commitEnv, [commitEnv])
  return (
    <div className="space-y-4">
      <div className="divide-y divide-[color:var(--border-subtle)]">
        <SettingsRow
          label="Shell"
          help="The shell a plain terminal opens, and the one an agent's tab ends in."
          htmlFor={`machine-shell-${host.id}`}
        >
          <Input
            id={`machine-shell-${host.id}`}
            aria-label={`${host.label} shell`}
            value={settings.shell ?? ''}
            onChange={(event) => onChange({ shell: event.target.value.trim() ? event.target.value : undefined })}
            placeholder="bash -li"
            size="md"
            variant="well"
            fullWidth={false}
            className={ROW_FIELD}
          />
        </SettingsRow>
        <SettingsRow
          label="Environment"
          help="Exported into every terminal and agent on this machine. One NAME=value per line."
          htmlFor={`machine-env-${host.id}`}
          stacked
        >
          <Textarea
            id={`machine-env-${host.id}`}
            aria-label={`${host.label} environment`}
            value={envText}
            onChange={(event) => {
              const text = event.target.value
              latest.current.envText = text
              setEnvText(text)
              if (envTimer.current !== null) clearTimeout(envTimer.current)
              envTimer.current = setTimeout(commitEnv, ENV_COMMIT_DELAY_MS)
            }}
            onBlur={commitEnv}
            placeholder="NAME=value"
            size="md"
            variant="well"
            rows={3}
            className="font-mono"
          />
        </SettingsRow>
        {host.server ? <ServerRow host={host} server={host.server} settings={settings} onChange={onChange} /> : null}
      </div>
    </div>
  )
}

function ServerRow({
  host,
  server,
  settings,
  onChange,
}: {
  host: ExecutionHostSummary
  server: WslServerSummary
  settings: ExecutionHostSettings
  onChange: (patch: Partial<ExecutionHostSettings>) => void
}): React.JSX.Element {
  return (
    <SettingsRow label="Studio server" help={serverWords(server)}>
      <Select
        ariaLabel={`How Windows reaches the Studio server in ${host.label}`}
        items={SERVER_TRANSPORT_ITEMS}
        value={settings.serverTransport ?? 'auto'}
        onChange={(value) => onChange({ serverTransport: value })}
      />
    </SettingsRow>
  )
}
