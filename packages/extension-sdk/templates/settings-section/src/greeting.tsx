import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

// A section in Settings, declared in extension.json
// (`contributes.settingsSections`), drawn in a frame of its own. What it saves
// Studio keeps as the extension's Settings values (`settings.set`, permission
// `settings:own`), and a worker reads them with `getModuleAppState`. The
// declared command "Open settings" runs Studio's own `app.settings.open`,
// with no code here at all.

type Tone = 'plain' | 'warm'

export type GreetingValues = { name?: unknown; tone?: unknown }

const asTone = (value: unknown): Tone => (value === 'warm' ? 'warm' : 'plain')

export function greetingFrom(values: GreetingValues): string {
  const name = typeof values.name === 'string' && values.name.trim() ? values.name.trim() : 'there'
  return asTone(values.tone) === 'warm' ? `Good to see you, ${name}!` : `Hello, ${name}.`
}

export function GreetingSettings({ studio, initial }: { studio: ExtensionMountStudio; initial: GreetingValues }) {
  const [name, setName] = useState(typeof initial.name === 'string' ? initial.name : '')
  const [tone, setTone] = useState<Tone>(asTone(initial.tone))
  const save = (key: 'name' | 'tone', value: string) =>
    void studio.host.call('settings.set', { key, value: value || null })

  useEffect(() => studio.ready(), [studio])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Your name
        <input
          className="se-input"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            save('name', event.target.value)
          }}
        />
      </label>
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend>Tone</legend>
        {(['plain', 'warm'] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="tone"
              checked={tone === value}
              onChange={() => {
                setTone(value)
                save('tone', value)
              }}
            />{' '}
            {value === 'plain' ? 'Plain' : 'Warm'}
          </label>
        ))}
      </fieldset>
      <p className="se-muted" style={{ margin: 0 }}>
        Preview: {greetingFrom({ name, tone })}
      </p>
    </div>
  )
}

export const mount: ExtensionMount = async (root, studio) => {
  const initial = await studio.host.call('settings.get', {})
  const view = createRoot(root)
  view.render(<GreetingSettings studio={studio} initial={initial} />)
  return () => view.unmount()
}
