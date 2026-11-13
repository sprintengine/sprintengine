import { useCallback, useEffect, useState } from 'react'

import type { WebDevicesStatus } from '../../../../shared/web-client'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { relativeFromNow } from '../../utils/relativeTime'
import { webDevicesApi } from '../../studio/webDevices'
import { GhostButton, InlineNotice, Input, OutlineButton, useConfirmDialog } from '../ui'
import { SettingCard, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'

// Settings → Remote, in a web tab: the browsers paired with this server
// (phase 9 spec, 6.2, 14.9). Every paired browser is listed with where it
// paired from and when it was last seen, and is removed here; removing one
// closes its connections at once. A browser asking to pair by approval waits
// here until the owner types the six digits it shows. That is how another
// browser, a phone's included, is paired from a tab: no tab is handed a
// pairing link (a one-time credential), so a stolen session cannot mint one.
// On the machine itself, `studio-server pair` prints one.
//
// Only a server running the web listener answers these; a desktop window
// asks, is refused, and draws nothing.

export function BrowsersSettings() {
  const [status, setStatus] = useState<WebDevicesStatus | null>(null)
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const dialog = useConfirmDialog()

  const refresh = useCallback(async () => {
    try {
      setStatus(await webDevicesApi.webDevicesStatus())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return webDevicesApi.onWebDevicesChanged((next) => setStatus(next))
  }, [refresh])

  // "last seen 2 minutes ago" and "pairing ends in 3 days" move with the
  // clock while the panel stays open, not only when the device list changes.
  // A desktop window draws nothing here, so its clock does not tick.
  const now = useRelativeNow(30_000, status !== null)

  if (!status) return null

  const act = async (work: () => Promise<{ ok: boolean; message?: string } | boolean>) => {
    setError(null)
    try {
      const result = await work()
      if (typeof result === 'object' && !result.ok) setError(result.message ?? 'That did not work.')
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const revoke = async (id: string, name: string, current: boolean) => {
    const confirmed = await dialog.confirm({
      title: current ? 'Remove this browser?' : `Remove ${name}?`,
      body: current
        ? 'This browser leaves Studio now, and has to be paired again to come back.'
        : 'It is disconnected now, and has to be paired again to come back.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (confirmed) await act(() => webDevicesApi.webDevicesRevoke(id))
  }

  return (
    <section aria-labelledby="browsers-settings-title" className="space-y-3">
      <SettingsSectionTitle id="browsers-settings-title" count={status.devices.length}>
        Browsers
      </SettingsSectionTitle>
      {error ? <InlineNotice tone="error" title={error} /> : null}

      {status.requests.length > 0 ? (
        <SettingCard>
          {status.requests.map((request) => (
            <SettingsRow
              key={request.requestId}
              label={`${request.name} asks to pair`}
              help={[
                request.route === 'tailnet' ? 'Over the tailnet' : 'On this machine',
                'type the six digits it shows',
              ].join(' · ')}
            >
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void act(() => webDevicesApi.webDevicesApprove(request.requestId, codes[request.requestId] ?? ''))
                }}
              >
                <Input
                  aria-label={`The code ${request.name} shows`}
                  inputMode="numeric"
                  autoComplete="off"
                  size="sm"
                  fullWidth={false}
                  className="w-28"
                  value={codes[request.requestId] ?? ''}
                  onChange={(event) =>
                    setCodes((current) => ({
                      ...current,
                      [request.requestId]: event.target.value.replace(/[^0-9]/gu, '').slice(0, 6),
                    }))
                  }
                />
                <OutlineButton type="submit" disabled={(codes[request.requestId] ?? '').length !== 6}>
                  Let in
                </OutlineButton>
                <GhostButton onClick={() => void act(() => webDevicesApi.webDevicesDecline(request.requestId))}>
                  Decline
                </GhostButton>
              </form>
            </SettingsRow>
          ))}
        </SettingCard>
      ) : null}

      <SettingCard>
        {status.devices.map((device) => (
          <SettingsRow
            key={device.id}
            label={device.current ? `${device.name} (this browser)` : device.name}
            help={[
              device.route === 'tailnet' ? 'Over the tailnet' : 'On this machine',
              device.lastSeenAt ? `last seen ${relativeFromNow(Date.parse(device.lastSeenAt), now)}` : null,
              `pairing ends ${relativeFromNow(Date.parse(device.expiresAt), now)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <GhostButton tone="danger" onClick={() => void revoke(device.id, device.name, device.current)}>
              Remove
            </GhostButton>
          </SettingsRow>
        ))}
      </SettingCard>

      <SettingCard>
        <SettingsRow
          label="Pair another browser"
          help={`Open ${status.origins[0] ?? 'this server'} in it and ask to pair; it shows six digits to type here. Or run studio-server pair on this machine.`}
        >
          {null}
        </SettingsRow>
      </SettingCard>
    </section>
  )
}
