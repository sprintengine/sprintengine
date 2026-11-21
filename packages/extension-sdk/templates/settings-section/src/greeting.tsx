import { useCallback, useEffect, useSyncExternalStore, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

// A section in Settings, declared in extension.json
// (`contributes.settingsSections`). What it saves is the extension's app
// state, so the rest of the extension reads it with `getModuleAppState`, and
// a worker with the same call. The declared command "Open settings" runs
// Studio's own `app.settings.open`, with no code here at all.

type Tone = 'plain' | 'warm'

export type GreetingValues = { name?: unknown; tone?: unknown }

const asTone = (value: unknown): Tone => (value === 'warm' ? 'warm' : 'plain')

export function greetingFrom(values: GreetingValues): string {
  const name = typeof values.name === 'string' && values.name.trim() ? values.name.trim() : 'there'
  return asTone(values.tone) === 'warm' ? `Good to see you, ${name}!` : `Hello, ${name}.`
}

const text: CSSProperties = {
  fontFamily: 'var(--sem-font-family-ui)',
  fontSize: 'var(--sem-font-size-body)',
  color: 'var(--sem-color-text-default)',
}
const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--sem-space-xs)' }
const input: CSSProperties = {
  ...text,
  padding: 'var(--sem-space-xs) var(--sem-space-sm)',
  border: '1px solid var(--sem-color-border-default)',
  borderRadius: 'var(--sem-radius-control)',
  background: 'var(--sem-color-bg-surface-raised)',
}

export function GreetingSettings({ studio }: { studio: ExtensionMountStudio }) {
  const subscribe = useCallback((onChange: () => void) => studio.watchModuleAppState(() => onChange()), [studio])
  const readName = useCallback(() => studio.getModuleAppState<string>('name') ?? '', [studio])
  const readTone = useCallback(() => asTone(studio.getModuleAppState('tone')), [studio])
  const name = useSyncExternalStore(subscribe, readName, readName)
  const tone = useSyncExternalStore(subscribe, readTone, readTone)

  useEffect(() => studio.ready(), [studio])

  return (
    <div style={{ ...text, display: 'flex', flexDirection: 'column', gap: 'var(--sem-space-md)' }}>
      <label style={field}>
        Your name
        <input
          style={input}
          value={name}
          onChange={(event) => studio.setModuleAppState('name', event.target.value || undefined)}
        />
      </label>
      <fieldset style={{ ...field, border: 'none', margin: 0, padding: 0 }}>
        <legend>Tone</legend>
        {(['plain', 'warm'] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="ext-{{id}}-tone"
              checked={tone === value}
              onChange={() => studio.setModuleAppState('tone', value)}
            />{' '}
            {value === 'plain' ? 'Plain' : 'Warm'}
          </label>
        ))}
      </fieldset>
      <p style={{ margin: 0, color: 'var(--sem-color-text-muted)' }}>Preview: {greetingFrom({ name, tone })}</p>
    </div>
  )
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<GreetingSettings studio={studio} />)
  return () => view.unmount()
}
