import { MainOwnedSettingToggle } from './MainOwnedSettingToggle'

// Settings → General: "Ask before quitting while agents are working". Main
// owns the value (the quit dialog's "Don't ask again" turns it off), so it is
// read from main when the page opens and every write answers with what main
// now holds. A client with no quit of its own (a browser tab) shows nothing.
export function QuitConfirmationSetting() {
  return (
    <MainOwnedSettingToggle
      label="Ask before quitting while agents are working"
      description="Quitting stops running agents, schedules and pull request watches until you reopen."
      read={window.api?.getQuitConfirmation}
      write={(enabled) => window.api.setQuitConfirmation(enabled)}
    />
  )
}
