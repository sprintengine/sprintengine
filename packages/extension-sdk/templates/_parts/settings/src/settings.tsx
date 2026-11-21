import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

const NAME = '{{displayName}}'

// A section in Settings, declared in extension.json
// (`contributes.settingsSections`, id "settings"). It saves into the
// extension's app state, so the rest of the extension reads the value with
// `studio.getModuleAppState('label')`, a worker included ("storage" permission).
export function Settings({ studio }: { studio: ExtensionMountStudio }) {
  const subscribe = useCallback((onChange: () => void) => studio.watchModuleAppState(() => onChange()), [studio])
  const readLabel = useCallback(() => studio.getModuleAppState<string>('label') ?? '', [studio])
  const label = useSyncExternalStore(subscribe, readLabel, readLabel)

  useEffect(() => studio.ready(), [studio])

  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sem-space-xs)',
        fontFamily: 'var(--sem-font-family-ui)',
        fontSize: 'var(--sem-font-size-body)',
        color: 'var(--sem-color-text-default)',
      }}
    >
      Label
      <input
        value={label}
        onChange={(event) => studio.setModuleAppState('label', event.target.value || undefined)}
        style={{
          font: 'inherit',
          color: 'inherit',
          padding: 'var(--sem-space-xs) var(--sem-space-sm)',
          border: '1px solid var(--sem-color-border-default)',
          borderRadius: 'var(--sem-radius-control)',
          background: 'var(--sem-color-bg-surface-raised)',
        }}
      />
      <span style={{ color: 'var(--sem-color-text-muted)', fontSize: 'var(--sem-font-size-meta)' }}>
        Shown wherever {NAME} names itself.
      </span>
    </label>
  )
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<Settings studio={studio} />)
  return () => view.unmount()
}
