// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, test } from 'vitest'

import {
  publishChatPanelFacts,
  useChatPanelFacts,
  usePublishChatPanelFacts,
  type ChatPanelFacts,
} from './chatPanelStore'

// The panel reads a chat only through this store, whichever machine it runs on.
// A chat renders on every token, so what it publishes must wake nobody unless
// it changed.

const NO_PULL_REQUESTS: ChatPanelFacts['pullRequests'] = []

const facts = (patch: Partial<ChatPanelFacts> = {}): ChatPanelFacts => ({
  name: 'Calendar screen rebuild',
  cli: 'claude-code',
  harnessLabel: 'Claude Code',
  modelLabel: 'Opus 5.5',
  machine: null,
  remote: false,
  branch: null,
  changes: null,
  pullRequests: NO_PULL_REQUESTS,
  createPullRequest: null,
  localServers: null,
  permissions: null,
  permissionLabel: null,
  ...patch,
})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  publishChatPanelFacts('w1', 'a1', null)
})

function Reader({ onRender }: { onRender: (facts: ChatPanelFacts | null) => void }) {
  onRender(useChatPanelFacts('w1', 'a1'))
  return null
}

function Publisher({ value }: { value: ChatPanelFacts }) {
  usePublishChatPanelFacts('w1', 'a1', value)
  return null
}

test('a reader sees what a chat publishes, and nothing once the chat is gone', () => {
  const seen: Array<ChatPanelFacts | null> = []
  const root = createRoot(document.createElement('div'))
  act(() => root.render(<Reader onRender={(value) => seen.push(value)} />))
  assert.equal(seen.at(-1), null)

  const chat = createRoot(document.createElement('div'))
  act(() => chat.render(<Publisher value={facts()} />))
  assert.equal(seen.at(-1)?.name, 'Calendar screen rebuild')

  act(() => chat.unmount())
  assert.equal(seen.at(-1), null)
  act(() => root.unmount())
})

test('a publish that changes nothing wakes no reader', () => {
  let renders = 0
  const root = createRoot(document.createElement('div'))
  act(() => {
    publishChatPanelFacts('w1', 'a1', facts())
    root.render(<Reader onRender={() => (renders += 1)} />)
  })
  const settled = renders
  act(() => publishChatPanelFacts('w1', 'a1', facts()))
  assert.equal(renders, settled)
  act(() => publishChatPanelFacts('w1', 'a1', facts({ modelLabel: 'Haiku 5.5' })))
  assert.equal(renders, settled + 1)
  act(() => root.unmount())
})
