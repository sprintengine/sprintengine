import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExecutionHostId, ExecutionHostSettings } from '../../shared/execution-host'
import { createDesktopWslServers } from './desktop-wsl-servers'

// A distribution's Studio server holds its chats (design-wsl-ssh-direct PR
// 3c), whichever process owns the core. Building the supervisor starts
// nothing: a server starts when a chat, a window or the hand-over needs it.

function servers(hosts: Partial<Record<ExecutionHostId, Partial<ExecutionHostSettings>>>) {
  return createDesktopWslServers({
    readHostSettings: () => hosts as Partial<Record<ExecutionHostId, ExecutionHostSettings>>,
    userDataDir: '/Users/dev/Library/Application Support/SprintEngine Studio',
    app: { version: '0.4.0', channel: 'latest' },
    packaged: false,
    resourcesDir: null,
    appRoot: null,
    isDefaultProfile: false,
  })
}

test('building the supervisor starts no server', () => {
  assert.deepEqual(servers({ 'wsl:Ubuntu': { serverTransport: 'stdio' } }).manager.statuses(), [])
})
