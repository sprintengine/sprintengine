import { useWorkspaceStore } from '../../store/workspaceStore'
import { APP_THEMES, systemThemeChoices, type ResolvedAppTheme } from '../../../../shared/app-theme'
import { Select } from '../ui'
import { SettingCard, SettingsRow } from './SettingsAtoms'
import { copy } from '../../../../shared/copy'

const labelOf = (id: ResolvedAppTheme): string => APP_THEMES.find((theme) => theme.id === id)?.label ?? id

/**
 * Which theme "System" paints on each side of the OS's light/dark switch.
 * Shown only while System is the theme: under any other, the switch changes
 * nothing.
 */
export function SystemThemeRows() {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const light = useWorkspaceStore((s) => s.appSettings.appearance.systemLightTheme)
  const dark = useWorkspaceStore((s) => s.appSettings.appearance.systemDarkTheme)
  const setSystemTheme = useWorkspaceStore((s) => s.setAppearanceSystemTheme)
  if (theme !== 'system') return null
  return (
    <SettingCard>
      <SettingsRow label={copy.settings.systemThemeRows.inLightMode}>
        <Select<ResolvedAppTheme>
          ariaLabel={copy.settings.systemThemeRows.themeInLightMode}
          items={systemThemeChoices('light').map((id) => ({ value: id, label: labelOf(id) }))}
          value={light}
          onChange={(next) => setSystemTheme('light', next)}
        />
      </SettingsRow>
      <SettingsRow label={copy.settings.systemThemeRows.inDarkMode}>
        <Select<ResolvedAppTheme>
          ariaLabel={copy.settings.systemThemeRows.themeInDarkMode}
          items={systemThemeChoices('dark').map((id) => ({ value: id, label: labelOf(id) }))}
          value={dark}
          onChange={(next) => setSystemTheme('dark', next)}
        />
      </SettingsRow>
    </SettingCard>
  )
}
