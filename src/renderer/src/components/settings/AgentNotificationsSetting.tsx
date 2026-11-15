import { useEffect, useState } from 'react'

import type { AgentNotificationMode } from '../../../../shared/agent-notifications'
import { SegmentedControl } from '../ui'
import { SettingsRow } from './SettingsAtoms'
import { copy } from '../../../../shared/copy'

// Settings → General: the OS banner a chat raises when it finishes or waits on
// the person while they are in another app. Main owns the value and raises
// the banners (agent-notifications.ts), so it is read from main when the page
// opens and every write answers with what main now holds. A client with no
// banners of its own (a browser tab) shows nothing.

const ITEMS: Array<{ value: AgentNotificationMode; label: string }> = [
  { value: 'off', label: copy.settings.agentNotificationsSetting.off },
  { value: 'banner', label: copy.settings.agentNotificationsSetting.banner },
  { value: 'banner-sound', label: copy.settings.agentNotificationsSetting.bannerAndSound },
]

export function AgentNotificationsSetting() {
  const [mode, setMode] = useState<AgentNotificationMode | null>(null)
  useEffect(() => {
    if (typeof window.api?.getAgentNotifications !== 'function') return
    let cancelled = false
    void window.api
      .getAgentNotifications()
      .then((next) => {
        if (!cancelled) setMode(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  if (mode === null) return null
  return (
    <SettingsRow
      label={copy.settings.agentNotificationsSetting.notifyWhenAChatFinishes}
      help="While you are in another app. Click the notification to open the chat."
    >
      <SegmentedControl<AgentNotificationMode>
        ariaLabel={copy.settings.agentNotificationsSetting.notifyWhenAChatFinishes}
        items={ITEMS}
        value={mode}
        onChange={(next) => {
          const previous = mode
          setMode(next)
          void window.api
            .setAgentNotifications(next)
            .then((held) => {
              if (held !== null) setMode(held)
            })
            .catch(() => setMode(previous))
        }}
      />
    </SettingsRow>
  )
}
