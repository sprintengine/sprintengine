import { useEffect, useState } from 'react'

import { Select, type SelectItem } from '../ui'
import { SettingsRow } from './SettingsAtoms'
import { copy } from '../../../../shared/copy'

// Settings → Agents → Built-in browser: after how long a tab nobody uses, in a
// chat whose agent has not worked for as long, is closed. Main owns the value
// and closes the tabs (browser-tab-auto-close.ts); a client with no main of its
// own (a browser tab) shows nothing. Programs agents started are never closed
// this way; they are stopped by hand from Processes.

const CHOICES: readonly (number | null)[] = [4, 24, 72, 168, null]
const NEVER = 'never'

const valueOf = (hours: number | null): string => (hours === null ? NEVER : String(hours))

export function BrowserTabAutoCloseSetting() {
  const read = typeof window === 'undefined' ? undefined : window.api?.getBrowserTabAutoClose
  const write = typeof window === 'undefined' ? undefined : window.api?.setBrowserTabAutoClose
  const [hours, setHours] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    if (typeof read !== 'function') return
    let cancelled = false
    void read()
      .then((next) => {
        if (!cancelled) setHours(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [read])
  if (hours === undefined || typeof write !== 'function') return null
  const words = copy.settings.agentBrowserSettings
  const items: SelectItem[] = CHOICES.map((choice) => ({
    value: valueOf(choice),
    label: choice === null ? words.never : words.afterHours(choice),
  }))
  return (
    <SettingsRow label={words.closeUnusedTabs} help={words.closeUnusedTabsHelp}>
      <Select
        ariaLabel={words.closeUnusedTabsAfter}
        items={items}
        value={valueOf(hours)}
        onChange={(value) => {
          const next = value === NEVER ? null : Number(value)
          setHours(next)
          void write(next)
            .then((held) => setHours(held))
            .catch(() => setHours(hours))
        }}
      />
    </SettingsRow>
  )
}
