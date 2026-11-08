import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, test } from 'vitest'

// A stand-in (a workspace with `remoteOrigin`) exists to show one chat on a
// paired machine, so its layout always holds that chat's pane. One whose pane
// was closed used to fall to the empty-layout floor's New chat tab, and its
// sidebar row, still matched to the chat by session id, opened a blank
// composer while the chat ran on over there.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

type Modules = {
  React: typeof import('react')
  createRoot: typeof import('react-dom/client').createRoot
  WorkspaceLayout: typeof import('./WorkspaceLayout').default
  useWorkspaceStore: typeof import('../../store/workspaceStore').useWorkspaceStore
  modelRegistry: typeof import('../../utils/modelRegistry')
  layoutTabActions: typeof import('./manager/layoutTabActions')
  mesh: typeof import('../../../../shared/tailnet-mesh')
}
let modules: Modules

beforeAll(async () => {
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Element = dom.window.Element
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  anyGlobal.requestAnimationFrame = (callback: FrameRequestCallback) =>
    dom.window.setTimeout(() => callback(Date.now()), 0)
  anyGlobal.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id)
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

  // Nothing the layout asks of main matters here: subscriptions hand back an
  // unsubscribe, every read stays pending.
  domWindow.api = new Proxy(
    { platform: 'darwin' },
    {
      get: (target, name) =>
        name in target
          ? (target as Record<string | symbol, unknown>)[name]
          : typeof name === 'string' && name.startsWith('on')
            ? () => () => {}
            : () => new Promise(() => {}),
    },
  )

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  modules = {
    React,
    createRoot,
    WorkspaceLayout: (await import('./WorkspaceLayout')).default,
    useWorkspaceStore: (await import('../../store/workspaceStore')).useWorkspaceStore,
    modelRegistry: await import('../../utils/modelRegistry'),
    layoutTabActions: await import('./manager/layoutTabActions'),
    mesh: await import('../../../../shared/tailnet-mesh'),
  }
})

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

const SESSION_ID = 'conversation:rw1:agent-1'
const origin = (sessionId: string | null = SESSION_ID) => ({
  connectionId: 'c1',
  machineName: 'mac-mini',
  // The project's seat, as rows started from New chat were stamped: the chat
  // itself is the one the session id names.
  workspaceId: 'seat',
  workspaceName: 'Tidy the release notes',
  workspaceRoot: null,
  ...(sessionId ? { sessionId } : {}),
  checkout: { mode: 'current' as const, branch: null, worktreePath: null },
})

type JsonTab = { type: 'tab'; id: string; name: string; component: string; config?: Record<string, unknown> }
const blankNewChat: JsonTab = {
  type: 'tab',
  id: 'new-agent-abc',
  name: 'Niamh Quinn',
  component: 'new-agent',
  config: { agentName: 'Niamh Quinn' },
}

function layoutOf(tabs: readonly JsonTab[], selected = 0) {
  return {
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: tabs.length ? [{ type: 'tabset', id: 'ts1', selected, children: tabs }] : [],
    },
  }
}

async function mount(options: {
  layoutModel: unknown
  remoteOrigin: ReturnType<typeof origin> | null
}): Promise<{ newChatOpened: () => number }> {
  const { React, createRoot, WorkspaceLayout, useWorkspaceStore, modelRegistry } = modules
  const { act } = React
  useWorkspaceStore.setState((state) => ({
    ...state,
    workspaces: [
      {
        id: 'w1',
        name: 'Tidy the release notes',
        mode: 'standard',
        folderPath: null,
        agents: {},
        layoutModel: options.layoutModel,
        ...(options.remoteOrigin ? { remoteOrigin: options.remoteOrigin } : {}),
      },
    ] as never,
  }))
  // The "+" as the manager wires it, which the empty-layout floor also calls.
  let opened = 0
  const onNewAgentTab = (hostTabsetId?: string) => {
    opened += 1
    modelRegistry.addNewAgentTab('w1', 'Cara Doyle', hostTabsetId)
  }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(React.createElement(WorkspaceLayout, { workspaceId: 'w1', onNewAgentTab }))
  })
  await settle()
  cleanups.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  return { newChatOpened: () => opened }
}

async function settle(): Promise<void> {
  const { act } = modules.React
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
    })
  }
}

/** The tabs of the layout as saved: what the registry holds and the next launch restores. */
function savedTabs(): JsonTab[] {
  const workspace = modules.useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === 'w1')
  const tabs: JsonTab[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as { type?: unknown; children?: unknown }
    if (record.type === 'tab') tabs.push(node as JsonTab)
    if (Array.isArray(record.children)) record.children.forEach(walk)
  }
  walk((workspace?.layoutModel as { layout?: unknown } | undefined)?.layout)
  return tabs
}

