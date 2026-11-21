import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

// The door the top bar button opens. extension.json declares both: the button
// (`contributes.topBarItems`, with `door: "timer"`) and the door
// (`contributes.doors`). Studio draws the button with the declared icon and
// title; this file draws the door, in a frame of its own.

const ENDS_AT_KEY = 'focusEndsAt'
export const FOCUS_MINUTES = 25

export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// The end time is one of the extension's Settings values, which Studio keeps
// (`settings.set`, permission `settings:own`), so a running timer survives a
// restart.
export function FocusTimer({ studio, initialEndsAt }: { studio: ExtensionMountStudio; initialEndsAt: number | null }) {
  const [endsAt, setEndsAt] = useState<number | null>(initialEndsAt)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => studio.ready(), [studio])
  useEffect(() => {
    if (endsAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [endsAt])

  const remaining = endsAt === null ? null : endsAt - now
  const done = remaining !== null && remaining <= 0
  const toggle = () => {
    const next = endsAt === null ? Date.now() + FOCUS_MINUTES * 60_000 : null
    setNow(Date.now())
    setEndsAt(next)
    void studio.host.call('settings.set', { key: ENDS_AT_KEY, value: next })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        height: '100%',
      }}
    >
      <p style={{ margin: 0, fontSize: 48, fontVariantNumeric: 'tabular-nums' }} aria-live="polite">
        {endsAt === null
          ? formatRemaining(FOCUS_MINUTES * 60_000)
          : done
            ? 'Time is up'
            : formatRemaining(remaining ?? 0)}
      </p>
      <button type="button" className="se-button se-button--primary" onClick={toggle}>
        {endsAt === null ? `Start ${FOCUS_MINUTES} minutes of focus` : done ? 'Clear the timer' : 'Stop the timer'}
      </button>
    </div>
  )
}

export const mount: ExtensionMount = async (root, studio) => {
  const saved = (await studio.host.call('settings.get', {}))[ENDS_AT_KEY]
  const view = createRoot(root)
  view.render(<FocusTimer studio={studio} initialEndsAt={typeof saved === 'number' ? saved : null} />)
  return () => view.unmount()
}
