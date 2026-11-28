import assert from 'node:assert/strict'
import { test } from 'vitest'

import { emptyAgentLaunchSettings, type AgentLaunchSettings } from '../../shared/launch-settings'
import { launchSettingsGatewayDeps } from './gateway-backends'

test('the gateway reads the launch settings as they are when asked, not as they were when it was built', () => {
  let settings: AgentLaunchSettings = emptyAgentLaunchSettings()
  const deps = launchSettingsGatewayDeps({ get: () => settings })
  settings = { ...settings, lastSelectedCli: 'codex' }
  assert.equal(deps.defaultChatCli!(), 'codex')
})
