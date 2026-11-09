import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationSessionFrame,
} from '../../../../../../shared/conversation-runtime'
import type { MeshConversationFrame, MeshConversationKey, MeshSubagent } from '../../../../../../shared/tailnet-mesh'
import type { ConversationSessionEntry } from '../../../../hooks/conversationSessionsStore'
import type { ConversationTransport } from '../../../panels/agentChat/conversationTransport'
import { latestSessionOf } from '../../../panels/agentChat/chatSubagents'
import { panelFacts } from './panelFactsFixture'

// The panel beside a chat's tab, following the agent in view: the real host and
// the real panel, joined only by the stores that join them in the window, for a
// chat here and a chat on a paired machine alike. A sub-agent's chat is drawn by
// the view that hosts it, and is stubbed here: what it says of itself reaches the
// panel as any chat's does.

vi.mock('./useWorkspaceCheckoutFacts', () => ({
  useWorkspaceCheckoutFacts: () => ({ branch: null, changes: null }),
}))

let seq = 0
function event(type: ConversationEventType, payload: Record<string, unknown>): ConversationEvent {
  seq++
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    type,
    createdAt: seq * 1000,
    payload,
  }
}

// A chat that sent two agents off: one still working (a step in, reporting what
// it is doing), one finished with its report.
const transcript = [
  event('session_updated', {
    providerSessionId: 'native',
    agents: [{ name: 'Explore', description: 'Fast read-only search agent for locating code.' }],
  }),
  event('turn_started', { turnId: 'turn-1' }),
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'lane-find',
    tool: 'Agent',
    subagentLane: true,
    subagentType: 'Explore',
    input: { description: 'Find the router', subagent_type: 'Explore' },
  }),
  event('subagent_status', { toolUseId: 'lane-find', status: 'running', background: true }),
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'lane-plan',
    tool: 'Agent',
    subagentLane: true,
    subagentType: 'Plan',
    input: { description: 'Plan the migration', subagent_type: 'Plan' },
  }),
  event('subagent_status', { toolUseId: 'lane-plan', status: 'running', background: true }),
  event('turn_completed', { turnId: 'turn-1' }),
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'grep-1',
    tool: 'Grep',
    summary: 'Grep: createRouter',
    parentToolUseId: 'lane-find',
  }),
  event('subagent_status', {
    toolUseId: 'lane-find',
    status: 'running',
    progressSummary: 'Searching for the router',
    usage: { totalTokens: 9_000, toolUses: 1, durationMs: 2_000 },
  }),
  event('tool_output', { toolCallId: 'lane-plan', output: 'Move the tables first.', backgroundResult: true }),
  event('subagent_status', {
    toolUseId: 'lane-plan',
    status: 'completed',
    usage: { totalTokens: 21_000, toolUses: 4, durationMs: 9_000 },
  }),
]

