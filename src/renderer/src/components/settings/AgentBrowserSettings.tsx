import { useWorkspaceStore } from '../../store/workspaceStore'
import { MainOwnedSettingToggle } from './MainOwnedSettingToggle'
import { SettingCard, SettingToggle, SettingsSectionTitle } from './SettingsAtoms'
import { copy } from '../../../../shared/copy'

// Settings → Agents → Built-in browser: whether the agents get the browser at
// all, and how it shows itself to the person sitting beside them.

export function AgentBrowserSettings() {
  const autoFloat = useWorkspaceStore((s) => s.appSettings.browserAutoFloatAgentPreview)
  const setAutoFloat = useWorkspaceStore((s) => s.setBrowserAutoFloatAgentPreview)
  return (
    <section className="space-y-3 pt-2" aria-labelledby="agent-browser-settings-title">
      <SettingsSectionTitle id="agent-browser-settings-title">
        {copy.settings.agentBrowserSettings.builtInBrowser}
      </SettingsSectionTitle>
      <SettingCard>
        {/* Main owns this one: it puts the tools together and offers them, and
            a browser tab, which offers none, leaves the row out. */}
        <MainOwnedSettingToggle
          label={copy.settings.agentBrowserSettings.letAgentsUseTheBuilt}
          description={copy.settings.agentBrowserSettings.agentsCanOpenReadAnd}
          read={window.api?.getAgentBrowserTools}
          write={(enabled) => window.api.setAgentBrowserTools(enabled)}
        />
        <SettingToggle
          label={copy.settings.agentBrowserSettings.showThePageWhileAn}
          description={copy.settings.agentBrowserSettings.withThePaneClosedFloat}
          enabled={autoFloat}
          onChange={setAutoFloat}
        />
      </SettingCard>
    </section>
  )
}
