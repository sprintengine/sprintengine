import { useWorkspaceStore } from '../../store/workspaceStore'
import type { FollowUpBehavior } from '../../../../shared/workspace'
import { renderKeybinding } from '../../commands/keybindings'
import { SegmentedControl, SettingRow } from '../ui'
import { copy } from '../../../../shared/copy'

// Settings → Agents: what a message sent while a chat's agent is working does.
// Queue holds it in the composer's tray and sends it when the turn ends, as
// every such message did before the choice; Steer hands it to the running
// turn, where the chat's provider takes one. The other is a chord away for one
// message, so the row names it.
export function FollowUpBehaviorSetting() {
  const behavior = useWorkspaceStore((s) => s.appSettings.followUpBehavior)
  const setBehavior = useWorkspaceStore((s) => s.setFollowUpBehavior)
  const platform = window.api?.platform
  const chord = renderKeybinding(
    'Primary+Enter',
    platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux',
  )
  // A row; Settings ▸ Agents sets it in the card of chat behaviour.
  return (
    <SettingRow
      label={copy.settings.followUpBehaviorSetting.whenISendWhileAn}
      help={copy.settings.followUpBehaviorSetting.queueSendsYourMessage(chord)}
    >
      <SegmentedControl<FollowUpBehavior>
        ariaLabel={copy.settings.followUpBehaviorSetting.whenISendWhileAn}
        items={[
          { value: 'queue', label: copy.settings.followUpBehaviorSetting.queue },
          { value: 'steer', label: copy.settings.followUpBehaviorSetting.steer },
        ]}
        value={behavior}
        onChange={setBehavior}
      />
    </SettingRow>
  )
}
