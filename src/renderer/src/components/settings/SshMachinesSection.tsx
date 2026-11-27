import React, { useCallback, useEffect, useId, useState } from 'react'

import type {
  SshEnvironmentSettings,
  SshEnvironmentSummary,
  SshPaneTraffic,
  SshResolveResult,
} from '../../../../shared/ssh-environments'
import {
  ChipButton,
  GhostButton,
  InlineNotice,
  Input,
  OutlineButton,
  ProviderStateId,
  Select,
  useConfirmDialog,
} from '../ui'
import { deleteContainer, type ContainerApi } from './ContainerMachinesSection'
import { MachineGhRow } from './MachineGhRow'
import { SettingCard, SettingsRow, SettingToggle } from './SettingsAtoms'
import { isImeKey } from '../../utils/imeKey'
import { copy } from '../../../../shared/copy'

// An SSH machine's parts of Settings › Machines (phase 8): its row's own
// actions, its detail, and the field that adds one. The row itself is the
// machine list's (`MachinesSettingsTab`), as every machine's is. One field adds
// a machine: an alias from the SSH config or `user@host:port`, checked with
// `ssh -G` and shown resolved before anything connects.

type Api = Pick<
  Window['api'],
  | 'sshEnvironmentsList'
  | 'sshEnvironmentResolve'
  | 'sshEnvironmentSuggestions'
  | 'sshEnvironmentAdd'
  | 'sshEnvironmentUpdate'
  | 'sshEnvironmentConnect'
  | 'sshEnvironmentDisconnect'
  | 'sshEnvironmentStopServer'
  | 'sshEnvironmentUpgradeServer'
  | 'sshEnvironmentForget'
  | 'sshEnvironmentDiagnostics'
  | 'onSshEnvironmentsChanged'
>

const PANE_TRAFFIC_ITEMS: Array<{ value: SshPaneTraffic; label: string }> = [
  { value: 'all', label: copy.settings.sshMachinesSection.everythingThroughTheMachine },
  { value: 'loopback', label: copy.settings.sshMachinesSection.onlyItsLocalhost },
  { value: 'off', label: copy.settings.sshMachinesSection.nothingTabsUseThisComputer },
]

const ROW_FIELD = 'w-60 max-w-full font-mono'
const MUTED = 'text-body leading-5 text-[color:var(--text-muted)]'

/** The machine list, kept current from main's pushes. */
export function useSshMachines(api: Api | null = window.api): {
  machines: SshEnvironmentSummary[]
  reload: () => Promise<void>
} {
  const [machines, setMachines] = useState<SshEnvironmentSummary[]>([])
  const reload = useCallback(async () => {
    if (typeof api?.sshEnvironmentsList !== 'function') return
    const listed = await api.sshEnvironmentsList().catch(() => [])
    setMachines(Array.isArray(listed) ? listed : [])
  }, [api])
  useEffect(() => {
    void reload()
    const off =
      typeof api?.onSshEnvironmentsChanged === 'function' ? api.onSshEnvironmentsChanged(() => void reload()) : null
    return typeof off === 'function' ? off : undefined
  }, [api, reload])
  return { machines, reload }
}

/**
 * What only an SSH machine offers on its row: Disconnect while connected, and
 * Update for a server this app may replace, Retry update for one whose
 * update did not start. Connect and Retry are the
 * machine list's own action, the same for every machine.
 */
export function SshMachineActions({
  machine,
  api,
}: {
  machine: SshEnvironmentSummary
  api: Api
}): React.JSX.Element | null {
  const { confirm: confirmDialog } = useConfirmDialog()
  if (machine.state === 'connected')
    return (
      <OutlineButton
        size="xs"
        aria-label={copy.settings.sshMachinesSection.disconnect(machine.label)}
        onClick={() => void api.sshEnvironmentDisconnect(machine.id)}
      >
        {copy.settings.sshMachinesSection.disconnect2}
      </OutlineButton>
    )
  // This app's own update of its server did not start (the row says why):
  // trying it again is the person's call, and needs no warning about others.
  if (machine.action === 'retry-update')
    return (
      <OutlineButton
        size="xs"
        aria-label={copy.settings.sshMachinesSection.retryTheUpdate(machine.label)}
        onClick={() => void api.sshEnvironmentUpgradeServer(machine.id)}
      >
        {copy.settings.sshMachinesSection.retryUpdate}
      </OutlineButton>
    )
  if (machine.action === 'upgrade')
    return (
      <OutlineButton
        size="xs"
        aria-label={copy.settings.sshMachinesSection.updateTheStudioServer(machine.label)}
        onClick={() =>
          void confirmDialog({
            title: copy.settings.sshMachinesSection.updateTheStudioServerOn(machine.label),
            body: copy.settings.sshMachinesSection.itWasStartedOutsideThis,
            confirmLabel: copy.settings.sshMachinesSection.updateIt,
          }).then((yes) => (yes ? api.sshEnvironmentUpgradeServer(machine.id) : undefined))
        }
      >
        {copy.settings.sshMachinesSection.update}
      </OutlineButton>
    )
  return null
}

