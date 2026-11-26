import React, { useCallback, useEffect, useState } from 'react'
import type { AppUpdateCheckResult, AppUpdateTrack } from '../../../../shared/electron-api'
import { SegmentedControl } from '../ui'
import { SettingsRow } from './SettingsAtoms'
import { copy } from '../../../../shared/copy'

// One sentence per channel, shown for the selected one. Main owns the choice
// (it configures the updater before any window exists), so this row reads it
// from main and writes it back there rather than into appSettings.
const UPDATE_CHANNEL_HELP: Record<AppUpdateTrack, string> = {
  stable: 'Stable gets a release once it has already run as a nightly, so it changes less often.',
  // Moving to stable from a newer nightly installs an older build
  // (`applyUpdaterChannel`). A build from before a change to the data folder
  // runs on what that change left behind (docs/data-folder.md), and what it
  // writes is not read when the newer build returns.
  nightly:
    'Nightly gets the newest changes from main a few times a day, before they reach stable. Switching back to stable can install an older build: it runs on your chats and settings as they were when this one upgraded them, and what you change there is not kept when you update again.',
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
      helpId={HELP_ID}
    >
      <SegmentedControl<AppUpdateTrack>
        ariaLabel={copy.settings.updateChannelSettings.updateChannel}
        ariaDescribedBy={HELP_ID}
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
