// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { publishChatPanelFacts } from '../../../panels/agentChat/chatPanelStore'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { Workspace } from '../../../../types/workspace'
import { ChatPanel } from './ChatPanel'
import { panelFacts } from './panelFactsFixture'
import { publishRemoteChat } from '../../../panels/agentChat/remoteChatRegistry'
import type { ChatBinding } from '../../../panels/agentChat/chatBinding'
import type { ConversationTransport } from '../../../panels/agentChat/conversationTransport'

// The panel's own reading of the checkout, for a tab with no chat to say.
const checkout = vi.hoisted(() => ({
  facts: { branch: null as string | null, changes: null as null | object },
}))
vi.mock('./useWorkspaceCheckoutFacts', () => ({ useWorkspaceCheckoutFacts: () => checkout.facts }))

const WS = 'ws-panel'
const AGENT = 'agent-1'
const MACHINE = { id: 'mac-mini', kind: 'laptop', colour: 'blue', overridden: false } as never

let root: Root | null = null
let host: HTMLElement

function seed(workspace: Partial<Workspace> = {}, focused: string | null = AGENT) {
  useWorkspaceStore.setState({
    workspaces: [{ id: WS, name: 'demo-app', folderPath: '/Users/dev/demo-app', agents: {}, ...workspace }] as never,
    focusedAgentByWorkspaceId: focused ? { [WS]: focused } : {},
  })
}

function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <ChatPanel
        workspaceId={WS}
        tabs={[]}
        items={[]}
        currentTabId={null}
        onOpenTab={() => undefined}
        onCloseTab={() => undefined}
        onTabContextMenu={() => undefined}
        addControl={null}
      />,
    ),
  )
  return host
}

const row = (name: string) =>
  [...host.querySelectorAll<HTMLElement>('[data-panel-row]')].find((item) => item.textContent?.startsWith(name))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  checkout.facts = { branch: null, changes: null }
  Object.assign(window, { api: { ...window.api, platform: 'darwin' } })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host.remove()
  publishChatPanelFacts(WS, AGENT, null)
})

test('the head says what the chat is and how it runs', () => {
  seed({
    agents: { [AGENT]: { id: AGENT, name: 'Calendar', conversation: { providerId: 'x', modelId: 'y' } } },
  } as never)
  render()
  act(() => publishChatPanelFacts(WS, AGENT, panelFacts({ name: 'Calendar', modelLabel: 'Opus 5.5' })))
  expect(host.querySelector('h2')?.textContent).toBe('Calendar')
  expect(host.textContent).toContain('Claude Code · Opus 5.5')
  expect(host.querySelector('[data-panel-machine]')).toBeNull()
})

test('a chat on a paired machine names the machine and its project there, not an address', () => {
  seed({
    remoteOrigin: { machineName: 'mac-mini.tail1234.ts.net', workspaceRoot: '/Users/dev/demo-app' },
  } as never)
  render()
  act(() =>
    publishChatPanelFacts(
      WS,
      AGENT,
      panelFacts({
        environmentLabel: 'mac-mini.tail1234.ts.net',
        machine: { name: 'mac-mini.tail1234.ts.net', identity: MACHINE },
      }),
    ),
  )
  expect(host.querySelector('[data-panel-machine]')?.textContent).toContain('mac-mini')
  expect(host.textContent).not.toContain('ts.net')
  expect(host.querySelector('header')?.textContent).toContain('demo-app')
})

test('on a paired machine what this computer cannot open says so, and nothing offers a dead click', () => {
  seed()
  render()
  act(() =>
    publishChatPanelFacts(
      WS,
      AGENT,
      panelFacts({
        environmentLabel: 'mac-mini',
        machine: { name: 'mac-mini', identity: MACHINE },
        branch: { name: 'agent/calendar', worktree: false, onOpen: null },
        changes: { added: 3, removed: 1, phrase: '3 files added, 1 removed' },
      }),
    ),
  )
  for (const name of ['Changes', 'Files', 'Terminal', 'Branch'])
    expect(row(name)?.getAttribute('data-panel-row'), name).toBe('fact')
  expect(row('Files')?.textContent).toContain('On mac-mini')
  expect(row('Terminal')?.textContent).toContain('On mac-mini')
  expect(row('Branch')?.textContent).toContain('agent/calendar')
  expect(row('Library')?.getAttribute('data-panel-row')).toBe('action')
})

