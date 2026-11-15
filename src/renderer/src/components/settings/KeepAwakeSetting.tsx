import { MainOwnedSettingToggle } from './MainOwnedSettingToggle'
import { copy } from '../../../../shared/copy'

// Settings → General: "Keep the computer awake while agents work". Main owns
// the value, because main holds the power-save blocker as agents start and
// stop (agent-keep-awake.ts). A browser tab, whose machine is not this one,
// shows nothing.
export function KeepAwakeSetting() {
  return (
    <MainOwnedSettingToggle
      label={copy.settings.keepAwakeSetting.keepTheComputerAwakeWhile}
      description={copy.settings.keepAwakeSetting.noSleepWhileAnAgent}
      read={window.api?.getKeepAwake}
      write={(enabled) => window.api.setKeepAwake(enabled)}
    />
  )
}
