import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

// The door the top bar button opens. extension.json declares both: the button
// (`contributes.topBarItems`, with `door: "timer"`) and the door
// (`contributes.doors`). Studio draws the button with the declared icon and
// title; this file draws the door.

const ENDS_AT_KEY = 'focusEndsAt'
export const FOCUS_MINUTES = 25

export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const button: CSSProperties = {
  padding: 'var(--sem-space-sm) var(--sem-space-lg)',
  border: 'none',
  borderRadius: 'var(--sem-radius-control)',
  background: 'var(--sem-color-accent-primary)',
  color: 'var(--sem-color-text-on-accent)',
  font: 'inherit',
  cursor: 'pointer',
}

// The end time lives in the extension's app state, so a running timer
// survives a restart and shows the same time in every window.
export function FocusTimer({ studio }: { studio: ExtensionMountStudio }) {
  const subscribe = useCallback((onChange: () => void) => studio.watchModuleAppState(() => onChange()), [studio])
  const readEndsAt = useCallback(() => studio.getModuleAppState<number>(ENDS_AT_KEY) ?? null, [studio])
  // The third argument is what a server render (the tests') reads.
  const endsAt = useSyncExternalStore(subscribe, readEndsAt, readEndsAt)
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
    setNow(Date.now())
    studio.setModuleAppState(ENDS_AT_KEY, endsAt === null ? Date.now() + FOCUS_MINUTES * 60_000 : undefined)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--sem-space-lg)',
        height: '100%',
        background: 'var(--sem-color-bg-surface)',
        color: 'var(--sem-color-text-default)',
        fontFamily: 'var(--sem-font-family-ui)',
        fontSize: 'var(--sem-font-size-body)',
      }}
    >
      <p style={{ margin: 0, fontSize: 48, fontVariantNumeric: 'tabular-nums' }} aria-live="polite">
        {endsAt === null
          ? formatRemaining(FOCUS_MINUTES * 60_000)
          : done
            ? 'Time is up'
            : formatRemaining(remaining ?? 0)}
      </p>
      <button type="button" style={button} onClick={toggle}>
        {endsAt === null ? `Start ${FOCUS_MINUTES} minutes of focus` : done ? 'Clear the timer' : 'Stop the timer'}
      </button>
    </div>
  )
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<FocusTimer studio={studio} />)
  return () => view.unmount()
}