function assertOwnPane(tab: JsonTab | undefined): void {
  assert.ok(tab, 'the stand-in holds a tab')
  assert.equal(tab.component, modules.mesh.MESH_CONVERSATION_COMPONENT, `a pane onto the chat: ${JSON.stringify(tab)}`)
  assert.deepEqual(
    {
      connectionId: tab.config?.connectionId,
      remoteWorkspaceId: tab.config?.remoteWorkspaceId,
      remoteAgentId: tab.config?.remoteAgentId,
      remoteSessionId: tab.config?.remoteSessionId,
      machineName: tab.config?.machineName,
    },
    {
      connectionId: 'c1',
      // The chat the session id names, not the seat in `workspaceId`.
      remoteWorkspaceId: 'rw1',
      remoteAgentId: 'agent-1',
      remoteSessionId: SESSION_ID,
      machineName: 'mac-mini',
    },
  )
  assert.equal((tab as { enableClose?: unknown }).enableClose, false, 'and it carries no close')
}

test('a stand-in saved with an empty layout gets its chat pane back, not a blank New chat', async () => {
  const { newChatOpened } = await mount({ layoutModel: layoutOf([]), remoteOrigin: origin() })

  const tabs = savedTabs()
  assert.equal(tabs.length, 1, `one tab: ${JSON.stringify(tabs)}`)
  assertOwnPane(tabs[0])
  assert.equal(newChatOpened(), 0, 'the empty-layout floor opened no New chat tab')
})

test('a stand-in holding only a blank New chat tab has that tab retyped into its chat pane', async () => {
  const { newChatOpened } = await mount({ layoutModel: layoutOf([blankNewChat]), remoteOrigin: origin() })

  const tabs = savedTabs()
  assert.equal(tabs.length, 1, `retyped in place, not a second tab: ${JSON.stringify(tabs)}`)
  assert.equal(tabs[0].id, blankNewChat.id, 'the same node')
  assertOwnPane(tabs[0])
  assert.equal(tabs[0].name, 'Tidy the release notes', 'named for the chat, not the random agent name')
  assert.equal(newChatOpened(), 0)
})

test('a healthy stand-in keeps a New chat tab opened with the "+" beside its pane', async () => {
  const pane = {
    type: 'tab' as const,
    ...modules.mesh.meshConversationTab({
      connectionId: 'c1',
      machineName: 'mac-mini',
      remoteWorkspaceId: 'rw1',
      remoteAgentId: 'agent-1',
      title: 'Tidy the release notes',
    }),
  }
  await mount({ layoutModel: layoutOf([pane, blankNewChat], 1), remoteOrigin: origin() })

  const tabs = savedTabs()
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    [pane.id, blankNewChat.id],
    'both tabs stay, in their order',
  )
  assertOwnPane(tabs[0])
  assert.equal(tabs[1].component, 'new-agent', 'the New chat tab is left a New chat tab')
  assert.deepEqual(tabs[1].config, blankNewChat.config)
})

test('closing the pane of a stand-in leaves it holding its chat', async () => {
  const { newChatOpened } = await mount({ layoutModel: layoutOf([]), remoteOrigin: origin() })
  const [pane] = savedTabs()

  // Primary+W reads the tab's close and does nothing.
  assert.equal(modules.layoutTabActions.closeActiveLayoutTab('w1', []), false, 'Primary+W cannot close it')
  // Removed some other way while mounted, it comes straight back.
  const model = modules.modelRegistry.getModel('w1')
  assert.ok(model)
  const { act } = modules.React
  act(() => {
    modules.modelRegistry.deleteTabPreservingRails(model, pane.id)
  })
  await settle()

  const tabs = savedTabs()
  assert.equal(tabs.length, 1, `back to one tab: ${JSON.stringify(tabs)}`)
  assertOwnPane(tabs[0])
  assert.equal(newChatOpened(), 0, 'never the blank New chat')
})

test('a row born before the session id was stamped keeps the ordinary empty-layout floor', async () => {
  // Nothing on it says which chat it was, so there is no pane to put back.
  const { newChatOpened } = await mount({ layoutModel: layoutOf([]), remoteOrigin: origin(null) })

  assert.equal(newChatOpened(), 1)
  assert.deepEqual(
    savedTabs().map((tab) => tab.component),
    ['new-agent'],
  )
})

test('a local workspace still lands on New chat when it is empty', async () => {
  const { newChatOpened } = await mount({ layoutModel: layoutOf([]), remoteOrigin: null })

  assert.equal(newChatOpened(), 1)
  assert.deepEqual(
    savedTabs().map((tab) => tab.component),
    ['new-agent'],
  )
})