// Rows the live-row hook watches, so a test can scroll one out of view.
const observed = new Map<Element, (entries: Array<{ target: Element; isIntersecting: boolean }>) => void>()
class FakeIntersectionObserver {
  constructor(private readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {}
  observe(target: Element) {
    observed.set(target, this.callback)
  }
  unobserve(target: Element) {
    observed.delete(target)
  }
  disconnect() {
    observed.clear()
  }
}

async function mountPanel({
  focused = true,
  remote = false,
  subagents = {},
}: { focused?: boolean; remote?: boolean; subagents?: Record<string, unknown> } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IntersectionObserver: FakeIntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const frames: ((frame: ConversationSessionFrame) => void)[] = []
  const followed = new Map<string, (frame: MeshConversationFrame) => void>()
  const resolved: unknown[] = []
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api: {
      platform: 'darwin',
      onConversationSession: (_input: unknown, receive: (frame: ConversationSessionFrame) => void) => {
        frames.push(receive)
        return () => undefined
      },
      onMeshConversationSession: (
        input: { key: MeshConversationKey },
        receive: (frame: MeshConversationFrame) => void,
      ) => {
        followed.set(input.key.agentId, receive)
        return () => undefined
      },
      meshConversationResolveApproval: async (input: unknown) => {
        resolved.push(input)
        return { ok: true }
      },
      canvasListBoards: async () => ({ ok: true, value: [] }),
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../../../store/workspaceStore')
  const { SubagentChatHost } = await import('../../../panels/agentChat/SubagentChatHost')
  const { ChatPanel } = await import('./ChatPanel')
  const { resetSubagentViews } = await import('../../../panels/agentChat/subagentViewStack')
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'workspace',
        name: 'Project',
        folderPath: '/Users/dev/project',
        agents: remote
          ? {}
          : {
              agent: {
                id: 'agent',
                name: 'Router work',
                runtimeKind: 'conversation',
                conversation: { providerId: 'claude-agent', modelId: 'sonnet' },
              },
              ...subagents,
            },
      },
    ] as never,
    focusedAgentByWorkspaceId: focused ? { workspace: 'agent' } : {},
  })
  const rootAgentId = remote ? 'far-agent' : 'agent'
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const tree = () =>
    createElement(
      'div',
      null,
      createElement(
        'div',
        { 'data-tab': '' },
        createElement(SubagentChatHost, {
          workspaceId: 'workspace',
          rootAgentId,
          rootName: 'Router work',
          renderChat: (chat) => createElement('p', null, `Chat of ${chat.agentId}`),
          children: createElement('p', null, 'The main chat'),
        }),
      ),
      createElement(ChatPanel, {
        workspaceId: 'workspace',
        tabs: [],
        items: [],
        currentTabId: null,
        onOpenTab: () => undefined,
        onCloseTab: () => undefined,
        onTabContextMenu: () => undefined,
        addControl: null,
      }),
    )
  await act(async () => root.render(tree()))
  const panel = () => host.querySelector<HTMLElement>('[data-chat-panel]')!
  return {
    host,
    act,
    panel,
    head: () => panel().querySelector('h2')?.textContent,
    parent: () => panel().querySelector<HTMLElement>('[data-panel-parent]'),
    tabView: () => [...observed.keys()][0]!,
    row: (name: string) =>
      [...panel().querySelectorAll<HTMLElement>('[data-panel-row]')].find((item) => item.textContent?.startsWith(name)),
    names: () =>
      [...panel().querySelectorAll<HTMLElement>('[data-panel-row]')].map((item) => item.getAttribute('aria-label')),
    async deliver(events: ConversationEvent[]) {
      await act(async () => {
        frames.at(-1)?.({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
        frames.at(-1)?.({ type: 'synchronized', seq: events.at(-1)?.seq ?? 0 })
      })
    },
    async page(events: ConversationEvent[]) {
      await act(async () => {
        frames.at(-1)?.({ type: 'snapshot', page: { events, hasMore: true, beforeCursor: 1 } })
        frames.at(-1)?.({ type: 'synchronized', seq: events.at(-1)?.seq ?? 0 })
      })
    },
    followed,
    resolved,
    async unmount() {
      await act(async () => {
        resetSubagentViews()
        root.unmount()
      })
      observed.clear()
      dom.window.close()
      for (const key of Object.keys(globals)) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

// What a chat says of itself, as `ConversationChatBody` publishes it.
async function chatSays(tab: { act: (run: () => Promise<void>) => Promise<unknown> }, agentId: string, facts: object) {
  const { publishChatPanelFacts } = await import('../../../panels/agentChat/chatPanelStore')
  await tab.act(async () => publishChatPanelFacts('workspace', agentId, panelFacts(facts)))
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const anotherLane = () => [
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'lane-tests',
    tool: 'Agent',
    subagentLane: true,
    subagentType: 'general-purpose',
    input: { description: 'Write the tests' },
  }),
  event('subagent_status', { toolUseId: 'lane-tests', status: 'running', background: true }),
]

const nested = () => [
  event('tool_started', {
    turnId: 'turn-1',
    toolCallId: 'lane-inner',
    tool: 'Agent',
    subagentLane: true,
    subagentType: 'Explore',
    input: { description: 'Read the routes', subagent_type: 'Explore', model: 'haiku' },
    parentToolUseId: 'lane-find',
  }),
  event('subagent_status', { toolUseId: 'lane-inner', status: 'running', background: true }),
]

test('with no chat in focus the panel lists nothing, and reads nothing', async () => {
  const tab = await mountPanel({ focused: false })
  try {
    expect(tab.panel().textContent).not.toContain('Subagents')
  } finally {
    await tab.unmount()
  }
})

test('the chat’s direct children are listed working first, with live status words, and not theirs', async () => {
  const tab = await mountPanel()
  try {
    await tab.deliver([...transcript, ...nested()])
    await tab.act(() => pause(500))
    expect(tab.names().slice(0, 2)).toEqual(['Find the router', 'Plan the migration'])
    expect(tab.row('Find the router')?.textContent).toContain('Working')
    expect(tab.row('Plan the migration')?.textContent).toContain('Done')
    expect(tab.panel().textContent).not.toContain('Read the routes')
  } finally {
    await tab.unmount()
  }
})

test('the panel follows a lane: its head, the way back, and only its children, and back again', async () => {
  const tab = await mountPanel()
  try {
    await chatSays(tab, 'agent', {
      name: 'Router work',
      permissionLabel: 'Auto',
      changes: { added: 105, removed: 12, phrase: '3 files added' },
    })
    await tab.deliver([...transcript, ...nested()])
    await tab.act(() => pause(500))
    expect(tab.head()).toBe('Router work')
    expect(tab.parent()).toBeNull()
    await tab.act(async () => tab.row('Find the router')!.click())
    await tab.act(() => pause(500))

    expect(tab.head()).toBe('Find the router')
    expect(tab.parent()?.textContent).toContain('Main chat')
    expect(tab.parent()?.textContent).toContain('Router work')
    expect(tab.names()).toContain('Read the routes')
    expect(tab.names()).not.toContain('Plan the migration')

    // Into the nested one: its parent is the agent, by name, and it has no section.
    await tab.act(async () => tab.row('Read the routes')!.click())
    await tab.act(() => pause(500))
    expect(tab.head()).toBe('Read the routes')
    expect(tab.parent()?.textContent).toContain('Find the router')
    expect(tab.parent()?.textContent).toContain('Parent agent')
    expect(tab.panel().textContent).not.toContain('Subagents')

    await tab.act(async () => tab.parent()!.querySelector('button')!.click())
    await tab.act(async () => tab.parent()!.querySelector('button')!.click())
    expect(tab.head()).toBe('Router work')
    expect(tab.parent()).toBeNull()
  } finally {
    await tab.unmount()
  }
})

test('a lane has no record of its own, so nothing the chat measured is said of it', async () => {
  const tab = await mountPanel()
  try {
    await chatSays(tab, 'agent', {
      name: 'Router work',
      permissionLabel: 'Auto',
      changes: { added: 105, removed: 12, phrase: '3 files added' },
    })
    await tab.deliver(transcript)
    await tab.act(() => pause(500))
    expect(tab.row('Changes')?.textContent).toContain('105')
    await tab.act(async () => tab.row('Find the router')!.click())
    await tab.act(() => pause(500))
    expect(tab.row('Changes')?.textContent, 'the chat’s changes are not the lane’s').not.toContain('105')
    expect(tab.row('Permissions')?.textContent).toContain('Set by its parent')
    expect(tab.row('Tokens')?.textContent, 'what it spent is its own').toContain('9')
  } finally {
    await tab.unmount()
  }
})

const reviewer = {
  id: 'agent-reviewer',
  name: 'Cursor · muse-wonder-1.0',
  runtimeKind: 'conversation',
  conversation: { providerId: 'cursor-agent', modelId: 'muse-wonder-1.0' },
  subagentOf: { agentId: 'agent', startedAt: 1_000, task: 'Review the calendar screen' },
  subagentReadOnly: true,
  subagentEnd: { at: 91_000, status: 'completed' },
}
const failedReviewer = {
  ...reviewer,
  id: 'agent-failed',
  name: 'Reviewer that failed',
  subagentReadOnly: false,
  subagentEnd: { at: 11_000, status: 'failed', error: 'The model is unavailable.' },
}
const someoneElses = {
  ...reviewer,
  id: 'agent-other',
  name: 'Not this chat’s',
  subagentOf: { agentId: 'agent-second', startedAt: 3_000, task: 'Something else' },
}

test('Studio sub-agents are listed beside lanes, with their harness’s mark and a Read-only badge, and no other chat’s', async () => {
  const tab = await mountPanel({
    subagents: { 'agent-reviewer': reviewer, 'agent-failed': failedReviewer, 'agent-other': someoneElses },
  })
  try {
    await tab.deliver(transcript)
    await tab.act(() => pause(500))
    const text = tab.panel().textContent ?? ''
    expect(text).toContain('Cursor · muse-wonder-1.0')
    expect(text).toContain('Read-only')
    expect(text).toContain('Done in 1m 30s')
    expect(text).toContain('Failed after 10s')
    expect(text).not.toContain('Not this chat’s')
    expect(tab.row('Cursor')?.querySelector('svg')).not.toBeNull()
  } finally {
    await tab.unmount()
  }
})

test('a chat with only sub-agents has the section', async () => {
  const tab = await mountPanel({ subagents: { 'agent-reviewer': reviewer } })
  try {
    await tab.deliver([])
    await tab.act(() => pause(500))
    expect(tab.panel().textContent).toContain('Subagents')
  } finally {
    await tab.unmount()
  }
})

test('a sub-agent’s own chat reaches the head through what it says of itself', async () => {
  const tab = await mountPanel({ subagents: { 'agent-reviewer': reviewer } })
  try {
    await tab.deliver(transcript)
    await tab.act(() => pause(500))
    await chatSays(tab, 'agent', { name: 'Router work' })
    await chatSays(tab, 'agent-reviewer', { name: 'Design review', modelLabel: 'Grok 4.7' })
    await tab.act(async () => tab.row('Cursor')!.click())
    expect(tab.host.textContent).toContain('Chat of agent-reviewer')
    expect(tab.head()).toBe('Design review')
    expect(tab.panel().textContent).toContain('Grok 4.7')
  } finally {
    await tab.unmount()
  }
})

test('a sub-agent’s answers go to its newest session: a follow-up to a rested one starts a new one', () => {
  const session = (sessionId: string, agentId: string, updatedAt: number) =>
    ({ sessionId, workspaceId: 'w-1', agentId, updatedAt }) as ConversationSessionEntry
  const sessions = [session('rested', 'agent-a', 1), session('newest', 'agent-a', 3), session('other', 'agent-b', 9)]
  expect(latestSessionOf(sessions, 'w-1', 'agent-a')?.sessionId).toBe('newest')
  expect(latestSessionOf(sessions, 'w-1', 'agent-c')).toBeUndefined()
})

test('where older turns are not read there is a way to them, and it asks for them', async () => {
  const tab = await mountPanel()
  try {
    await tab.page(transcript)
    await tab.act(() => pause(500))
    expect(tab.panel().textContent).toContain('Load earlier turns to see older subagents')
  } finally {
    await tab.unmount()
  }
})

test('a chat with no agents known and older turns unread has no section, only the way to look', async () => {
  const tab = await mountPanel()
  try {
    await tab.page([event('user_message', { turnId: 'turn-1', text: 'Hello' })])
    await tab.act(() => pause(500))
    expect(tab.panel().textContent).not.toMatch(/Subagents$|Subagents[A-Z]/u)
    expect(tab.panel().textContent).toContain('Load earlier turns to see older subagents')
  } finally {
    await tab.unmount()
  }
})

test('a tab out of sight rests what it publishes, and catches up when seen', async () => {
  const tab = await mountPanel()
  try {
    await tab.deliver(transcript)
    await tab.act(() => pause(500))
    const view = tab.tabView()
    await tab.act(async () => observed.get(view)?.([{ target: view, isIntersecting: false }]))
    await tab.deliver([...transcript, ...anotherLane()])
    await tab.act(() => pause(500))
    expect(tab.names()).not.toContain('Write the tests')
    await tab.act(async () => observed.get(view)?.([{ target: view, isIntersecting: true }]))
    await tab.act(() => pause(500))
    expect(tab.names()).toContain('Write the tests')
  } finally {
    await tab.unmount()
  }
})

test('while the chat streams, the rows follow on a short beat rather than every event', async () => {
  const tab = await mountPanel()
  try {
    await tab.deliver(transcript)
    await tab.deliver([...transcript, ...anotherLane()])
    expect(tab.names()).not.toContain('Write the tests')
    await tab.act(() => pause(500))
    expect(tab.names()).toContain('Write the tests')
  } finally {
    await tab.unmount()
  }
})

const chatOnMachine = { connectionId: 'connection', workspaceId: 'far-workspace', agentId: 'far-agent' }
const farReviewer: MeshSubagent = {
  workspaceId: 'far-workspace',
  agentId: 'far-child',
  title: 'Cursor · grok-4.7',
  providerId: 'cursor-agent',
  modelId: 'grok-4.7',
  readOnly: true,
  status: 'needs_input',
  task: 'Review the calendar screen',
  startedAt: 1_000,
}

/** The tab on a chat of a paired machine: its pane publishes it as `RemoteConversationPanel` does. */
async function openRemoteChat(tab: Awaited<ReturnType<typeof mountPanel>>) {
  const { createRemoteConversationTransport } = await import('../../../panels/agentChat/conversationTransport')
  const { publishRemoteChat } = await import('../../../panels/agentChat/remoteChatRegistry')
  const transport = createRemoteConversationTransport({
    key: chatOnMachine,
    machineName: 'mac-mini',
    access: 'operate',
  })
  const transports = new Map<string, ConversationTransport>()
  const subagentTransport = (agentId: string) => {
    const made =
      transports.get(agentId) ??
      createRemoteConversationTransport({
        key: { ...chatOnMachine, agentId },
        machineName: 'mac-mini',
        access: 'operate',
      })
    transports.set(agentId, made)
    return made
  }
  const binding = {
    agent: { name: 'Router work', conversation: { providerId: 'claude-agent', modelId: 'opus' } },
    update: () => undefined,
    workspace: null,
    workspaceRoot: null,
    sessionRoot: 'mesh:connection',
  }
  let take = () => {}
  const publish = async (subagents: MeshSubagent[]) => {
    await tab.act(async () => {
      take()
      take = publishRemoteChat('workspace', {
        agentId: 'far-agent',
        key: { connectionId: 'connection', workspaceId: 'far-workspace', agentId: 'far-agent' },
        machineName: 'mac-mini',
        hostChanges: false,
        transport,
        binding,
        subagents,
        subagentTransport,
      })
    })
  }
  const deliver = async (events: ConversationEvent[]) => {
    await tab.act(async () => {
      const receive = tab.followed.get('far-agent')!
      receive({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
      receive({ type: 'synchronized', seq: events.at(-1)?.seq ?? 0 })
    })
    await tab.act(() => pause(500))
  }
  return { publish, deliver, close: () => take() }
}

test('a chat on a paired machine lists the sub-agents that machine names, live, with their harness and status', async () => {
  const tab = await mountPanel({ focused: false, remote: true })
  const chat = await openRemoteChat(tab)
  try {
    await chat.publish([farReviewer])
    await chat.deliver(transcript)
    const text = tab.panel().textContent ?? ''
    expect(text).toContain('Cursor · grok-4.7')
    expect(text).toContain('Read-only')
    expect(text).toContain('Waiting on you')
    expect(text).toContain('Find the router')
    expect(tab.names()[0], 'a sub-agent waiting on the person is at the top').toBe('Cursor · grok-4.7')
    expect(tab.row('Cursor')!.querySelector('svg')).not.toBeNull()

    await chat.publish([{ ...farReviewer, status: 'failed', endedAt: 11_000, error: 'The model is unavailable.' }])
    await tab.act(() => pause(50))
    const moved = tab.panel().textContent ?? ''
    expect(moved).toContain('Failed after 10s')
    expect(moved).not.toContain('Waiting on you')
  } finally {
    chat.close()
    await tab.unmount()
  }
})

test('one on a paired machine opens in the tab, and the panel follows it', async () => {
  const tab = await mountPanel({ focused: false, remote: true })
  const chat = await openRemoteChat(tab)
  try {
    await chat.publish([farReviewer])
    await chat.deliver(transcript)
    await tab.act(async () => tab.row('Cursor')!.click())
    expect(tab.host.textContent).toContain('Chat of far-child')
    expect(tab.parent()?.textContent).toContain('Main chat')
    expect(tab.parent()?.textContent).toContain('Router work')
    await tab.act(async () => tab.parent()!.querySelector('button')!.click())
    expect(tab.host.textContent).toContain('The main chat')
    expect(tab.parent()).toBeNull()
  } finally {
    chat.close()
    await tab.unmount()
  }
})

test('a lane of a chat on a paired machine opens, and the panel follows it, read through that chat', async () => {
  const tab = await mountPanel({ focused: false, remote: true })
  const chat = await openRemoteChat(tab)
  try {
    await chat.publish([])
    await chat.deliver([...transcript, ...nested()])
    await tab.act(async () => tab.row('Find the router')!.click())
    await tab.act(() => pause(500))
    await chat.deliver([...transcript, ...nested()])
    expect(tab.head()).toBe('Find the router')
    expect(tab.names()).toContain('Read the routes')
    expect(tab.names()).not.toContain('Plan the migration')
  } finally {
    chat.close()
    await tab.unmount()
  }
})

test('a machine that names none leaves the panel the agents its chat’s CLI spawned', async () => {
  const tab = await mountPanel({ focused: false, remote: true })
  const chat = await openRemoteChat(tab)
  try {
    await chat.publish([])
    await chat.deliver(transcript)
    const text = tab.panel().textContent ?? ''
    expect(text).toContain('Find the router')
    expect(text).not.toContain("Couldn't")
  } finally {
    chat.close()
    await tab.unmount()
  }
})
