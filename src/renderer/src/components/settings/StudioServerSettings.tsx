import { useEffect, useState } from 'react'

import type { SshPreviewStatus } from '../../../../shared/ssh-preview'
import type { StudioServerInfo, StudioServerStatus } from '../../../../shared/studio-server-status'
import { useStudioServerStatus } from '../studioServer/useStudioServerStatus'
import { uptimeWords } from '../studioServer/studioServerWords'
import { GhostButton, InlineNotice, Switch } from '../ui'
import { SettingCard, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'
import { copy } from '../../../../shared/copy'

// Settings → Agents → Studio server: what the server, in its own process, is
// doing in words, with the actions a person takes on it.

const SSH_TOGGLE_ID = 'settings-ssh-machines-preview'
const SSH_TOGGLE_HELP_ID = 'settings-ssh-machines-preview-help'

/**
 * SSH machines (phase 8), a preview until it is complete: off by default.
 * Read once at launch.
 */
export function SshMachinesPreviewSwitch() {
  const [status, setStatus] = useState<SshPreviewStatus | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (typeof window.api?.sshPreviewStatus !== 'function') return
    let cancelled = false
    void window.api
      .sshPreviewStatus()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  if (!status) return null
  const restartNeeded = status.saved !== status.enabled && !status.fromEnvironment
  return (
    <>
      <SettingsRow
        label={copy.settings.studioServerSettings.sSHMachinesPreview}
        helpId={SSH_TOGGLE_HELP_ID}
        help={
          status.fromEnvironment
            ? 'Set for this launch by SPRINTENGINE_SSH_MACHINES.'
            : 'Run chats on machines you reach over SSH, from Settings › Machines. Still being built: some views do not work for them yet. Takes effect after a restart.'
        }
      >
        <Switch
          id={SSH_TOGGLE_ID}
          checked={status.saved}
          onChange={(next) => {
            if (pending) return
            setPending(true)
            void window.api
              .sshPreviewSet(next)
              .then(setStatus)
              .finally(() => setPending(false))
          }}
          disabled={pending || status.fromEnvironment}
          ariaLabel={copy.settings.studioServerSettings.sSHMachinesPreview}
          ariaDescribedBy={SSH_TOGGLE_HELP_ID}
        />
      </SettingsRow>
      {restartNeeded ? (
        <InlineNotice
          tone="warn"
          action={
            <GhostButton onClick={() => void window.api.restartApp?.()}>
              {copy.settings.studioServerSettings.restartNow}
            </GhostButton>
          }
        >
          {status.saved ? 'SSH machines appear after a restart.' : 'SSH machines go away after a restart.'}
        </InlineNotice>
      ) : null}
    </>
  )
}

const PHASE_WORDS: Record<StudioServerStatus['phase'], string> = {
  starting: 'Starting',
  running: 'Running',
  reconnecting: 'Reconnecting',
  stopped: 'Stopped',
  stopping: 'Stopping',
}

export function StudioServerSettings() {
  const [status] = useStudioServerStatus()
  const [info, setInfo] = useState<StudioServerInfo | null>(null)

  const running = status?.phase === 'running'
  useEffect(() => {
    if (!running) {
      setInfo(null)
      return
    }
    let cancelled = false
    void window.api
      .studioServerInfo()
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [running, status?.pid])

  if (!status) return null
  return (
    <section className="space-y-3 pt-2">
      <SettingsSectionTitle>{copy.settings.studioServerSettings.studioServer}</SettingsSectionTitle>
      <SettingCard>
        <SettingsRow
          label={PHASE_WORDS[status.phase]}
          help={
            info
              ? `Process ${info.pid}, up ${uptimeWords(info.uptimeMs)}, ${info.rssMb} MB` +
                (status.restarts > 0 ? `, restarted ${status.restarts} time${status.restarts === 1 ? '' : 's'}` : '')
              : status.reason
          }
        >
          <span className="flex items-center gap-2">
            <GhostButton onClick={() => void window.api.studioServerOpenLog()}>
              {copy.settings.studioServerSettings.openLog}
            </GhostButton>
            <GhostButton onClick={() => void window.api.studioServerRestart()} disabled={!running}>
              {copy.settings.studioServerSettings.restartServer}
            </GhostButton>
          </span>
        </SettingsRow>
        <SshMachinesPreviewSwitch />
      </SettingCard>
    </section>
  )
}