// A chat on a paired machine as its pane publishes it here, with whether that
// machine reads the chat's changes for this window (`conversation-changes`).
function publishPaired(hostChanges: boolean) {
  return publishRemoteChat(WS, {
    agentId: AGENT,
    key: { connectionId: 'connection-1', workspaceId: 'far-workspace', agentId: AGENT },
    machineName: 'mac-mini',
    hostChanges,
    transport: {} as ConversationTransport,
    binding: {} as ChatBinding,
    subagents: [],
    subagentTransport: () => ({}) as ConversationTransport,
  })
}

test('on a paired machine that reads them, Changes opens the chat’s changes from there', () => {
  seed()
  const take = publishPaired(true)
  try {
    render()
    act(() =>
      publishChatPanelFacts(
        WS,
        AGENT,
        panelFacts({ environmentLabel: 'mac-mini', machine: { name: 'mac-mini', identity: MACHINE }, changes: null }),
      ),
    )
    // Shown with no count to say, as a chat here shows it: the tab says what there is.
    expect(row('Changes')?.getAttribute('data-panel-row')).toBe('action')
    expect(row('Files')?.getAttribute('data-panel-row'), 'Files stays on the machine').toBe('fact')
    act(() => row('Changes')!.click())
    const tabs = useWorkspaceStore.getState().workspaces[0]!.paneState?.tabs ?? []
    expect(tabs.map((tab) => [tab.kind, tab.diff?.paired])).toEqual([
      ['diff', { connectionId: 'connection-1', workspaceId: 'far-workspace', agentId: AGENT, machineName: 'mac-mini' }],
    ])
  } finally {
    act(() => take())
  }
})

test('on a paired machine that does not read them, Changes stays its count and opens nothing', () => {
  seed()
  const take = publishPaired(false)
  try {
    render()
    act(() =>
      publishChatPanelFacts(
        WS,
        AGENT,
        panelFacts({
          environmentLabel: 'mac-mini',
          machine: { name: 'mac-mini', identity: MACHINE },
          changes: { added: 3, removed: 1, phrase: '3 files added, 1 removed' },
        }),
      ),
    )
    expect(row('Changes')?.getAttribute('data-panel-row')).toBe('fact')
    expect(row('Changes')?.textContent).toContain('+3')
  } finally {
    act(() => take())
  }
})

test('a tab with no chat to say still reads its checkout', () => {
  checkout.facts = {
    branch: 'agent/terminal-work',
    changes: { added: 2, removed: 0, phrase: '2 files added' },
  }
  seed({}, null)
  render()
  expect(host.querySelector('h2')?.textContent).toBe('demo-app')
  expect(row('Branch')?.textContent).toContain('agent/terminal-work')
  expect(row('Changes')?.textContent).toContain('+2')
  expect(row('Terminal')?.getAttribute('data-panel-row')).toBe('action')
})

test('no Subagents section without subagents, and no Session section with nothing to say', () => {
  seed()
  render()
  act(() => publishChatPanelFacts(WS, AGENT, panelFacts()))
  expect(host.textContent).not.toContain('Subagents')
  expect(host.textContent).not.toContain('Session')
})

test('the head has no close of its own: the column closes from its toggle', () => {
  seed({
    agents: { [AGENT]: { id: AGENT, name: 'Calendar', conversation: { providerId: 'x', modelId: 'y' } } },
  } as never)
  render()
  expect(host.querySelector('header button')).toBeNull()
})