export function SshMachineDetail({
  machine,
  machines,
  api,
}: {
  machine: SshEnvironmentSummary
  /** Every saved machine: the containers on this one are deleted, each as a container is, before it is forgotten. */
  machines: readonly SshEnvironmentSummary[]
  api: Api & ContainerApi
}): React.JSX.Element {
  const { confirm: confirmDialog } = useConfirmDialog()
  const installId = useId()
  const [installDir, setInstallDir] = useState(machine.settings.installDir ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<string | null>(null)
  const write = (patch: Partial<SshEnvironmentSettings>) =>
    void api.sshEnvironmentUpdate(machine.id, patch).then((result) => setProblem(result.ok ? null : result.message))
  const resolved = machine.resolved
  return (
    <div className="space-y-4">
      {machine.notes.map((note) => (
        <p key={note} className={MUTED}>
          {note}
        </p>
      ))}
      {problem ? <InlineNotice tone="warn" title={problem} /> : null}
      {/* The machine's GitHub CLI, as its last connect found it: its chats
          open pull requests with it. Asked again on the next connect. */}
      {machine.gh ? (
        <SettingCard>
          <MachineGhRow
            as="div"
            status={machine.gh}
            machine={{ kind: 'ssh', os: machine.gh.os }}
            machineLabel={machine.label}
          />
        </SettingCard>
      ) : null}
      <div className="divide-y divide-[color:var(--border-subtle)]">
        <SettingsRow label={copy.settings.sshMachinesSection.reachedAs}>
          <span className="font-mono text-body text-[color:var(--text-default)]">
            {resolved
              ? `${resolved.user}@${resolved.hostname}:${resolved.port}${resolved.proxyJump ? ` via ${resolved.proxyJump}` : ''}`
              : machine.destination}
          </span>
        </SettingsRow>
        {machine.server ? (
          <SettingsRow label={copy.settings.sshMachinesSection.studioServer}>
            <span className="font-mono text-body text-[color:var(--text-default)]">{machine.server.version}</span>
          </SettingsRow>
        ) : null}
        <SettingToggle
          label={copy.settings.sshMachinesSection.keepTheServerRunning}
          enabled={machine.settings.keepRunning}
          onChange={(keepRunning) => write({ keepRunning })}
        />
        <SettingsRow label={copy.settings.sshMachinesSection.browserTabsNetwork}>
          <Select
            ariaLabel={copy.settings.sshMachinesSection.browserTabTrafficThrough(machine.label)}
            items={PANE_TRAFFIC_ITEMS}
            value={machine.settings.paneTraffic}
            onChange={(paneTraffic) => write({ paneTraffic })}
          />
        </SettingsRow>
        <SettingToggle
          label={copy.settings.sshMachinesSection.downloadNodeJsOnThe}
          enabled={machine.settings.remoteDownload}
          onChange={(remoteDownload) => write({ remoteDownload })}
        />
        <SettingsRow
          label={copy.settings.sshMachinesSection.installDirectory}
          help={copy.settings.sshMachinesSection.setThisOnlyWhenNoexec}
          htmlFor={installId}
        >
          <Input
            id={installId}
            value={installDir}
            onChange={(event) => setInstallDir(event.target.value)}
            onBlur={() => write({ installDir: installDir.trim() || null })}
            placeholder={copy.settings.sshMachinesSection.localShareSprintengineStudio}
            size="md"
            variant="well"
            fullWidth={false}
            className={ROW_FIELD}
          />
        </SettingsRow>
      </div>
      <div className="flex flex-wrap gap-2">
        {machine.server?.origin === 'bootstrap' ? (
          <GhostButton
            size="sm"
            onClick={() =>
              void confirmDialog({
                title: copy.settings.sshMachinesSection.stopTheStudioServerOn(machine.label),
                body: copy.settings.sshMachinesSection.runningChatsGetAMinute,
                confirmLabel: copy.settings.sshMachinesSection.stopIt,
                tone: 'danger',
              }).then((yes) => (yes ? api.sshEnvironmentStopServer(machine.id) : undefined))
            }
          >
            {copy.settings.sshMachinesSection.stopServerOn}
            {machine.label}
          </GhostButton>
        ) : null}
        <GhostButton
          size="sm"
          onClick={() =>
            void api
              .sshEnvironmentDiagnostics(machine.id)
              .then((result) => setDiagnostics(result.ok ? result.text : result.message))
          }
        >
          {copy.settings.sshMachinesSection.diagnostics}
        </GhostButton>
        <GhostButton
          size="sm"
          onClick={() =>
            void confirmDialog({
              title: copy.settings.sshMachinesSection.forget(machine.label),
              body: copy.settings.sshMachinesSection.itsChatsStayOnThe,
              confirmLabel: copy.settings.sshMachinesSection.forget2,
              tone: 'danger',
            }).then(async (yes) => {
              if (!yes) return
              const forgotten = await api.sshEnvironmentForget(machine.id)
              if (forgotten.ok || !forgotten.containers?.length) {
                if (!forgotten.ok) setDiagnostics(forgotten.message)
                return
              }
              // Containers Studio made there would be stranded: each is deleted first, as a
              // container is (what exists only in it said before it goes), or, the machine
              // being gone, only their records are dropped, as the person says.
              const remove = await confirmDialog({
                title: copy.settings.sshMachinesSection.deleteTheContainersOnFirst(machine.label),
                body: copy.settings.sshMachinesSection.eachIsShownWithWhat(forgotten.message),
                confirmLabel: copy.settings.sshMachinesSection.deleteThemThenForget,
                tone: 'danger',
              })
              if (remove) {
                for (const id of forgotten.containers) {
                  const hosted = machines.find((each) => each.id === id)
                  if (!hosted) continue
                  const outcome = await deleteContainer(hosted, api, confirmDialog)
                  if (!outcome.deleted) {
                    if (outcome.message) setDiagnostics(outcome.message)
                    return
                  }
                }
                const after = await api.sshEnvironmentForget(machine.id)
                if (!after.ok) setDiagnostics(after.message)
                return
              }
              const recordsOnly = await confirmDialog({
                title: copy.settings.sshMachinesSection.forgetSContainerRecordsOnly(machine.label),
                body: copy.settings.sshMachinesSection.theContainersStayOnUntracked(machine.label),
                confirmLabel: copy.settings.sshMachinesSection.forgetTheRecords,
                tone: 'danger',
              })
              if (recordsOnly) {
                const dropped = await api.sshEnvironmentForget(machine.id, { containers: 'forget-records' })
                if (!dropped.ok) setDiagnostics(dropped.message)
              }
            })
          }
        >
          {copy.settings.sshMachinesSection.forget2}
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

export function AddSshMachine({ api }: { api: Api }): React.JSX.Element {
  const fieldId = useId()
  const [text, setText] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [checked, setChecked] = useState<SshResolveResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (typeof api.sshEnvironmentSuggestions !== 'function') return
    void Promise.resolve(api.sshEnvironmentSuggestions())
      .then((names) => setSuggestions(Array.isArray(names) ? names : []))
      .catch(() => undefined)
  }, [api])
  const check = async (value: string) => {
    setError(null)
    setBusy(true)
    try {
      setChecked(await api.sshEnvironmentResolve(value))
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    setBusy(true)
    try {
      const result = await api.sshEnvironmentAdd({ destination: text })
      if (!result.ok) setError(result.message)
      else {
        setText('')
        setChecked(null)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <SettingsRow label={copy.settings.sshMachinesSection.addSSHMachine} htmlFor={fieldId}>
        <span className="flex items-center gap-2">
          <Input
            id={fieldId}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setChecked(null)
            }}
            onKeyDown={(event) => {
              if (isImeKey(event)) return
              if (event.key === 'Enter' && text.trim()) void check(text)
            }}
            placeholder={copy.settings.sshMachinesSection.aliasOrUserHostPort}
            size="md"
            variant="well"
            fullWidth={false}
            className={ROW_FIELD}
          />
          <OutlineButton size="sm" disabled={busy || !text.trim()} onClick={() => void check(text)}>
            {copy.settings.sshMachinesSection.check}
          </OutlineButton>
        </span>
      </SettingsRow>
      {suggestions.length > 0 && !text ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className={MUTED}>{copy.settings.sshMachinesSection.fromYourSSHConfig}</span>
          {suggestions.slice(0, 12).map((name) => (
            <ChipButton
              key={name}
              onClick={() => {
                setText(name)
                void check(name)
              }}
            >
              {name}
            </ChipButton>
          ))}
        </div>
      ) : null}
      {checked && !checked.ok ? <InlineNotice tone="warn" title={checked.message} /> : null}
      {checked?.ok ? (
        <div className="space-y-2">
          <p className={MUTED}>
            {copy.settings.sshMachinesSection.studioWillConnectTo}{' '}
            <ProviderStateId>
              {checked.resolved.user}@{checked.resolved.hostname}:{checked.resolved.port}
            </ProviderStateId>
            {checked.resolved.proxyJump ? (
              <>
                {' '}
                through <ProviderStateId>{checked.resolved.proxyJump}</ProviderStateId>
              </>
            ) : null}
            {copy.settings.sshMachinesSection.sSHWillShowItsFingerprint}
          </p>
          {checked.resolved.notes.map((note) => (
            <p key={note} className={MUTED}>
              {note}
            </p>
          ))}
          <OutlineButton size="sm" disabled={busy} onClick={() => void add()}>
            {copy.settings.sshMachinesSection.add}
            {checked.destination}
          </OutlineButton>
        </div>
      ) : null}
      {error ? <InlineNotice tone="warn" title={error} /> : null}
    </div>
  )
}
