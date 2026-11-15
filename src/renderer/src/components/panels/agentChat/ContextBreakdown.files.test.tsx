// A memory file in the context breakdown opens the way a file link in the
// transcript does, because it is that link: a chat whose disk this window's
// Studio reads gets a button that opens the file in Studio's editor, and a chat
// on a paired machine gets the same text the transcript gives a path over
// there, with the whole path on hover.
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

import { installStudioLoopback } from '../../../../../../tests/studio-chat-loopback'
import { ContextMemoryFile } from './ContextBreakdown'
import { ConversationLinkProvider } from './conversationLinks'
import {
  ConversationTransportProvider,
  useConversationTransport,
  type ConversationTransport,
} from './conversationTransport'

beforeAll(async () => {
  const win = { api: { platform: 'darwin' } as Record<string, unknown> }
  vi.stubGlobal('window', win)
  await installStudioLoopback(win).welcomed()
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const PATH = '/Users/dev/.claude/CLAUDE.md'

function PairedMachine({ children }: { children: React.ReactNode }) {
  const local = useConversationTransport()
  const remote: ConversationTransport = {
    ...local,
    environment: { id: 'another-machine', label: 'mac-mini', route: null },
  }
  return <ConversationTransportProvider value={remote}>{children}</ConversationTransportProvider>
}

const inChat = (node: React.ReactNode) => (
  <ConversationLinkProvider workspaceId="workspace" workspaceRoot="/workspace/app" cwd="/workspace/app">
    {node}
  </ConversationLinkProvider>
)

test('a memory file in a chat whose disk the window reads is a button that opens it', () => {
  const html = renderToStaticMarkup(inChat(<ContextMemoryFile path={PATH} />))
  expect(html).toContain(`aria-label="Open ${PATH}"`)
  expect(html).toContain('…/.claude/CLAUDE.md')
})

test('on a paired machine it is the transcript’s text for a path over there, the whole path on hover', () => {
  const html = renderToStaticMarkup(<PairedMachine>{inChat(<ContextMemoryFile path={PATH} />)}</PairedMachine>)
  expect(html).not.toContain('aria-label="Open ')
  expect(html).toContain(`title="${PATH}"`)
  expect(html).toContain('…/.claude/CLAUDE.md')
})
