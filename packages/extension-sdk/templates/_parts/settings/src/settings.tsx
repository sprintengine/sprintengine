import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

const NAME = '{{displayName}}'

// A section in Settings, declared in extension.json
// (`contributes.settingsSections`, id "settings"). It saves the extension's
// Settings values through Studio (`settings.get`, `settings.set`, permission
// `settings:own`), which keeps them, so a worker reads the value with
// `studio.getModuleAppState('label')`.
export function Settings({ studio, initial }: { studio: ExtensionMountStudio; initial: string }) {
  const [label, setLabel] = useState(initial)
  useEffect(() => studio.ready(), [studio])
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 16 }}>
      Label
      <input
        className="se-input"
        value={label}
        onChange={(event) => {
          setLabel(event.target.value)
          void studio.host.call('settings.set', { key: 'label', value: event.target.value || null })
        }}
      />
      <span className="se-muted">Shown wherever {NAME} names itself.</span>
    </label>
  )
}

export const mount: ExtensionMount = async (root, studio) => {
  const saved = await studio.host.call('settings.get', {})
  const view = createRoot(root)
  view.render(<Settings studio={studio} initial={typeof saved.label === 'string' ? saved.label : ''} />)
  return () => view.unmount()
}
