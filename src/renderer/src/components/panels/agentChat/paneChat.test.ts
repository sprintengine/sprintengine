import { expect, test } from 'vitest'

import { environmentConversationTransport } from './environmentChat'
import { paneChatOfPairedTab, paneChatOfRecord } from './paneChat'

// Every chat pane is given its chat by where it lives. A record here names its
// chat on this computer, an SSH machine or a WSL distribution; a paired chat's
// tab names it on that machine, as a chat this window keeps no record of.

test("a chat of this computer is its own Studio's, by its id", () => {
  expect(paneChatOfRecord({ id: 'chat-1', environment: undefined })).toEqual({ environment: null, chatId: 'chat-1' })
})

test("an SSH machine's chat and a WSL distribution's are those environments', and their transport is theirs", () => {
  const ssh = paneChatOfRecord({ id: 'chat-2', environment: { kind: 'ssh', id: 'build-box', label: 'build-box' } })
  expect(ssh).toEqual({ environment: { route: 'ssh:build-box', name: 'build-box' }, chatId: 'chat-2' })
  expect(environmentConversationTransport(ssh.environment!).environment.route).toBe('ssh:build-box')

  const wsl = paneChatOfRecord({ id: 'chat-3', environment: { kind: 'wsl', id: 'Ubuntu', label: 'WSL: Ubuntu' } })
  expect(wsl).toEqual({ environment: { route: 'wsl:Ubuntu', name: 'WSL: Ubuntu' }, chatId: 'chat-3' })
  expect(environmentConversationTransport(wsl.environment!).environment.route).toBe('wsl:Ubuntu')
})

test("a paired chat's tab names its chat on that machine, read off that machine's list", () => {
  expect(
    paneChatOfPairedTab({
      connectionId: 'connection',
      machineName: 'mac-mini',
      remoteWorkspaceId: 'far-chat',
      remoteAgentId: 'far-agent',
      title: 'Router work',
    }),
  ).toEqual({
    chat: {
      environment: { route: 'tailnet:connection', name: 'mac-mini' },
      chatId: 'far-chat',
      listed: { connectionId: 'connection', title: 'Router work' },
    },
    agentId: 'far-agent',
  })
  expect(paneChatOfPairedTab({ connectionId: 'connection', remoteWorkspaceId: 'far-chat' })).toBeNull()
  expect(paneChatOfPairedTab(undefined)).toBeNull()
})
