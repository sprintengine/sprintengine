import { useEffect } from 'react'

import {
  retainUsageLimitResumes,
  updateUsageLimitResume,
  useUsageLimitResumeStore,
} from '../../store/usageLimitResumeStore'
import { SettingToggle } from './SettingsAtoms'

// Settings → Agents' switch for resuming a chat a usage limit stopped. Main
// keeps it, beside the resumes it schedules (src/main/usage-limits/resume.ts);
// the chat's own notice can turn it on too.
export function UsageLimitResumeSettings() {
  useEffect(() => retainUsageLimitResumes(), [])
  const autoResume = useUsageLimitResumeStore((store) => store.state?.autoResume ?? false)
  // A row; Settings ▸ Agents sets it in the card of chat behaviour.
  return (
    <SettingToggle
      label="Resume after usage limits"
      description="Claude and Codex chats carry on once their usage limit resets. Off: you choose."
      enabled={autoResume}
      onChange={(enabled) => void updateUsageLimitResume({ kind: 'auto', enabled })}
    />
  )
}
