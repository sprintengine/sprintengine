import React, { useCallback, useEffect, useState } from 'react'
import type { AppUpdateCheckResult, AppUpdateTrack } from '../../../../shared/electron-api'
import { SegmentedControl } from '../ui'
import { SettingsRow } from './SettingsAtoms'
import { copy } from '../../../../shared/copy'

// The one warning a channel carries, shown while it is selected: moving to
// stable from a newer nightly installs an older build (`applyUpdaterChannel`).
// A build from before a change to the data folder runs on what that change
// left behind (docs/data-folder.md), and what it writes is not read when the
// newer build returns. Stable needs no sentence. Main owns the choice (it
// configures the updater before any window exists), so this row reads it from
// main and writes it back there rather than into appSettings.
const UPDATE_CHANNEL_HELP: Record<AppUpdateTrack, string | undefined> = {
  stable: undefined,
  nightly: copy.settings.updateChannelSettings.switchingBackToStable,
}

const HELP_ID = 'settings-update-channel-help'

export function UpdateChannelSettings({ onResult }: { onResult: (result: AppUpdateCheckResult) => void }) {
  const [channel, setChannel] = useState<AppUpdateTrack | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api
      .updateGetChannel()
      .then((setting) => {
        if (!cancelled) setChannel(setting.channel)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const choose = useCallback(
    async (next: AppUpdateTrack) => {
      if (next === channel || pending) return
      const previous = channel
      setChannel(next)
      setPending(true)
      try {
        onResult(await window.api.updateSetChannel(next))
      } catch {
        setChannel(previous)
      } finally {
        setPending(false)
      }
    },
    [channel, onResult, pending],
  )

  if (!channel) return null
  return (
    <SettingsRow
      label={copy.settings.updateChannelSettings.updateChannel}
      help={UPDATE_CHANNEL_HELP[channel]}
      helpId={UPDATE_CHANNEL_HELP[channel] ? HELP_ID : undefined}
    >
      <SegmentedControl<AppUpdateTrack>
        ariaLabel={copy.settings.updateChannelSettings.updateChannel}
        ariaDescribedBy={UPDATE_CHANNEL_HELP[channel] ? HELP_ID : undefined}
        items={[
          { value: 'stable', label: copy.settings.updateChannelSettings.stable, disabled: pending },
          { value: 'nightly', label: copy.settings.updateChannelSettings.nightly, disabled: pending },
        ]}
        value={channel}
        onChange={(next) => void choose(next)}
      />
    </SettingsRow>
  )
}
