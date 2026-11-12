import assert from 'node:assert/strict'
import { test } from 'vitest'

import { chatLinkFromArgv } from './deep-link'

// The grammar's own cases are the protocol package's (chat-link.test.ts).

test('a launch hands its link over among other arguments', () => {
  assert.deepEqual(
    chatLinkFromArgv([
      'C:\\Program Files\\SprintEngine Studio\\SprintEngine Studio.exe',
      '--allow-file-access-from-files',
      'sprintengine://chat/env-1/ws-1?agent=a1',
    ]),
    { kind: 'chat', environmentId: 'env-1', chatId: 'ws-1', agentId: 'a1' },
  )
  assert.deepEqual(chatLinkFromArgv(['/opt/app/sprintengine', 'sprintengine://chat/ws-1']), {
    kind: 'chat',
    environmentId: null,
    chatId: 'ws-1',
    agentId: null,
  })
  assert.equal(chatLinkFromArgv(['/opt/app/sprintengine', '--no-sandbox']), null)
  assert.equal(chatLinkFromArgv([]), null)
})

test('the sign-in callback is not a chat link', () => {
  assert.equal(chatLinkFromArgv(['/Applications/app', 'sprintengine://auth/callback?code=abc']), null)
})
