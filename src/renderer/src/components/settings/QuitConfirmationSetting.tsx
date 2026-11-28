import { MainOwnedSettingToggle } from './MainOwnedSettingToggle'
import { copy } from '../../../../shared/copy'

// Settings → General: "Ask before quitting while agents are working". Main
// owns the value (the quit dialog's "Don't ask again" turns it off), so it is
// read from main when the page opens and every write answers with what main
// now holds. A client with no quit of its own (a browser tab) shows nothing.
export function QuitConfirmationSetting() {
  return (
    <MainOwnedSettingToggle
      label={copy.settings.quitConfirmationSetting.askBeforeQuittingWhileAgents}
      read={window.api?.getQuitConfirmation}
      write={(enabled) => window.api.setQuitConfirmation(enabled)}
    />
  )
}
