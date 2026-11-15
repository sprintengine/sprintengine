import { useWorkspaceStore } from '../../store/workspaceStore'
import { MainOwnedSettingToggle } from './MainOwnedSettingToggle'
import { SettingCard, SettingToggle, SettingsSectionTitle } from './SettingsAtoms'

// Settings → Agents → Built-in browser: whether the agents get the browser at
// all, and how it shows itself to the person sitting beside them.

export function AgentBrowserSettings() {
  const autoFloat = useWorkspaceStore((s) => s.appSettings.browserAutoFloatAgentPreview)
  const setAutoFloat = useWorkspaceStore((s) => s.setBrowserAutoFloatAgentPreview)
  return (
    <section className="space-y-3 pt-2" aria-labelledby="agent-browser-settings-title">
      <SettingsSectionTitle id="agent-browser-settings-title">Built-in browser</SettingsSectionTitle>
      <SettingCard>
        {/* Main owns this one: it puts the tools together and offers them, and
            a browser tab, which offers none, leaves the row out. */}
        <MainOwnedSettingToggle
          label="Let agents use the built-in browser"
          description="Agents can open, read and click pages. Running agents pick this up next session."
          read={window.api?.getAgentBrowserTools}
          write={(enabled) => window.api.setAgentBrowserTools(enabled)}
        />
        <SettingToggle
          label="Show the page while an agent uses it"
          description="With the pane closed, float the agent’s page or board over the chat."
          enabled={autoFloat}
          onChange={setAutoFloat}
        />
      </SettingCard>
    </section>
  )
}
